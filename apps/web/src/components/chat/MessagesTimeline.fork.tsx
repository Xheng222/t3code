import { type LegendListProps, type LegendListRef } from "@legendapp/list/react";
import {
  useLayoutEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { observeResize } from "~/lib/observeResize";
import { useClientSettings } from "../../hooks/useSettings";
import { type PendingApproval, type TimelineEntry } from "../../session-logic";
import {
  type MessagesTimelineRow,
  type MessagesTimelineRowsInput,
  type TimelineLatestRun,
} from "./MessagesTimeline.logic";
import { processRowHooks } from "./MessagesTimeline.logic.fork";
import {
  deriveProcessGroupRows,
  usePacedActivityRows,
  waitingResponseLabel,
} from "./activityPresentation.fork";
import { TimelineMotionRow, useTimelineMotionRows } from "./timelineMotion.fork";
import {
  ForkTimelineRowCtx,
  type ForkTimelineRowState,
  type ForkWorkGroupViewState,
} from "./timelineRowContext.fork";
import { type TimelineViewport } from "./timelineViewport";
import { useTurnPresentation } from "./turnPresentation.fork";
import { useStableRows } from "./useTimelineRows";

// Rows measured or resized above the viewport keep the reading position; row changes do not.
const KEEP_READING_POSITION_ON_RESIZE = { size: true, data: false } as const;

// Optional, so TypeScript accepts the spreads as overriding upstream's values.
type ForkRowsInput = Partial<
  Pick<
    MessagesTimelineRowsInput,
    "timelineEntries" | "sourceTimelineEntries" | "presentingRunIds" | "processRows"
  >
>;
type ForkListProps = Partial<
  Pick<
    LegendListProps<MessagesTimelineRow>,
    "onItemSizeChanged" | "maintainScrollAtEnd" | "maintainVisibleContentPosition"
  >
>;

/** Turn presentation, ahead of row derivation: the timeline derives rows from presented entries. */
export function useForkTimelinePresentation(input: {
  identity: string;
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestRun: TimelineLatestRun | null;
  isWorking: boolean;
  synced: boolean;
  findExpanded: boolean;
  citationPositioning: boolean;
}) {
  const { identity, timelineEntries, synced } = input;
  const toolCallVisibility = useClientSettings((settings) => settings.toolCallVisibility);
  // Opening a thread settles until a frame after its first synced layout; nothing animates
  // or paces before, so rows that arrive with the sync appear as they are.
  const [settledIdentity, setSettledIdentity] = useState<string | null>(null);
  const settling = settledIdentity !== identity;
  const immediate = input.findExpanded || input.citationPositioning || toolCallVisibility === "zen";
  const { visit, entries, presentingRunIds, onPendingChange } = useTurnPresentation({
    identity,
    entries: timelineEntries,
    latestRunId: input.latestRun?.runId ?? null,
    isWorking: input.isWorking,
    immediate,
    synced,
  });
  const rowsInput: ForkRowsInput = {
    timelineEntries: entries,
    sourceTimelineEntries: timelineEntries,
    presentingRunIds,
    processRows: processRowHooks,
  };
  return {
    ...input,
    toolCallVisibility,
    settling,
    setSettledIdentity,
    immediate,
    visit,
    presentedEntries: entries,
    onPresentationPendingChange: onPendingChange,
    /** Spread last into the derivation input. */
    rowsInput,
  };
}

type ForkTimelinePresentation = ReturnType<typeof useForkTimelinePresentation>;

/**
 * Paced and process rows, work group auto-collapse and motion rows, from the derived rows.
 * Returns the rows the list shows and the fork's list hooks.
 */
export function useForkTimeline(
  presentation: ForkTimelinePresentation,
  derivedRows: MessagesTimelineRow[],
  input: {
    expandedWorkGroupIds: ReadonlySet<string>;
    setExpandedWorkGroupIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
    workGroupViewState: ForkWorkGroupViewState;
    restoringThreadPosition: boolean;
    prefersReducedMotion: boolean;
    activeTurnStartedAt: string | null;
    isPreparingWorktree: boolean;
    isCompacting: boolean;
    awaitingUser: "approval" | "input" | null;
    pendingApprovals: ReadonlyArray<PendingApproval>;
    navigateTimeline: () => void;
  },
) {
  const {
    identity,
    timelineEntries,
    presentedEntries,
    latestRun,
    isWorking,
    findExpanded,
    citationPositioning,
    toolCallVisibility,
    settling,
    immediate,
    visit,
  } = presentation;
  const { expandedWorkGroupIds, setExpandedWorkGroupIds, activeTurnStartedAt, navigateTimeline } =
    input;
  const pacedRows = usePacedActivityRows(derivedRows, identity, immediate || settling);
  const turnPrompt = timelineEntries.findLast(
    (entry) =>
      entry.kind === "message" &&
      entry.message.role === "user" &&
      entry.message.inputIntent !== "steer" &&
      entry.message.inputIntent !== "promoted_queued_to_steer",
  );
  const tailEntry = presentedEntries.at(-1);
  const presentingProse =
    tailEntry?.kind === "message" &&
    tailEntry.message.role === "assistant" &&
    (tailEntry.message.streaming ||
      visit.pending.has(tailEntry.message.id) ||
      (visit.completed.get(tailEntry.message.id) ?? 0) < tailEntry.message.text.length);
  const canWait =
    isWorking &&
    latestRun?.turnEnded !== true &&
    !presentingProse &&
    !input.isPreparingWorktree &&
    !input.isCompacting &&
    input.awaitingUser === null &&
    input.pendingApprovals.length === 0 &&
    toolCallVisibility !== "zen";
  const rawRows = deriveProcessGroupRows(
    pacedRows,
    canWait
      ? {
          label: waitingResponseLabel(
            `${identity}:${turnPrompt?.id ?? latestRun?.runId ?? activeTurnStartedAt ?? "start"}`,
          ),
          createdAt: activeTurnStartedAt ?? latestRun?.startedAt ?? null,
        }
      : null,
  );
  const activeWorkGroups = new Set(
    rawRows.flatMap((row) => (row.kind === "work-live" ? [row.groupId] : [])),
  );
  const [workGroupActivity, setWorkGroupActivity] = useState({
    identity,
    groups: activeWorkGroups,
  });
  if (
    workGroupActivity.identity !== identity ||
    workGroupActivity.groups.size !== activeWorkGroups.size ||
    [...workGroupActivity.groups].some((id) => !activeWorkGroups.has(id))
  ) {
    setWorkGroupActivity({ identity, groups: activeWorkGroups });
    if (workGroupActivity.identity === identity) {
      const completedGroups = [...workGroupActivity.groups].filter(
        (id) => !activeWorkGroups.has(id),
      );
      if (completedGroups.some((id) => expandedWorkGroupIds.has(id))) {
        const nextExpanded = new Set(expandedWorkGroupIds);
        for (const id of completedGroups) nextExpanded.delete(id);
        setExpandedWorkGroupIds(nextExpanded);
      }
    }
  }
  const stableRows = useStableRows(rawRows, identity);
  const { rows, exits, motion, pins, closingGroups, prepended } = useTimelineMotionRows(
    stableRows,
    identity,
    !input.prefersReducedMotion &&
      !findExpanded &&
      !citationPositioning &&
      !input.restoringThreadPosition &&
      !settling,
  );
  // Turn folds share `turn-status:*` ids with the working row; upstream anchors them by run.
  const captureDisclosure = (anchorKey: string) => {
    const header = rows.find(
      (row) => row.kind === "turn-fold" && `turn-fold:${row.runId}` === anchorKey,
    );
    navigateTimeline();
    motion.capture(header?.id ?? anchorKey);
    return true;
  };
  const rowState: ForkTimelineRowState = {
    activityImmediate: immediate || settling,
    seenAssistantMessages: visit.seen,
    onPresentationPendingChange: presentation.onPresentationPendingChange,
    presentedAssistantMessages: visit.completed,
    pendingAssistantMessages: visit.pending,
    onWorkEntryToggle: captureDisclosure,
    workGroupViewState: input.workGroupViewState,
  };
  const fork = {
    rowState,
    exits,
    /** Replaces upstream's disclosure anchoring: motion keeps the toggled row in place. */
    captureDisclosure,
    /** Motion's pinned rows, kept mounted ahead of upstream's. */
    alwaysRenderKeys: pins,
    withRowFrame:
      <Info extends { item: MessagesTimelineRow }>(render: (info: Info) => ReactNode) =>
      (info: Info) => {
        const { item } = info;
        return (
          <ForkTimelineRowCtx value={rowState}>
            <TimelineMotionRow
              key={`${identity}:${item.id}`}
              entry={item}
              motion={motion}
              id={item.id}
              exiting={exits.has(item.id)}
              presentationPending={item.kind === "message" && visit.pending.has(item.message.id)}
              closingChildren={
                (item.kind === "work-live" || item.kind === "work-toggle") &&
                closingGroups.has(item.groupId)
              }
            >
              {render(info)}
            </TimelineMotionRow>
          </ForkTimelineRowCtx>
        );
      },
    /** Spread last on the list: extends upstream's `onItemSizeChanged`, replaces the rest. */
    listProps: (upstream: { onItemSizeChanged: () => void }): ForkListProps => ({
      onItemSizeChanged: () => {
        motion.layoutChanged();
        upstream.onItemSizeChanged();
      },
      // Follow scrolls to the end itself, after motion lays rows out.
      maintainScrollAtEnd: false,
      maintainVisibleContentPosition:
        findExpanded || citationPositioning || input.restoringThreadPosition
          ? false
          : prepended
            ? true
            : KEEP_READING_POSITION_ON_RESIZE,
    }),
    /** Motion; attach before follow. */
    attach: (viewport: TimelineViewport | null, list: LegendListRef | null) => {
      if (!viewport || !list) return () => {};
      const detachMotion = motion.attach(viewport, list);
      // Resizing the viewport moves the end without changing any content size; follow keeps up
      // without a tween, as during motion.
      let height = viewport.scrollNode.clientHeight;
      const stopResize = observeResize(viewport.scrollNode, () => {
        if (viewport.scrollNode.clientHeight === height) return;
        height = viewport.scrollNode.clientHeight;
        viewport.layoutChanged(true);
      });
      return () => {
        stopResize();
        detachMotion();
      };
    },
    /** The content size schedule, which replaces upstream's; attach after follow. */
    attachAfterFollow: (
      viewport: TimelineViewport | null,
      list: LegendListRef | null,
      onContentSizeChanged: () => void,
    ) => {
      let contentSizeFrame: number | null = null;
      // LegendList lays rows out from layout effects; the next frame sees them settled.
      const scheduleContentSizeChanged = () => {
        if (!list) return;
        motion.layoutChanged();
        if (contentSizeFrame !== null) return;
        contentSizeFrame = requestAnimationFrame(() => {
          contentSizeFrame = null;
          viewport?.layoutChanged(motion.isAnimating());
          onContentSizeChanged();
        });
      };
      const stopListeningToContentSize = list
        ?.getState()
        .listen("totalSize", scheduleContentSizeChanged);
      const stopListeningToFooterSize = list
        ?.getState()
        .listen("footerSize", scheduleContentSizeChanged);
      scheduleContentSizeChanged();
      return () => {
        stopListeningToContentSize?.();
        stopListeningToFooterSize?.();
        if (contentSizeFrame !== null) cancelAnimationFrame(contentSizeFrame);
      };
    },
  };
  return [rows, fork] as const;
}

/** Ends the opening settle a frame after the list lays out the shown thread's first synced rows. */
export function useForkTimelineSettle(
  presentation: ForkTimelinePresentation,
  showsEmptyState: boolean,
) {
  const { identity, setSettledIdentity } = presentation;
  const settleReady = presentation.settling && presentation.synced && !showsEmptyState;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ends the opening settle a frame after LegendList lays out the shown thread's first synced rows
  useLayoutEffect(() => {
    if (!settleReady) return;
    const frame = requestAnimationFrame(() => setSettledIdentity(identity));
    return () => cancelAnimationFrame(frame);
  }, [identity, settleReady, setSettledIdentity]);
}

/** LegendList item types for the fork's rows; `undefined` leaves the row to upstream. */
export function forkTimelineItemType(item: MessagesTimelineRow): string | undefined {
  if (item.kind === "working" || item.kind === "turn-fold") return "turn-status";
  if (
    item.kind === "work-live" ||
    item.kind === "work-toggle" ||
    item.kind === "work-waiting" ||
    (item.kind === "event" && item.projectedItem.item.type === "subagent")
  )
    return "process-group";
  if (item.kind === "work" && item.groupedEntries[0]?.itemType === "reasoning") {
    const length = item.groupedEntries[0].detail?.length ?? 0;
    return `work:reasoning:${Math.max(0, Math.floor(Math.log2(length / 1000)))}`;
  }
  return undefined;
}
