import { use, useState } from "react";
import { useTimelineSettling } from "./timelineMotion.fork";
import { TimelineRowActivityCtx, TimelineRowCtx, type TimelineRow } from "./timelineRowContext";
import { ForkTimelineRowCtx } from "./timelineRowContext.fork";

/**
 * The assistant text to show, held while timeline motion settles, and the props
 * `StreamingMarkdown` paces it with.
 */
export function useForkAssistantText(
  row: Extract<TimelineRow, { kind: "message" }>,
  incomingText: string,
) {
  const ctx = use(TimelineRowCtx);
  const forkCtx = use(ForkTimelineRowCtx);
  const { latestRunId } = use(TimelineRowActivityCtx);
  const immediate =
    ctx.findActive ||
    ctx.citationRequest?.citation.messageId === row.message.id ||
    row.projectedItem?.item.status === "interrupted" ||
    row.projectedItem?.item.status === "cancelled" ||
    row.projectedItem?.item.status === "failed";
  const [heldText, setHeldText] = useState(incomingText);
  // Height animations target heights measured when they start, so paced text waits until they settle.
  const settling = useTimelineSettling(
    !immediate &&
      (Boolean(row.message.streaming) ||
        forkCtx.pendingAssistantMessages.has(row.message.id) ||
        heldText !== incomingText),
  );
  if (!settling && heldText !== incomingText) setHeldText(incomingText);
  const text = settling ? heldText : incomingText;
  const presented = forkCtx.presentedAssistantMessages.get(row.message.id);
  const showChangedFiles =
    !row.message.streaming &&
    !forkCtx.pendingAssistantMessages.has(row.message.id) &&
    (latestRunId === null ||
      row.message.runId !== latestRunId ||
      (presented !== undefined && presented >= text.length));
  return {
    text,
    showChangedFiles,
    streamingProps: {
      messageId: row.message.id,
      paused: settling,
      seenMessages: forkCtx.seenAssistantMessages,
      animateInitial:
        !forkCtx.seenAssistantMessages.has(row.message.id) &&
        (Boolean(row.message.streaming) ||
          (latestRunId !== null && row.message.runId === latestRunId)),
      immediate,
      onPendingChange: forkCtx.onPresentationPendingChange,
    },
  };
}
