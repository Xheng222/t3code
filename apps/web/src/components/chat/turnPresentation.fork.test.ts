import { expect, it } from "vite-plus/test";
import { MessageId, RunId } from "@t3tools/contracts";
import { admitTurnContent } from "./turnPresentation.fork";
import type { TimelineEntry } from "../../session-logic";

it("admits process content after the preceding prose is presented while keeping user interaction available", () => {
  const runId = RunId.make("presentation-run");
  const at = "2026-11-08T00:00:00Z";
  const prose = (id: string, text: string, replyRunId = runId): TimelineEntry => ({
    kind: "message",
    id,
    createdAt: at,
    message: {
      id: MessageId.make(id),
      runId: replyRunId,
      role: "assistant",
      text,
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  });
  const tool = (id: string): TimelineEntry => ({
    kind: "work",
    id,
    createdAt: at,
    entry: {
      id,
      runId,
      createdAt: at,
      tone: "tool",
      itemType: "command_execution",
      label: "Ran rg",
      command: "rg",
      toolLifecycleStatus: "completed",
    },
  });
  const first = prose("first", "Checking the source.");
  const final = prose("final", "Done.");
  const interaction: TimelineEntry = {
    kind: "work",
    id: "question",
    createdAt: at,
    entry: {
      id: "question",
      runId,
      createdAt: at,
      tone: "tool",
      itemType: "user_input_request",
      label: "Question",
    },
  };
  const user: TimelineEntry = {
    kind: "message",
    id: "steer",
    createdAt: at,
    message: {
      id: MessageId.make("steer"),
      runId,
      role: "user",
      inputIntent: "steer",
      text: "Continue",
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  };
  const entries = [first, tool("search"), final, tool("followup"), interaction, user];
  const presented = new Map<string, number>();
  const shown = (pending: ReadonlySet<string> = new Set()) =>
    admitTurnContent(entries, presented, pending, runId).map(({ id }) => id);
  expect(shown()).toEqual(["first", "question", "steer"]);
  presented.set("first", "Checking the source.".length);
  expect(shown(new Set(["first"]))).toEqual(["first", "question", "steer"]);
  expect(shown()).toEqual(["first", "search", "final", "question", "steer"]);
  presented.set("final", "Done.".length);
  expect(admitTurnContent(entries, presented, new Set(), runId)).toBe(entries);
  const appended = [prose("first", "Checking the source. More text."), ...entries.slice(1)];
  expect(admitTurnContent(appended, presented, new Set(), runId).map(({ id }) => id)).toEqual([
    "first",
    "question",
    "steer",
  ]);
  for (const inputIntent of ["steer", "promoted_queued_to_steer"] as const) {
    const steered = [first, { ...user, message: { ...user.message, inputIntent } }, tool("later")];
    expect(
      admitTurnContent(steered, new Map(), new Set(["first"]), runId).map(({ id }) => id),
    ).toEqual(["first", "steer"]);
  }
  const nextRun = RunId.make("next-presentation-run");
  const nextPrompt: TimelineEntry = {
    ...user,
    id: "next-prompt",
    message: {
      ...user.message,
      id: MessageId.make("next-prompt"),
      inputIntent: "turn_start",
      runId: nextRun,
    },
  };
  const nextReply = prose("next-reply", "Starting the next turn.", nextRun);
  expect(
    admitTurnContent(
      [...appended, nextPrompt, nextReply],
      presented,
      new Set(["first"]),
      nextRun,
    ).at(-1),
  ).toBe(nextReply);
});
