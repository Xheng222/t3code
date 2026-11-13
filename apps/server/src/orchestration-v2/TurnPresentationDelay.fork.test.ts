import { ThreadId, type ClientActivityLease } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import {
  MAX_PRESENTATION_DELAY_MS,
  presentationDelayMs,
  threadIsWatched,
} from "./TurnPresentationDelay.fork.ts";

const NOW = 1_000_000;
const reply = (text: string, createdAt: number, updatedAt = createdAt) => ({
  role: "assistant" as const,
  text,
  createdAt: DateTime.makeUnsafe(createdAt),
  updatedAt: DateTime.makeUnsafe(updatedAt),
});

it.each([
  {
    name: "a reply that arrived at once",
    messages: [reply("x".repeat(2000), NOW)],
    min: 10_000,
    max: 13_000,
  },
  {
    name: "a reply that streamed slower than its reveal",
    messages: [reply("x".repeat(600), NOW - 30_000, NOW)],
    min: 0,
    max: 1_000,
  },
  {
    name: "a reply revealed long ago",
    messages: [reply("x".repeat(2000), NOW - 120_000)],
    min: 0,
    max: 0,
  },
  {
    name: "a reply too long to wait for",
    messages: [reply("x".repeat(20_000), NOW)],
    min: MAX_PRESENTATION_DELAY_MS,
    max: MAX_PRESENTATION_DELAY_MS,
  },
  {
    name: "no reply text",
    messages: [{ ...reply("x".repeat(2000), NOW), role: "user" as const }, reply("", NOW)],
    min: 0,
    max: 0,
  },
])("holds completion for $name", ({ messages, min, max }) => {
  const delay = presentationDelayMs(messages, NOW);
  expect(delay).toBeGreaterThanOrEqual(min);
  expect(delay).toBeLessThanOrEqual(max);
});

it("waits only for visible desktop and web clients showing the thread", () => {
  const threadId = ThreadId.make("thread:shown");
  const lease = (
    clientKind: ClientActivityLease["clientKind"],
    visible: boolean,
    shown = threadId,
  ): Pick<ClientActivityLease, "clientKind" | "visible" | "scopes"> => ({
    clientKind,
    visible,
    scopes: [{ type: "provider-status" }, { type: "thread", threadId: shown }],
  });
  expect(
    [
      lease("web", true),
      lease("desktop-renderer", true),
      lease("mobile", true),
      lease("desktop-renderer", false),
      lease("web", true, ThreadId.make("thread:other")),
    ].map((watching) => threadIsWatched({ leases: [watching] }, threadId)),
  ).toEqual([true, true, false, false, false]);
});
