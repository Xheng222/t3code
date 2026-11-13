import { type LegendListProps, type LegendListRef } from "@legendapp/list/react";
import { type MessageId } from "@t3tools/contracts";
import {
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { useClientSettings } from "../../hooks/useSettings";
import { type PendingApproval, type TimelineEntry } from "../../session-logic";
import {
  messageIsSteer,
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
import { CHAT_TIMELINE_ANCHOR_OFFSET } from "./timelineScrollAnchoring";
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
  paused: boolean;
  synced: boolean;
  findExpanded: boolean;
  citationPositioning: boolean;
}) {
  const { identity, timelineEntries, paused, synced } = input;
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
    paused,
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
 * Paced and process rows, work group auto-collapse, motion rows and the end gap, from the derived
 * rows. Returns the rows the list shows and the fork's list hooks.
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
    anchorMessageId: MessageId | null;
    onAnchorReady: (messageId: MessageId, anchorIndex: number) => void;
    activeTurnStartedAt: string | null;
    isPreparingWorktree: boolean;
    isCompacting: boolean;
    awaitingUser: "approval" | "input" | null;
    pendingApprovals: ReadonlyArray<PendingApproval>;
    listRef: RefObject<LegendListRef | null>;
    navigateTimeline: () => void;
  },
) {
  const {
    identity,
    timelineEntries,
    presentedEntries,
    latestRun,
    isWorking,
    paused,
    findExpanded,
    citationPositioning,
    toolCallVisibility,
    settling,
    immediate,
    visit,
  } = presentation;
  const {
    expandedWorkGroupIds,
    setExpandedWorkGroupIds,
    anchorMessageId,
    activeTurnStartedAt,
    listRef,
    navigateTimeline,
  } = input;
  const pacedRows = usePacedActivityRows(derivedRows, identity, immediate || settling, paused);
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
    (isWorking || anchorMessageId !== null) &&
    (anchorMessageId !== null || latestRun?.turnEnded !== true) &&
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
    anchorMessageId,
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
      !paused &&
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
  // The current turn starts at the latest prompt; steers continue it.
  const turnStartId = rows.findLast(
    (row) => row.kind === "message" && row.message.role === "user" && !messageIsSteer(row.message),
  )?.id;
  // The end gap lets the current turn fill the viewport, so its prompt can rest at the top. It
  // grows before the list commits shorter content, so the end cannot clamp, and shrinks after
  // taller content commits. Its padding is its floor. Resize observers keep the viewport and
  // footer heights, so applying it on motion frames reads no layout.
  const endGapRef = useRef<HTMLDivElement | null>(null);
  const endGapLayout = useRef({ viewport: 0, footer: 0 });
  const applyEndGap = useStableCallback((shrink: boolean) => {
    const gap = endGapRef.current;
    const state = listRef.current?.getState();
    if (!gap || !state) return;
    const start = turnStartId === undefined ? undefined : state.indexByKey(turnStartId);
    let room = 0;
    if (start !== undefined) {
      room =
        endGapLayout.current.viewport - CHAT_TIMELINE_ANCHOR_OFFSET - endGapLayout.current.footer;
      for (let index = start; index < state.data.length && room > 0; index += 1) {
        room -= state.sizeAtIndex(index) || 0;
      }
    }
    const extra = Math.max(0, Math.round(room));
    const current = Number.parseFloat(gap.style.minHeight) || 0;
    if (extra === current || (extra < current && !shrink)) return;
    gap.style.minHeight = extra > 0 ? `${extra}px` : "";
  });
  // The footer resizes with its content and with the gap; what sits above the gap counts.
  const attachEndGap = useStableCallback((gap: HTMLDivElement) => {
    endGapRef.current = gap;
    const footer = gap.parentElement;
    const stop = footer
      ? observeResize(footer, () => {
          endGapLayout.current.footer = footer.offsetHeight - gap.offsetHeight;
          applyEndGap(true);
        })
      : undefined;
    return () => {
      stop?.();
      if (endGapRef.current === gap) endGapRef.current = null;
    };
  });
  const pendingPromptIndex =
    anchorMessageId === null
      ? -1
      : rows.findIndex((row) => row.kind === "message" && row.message.id === anchorMessageId);
  // Follow positions a send once the rows from it down are measured and the end gap fits them. A
  // prompt without a row of its own, such as a compaction, positions the end directly.
  const reportAnchorReady = useStableCallback(() => {
    const state = listRef.current?.getState();
    if (anchorMessageId === null || state?.data !== rows) return;
    const measured =
      pendingPromptIndex < 0 ||
      rows.slice(pendingPromptIndex).every((row) => {
        const index = state.indexByKey(row.id);
        return index !== undefined && state.sizeAtIndex(index) !== undefined;
      });
    if (!measured) return;
    applyEndGap(true);
    input.onAnchorReady(
      anchorMessageId,
      pendingPromptIndex < 0 ? rows.length - 1 : pendingPromptIndex,
    );
  });
  const rowState: ForkTimelineRowState = {
    activityImmediate: immediate || settling,
    seenAssistantMessages: visit.seen,
    onPresentationPendingChange: presentation.onPresentationPendingChange,
    presentedAssistantMessages: visit.completed,
    pendingAssistantMessages: visit.pending,
    presentationPaused: paused,
    onWorkEntryToggle: captureDisclosure,
    workGroupViewState: input.workGroupViewState,
  };
  const fork = {
    rowState,
    exits,
    /** Replaces upstream's disclosure anchoring: motion keeps the toggled row in place. */
    captureDisclosure,
    /** Kept mounted ahead of upstream's: motion's pinned rows, and a send's rows while it positions. */
    alwaysRenderKeys: [
      ...pins,
      ...(pendingPromptIndex >= 0 ? rows.slice(pendingPromptIndex).map((row) => row.id) : []),
    ],
    /** Each thread mounts its own end gap, so a switch never shows the previous thread's space. */
    endGap: <div key={identity} ref={attachEndGap} aria-hidden className="pt-3 sm:pt-4" />,
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
    /** Motion and the end gap; attach before follow, whose layout step measures the gap. */
    attach: (viewport: TimelineViewport | null, list: LegendListRef | null) => {
      if (!viewport || !list) return () => {};
      const detachMotion = motion.attach(viewport, list);
      // Resizing the viewport moves the end without changing any content size; follow keeps up
      // without a tween, as during motion.
      let height = viewport.scrollNode.clientHeight;
      // The window caps the gap's viewport, so a list whose height follows its content does not
      // grow with its own gap.
      endGapLayout.current.viewport = Math.min(height, window.innerHeight);
      const stopResize = observeResize(viewport.scrollNode, () => {
        if (viewport.scrollNode.clientHeight === height) return;
        height = viewport.scrollNode.clientHeight;
        endGapLayout.current.viewport = Math.min(height, window.innerHeight);
        viewport.layoutChanged(true);
      });
      const stopEndGap = viewport.onLayoutChanged(() => queueMicrotask(() => applyEndGap(true)));
      return () => {
        stopEndGap();
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
          reportAnchorReady();
          viewport?.layoutChanged(motion.isAnimating());
          onContentSizeChanged();
        });
      };
      const stopListeningToContentSize = list?.getState().listen("totalSize", () => {
        applyEndGap(false);
        scheduleContentSizeChanged();
      });
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
