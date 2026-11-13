import type {
  ClientActivityLease,
  OrchestrationV2ConversationMessage,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { STREAMING_SPEED, streamingSpeed } from "@t3tools/shared/streamingPace";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const FRAME_MS = 1000 / 60;
// The last characters' fade, reveal pauses while timeline rows animate, and delivery.
const PRESENTATION_MARGIN_MS = 600;
export const MAX_PRESENTATION_DELAY_MS = 30_000;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * When a client that received the text as it arrived finishes revealing it, assuming it arrived
 * evenly between `createdAt` and `updatedAt`.
 */
function revealEndMs(
  message: { readonly text: string; readonly createdAt: number; readonly updatedAt: number },
  limit: number,
) {
  let length = 0;
  for (const _ of graphemes.segment(message.text)) length += 1;
  const span = message.updatedAt - message.createdAt;
  const receivedAt = (time: number) =>
    span <= 0 ? length : Math.min(length, (length * (time - message.createdAt)) / span);
  let time = message.createdAt;
  let visible = 0;
  let speed = STREAMING_SPEED.normal;
  while (visible < length && time < limit) {
    time += FRAME_MS;
    const received = receivedAt(time);
    speed = streamingSpeed(speed, received - visible, FRAME_MS);
    visible = Math.min(received, visible + (speed * FRAME_MS) / 1000);
  }
  return time;
}

/** How long to hold a finished run's completion so a client revealing its replies ends first. */
export function presentationDelayMs(
  messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "role" | "text" | "createdAt" | "updatedAt">
  >,
  now: number,
) {
  const limit = now + MAX_PRESENTATION_DELAY_MS;
  let end = -Infinity;
  for (const message of messages) {
    if (message.role !== "assistant" || message.text === "") continue;
    const updatedAt = DateTime.toEpochMillis(message.updatedAt);
    // Even revealed at the normal speed after arriving at once, this text ended long ago.
    if (updatedAt + (message.text.length / STREAMING_SPEED.normal) * 1000 < now) continue;
    const createdAt = DateTime.toEpochMillis(message.createdAt);
    end = Math.max(end, revealEndMs({ text: message.text, createdAt, updatedAt }, limit));
  }
  return Math.min(MAX_PRESENTATION_DELAY_MS, Math.max(0, end + PRESENTATION_MARGIN_MS - now));
}

/** Whether a visible desktop or web client, the ones that pace replies, shows the thread. */
export function threadIsWatched(
  snapshot: {
    readonly leases: ReadonlyArray<Pick<ClientActivityLease, "clientKind" | "visible" | "scopes">>;
  },
  threadId: ThreadId,
) {
  return snapshot.leases.some(
    (lease) =>
      (lease.clientKind === "web" || lease.clientKind === "desktop-renderer") &&
      lease.visible &&
      lease.scopes.some((scope) => scope.type === "thread" && scope.threadId === threadId),
  );
}

/** Delays a completed run's checkpoint, and so its completion, while a watching client presents. */
export class TurnPresentationDelay extends Context.Reference<{
  readonly forCompletedRun: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<number>;
}>("t3/orchestration-v2/TurnPresentationDelay", {
  defaultValue: () => ({ forCompletedRun: () => Effect.succeed(0) }),
}) {}

export const layer = Layer.effect(
  TurnPresentationDelay,
  Effect.gen(function* () {
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return {
      forCompletedRun: Effect.fn("TurnPresentationDelay.forCompletedRun")(
        function* ({ threadId, runId }) {
          if (!threadIsWatched(yield* backgroundPolicy.snapshot, threadId)) return 0;
          const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
            messageRoles: ["assistant"],
            messageRunIds: [runId],
          });
          return presentationDelayMs(messages, DateTime.toEpochMillis(yield* DateTime.now));
        },
        Effect.orElseSucceed(() => 0),
      ),
    };
  }),
);
