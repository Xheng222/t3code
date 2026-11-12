import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
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
import {
  ForkTimelineRowCtx,
  type ForkTimelineRowState,
  type ForkWorkGroupViewState,
} from "./timelineRowContext.fork";
import { useTurnPresentation } from "./turnPresentation.fork";
import { useStableRows } from "./useTimelineRows";

// Optional, so TypeScript accepts the spreads as overriding upstream's values.
type ForkRowsInput = Partial<
  Pick<
    MessagesTimelineRowsInput,
    "timelineEntries" | "sourceTimelineEntries" | "presentingRunIds" | "processRows"
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
 * Paced and process rows and work group auto-collapse, from the derived rows. Returns the rows
 * the list shows and the fork's list hooks.
 */
export function useForkTimeline(
  presentation: ForkTimelinePresentation,
  derivedRows: MessagesTimelineRow[],
  input: {
    expandedWorkGroupIds: ReadonlySet<string>;
    setExpandedWorkGroupIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
    workGroupViewState: ForkWorkGroupViewState;
    activeTurnStartedAt: string | null;
    isPreparingWorktree: boolean;
    isCompacting: boolean;
    awaitingUser: "approval" | "input" | null;
    pendingApprovals: ReadonlyArray<PendingApproval>;
  },
) {
  const {
    identity,
    timelineEntries,
    presentedEntries,
    latestRun,
    isWorking,
    toolCallVisibility,
    immediate,
    visit,
  } = presentation;
  const { expandedWorkGroupIds, setExpandedWorkGroupIds, activeTurnStartedAt } = input;
  const pacedRows = usePacedActivityRows(derivedRows, identity, immediate);
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
  const rows = useStableRows(rawRows, identity);
  const rowState: ForkTimelineRowState = {
    activityImmediate: immediate,
    seenAssistantMessages: visit.seen,
    onPresentationPendingChange: presentation.onPresentationPendingChange,
    presentedAssistantMessages: visit.completed,
    pendingAssistantMessages: visit.pending,
    workGroupViewState: input.workGroupViewState,
  };
  const fork = {
    rowState,
    withRowFrame:
      <Info extends { item: MessagesTimelineRow }>(render: (info: Info) => ReactNode) =>
      (info: Info) => <ForkTimelineRowCtx value={rowState}>{render(info)}</ForkTimelineRowCtx>,
  };
  return [rows, fork] as const;
}

/** LegendList item types for the fork's rows; `undefined` leaves the row to upstream. */
export function forkTimelineItemType(item: MessagesTimelineRow): string | undefined {
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
