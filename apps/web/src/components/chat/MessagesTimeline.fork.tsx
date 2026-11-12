import { useState, type ReactNode } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { type TimelineEntry } from "../../session-logic";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { ForkTimelineRowCtx, type ForkTimelineRowState } from "./timelineRowContext.fork";
import { useStableRows } from "./useTimelineRows";

/**
 * Streamed reply presentation for the visit: replies seen when it opened show as history, and
 * replies still revealing their text are pending.
 */
export function useForkTimelinePresentation(input: {
  identity: string;
  timelineEntries: ReadonlyArray<TimelineEntry>;
}) {
  const { identity, timelineEntries } = input;
  const createPresentationVisit = () => ({
    identity,
    hydrated: timelineEntries.length > 0,
    seen: new Set<string>(
      timelineEntries.flatMap((entry) =>
        entry.kind === "message" && entry.message.role === "assistant" ? [entry.message.id] : [],
      ),
    ),
    pending: new Set<string>(),
  });
  const [presentationVisit, setPresentationVisit] = useState(createPresentationVisit);
  let visit = presentationVisit;
  if (visit.identity !== identity || (!visit.hydrated && timelineEntries.length > 0)) {
    visit = createPresentationVisit();
    setPresentationVisit(visit);
  }
  const onPresentationPendingChange = useStableCallback((messageId: string, pending: boolean) => {
    setPresentationVisit((current) => {
      if (current.identity !== identity || current.pending.has(messageId) === pending)
        return current;
      const next = new Set(current.pending);
      if (pending) next.add(messageId);
      else next.delete(messageId);
      return { ...current, pending: next };
    });
  });
  return { ...input, visit, onPresentationPendingChange };
}

type ForkTimelinePresentation = ReturnType<typeof useForkTimelinePresentation>;

/** The rows the list shows, from the derived rows, and the fork's list hooks. */
export function useForkTimeline(
  presentation: ForkTimelinePresentation,
  derivedRows: MessagesTimelineRow[],
) {
  const { identity, visit } = presentation;
  const rows = useStableRows(derivedRows, identity);
  const rowState: ForkTimelineRowState = {
    seenAssistantMessages: visit.seen,
    onPresentationPendingChange: presentation.onPresentationPendingChange,
  };
  const fork = {
    rowState,
    withRowFrame:
      <Info extends { item: MessagesTimelineRow }>(render: (info: Info) => ReactNode) =>
      (info: Info) => <ForkTimelineRowCtx value={rowState}>{render(info)}</ForkTimelineRowCtx>,
  };
  return [rows, fork] as const;
}
