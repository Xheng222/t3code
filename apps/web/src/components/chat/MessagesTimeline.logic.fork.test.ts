import { ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import {
  CheckpointRef,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  TurnItemId,
  RuntimeRequestId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntry,
} from "../../session-logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import type { TurnDiffSummary } from "../../types";
import { describe, expect, it } from "vite-plus/test";
import { MessageId, RunId } from "@t3tools/contracts";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
  type MessagesTimelineRow,
  type MessagesTimelineRowsInput,
} from "./MessagesTimeline.logic";
import {
  processActivityLabel,
  processAnswerPreview,
  reasoningParagraphs,
  withProcessRows,
} from "./MessagesTimeline.logic.fork";

const deriveProcessRows = (input: MessagesTimelineRowsInput) =>
  deriveMessagesTimelineRows(withProcessRows(input));

describe("reasoning paragraphs", () => {
  it.each([
    [
      "paragraphs",
      "First idea.\n\nSecond idea.\r\n\r\nThird idea.",
      ["First idea.", "Second idea.", "Third idea."],
    ],
    [
      "a title with its body",
      "**Reading logs**\n\nThe cache misses.",
      ["**Reading logs**\n\nThe cache misses."],
    ],
    ["a title before its body arrives", "Done.\n\n**Next step**", ["Done.", "**Next step**"]],
    [
      "a fence with blank lines",
      "Try:\n\n```ts\na();\n\nb();\n```\n\nThen check.",
      ["Try:", "```ts\na();\n\nb();\n```", "Then check."],
    ],
    ["blank text", " \n\n ", []],
  ])("splits %s", (_, text, paragraphs) => {
    expect(reasoningParagraphs(text)).toEqual(paragraphs);
  });

  it("counts and previews each paragraph as its own thought", () => {
    const at = "2026-01-01T00:00:01Z";
    const thought: TimelineEntry = {
      kind: "work",
      id: "thought",
      createdAt: at,
      entry: {
        id: "thought",
        createdAt: at,
        label: "Thinking",
        tone: "thinking",
        itemType: "reasoning",
        detail: "**Reading logs**\n\nThe cache misses.\n\nThe key changes on every run.",
        toolLifecycleStatus: "completed",
      },
    };
    const rows = deriveProcessRows({
      timelineEntries: [thought],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
      id: "work-toggle:thought",
      hiddenCount: 2,
      summary: "Thought (×2)",
    });
    expect(processAnswerPreview([thought])).toBe("The key changes on every run.");
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("stops stranded thinking after a steer and follows the next thought or tool", () => {
    const runId = RunId.make("steered-run");
    const at = "2026-10-01T06:19:10Z";
    const thought = (id: string): TimelineEntry => ({
      kind: "work",
      id,
      createdAt: at,
      entry: {
        id,
        runId,
        createdAt: at,
        label: "Thinking",
        tone: "thinking",
        itemType: "reasoning",
        detail: id,
        toolLifecycleStatus: "inProgress",
      },
    });
    const steer: TimelineEntry = {
      kind: "message",
      id: "steer",
      createdAt: at,
      message: {
        id: MessageId.make("steer"),
        role: "user",
        text: "Also evaluate speed",
        runId,
        inputIntent: "steer",
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    };
    const first = thought("first-thought");
    const next = thought("next-thought");
    const tool: TimelineEntry = {
      kind: "work",
      id: "tool",
      createdAt: at,
      entry: {
        id: "tool",
        runId,
        createdAt: at,
        label: "Running cat",
        tone: "tool",
        command: "cat file",
        toolLifecycleStatus: "inProgress",
      },
    };
    const rows = (timelineEntries: ReadonlyArray<TimelineEntry>) =>
      deriveProcessRows({
        timelineEntries,
        expandedWorkGroupIds: new Set(["work-group:first-thought"]),
        runningRunId: runId,
        isWorking: true,
        activeTurnStartedAt: at,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
    expect(rows([first]).find((row) => row.kind === "work-live")).toMatchObject({
      active: true,
      entry: { id: "first-thought" },
    });
    const afterSteer = rows([first, steer]);
    expect(afterSteer.some((row) => row.kind === "work-live")).toBe(false);
    expect(afterSteer.at(-1)?.kind).toBe("message");
    expect(afterSteer.find((row) => row.kind === "work")).toMatchObject({
      groupedEntries: [{ id: "first-thought", toolLifecycleStatus: "completed" }],
    });
    for (const entries of [
      [first, steer, next],
      [first, next],
      [first, steer, next, tool],
    ]) {
      const live = rows(entries).filter((row) => row.kind === "work-live" && row.active);
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ entry: { id: entries.at(-1)!.id } });
    }
    expect(first.kind === "work" && first.entry.toolLifecycleStatus).toBe("inProgress");
  });

  it.each(["waiting", "completed"] as const)(
    "groups approval and user-input requests with commands without expanding them when %s",
    (status) => {
      const fixture = makeStreamingTimelineFixture();
      const source = fixture.visibleTurnItems[0]!;
      const common = {
        ...source.item,
        threadId: fixture.threadId,
        runId: fixture.runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status,
      };
      const items: OrchestrationV2ProjectedTurnItem["item"][] = [
        {
          ...common,
          id: TurnItemId.make("command"),
          type: "command_execution",
          input: "pwd",
          output: "",
        },
        {
          ...common,
          id: TurnItemId.make("approval"),
          type: "approval_request",
          requestId: RuntimeRequestId.make("approval-request"),
          requestKind: "command",
          prompt: "Allow pwd?",
        },
        {
          ...common,
          id: TurnItemId.make("input"),
          type: "user_input_request",
          requestId: RuntimeRequestId.make("input-request"),
          questions: [],
        },
      ];
      const entries = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: items.map((item, position) => ({
          ...source,
          item,
          position,
          sourceItemId: item.id,
        })),
        optimisticMessages: [],
      });
      expect(entries.map((entry) => entry.kind)).toEqual(["work", "work", "work"]);
      const rows = deriveProcessRows({
        timelineEntries: entries,
        isWorking: status === "waiting",
        runningRunId: fixture.runId,
        activeTurnStartedAt: fixture.time(0),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      const workRows = rows.filter((row) => row.kind === "work-toggle" || row.kind === "work-live");
      expect(workRows).toHaveLength(1);
      expect(workRows[0]).toMatchObject({ expanded: false });
      const expandedRows = deriveProcessRows({
        timelineEntries: entries,
        isWorking: status === "waiting",
        runningRunId: fixture.runId,
        activeTurnStartedAt: fixture.time(0),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        expandedWorkGroupIds: new Set([workRows[0]!.groupId]),
      });
      expect(
        expandedRows.flatMap((row) =>
          row.kind === "work" && row.isExpandedToolGroup
            ? row.groupedEntries.map((entry) => entry.itemType)
            : [],
        ),
      ).toEqual(["command_execution", "approval_request", "user_input_request"]);
      expect(rows.some((row) => row.kind === "event")).toBe(false);
      expect(workRows[0]).not.toMatchObject({ expanded: true });
      expect(workRows[0]).not.toMatchObject({ isExpandedToolGroup: true });
      const pendingRows = deriveProcessRows({
        timelineEntries: entries,
        pendingApprovalRequestIds: new Set([RuntimeRequestId.make("approval-request")]),
        isWorking: status === "waiting",
        runningRunId: fixture.runId,
        activeTurnStartedAt: fixture.time(0),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      expect(pendingRows.filter((row) => row.kind === "work")).toContainEqual(
        expect.objectContaining({
          groupedEntries: [expect.objectContaining({ itemType: "approval_request" })],
          isExpandedToolGroup: false,
        }),
      );
      expect(
        pendingRows
          .filter((row) => row.kind === "work-live")
          .flatMap((row) => row.groupedEntries)
          .some((entry) => entry.itemType === "approval_request"),
      ).toBe(false);
      const approvalOnlyRows = deriveProcessRows({
        timelineEntries: entries.slice(1, 2),
        pendingApprovalRequestIds: new Set([RuntimeRequestId.make("approval-request")]),
        isWorking: status === "waiting",
        runningRunId: fixture.runId,
        activeTurnStartedAt: fixture.time(0),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      expect(approvalOnlyRows.some((row) => row.kind === "thinking")).toBe(false);
    },
  );

  it.each([false, true])(
    "gives live compaction the activity slot and restores Thinking (runless: %s)",
    (runless) => {
      const fixture = makeStreamingTimelineFixture();
      const last = fixture.visibleTurnItems.at(-1)!;
      if (last.item.type !== "assistant_message") throw new Error("Expected assistant fixture");
      const compact = {
        ...last,
        item: {
          ...last.item,
          type: "compaction" as const,
          status: "running" as const,
          driver: null,
          beforeTokenCount: 899_000,
        },
      };
      const input = {
        isWorking: true,
        runningRunId: fixture.runId,
        activeTurnStartedAt: fixture.time(5),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      };
      const runningEntries = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [...fixture.visibleTurnItems.slice(0, -1), compact],
        optimisticMessages: [],
      });
      const runningRows = deriveProcessRows({
        ...input,
        runningRunId: runless ? null : fixture.runId,
        runlessWorkActive: runless,
        timelineEntries: runless
          ? runningEntries.map((entry) =>
              entry.kind === "work" ? { ...entry, entry: { ...entry.entry, runId: null } } : entry,
            )
          : runningEntries,
      });
      expect(runningRows.find((row) => row.kind === "context-compaction")).toMatchObject({
        active: true,
        label: "Compacting context",
      });
      expect(runningRows.some((row) => row.kind === "thinking")).toBe(false);

      const completedRows = deriveProcessRows({
        ...input,
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: [
            ...fixture.visibleTurnItems.slice(0, -1),
            {
              ...compact,
              item: { ...compact.item, status: "completed", afterTokenCount: 19_000 },
            },
          ],
          optimisticMessages: [],
        }),
      });
      expect(completedRows.find((row) => row.kind === "context-compaction")).toMatchObject({
        active: false,
        label: "Context compacted 899K → 19K tokens",
        tokenCounts: { before: "899K", after: "19K" },
      });
      expect(completedRows.some((row) => row.kind === "thinking")).toBe(false);

      const settledRows = deriveProcessRows({
        ...input,
        isWorking: false,
        timelineEntries: runningEntries,
      });
      expect(settledRows.find((row) => row.kind === "context-compaction")).toMatchObject({
        active: false,
      });
      const stable = computeStableMessagesTimelineRows(runningRows, {
        result: [],
        byId: new Map(),
      });
      expect(computeStableMessagesTimelineRows(settledRows, stable).result).toEqual(settledRows);
    },
  );

  it("folds the first assistant message and settled work before the terminal response", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-first-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-first" as never,
          role: "assistant" as const,
          text: "Synthetic deployment checklist\n1. Confirm the deployment is ready.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          runId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveProcessRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);
    expect(foldRow?.label).toBe("Worked for 22s");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveProcessRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-first-entry",
      "work-toggle:work-entry-1",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
  });

  it.each([1, 2, 3])("folds %i completed activities after the terminal response", (count) => {
    const runId = RunId.make("turn-1");
    const timelineEntries = [
      {
        id: "work-entry-before-text",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "work-before-text",
          createdAt: "2026-01-01T00:00:01Z",
          runId,
          label: "Status updated",
          tone: "info" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "CI is re-running. Waiting.",
          runId,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      ...Array.from({ length: count }, (_, index) => ({
        id: `work-entry-after-text-${index}`,
        kind: "work" as const,
        createdAt: `2026-01-01T00:00:0${index + 7}Z`,
        entry: {
          id: `work-after-text-${index}`,
          createdAt: `2026-01-01T00:00:0${index + 7}Z`,
          runId,
          label: "Ran command",
          tone: "tool" as const,
          itemType: "command_execution" as const,
          toolLifecycleStatus: "completed" as const,
        },
      })),
    ];

    const input = {
      latestRun: {
        runId,
        status: "completed" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };
    const rows = deriveProcessRows({ ...input, timelineEntries });

    expect(rows.map((row) => row.id)).toEqual(["turn-fold:turn-1", "assistant-final-entry"]);
    const expanded = deriveProcessRows({
      ...input,
      timelineEntries,
      expandedRunIds: new Set([runId]),
    });
    expect(
      expanded.some(
        (row) =>
          row.id === "work-entry-after-text-0" ||
          (row.kind === "work-toggle" &&
            row.id === "work-toggle:work-entry-after-text-0" &&
            row.hiddenCount === count),
      ),
    ).toBe(true);
    expect(expanded.filter((row) => row.kind === "work")).toHaveLength(0);
    expect(expanded.find((row) => row.id === "assistant-final-entry")).toMatchObject({
      showAssistantMeta: true,
      showAssistantCopyButton: true,
    });
    expect(expanded.some((row) => row.kind === "assistant-meta")).toBe(false);
    const groupHistory = deriveProcessRows({
      ...input,
      timelineEntries,
      expandedRunIds: new Set([runId]),
      expandedWorkGroupIds: new Set(["work-group:work-entry-after-text-0"]),
    });
    expect(
      groupHistory.flatMap((row) =>
        row.kind === "work" ? row.groupedEntries.map((entry) => entry.id) : [],
      ),
    ).toEqual(Array.from({ length: count }, (_, index) => `work-after-text-${index}`));

    const failedEntries = timelineEntries.map((entry) =>
      entry.kind === "work" && entry.id === "work-entry-after-text-0"
        ? { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "failed" as const } }
        : entry,
    );
    const failedRows = deriveProcessRows({ ...input, timelineEntries: failedEntries });
    expect(
      failedRows.some(
        (row) =>
          row.kind === "work-toggle" &&
          row.groupId === "work-group:work-entry-after-text-0" &&
          row.hasFailure,
      ),
    ).toBe(true);

    const pendingEntries = timelineEntries.map((entry) =>
      entry.kind === "work" && entry.id === "work-entry-after-text-0"
        ? { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "inProgress" as const } }
        : entry,
    );
    const pendingRows = deriveProcessRows({
      ...input,
      timelineEntries: pendingEntries,
      latestRun: { ...input.latestRun, status: "running", completedAt: null },
      isWorking: true,
      activeTurnStartedAt: input.latestRun.startedAt,
    });
    expect(
      pendingRows.some(
        (row) => row.kind === "work-live" && row.entry.id === `work-after-text-${count - 1}`,
      ),
    ).toBe(true);
  });

  it.each(["steer", "promoted_queued_to_steer"] as const)(
    "keeps the duration header at the initiating prompt when %s arrives before output",
    (inputIntent) => {
      const runId = RunId.make("steered-run");
      const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
      const prompt = (id: string, second: number, intent: "turn_start" | typeof inputIntent) => ({
        kind: "message" as const,
        id,
        createdAt: time(second),
        message: {
          id: MessageId.make(id),
          role: "user" as const,
          text: id,
          runId,
          inputIntent: intent,
          createdAt: time(second),
          updatedAt: time(second),
          streaming: false,
        },
      });
      const entries = [prompt("initial-prompt", 0, "turn_start"), prompt("steer", 5, inputIntent)];
      const work = {
        kind: "work" as const,
        id: "work",
        createdAt: time(8),
        entry: {
          id: "work",
          createdAt: time(8),
          runId,
          label: "Ran command",
          tone: "tool" as const,
        },
      };
      const final = {
        kind: "message" as const,
        id: "final",
        createdAt: time(20),
        message: {
          id: MessageId.make("final"),
          role: "assistant" as const,
          text: "Done",
          runId,
          createdAt: time(20),
          updatedAt: time(20),
          streaming: false,
        },
      };
      for (const phase of ["working", "presenting", "settled"] as const) {
        const isWorking = phase === "working";
        const isPresenting = phase === "presenting";
        const showWorking = isWorking || isPresenting;
        for (const expanded of [true, false]) {
          const rows = deriveProcessRows({
            timelineEntries: [...entries, work, final],
            latestRun: {
              runId,
              status: isWorking ? "running" : "completed",
              startedAt: time(0),
              completedAt: isWorking ? null : time(20),
            },
            isWorking,
            presentingRunIds: new Set(isPresenting ? [runId] : []),
            activeTurnStartedAt: time(0),
            expandedRunIds: expanded ? new Set([runId]) : new Set(),
            turnDiffSummaries: [],
            supportsConversationRollback: false,
          });
          expect(rows.slice(0, 3).map((row) => row.id)).toEqual([
            "initial-prompt",
            showWorking ? "working-indicator-row" : `turn-fold:${runId}`,
            "steer",
          ]);
          expect(rows[1]?.createdAt).toBe(time(0));
          if (isPresenting)
            expect(rows[1]).toMatchObject({ kind: "working", completedAt: time(20) });
          if (!showWorking) expect(rows[1]).toMatchObject({ label: "Worked for 20s", expanded });
          expect(rows.some((row) => row.id === "final")).toBe(true);
          expect(
            rows.some((row) => row.kind === "work-toggle" && row.groupId === "work-group:work"),
          ).toBe(showWorking || expanded);
        }
      }
    },
  );

  it("splits a settled turn's work at each steer and keeps the total time on top", () => {
    const runId = RunId.make("steered-run");
    const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const message = (
      id: string,
      second: number,
      role: "user" | "assistant",
      inputIntent?: "turn_start" | "steer",
    ): TimelineEntry => ({
      kind: "message",
      id,
      createdAt: time(second),
      message: {
        id: MessageId.make(id),
        role,
        text: id,
        runId,
        ...(inputIntent ? { inputIntent } : {}),
        createdAt: time(second),
        updatedAt: time(second),
        streaming: false,
      },
    });
    const work = (id: string, second: number): TimelineEntry => ({
      kind: "work",
      id,
      createdAt: time(second),
      entry: { id, createdAt: time(second), runId, label: "Ran command", tone: "tool" },
    });
    const rows = (expandedRunIds: ReadonlySet<RunId>) =>
      deriveProcessRows({
        timelineEntries: [
          message("prompt", 0, "user", "turn_start"),
          work("work-before-steer", 4),
          message("steer", 10, "user", "steer"),
          work("work-after-steer", 15),
          message("final", 30, "assistant"),
        ],
        latestRun: { runId, status: "completed", startedAt: time(0), completedAt: time(30) },
        isWorking: false,
        expandedRunIds,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

    const segmentKey = RunId.make(`${runId}:steer:steer`);
    const collapsed = rows(new Set());
    expect(collapsed.map((row) => row.id)).toEqual([
      "prompt",
      `turn-fold:${runId}`,
      "steer",
      `turn-fold:${segmentKey}`,
      "final",
    ]);
    expect(collapsed[1]).toMatchObject({ label: "Worked for 30s" });
    expect(collapsed[3]).toMatchObject({ label: "Continued for 20s", createdAt: time(10) });

    expect(rows(new Set([segmentKey])).map((row) => row.id)).toEqual([
      "prompt",
      `turn-fold:${runId}`,
      "steer",
      `turn-fold:${segmentKey}`,
      "work-toggle:work-after-steer",
      "final",
    ]);
  });

  it("keeps the previous turn folded while a newly sent message awaits its turn", () => {
    const rows = deriveProcessRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:22Z",
            streaming: false,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "yooo",
            runId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:22Z",
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.map((row) => row.id)).toEqual([
      "turn-fold:turn-1",
      "assistant-final-entry",
      "user-followup-entry",
      "working-indicator-row",
    ]);
    const finalRow = rows.find((row) => row.id === "assistant-final-entry");
    expect(finalRow?.kind === "message" && finalRow.showAssistantMeta).toBe(true);
    expect(rows.at(-1)).toMatchObject({ kind: "working" });
  });

  it("does not show Thinking once the open run's provider turn has ended", () => {
    const input = {
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message" as const,
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user" as never,
            role: "user" as const,
            text: "Take over the queue",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };

    expect(deriveProcessRows(input).some((row) => row.kind === "thinking")).toBe(false);
    const ended = deriveProcessRows({
      ...input,
      latestRun: { ...input.latestRun, turnEnded: true },
    });
    expect(ended.some((row) => row.kind === "thinking")).toBe(false);
  });

  it("keeps a promptless restart in one active visual response", () => {
    const rows = deriveProcessRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "keep going",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "old-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "old-work",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-before-restart" as never,
            label: "Searched files",
            command: "rg restart",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "old-stale-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:06Z",
          entry: {
            id: "old-stale-work",
            createdAt: "2026-01-01T00:00:06Z",
            runId: "turn-before-restart" as never,
            label: "Running stale command",
            command: "rg stale",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "old-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:08Z",
          message: {
            id: "old-commentary" as never,
            role: "assistant",
            text: "the server restarted, continuing here.",
            runId: "turn-before-restart" as never,
            createdAt: "2026-01-01T00:00:08Z",
            updatedAt: "2026-01-01T00:00:08Z",
            streaming: false,
          },
        },
        {
          id: "new-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:01:05Z",
          entry: {
            id: "new-work",
            createdAt: "2026-01-01T00:01:05Z",
            runId: "turn-after-restart" as never,
            label: "Running tests",
            command: "vp test run",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-after-restart" as never,
        status: "running",
        startedAt: "2026-01-01T00:01:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(rows.filter((row) => row.id === "working-indicator-row")).toHaveLength(1);
    expect(rows.findIndex((row) => row.id === "working-indicator-row")).toBeLessThan(
      rows.findIndex(
        (row) => row.kind === "work-toggle" && row.groupId === "work-group:old-work-entry",
      ),
    );
    expect(rows.find((row) => row.id === "working-indicator-row")).toMatchObject({
      createdAt: "2026-01-01T00:01:00Z",
    });
    expect(rows.find((row) => row.id === "old-commentary-entry")).toMatchObject({
      showAssistantMeta: false,
      showAssistantCopyButton: false,
      assistantCopyStreaming: true,
    });
    expect(rows.filter((row) => row.kind === "work-live" && row.active)).toEqual([
      expect.objectContaining({ entry: expect.objectContaining({ id: "new-work" }) }),
    ]);
    expect(rows.some((row) => row.kind === "thinking")).toBe(false);
  });

  it("shows the current tool and retains earlier thoughts in the group history", () => {
    type WorkEntry = Extract<
      Parameters<typeof deriveMessagesTimelineRows>[0]["timelineEntries"][number],
      { kind: "work" }
    >;
    const work = (
      id: string,
      at: string,
      fields: Omit<WorkEntry["entry"], "id" | "createdAt" | "runId" | "label">,
    ): WorkEntry => ({
      id: `${id}-entry`,
      kind: "work",
      createdAt: at,
      entry: { id, createdAt: at, runId: "turn-1" as never, label: id, ...fields },
    });
    const rows = deriveProcessRows({
      timelineEntries: [
        work("old-thought", "2026-01-01T00:00:01Z", {
          itemType: "reasoning",
          detail: "First idea.",
          tone: "thinking" as const,
          toolLifecycleStatus: "completed" as const,
        }),
        work("new-thought", "2026-01-01T00:00:02Z", {
          itemType: "reasoning",
          detail: "Found the cause.",
          tone: "thinking" as const,
          toolLifecycleStatus: "completed" as const,
        }),
        work("running-command", "2026-01-01T00:00:03Z", {
          command: "rg cause",
          requestKind: "command",
          tone: "tool" as const,
          toolLifecycleStatus: "inProgress" as const,
        }),
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "running-command" },
      groupedEntries: [{ id: "old-thought" }, { id: "new-thought" }, { id: "running-command" }],
    });
    expect(
      rows.flatMap((row) => (row.kind === "work" ? row.groupedEntries.map(({ id }) => id) : [])),
    ).toEqual(["running-command"]);
  });

  it("keeps the latest status in the current process group even when an earlier tool is running", () => {
    const rows = deriveProcessRows({
      timelineEntries: [
        {
          id: "running-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "running-command",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Running rg",
            command: "rg toolCall",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "completed-edit-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:06Z",
          entry: {
            id: "completed-edit",
            createdAt: "2026-01-01T00:00:06Z",
            runId: "turn-1" as never,
            label: "Edited files",
            requestKind: "file-change",
            changedFiles: ["src/one.ts", "src/two.ts"],
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "completed-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "completed-command",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Ran tests",
            command: "vp test run",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.map((row) => row.kind)).toEqual(["working", "work-live", "work"]);
    expect(rows.some((row) => row.kind === "thinking")).toBe(false);
    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "completed-command" },
      active: false,
      groupedEntries: [
        { id: "running-command" },
        { id: "completed-edit" },
        { id: "completed-command" },
      ],
    });
  });

  it("folds each run of a provider-native subagent thread like a normal turn", () => {
    const threadId = ThreadId.make("subagent-child");
    const rootNodeId = NodeId.make("task-root");
    const at = (second: number) =>
      DateTime.makeUnsafe(new Date(Date.UTC(2026, 8, 25, 22, 51, second)).toISOString());
    const base = (id: string, ordinal: number, second: number, endSecond = second) => ({
      id: TurnItemId.make(id),
      threadId,
      runId: null,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: at(second),
      completedAt: at(endSecond),
      updatedAt: at(endSecond),
    });
    const prompt = (id: string, ordinal: number, second: number) => ({
      ...base(id, ordinal, second),
      type: "user_message" as const,
      messageId: MessageId.make(id),
      text: `Prompt ${id}`,
      attachments: [],
      inputIntent: "turn_start" as const,
      createdBy: "agent" as const,
      creationSource: "provider" as const,
    });
    const answer = (id: string, ordinal: number, second: number) => ({
      ...base(id, ordinal, second),
      type: "assistant_message" as const,
      messageId: MessageId.make(id),
      text: `Answer ${id}`,
      streaming: false,
    });
    type ResumeState = "running" | "completed" | "failed";
    const items = (resume: ResumeState) =>
      [
        prompt("launch", 1, 0),
        { ...base("launch-ls", 2, 4), type: "command_execution" as const, input: "ls src" },
        {
          ...base("launch-thinking", 3, 8),
          type: "reasoning" as const,
          title: "Thinking",
          text: "Not there.",
          streaming: false,
        },
        answer("launch-answer", 4, 8),
        prompt("resume", 5, 72),
        {
          ...base("resume-ls", 6, 77),
          type: "command_execution" as const,
          input: "ls src",
          status: resume === "running" ? ("running" as const) : ("completed" as const),
          completedAt: resume === "running" ? null : at(77),
        },
        ...(resume === "failed"
          ? [
              {
                ...base("resume-error", 7, 80),
                type: "error" as const,
                status: "failed" as const,
                failure: {
                  class: "provider_error" as const,
                  message: "Subagent failed",
                  code: null,
                  retryable: null,
                },
              },
            ]
          : []),
        ...(resume === "running" ? [] : [answer("resume-answer", 8, 80)]),
      ].map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      }));
    const rows = (input: {
      resume: ResumeState;
      working: boolean;
      expandedRunIds?: ReadonlySet<RunId>;
    }) =>
      deriveProcessRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: items(input.resume),
          optimisticMessages: [],
        }),
        latestRun: null,
        isWorking: input.working,
        runlessWorkActive: input.working,
        ...(input.expandedRunIds === undefined ? {} : { expandedRunIds: input.expandedRunIds }),
        activeTurnStartedAt: input.working ? DateTime.formatIso(at(72)) : null,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
    const shape = (timeline: ReadonlyArray<MessagesTimelineRow>) =>
      timeline.map((row) =>
        row.kind === "turn-fold"
          ? `fold:${row.label}`
          : row.kind === "message"
            ? `${row.message.role}:${row.message.id}`
            : row.kind,
      );

    const settled = rows({ resume: "completed", working: false });
    expect(shape(settled)).toEqual([
      "user:launch",
      "fold:Worked for 8s",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 8s",
      "assistant:resume-answer",
    ]);

    const launchFold = settled.find((row) => row.kind === "turn-fold");
    if (launchFold?.kind !== "turn-fold") throw new Error("Expected the launch fold");
    const expanded = rows({
      resume: "completed",
      working: false,
      expandedRunIds: new Set([launchFold.runId]),
    });
    expect(shape(expanded)).toEqual([
      "user:launch",
      "fold:Worked for 8s",
      "work-toggle",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 8s",
      "assistant:resume-answer",
    ]);

    expect(shape(rows({ resume: "running", working: true }))).toEqual([
      "user:launch",
      "fold:Worked for 8s",
      "assistant:launch-answer",
      "user:resume",
      "working",
      "work-live",
      "work",
    ]);

    expect(shape(rows({ resume: "failed", working: false }))).toEqual([
      "user:launch",
      "fold:Worked for 8s",
      "assistant:launch-answer",
      "user:resume",
      "work-toggle",
      "work",
      "assistant:resume-answer",
    ]);
  });

  it("keeps answered questions in their own row outside tool groups and turn folds", () => {
    const threadId = ThreadId.make("answered-question-thread");
    const runId = RunId.make("answered-question-run");
    const requestId = RuntimeRequestId.make("scope-question");
    const at = (second: number) =>
      DateTime.makeUnsafe(new Date(Date.UTC(2026, 9, 17, 12, 0, second)).toISOString());
    const base = (id: string, ordinal: number, second: number) => ({
      id: TurnItemId.make(id),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: at(second),
      completedAt: at(second),
      updatedAt: at(second),
    });
    const command = (id: string, ordinal: number, second: number) => ({
      ...base(id, ordinal, second),
      type: "command_execution" as const,
      input: `cat ${id}`,
    });
    const items = (settled: boolean) =>
      [
        {
          ...base("prompt", 0, 0),
          type: "user_message" as const,
          messageId: MessageId.make("prompt"),
          text: "Pick a repository",
          attachments: [],
          inputIntent: "turn_start" as const,
          createdBy: "user" as const,
          creationSource: "web" as const,
        },
        command("before", 1, 1),
        {
          ...base("question", 2, 2),
          type: "user_input_request" as const,
          requestId,
          questions: [],
          questionAnswer: {
            requestId,
            questionTextById: { scope: "Which repository?" },
            answers: { scope: "The private one" },
            attachmentsByQuestionId: {},
          },
        },
        command("after", 3, 3),
        settled
          ? {
              ...base("answer", 4, 5),
              type: "assistant_message" as const,
              messageId: MessageId.make("answer"),
              text: "Done",
              streaming: false,
            }
          : { ...command("running", 4, 4), status: "running" as const, completedAt: null },
      ].map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      }));
    const rows = (settled: boolean, expandedRunIds?: ReadonlySet<RunId>) =>
      deriveProcessRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: items(settled),
          optimisticMessages: [],
        }),
        latestRun: {
          runId,
          status: settled ? "completed" : "running",
          startedAt: DateTime.formatIso(at(0)),
          completedAt: settled ? DateTime.formatIso(at(5)) : null,
        },
        runningRunId: settled ? null : runId,
        isWorking: !settled,
        activeTurnStartedAt: settled ? null : DateTime.formatIso(at(0)),
        ...(expandedRunIds === undefined ? {} : { expandedRunIds }),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
    const shape = (timeline: ReadonlyArray<MessagesTimelineRow>) =>
      timeline.map((row) =>
        row.kind === "turn-fold"
          ? "fold"
          : row.kind === "message"
            ? `${row.message.role}:${row.message.id}`
            : row.kind === "work" || row.kind === "work-live"
              ? `${row.kind}:${row.groupedEntries.map((entry) => entry.id).join(" + ")}`
              : row.kind,
      );

    expect(shape(rows(true))).toEqual(["user:prompt", "fold", "work:question", "assistant:answer"]);
    expect(shape(rows(true, new Set([runId])))).toEqual([
      "user:prompt",
      "fold",
      "work-toggle",
      "work:question",
      "work-toggle",
      "assistant:answer",
    ]);
    expect(shape(rows(false))).toEqual([
      "user:prompt",
      "working",
      "work-toggle",
      "work:question",
      "work-live:after + running",
      "work:running",
    ]);
  });

  it("does not treat runless entries as live work on a thread with runs", () => {
    const rows = deriveProcessRows({
      timelineEntries: [
        {
          id: "runless-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "runless-command",
            createdAt: "2026-01-01T00:00:05Z",
            runId: null,
            label: "Running git",
            command: "git status",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.some((row) => row.kind === "work-live")).toBe(false);
    expect(rows.at(-1)?.kind).toBe("working");
  });

  it("ends the previous process group when commentary starts even if a tool is still running", () => {
    const rows = deriveProcessRows({
      timelineEntries: [
        {
          id: "first-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "first-running",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Running first command",
            command: "rg first",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:06Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "Starting another command.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:06Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "second-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "second-running",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Running second command",
            command: "rg second",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.map((row) => row.kind)).toEqual([
      "working",
      "work-toggle",
      "message",
      "work-live",
      "work",
    ]);
    expect(rows.filter((row) => row.kind === "work-live").map((row) => row.entry.id)).toEqual([
      "second-running",
    ]);
  });

  it.each([
    ["inProgress", true],
    ["completed", false],
    ["failed", null],
  ] as const)(
    "respects the %s lifecycle of trailing task progress",
    (toolLifecycleStatus, active) => {
      const runId = RunId.make("turn-task-progress");
      const rows = deriveProcessRows({
        timelineEntries: [
          {
            id: "task-progress-entry",
            kind: "work",
            createdAt: "2026-01-01T00:00:05Z",
            entry: {
              id: "task-progress",
              createdAt: "2026-01-01T00:00:05Z",
              runId,
              label: "Task progress",
              tone: "thinking",
              sourceActivityKind: "task.progress",
              ...(toolLifecycleStatus ? { toolLifecycleStatus } : {}),
            },
          },
        ],
        latestRun: {
          runId,
          status: "running",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: null,
        },
        isWorking: true,
        activeTurnStartedAt: "2026-01-01T00:00:00Z",
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

      const workLiveRow = rows.find((row) => row.kind === "work-live");
      expect(workLiveRow).toMatchObject({ active: active ?? false });
      expect(rows.some((row) => row.kind === "thinking")).toBe(false);
    },
  );

  it("keeps one group header for actual tool states without a thinking placeholder", () => {
    const deriveRows = (
      toolLifecycleStatus: "inProgress" | "completed" | "failed" | "declined" | null,
      expandedWorkGroupIds?: ReadonlySet<string>,
    ) =>
      deriveProcessRows({
        ...(expandedWorkGroupIds ? { expandedWorkGroupIds } : {}),
        timelineEntries:
          toolLifecycleStatus === null
            ? []
            : [
                {
                  id: "latest-command-entry",
                  kind: "work",
                  createdAt: "2026-01-01T00:00:05Z",
                  entry: {
                    id: "latest-command",
                    createdAt: "2026-01-01T00:00:05Z",
                    runId: "turn-1" as never,
                    label: toolLifecycleStatus === "inProgress" ? "Running rg" : "Ran rg",
                    command: "rg toolCall",
                    requestKind: "command",
                    tone: "tool" as const,
                    toolLifecycleStatus,
                    ...(toolLifecycleStatus === "inProgress" ? { detail: "exit code 1" } : {}),
                  },
                },
              ],
        latestRun: {
          runId: "turn-1" as never,
          status: "running",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: null,
        },
        isWorking: true,
        activeTurnStartedAt: "2026-01-01T00:00:00Z",
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

    const initialRows = deriveRows(null);
    const runningRows = deriveRows("inProgress");
    const completedRows = deriveRows("completed");
    const failedRows = deriveRows("failed");
    const declinedRows = deriveRows("declined");
    const initialActivityRow = initialRows.find((row) => row.id === "live-activity-row");
    const runningActivityRow = runningRows.find((row) => row.id === "live-activity-row");
    const completedActivityRow = completedRows.find((row) => row.id === "live-activity-row");

    expect(initialActivityRow).toBeUndefined();
    expect(runningActivityRow).toMatchObject({ kind: "work-live", active: true });
    expect(completedActivityRow).toMatchObject({ kind: "work-live", active: false });
    expect(runningRows.filter((row) => row.kind === "work")).toHaveLength(1);
    expect(completedRows.filter((row) => row.kind === "work")).toHaveLength(1);
    const failedActivity = failedRows.find((row) => row.kind === "work-live");
    expect(failedActivity).toMatchObject({ active: false });
    const failedGroupId = failedActivity?.groupId;
    expect(failedGroupId).toBeDefined();
    expect(deriveRows("failed", new Set([failedGroupId!])).slice(-2)).toMatchObject([
      { kind: "work-live", id: "live-activity-row", expanded: true, active: false },
      { kind: "work", isExpandedToolGroup: true, groupedEntries: [{ id: "latest-command" }] },
    ]);
    expect(initialRows.some((row) => row.kind === "thinking")).toBe(false);
    for (const rows of [runningRows, completedRows, failedRows, declinedRows]) {
      expect(rows.some((row) => row.kind === "thinking")).toBe(false);
      expect(rows.filter((row) => row.id === "live-activity-row")).toHaveLength(1);
    }
  });
});

describe("v2 run and attempt history", () => {
  it("folds settled-turn commentary and work behind a Worked-for row", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-thought-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-thought" as never,
          role: "assistant" as const,
          text: "Looking around first.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          runId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "provider-recovered-entry",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:09Z",
        entry: {
          id: "provider-recovered",
          createdAt: "2026-01-01T00:00:09Z",
          runId: "turn-1" as never,
          label: "Provider recovered (2/5 retries)",
          tone: "info" as const,
          itemType: "error" as const,
          toolLifecycleStatus: "completed" as const,
        },
      },
      {
        id: "thread-created-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:10Z",
        projectedItem: {
          item: {
            type: "thread_created",
          },
        } as never,
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveProcessRows({
      timelineEntries,
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);
    expect(foldRow?.label).toBe("Worked for 22s");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "thread-created-entry",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveProcessRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-thought-entry",
      "work-toggle:work-entry-1",
      "thread-created-entry",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
    const openedActivity = deriveProcessRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      expandedWorkGroupIds: new Set(["work-group:work-entry-1"]),
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(
      openedActivity.flatMap((row) => (row.kind === "work" ? row.groupedEntries : [])),
    ).toEqual([
      expect.objectContaining({ id: "work-1" }),
      expect.objectContaining({ id: "provider-recovered" }),
    ]);
  });

  it("hides tool calls or everything but the final answer", () => {
    const runId = RunId.make("turn-1");
    const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
    const message = (
      id: string,
      role: "user" | "assistant",
      second: number,
      inputIntent?: "steer",
    ): TimelineEntry => ({
      id,
      kind: "message",
      createdAt: at(second),
      message: {
        id: MessageId.make(id),
        role,
        text: id,
        runId: role === "user" ? null : runId,
        createdAt: at(second),
        updatedAt: at(second),
        streaming: false,
        ...(inputIntent ? { inputIntent } : {}),
      },
    });
    const command = (
      id: string,
      status: "completed" | "failed",
      second: number,
    ): TimelineEntry => ({
      id,
      kind: "work",
      createdAt: at(second),
      entry: {
        id,
        createdAt: at(second),
        runId,
        label: "Ran command",
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: status,
      },
    });
    const [user, step, passed, failed, final] = [
      message("user", "user", 0),
      message("step", "assistant", 5),
      command("passed", "completed", 8),
      command("failed", "failed", 9),
      message("final", "assistant", 20),
    ];
    const running = { runId, status: "running" as const, startedAt: at(0), completedAt: null };
    const ended = { ...running, turnEnded: true };
    const rows = (
      timelineEntries: ReadonlyArray<TimelineEntry>,
      toolCallVisibility: "hideSuccessful" | "hideAll" | "zen",
      latestRun?: typeof ended | typeof running,
    ) =>
      deriveProcessRows({
        timelineEntries,
        expandedRunIds: new Set([runId]),
        isWorking: latestRun !== undefined,
        ...(latestRun ? { latestRun } : {}),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        toolCallVisibility,
      }).map((row) => row.id);

    const turn = [user, step, passed, failed, final];
    expect(rows(turn, "hideSuccessful")).toEqual([
      "user",
      "turn-fold:turn-1",
      "step",
      "work-toggle:failed",
      "final",
    ]);
    expect(rows([user, failed, final], "hideAll")).toEqual(["user", "final"]);
    expect(rows(turn, "zen")).toEqual(["user", "final"]);
    const [steer, answer] = [
      message("steer", "user", 4, "steer"),
      message("answer", "assistant", 7),
    ];
    expect(rows([user, steer, answer, final], "zen")).toEqual(["user", "steer", "answer", "final"]);
    expect(rows([user, steer, step, passed, final], "zen")).toEqual(["user", "steer", "final"]);
    expect(rows([user, steer, answer, step], "zen", running)).toEqual([
      "user",
      "working-indicator-row",
      "steer",
      "answer",
      "live-activity-row",
    ]);
    expect(rows([user, step, passed], "zen", running)).toEqual([
      "user",
      "working-indicator-row",
      "live-activity-row",
    ]);
    expect(processAnswerPreview([user, step, passed])).toBe("step");
    expect(rows(turn, "zen", ended)).toEqual(["user", "final"]);
    const followUp = message("follow-up", "user", 30);
    expect(rows([...turn, followUp], "zen", ended)).toEqual([
      "user",
      "final",
      "follow-up",
      "working-indicator-row",
    ]);
    const wake: TimelineEntry = {
      id: "wake",
      kind: "work",
      createdAt: at(30),
      entry: {
        id: "wake",
        createdAt: at(30),
        runId: RunId.make("wake"),
        label: "Task finished",
        tone: "info",
        itemType: "notification",
      },
    };
    expect(rows([user, final, wake], "zen", { ...running, runId: RunId.make("wake") })).toEqual([
      "user",
      "final",
      "wake",
      "working-indicator-row",
      "live-activity-row",
    ]);
  });

  it("collapses only output from a superseded V2 attempt within the active logical run", () => {
    const runId = "run-steered" as never;
    const supersededAttemptId = "attempt-1" as never;
    const activeAttemptId = "attempt-2" as never;
    const supersededAttempt = {
      id: supersededAttemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId: "node-attempt-1" as never,
      status: "superseded" as const,
      completedAt: null,
    };
    const activeAttempt = {
      id: activeAttemptId,
      runId,
      attemptOrdinal: 2,
      rootNodeId: "node-attempt-2" as never,
      status: "running" as const,
      completedAt: null,
    };
    const timelineEntries = [
      {
        id: "context-handoff-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:00Z",
        attempt: supersededAttempt,
        projectedItem: {
          item: { type: "handoff", runId },
        } as never,
      },
      {
        id: "initial-user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        attempt: supersededAttempt,
        message: {
          id: "initial-user" as never,
          role: "user" as const,
          text: "Build it",
          runId,
          inputIntent: "turn_start" as const,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "superseded-assistant-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:02Z",
        attempt: supersededAttempt,
        message: {
          id: "superseded-assistant" as never,
          role: "assistant" as const,
          text: "Partial old response",
          runId,
          createdAt: "2026-01-01T00:00:02Z",
          updatedAt: "2026-01-01T00:00:03Z",
          streaming: false,
        },
      },
      {
        id: "superseded-work-entry",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:04Z",
        attempt: supersededAttempt,
        entry: {
          id: "superseded-work",
          createdAt: "2026-01-01T00:00:04Z",
          runId,
          label: "Old command",
          tone: "tool" as const,
          projectedItem: {
            sourceItemId: "old-work-anchor",
            item: {
              type: "command_execution",
              deferredWork: { cursor: "old-work", itemCount: 200, lastOrdinal: 200 },
            },
          } as never,
        },
      },
      {
        id: "superseded-thread-created-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:04.500Z",
        attempt: supersededAttempt,
        projectedItem: {
          item: {
            type: "thread_created",
          },
        } as never,
      },
      {
        id: "steer-user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        attempt: activeAttempt,
        message: {
          id: "steer-user" as never,
          role: "user" as const,
          text: "Change direction",
          runId,
          inputIntent: "steer" as const,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:05Z",
          streaming: false,
        },
      },
      {
        id: "active-assistant-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:06Z",
        attempt: activeAttempt,
        message: {
          id: "active-assistant" as never,
          role: "assistant" as const,
          text: "Current response",
          runId,
          createdAt: "2026-01-01T00:00:06Z",
          updatedAt: "2026-01-01T00:00:07Z",
          streaming: true,
        },
      },
    ];
    const common = {
      timelineEntries,
      latestRun: {
        runId,
        status: "running" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };

    const collapsedRows = deriveProcessRows(common);
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "context-handoff-entry",
      "initial-user-entry",
      `attempt-fold:${supersededAttemptId}`,
      "superseded-thread-created-entry",
      "steer-user-entry",
      "active-assistant-entry",
    ]);
    expect(collapsedRows.find((row) => row.kind === "attempt-fold")).toMatchObject({
      attemptId: supersededAttemptId,
      runId,
      label: "Superseded attempt",
      expanded: false,
      deferredWorkItemIds: ["old-work-anchor"],
    });

    const expandedRows = deriveProcessRows({
      ...common,
      expandedAttemptIds: new Set([supersededAttemptId]),
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "context-handoff-entry",
      "initial-user-entry",
      `attempt-fold:${supersededAttemptId}`,
      "superseded-assistant-entry",
      "work-toggle:superseded-work-entry",
      "superseded-thread-created-entry",
      "steer-user-entry",
      "active-assistant-entry",
    ]);
    const settledRows = deriveProcessRows({
      ...common,
      latestRun: { ...common.latestRun, status: "completed", completedAt: "2026-01-01T00:00:08Z" },
      timelineEntries: timelineEntries.map((entry) =>
        entry.kind === "message" && entry.id === "active-assistant-entry"
          ? { ...entry, message: { ...entry.message, streaming: false } }
          : entry,
      ),
      expandedRunIds: new Set([runId]),
    });
    expect(settledRows.find((row) => row.kind === "attempt-fold")).toMatchObject({
      deferredWorkItemIds: ["old-work-anchor"],
    });
    expect(
      settledRows
        .filter((row) => row.kind === "turn-fold")
        .flatMap((row) => row.deferredWorkItemIds ?? []),
    ).not.toContain("old-work-anchor");
    const deferredTailRows = deriveProcessRows({
      ...common,
      timelineEntries: [
        timelineEntries[0]!,
        timelineEntries[2]!,
        timelineEntries[1]!,
        ...timelineEntries.slice(3),
      ].map((entry) => ({
        ...entry,
        attempt:
          entry.attempt.id === supersededAttemptId
            ? { ...entry.attempt, completedAt: DateTime.makeUnsafe("2026-01-01T00:00:08Z") }
            : entry.attempt,
        ...(entry.id === "superseded-assistant-entry"
          ? {
              projectedItem: {
                item: {
                  type: "assistant_message",
                  ordinal: 2,
                  status: "completed",
                  completedAt: DateTime.makeUnsafe("2026-01-01T00:00:03Z"),
                },
              } as never,
            }
          : {}),
      })),
    });
    expect(deferredTailRows.some((row) => row.kind === "attempt-fold")).toBe(true);
  });

  it("hides the interruption request while keeping intervening work and the result", () => {
    const runId = "turn-1" as never;
    const interruptEvent = (type: "run_interrupt_request" | "run_interrupt_result") => ({
      position: type === "run_interrupt_request" ? 0 : 2,
      visibility: "local" as const,
      sourceThreadId: "thread-1" as never,
      sourceItemId: `item-${type}` as never,
      item: {
        id: `item-${type}`,
        threadId: "thread-1",
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: type === "run_interrupt_request" ? 0 : 2,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: {},
        type,
        message: type === "run_interrupt_request" ? "Stopping" : "Stopped",
      },
    });
    const rows = deriveProcessRows({
      timelineEntries: [
        {
          id: "interrupt-request",
          kind: "event",
          createdAt: "2026-01-01T00:00:01Z",
          projectedItem: interruptEvent("run_interrupt_request") as never,
        },
        {
          id: "work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:02Z",
            runId,
            label: "Finishing tool output",
            tone: "tool",
          },
        },
        {
          id: "interrupt-result",
          kind: "event",
          createdAt: "2026-01-01T00:00:03Z",
          projectedItem: interruptEvent("run_interrupt_result") as never,
        },
      ],
      latestRun: {
        runId,
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:03Z",
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.map((row) => row.id)).toEqual(["work-toggle:work-entry", "interrupt-result"]);
    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);

    const stoppedRows = deriveProcessRows({
      timelineEntries: [
        {
          id: "stopped-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "stopped-command",
            createdAt: "2026-01-01T00:00:01Z",
            runId,
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            command: "/bin/bash -lc 'sleep 90 && echo slept'",
            toolLifecycleStatus: "stopped",
          },
        },
        {
          id: "interrupt-result",
          kind: "event",
          createdAt: "2026-01-01T00:00:03Z",
          projectedItem: interruptEvent("run_interrupt_result") as never,
        },
      ],
      latestRun: {
        runId,
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:03Z",
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      expandedWorkGroupIds: new Set(["work-group:stopped-command-entry"]),
    });
    expect(stoppedRows.map((row) => row.id)).toEqual([
      "work-toggle:stopped-command-entry",
      "work-group:stopped-command-entry:entry:stopped-command",
      "interrupt-result",
    ]);
    expect(stoppedRows.find((row) => row.kind === "work")).toMatchObject({
      groupedEntries: [{ id: "stopped-command", toolLifecycleStatus: "stopped" }],
    });
  });
});

describe("streaming v2 row projection", () => {
  function fixture(text = "") {
    const source = makeStreamingTimelineFixture(text);
    const timelineInput = { visibleTurnItems: source.visibleTurnItems, optimisticMessages: [] };
    const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput);
    const input = {
      timelineEntries: timeline.entries,
      latestRun: {
        runId: source.runId,
        status: "running" as const,
        startedAt: source.time(5),
        completedAt: null,
      },
      runningRunId: source.runId,
      isWorking: true,
      activeTurnStartedAt: source.time(5),
      turnDiffSummaries: [
        {
          runId: source.historyRunId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/history"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("history-assistant"),
          completedAt: source.time(4),
        },
      ] satisfies ReadonlyArray<TurnDiffSummary>,
      supportsConversationRollback: true,
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];
    return { ...source, timelineInput, timeline, input };
  }

  function updateText(items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>, text: string) {
    return items.map((row) =>
      row.item.type === "assistant_message" && row.item.streaming
        ? {
            ...row,
            item: { ...row.item, text, updatedAt: DateTime.makeUnsafe("2026-09-04T00:00:08.000Z") },
          }
        : row,
    );
  }

  it.each([
    ["", "Now visible"],
    [" \n", "Now visible"],
    ["Visible", ""],
    ["", " \t\n"],
    ["Visible", "★ Insight\nKeep these line breaks"],
  ])("keeps row parity and history identity from %j to %j", (before, after) => {
    const initial = fixture(before);
    const previous = deriveMessagesTimelineRowsWithState(
      withProcessRows({
        ...initial.input,
        sourceTimelineEntries: initial.timeline.entries,
        presentingRunIds: new Set([initial.runId]),
        availableRevertTurnCounts: new Set([0]),
        pendingApprovalRequestIds: new Set<RuntimeRequestId>(),
      }),
    );
    Object.freeze(previous.rows);
    for (const row of previous.rows) Object.freeze(row);
    const timelineInput = {
      ...initial.timelineInput,
      visibleTurnItems: updateText(initial.visibleTurnItems, after),
    };
    const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      timelineInput,
      initial.timeline,
    );
    const input = withProcessRows({
      ...initial.input,
      timelineEntries: timeline.entries,
      sourceTimelineEntries: timeline.entries,
      presentingRunIds: new Set([initial.runId]),
      latestRun: { ...initial.input.latestRun },
      turnDiffSummaries: initial.input.turnDiffSummaries.map((summary) => ({ ...summary })),
      availableRevertTurnCounts: new Set([0]),
      pendingApprovalRequestIds: new Set<RuntimeRequestId>(),
    });
    const next = deriveMessagesTimelineRowsWithState(input, previous);
    expect(next.rows).toEqual(
      deriveProcessRows({
        ...input,
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems(timelineInput),
      }),
    );
    for (const [index, row] of previous.rows.entries()) {
      if (
        (row.kind === "message" || row.kind === "assistant-meta") &&
        row.message.id === "live-assistant"
      ) {
        expect(next.rows[index]).toMatchObject({ message: { text: after } });
        expect(next.rows[index]).toHaveProperty(
          "projectedItem",
          timelineInput.visibleTurnItems.at(-1),
        );
        expect(row.message.text).toBe(before);
      } else {
        expect(next.rows[index]).toBe(row);
      }
    }
  });
});

describe("linked timeline resources", () => {
  const runId = RunId.make("resource-run");
  const event = (id: string, type: "subagent" | "thread_created", eventRunId = runId) => ({
    id,
    kind: "event" as const,
    createdAt: "2026-09-08T10:00:02Z",
    projectedItem: { item: { id, type, runId: eventRunId } } as OrchestrationV2ProjectedTurnItem,
  });
  const common = { isWorking: false, turnDiffSummaries: [], supportsConversationRollback: false };

  it.each([
    { status: "completed", envelope: "direct", role: "general" },
    { status: "completed", envelope: "structured", role: "general" },
    { status: "completed", envelope: "text", role: "general" },
    { status: "completed", envelope: "structured", role: "research" },
    { status: "running", envelope: "direct", role: "general" },
    { status: "running", envelope: "direct", role: "research" },
  ] as const)(
    "matches $status $role delegation calls by child identity with $envelope output",
    ({ status, envelope, role }) => {
      const child = (id: string) => {
        const entry = event(id, "subagent");
        return {
          ...entry,
          projectedItem: {
            item: {
              ...entry.projectedItem.item,
              origin: "app_owned",
              subagentId: id,
              prompt:
                role === "general" ? id : `Act as the ${role} sub-agent for this task.\n\n${id}`,
              childThreadId: null,
            },
          } as OrchestrationV2ProjectedTurnItem,
        };
      };
      const delegation = (id: string, taskId: string, failed = false): TimelineEntry => ({
        id,
        kind: "work",
        createdAt: "2026-09-08T10:00:02Z",
        entry: {
          id,
          runId,
          createdAt: "2026-09-08T10:00:02Z",
          label: "Delegated a child task",
          tone: failed ? "error" : "tool",
          itemType: "dynamic_tool",
          toolLifecycleStatus: failed
            ? "failed"
            : status === "running"
              ? "inProgress"
              : "completed",
          projectedItem: {
            item: {
              id,
              runId,
              type: "dynamic_tool",
              status: failed ? "failed" : status,
              toolName: "t3-code.delegate_task",
              input: { task: taskId === "b" ? "a" : taskId, role },
              ...(status === "completed"
                ? {
                    output:
                      envelope === "structured"
                        ? { content: JSON.stringify({ taskId }), structuredContent: { taskId } }
                        : envelope === "text"
                          ? { content: [{ type: "text", text: JSON.stringify({ taskId }) }] }
                          : { taskId },
                  }
                : {}),
            },
          } as OrchestrationV2ProjectedTurnItem,
        },
      });
      const rows = deriveProcessRows({
        ...common,
        isWorking: status === "running",
        runningRunId: status === "running" ? runId : null,
        timelineEntries: [
          child("a"),
          delegation("delegate-a", "a"),
          ...(status === "completed" ? [child("b")] : []),
          delegation("delegate-b", "b"),
          delegation("unmatched", "other-child"),
          child("c"),
          delegation("failed", "c", true),
          child("d"),
        ],
        expandedRunIds: new Set([runId]),
        expandedWorkGroupIds: new Set(["work-group:unmatched", "work-group:delegate-a"]),
      });
      if (status === "completed") {
        expect(rows.find((row) => row.id === "a")).toMatchObject({
          subagents: [{ item: { id: "a" } }, { item: { id: "b" } }],
        });
        expect(rows.some((row) => row.id === "b")).toBe(false);
      } else {
        expect(rows.find((row) => row.id === "a")).toBeDefined();
        expect(rows.find((row) => row.id === "b")).toBeUndefined();
      }
      expect(rows.find((row) => row.id === "c")).toBeDefined();
      expect(rows.find((row) => row.id === "d")).toBeDefined();
      const visibleTools = rows.flatMap((row) =>
        row.kind === "work" || row.kind === "work-live"
          ? row.groupedEntries.map((entry) => entry.id)
          : [],
      );
      expect(visibleTools).toContain("unmatched");
      expect(visibleTools).toContain("failed");
      expect(visibleTools.includes("delegate-a")).toBe(status === "running");
      expect(visibleTools.includes("delegate-b")).toBe(status === "running");
    },
  );
});

it("keeps the working header in place across worktree setup handoff", () => {
  const snapshot: WorktreeSetupSnapshot = {
    threadId: ThreadId.make("thread-setup"),
    phase: "running",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: null,
    branch: "feature",
    baseRef: "main",
    worktreePath: null,
    setupScript: null,
    stages: [],
    error: null,
    sequence: 3,
  };
  const userEntry = {
    id: "user-entry",
    kind: "message",
    createdAt: "2026-01-01T00:00:00Z",
    message: {
      id: "user-1" as never,
      role: "user",
      text: "Build it",
      runId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    },
  } as const;
  const assistantEntry = {
    id: "assistant-entry",
    kind: "message",
    createdAt: "2026-01-01T00:00:30Z",
    message: {
      id: "assistant-1" as never,
      role: "assistant",
      text: "On it",
      runId: "turn-1" as never,
      createdAt: "2026-01-01T00:00:30Z",
      updatedAt: "2026-01-01T00:00:30Z",
      streaming: true,
    },
  } as const;
  const withoutMessages = deriveProcessRows({
    timelineEntries: [],
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: snapshot,
  });
  expect(withoutMessages).toEqual([
    { kind: "working", id: "working-indicator-row", createdAt: snapshot.startedAt },
    {
      kind: "worktree-setup",
      id: "worktree-setup-row",
      createdAt: "2026-01-01T00:00:00Z",
      snapshot,
      embedded: false,
    },
  ]);

  const withMessages = deriveProcessRows({
    timelineEntries: [userEntry, assistantEntry],
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: { ...snapshot, phase: "failed" },
  });
  expect(withMessages.map((row) => row.kind)).toEqual([
    "message",
    "worktree-setup",
    "working",
    "message",
  ]);

  const stage = (id: "agent" | "setup-script", status: "done" | "running") =>
    ({
      id,
      status,
      startedAt: "2026-01-01T00:00:10Z",
      endedAt: status === "done" ? "2026-01-01T00:00:11Z" : null,
      percent: null,
      detail: null,
      tail: [],
    }) as const;
  const asyncSnapshot: WorktreeSetupSnapshot = {
    ...snapshot,
    stages: [stage("setup-script", "running"), stage("agent", "done")],
  };
  const liveTurn = {
    runId: "turn-1" as never,
    status: "running",
    startedAt: "2026-01-01T00:00:11Z",
    completedAt: null,
  } as const;
  const asyncRows = deriveProcessRows({
    timelineEntries: [userEntry],
    latestRun: liveTurn,
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: asyncSnapshot,
  });
  expect(asyncRows.map((row) => row.kind)).toEqual(["message", "working"]);

  const handoffRows = deriveProcessRows({
    timelineEntries: [userEntry],
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: asyncSnapshot,
  });
  expect(handoffRows.map((row) => row.kind)).toEqual(["message", "working", "worktree-setup"]);
  expect(handoffRows[2]).toMatchObject({ kind: "worktree-setup", embedded: false });

  const settledRows = deriveProcessRows({
    timelineEntries: [userEntry],
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: {
      ...snapshot,
      phase: "done",
      stages: [stage("setup-script", "done"), stage("agent", "done")],
    },
  });
  expect(settledRows.map((row) => row.kind)).toEqual(["message", "working", "worktree-setup"]);

  const finishedRows = deriveProcessRows({
    timelineEntries: [userEntry],
    latestRun: liveTurn,
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: {
      ...asyncSnapshot,
      stages: [stage("setup-script", "done"), stage("agent", "done")],
    },
  });
  expect(finishedRows.map((row) => row.kind)).toEqual(["message", "working"]);
});

describe("failed turn transcript", () => {
  it.each([
    { position: "historical", failureClass: "provider_error" },
    { position: "historical", failureClass: "usage_limit" },
    { position: "latest", failureClass: "usage_limit" },
  ] as const)(
    "keeps $position $failureClass failures visible with preceding work grouped appropriately",
    ({ position, failureClass }) => {
      const isLatest = position === "latest";
      const commands = isLatest ? ["pwd", "ls", "false"] : ["pwd"];
      const runId = RunId.make("failed-run");
      const threadId = ThreadId.make("failed-thread");
      const at = DateTime.makeUnsafe("2026-09-20T12:00:00Z");
      const base = {
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
      };
      const items: OrchestrationV2ProjectedTurnItem[] = [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("user"),
          item: {
            ...base,
            id: TurnItemId.make("user"),
            type: "user_message",
            status: "completed",
            messageId: MessageId.make("user"),
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            text: "Build it",
            attachments: [],
          },
        },
        ...commands.map((input, index): OrchestrationV2ProjectedTurnItem => ({
          position: index + 1,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make(index === 0 ? "command" : `command-${index}`),
          item: {
            ...base,
            id: TurnItemId.make(index === 0 ? "command" : `command-${index}`),
            ordinal: index + 1,
            type: "command_execution",
            status: "completed",
            input,
            output: "",
            exitCode: 0,
          },
        })),
        {
          position: commands.length + 1,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("failure"),
          item: {
            ...base,
            id: TurnItemId.make("failure"),
            type: "error",
            status: "failed",
            failure: {
              class: failureClass,
              message: "The provider stopped this turn.\nRetry later.",
              code: null,
              retryable: true,
            },
          },
        },
      ];
      const rows = deriveProcessRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: items,
          optimisticMessages: [],
        }).map((entry) =>
          isLatest
            ? entry
            : {
                ...entry,
                attempt: {
                  id: RunAttemptId.make("superseded-attempt"),
                  runId,
                  attemptOrdinal: 1,
                  rootNodeId: NodeId.make("superseded-root"),
                  status: "superseded" as const,
                  completedAt: null,
                },
              },
        ),
        latestRun: {
          runId: isLatest ? runId : RunId.make("newer-run"),
          status: isLatest ? "failed" : "completed",
          startedAt: DateTime.formatIso(at),
          completedAt: DateTime.formatIso(at),
        },
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      expect(rows.some((row) => row.kind === "turn-fold" || row.kind === "attempt-fold")).toBe(
        false,
      );
      const work = rows.flatMap((row) => (row.kind === "work" ? row.groupedEntries : []));
      expect(rows.find((row) => row.kind === "work-toggle")).toEqual(
        failureClass === "provider_error" && !isLatest
          ? undefined
          : expect.objectContaining({ hiddenCount: isLatest ? 3 : 1, expanded: false }),
      );
      expect(work.map((entry) => entry.id)).toEqual(
        failureClass === "provider_error" && !isLatest ? ["command", "failure"] : ["failure"],
      );
      expect(work.at(-1)?.detail).toBe("The provider stopped this turn.\nRetry later.");
      expect(work.at(-1)?.createdAt).toBe("2026-09-20T12:00:00.000Z");
      if (isLatest) return;
      const entriesWithoutTools = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: items.filter((row) => row.item.type !== "command_execution"),
        optimisticMessages: [],
      });
      entriesWithoutTools.splice(1, 0, {
        kind: "message",
        id: "assistant-before-failure",
        createdAt: DateTime.formatIso(at),
        message: {
          id: MessageId.make("assistant-before-failure"),
          role: "assistant",
          runId,
          text: "Checking the workspace.",
          createdAt: DateTime.formatIso(at),
          updatedAt: DateTime.formatIso(at),
          streaming: false,
        },
      });
      const compactRows = deriveProcessRows({
        timelineEntries: entriesWithoutTools,
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      expect(compactRows.map((row) => row.kind)).toEqual(["message", "message", "work"]);
      expect(compactRows[1]).toMatchObject({
        kind: "message",
        showAssistantMeta: true,
        showAssistantCopyButton: true,
        message: { id: "assistant-before-failure" },
      });
    },
  );
});

describe("long active tool groups", () => {
  it.each([false, true])(
    "preserves chronological order and the latest activity, expanded=%s",
    (expanded) => {
      const runId = RunId.make("long-active-run");
      const createdAt = "2026-10-12T00:00:00Z";
      const timelineEntries = Array.from({ length: 1_000 }, (_, index) => ({
        id: `work-entry-${index}`,
        kind: "work" as const,
        createdAt,
        entry: {
          id: `work-${index}`,
          createdAt,
          runId,
          label: `Tool ${index}`,
          tone: index % 2 === 0 ? ("thinking" as const) : ("tool" as const),
          itemType: index % 2 === 0 ? ("reasoning" as const) : ("command_execution" as const),
          ...(index % 2 === 0 ? { detail: `Thought ${index}` } : {}),
          toolLifecycleStatus: index === 999 ? ("inProgress" as const) : ("completed" as const),
        },
      }));
      const rows = deriveProcessRows({
        timelineEntries,
        isWorking: true,
        runningRunId: runId,
        activeTurnStartedAt: createdAt,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        expandedWorkGroupIds: new Set(expanded ? ["work-group:work-entry-0"] : []),
      });
      const live = rows.find((row) => row.kind === "work-live");
      expect(live).toBeDefined();
      expect(live?.entry.id).toBe("work-999");
      expect(live && processActivityLabel(live.entry)).toBe("Running command");
      expect(live?.groupedEntries.map(({ id }) => id)).toEqual(
        timelineEntries.map(({ entry }) => entry.id),
      );
      expect(live?.groupId).toBe("work-group:work-entry-0");
      const details = rows.filter((row) => row.kind === "work");
      expect(details).toHaveLength(expanded ? timelineEntries.length : 1);
      expect(details.flatMap((row) => row.groupedEntries.map(({ id }) => id))).toEqual(
        expanded ? timelineEntries.map(({ entry }) => entry.id) : ["work-999"],
      );
      expect(details.every((row) => row.groupedEntries.length === 1)).toBe(true);
    },
  );
});

describe("HTML renders in the timeline", () => {
  const runId = RunId.make("render-run");
  const at = (second: number) =>
    DateTime.makeUnsafe(`2026-09-04T12:00:${String(second).padStart(2, "0")}.000Z`);
  const base = (id: string, second: number) => ({
    id: TurnItemId.make(id),
    threadId: ThreadId.make("render-thread"),
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
    status: "completed" as const,
    title: null,
    startedAt: at(second),
    completedAt: at(second),
    updatedAt: at(second),
  });
  const visible = (item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem => ({
    position: item.ordinal,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  });
  const htmlRender = { attachmentId: "render-thread-chart.html", title: "Chart", height: 420 };
  const renderCall = (
    status: OrchestrationV2TurnItem["status"],
    output?: unknown,
  ): OrchestrationV2TurnItem => ({
    ...base("render", 2),
    status,
    type: "dynamic_tool",
    toolName: "mcp__t3-code__html_render",
    input: { title: "Chart", height: 420 },
    ...(output === undefined ? {} : { output }),
  });
  const command = (id: string, second: number): OrchestrationV2TurnItem => ({
    ...base(id, second),
    type: "command_execution",
    input: "vp test run",
  });
  const turn = (render: OrchestrationV2TurnItem) => {
    const items: OrchestrationV2TurnItem[] = [
      {
        ...base("prompt", 0),
        type: "user_message",
        messageId: MessageId.make("prompt"),
        inputIntent: "turn_start",
        text: "Chart it",
        createdBy: "user",
        creationSource: "server",
        attachments: [],
      },
      command("before", 1),
      render,
      command("after", 3),
      {
        ...base("reply", 4),
        type: "assistant_message",
        messageId: MessageId.make("reply"),
        text: "Here it is.",
        streaming: false,
      },
    ];
    return deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: items.map(visible),
      optimisticMessages: [],
    });
  };
  const rowsFor = (entries: TimelineEntry[], expanded: boolean) =>
    deriveProcessRows({
      timelineEntries: entries,
      latestRun: {
        runId,
        status: "completed",
        startedAt: DateTime.formatIso(at(0)),
        completedAt: DateTime.formatIso(at(5)),
      },
      ...(expanded ? { expandedRunIds: new Set([runId]) } : {}),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    }).map((row) => row.kind);

  it("shows a completed render in place, above the reply, through the turn fold", () => {
    const entries = turn(
      renderCall("completed", { structuredContent: { htmlRender }, content: [] }),
    );
    expect(entries.find((entry) => entry.kind === "html-render")).toMatchObject({
      id: "render",
      runId,
      htmlRender,
    });
    expect(rowsFor(entries, false)).toEqual(["message", "turn-fold", "html-render", "message"]);
    expect(rowsFor(entries, true)).toEqual([
      "message",
      "turn-fold",
      "work-toggle",
      "html-render",
      "work-toggle",
      "message",
    ]);
  });
});

describe("process group details", () => {
  it("keeps a group's viewed images below it and opens each entry's image among them", () => {
    type WorkEntry = Extract<
      MessagesTimelineRowsInput["timelineEntries"][number],
      { kind: "work" }
    >;
    const read = (name: string, second: number): WorkEntry => {
      const at = `2026-01-01T00:00:0${second}Z`;
      return {
        id: `read-${name}-entry`,
        kind: "work",
        createdAt: at,
        entry: {
          id: `read-${name}`,
          createdAt: at,
          runId: "turn-1" as never,
          label: `Read ${name}`,
          itemType: "dynamic_tool",
          tone: "tool",
          toolLifecycleStatus: "completed",
          viewedImagePath: `/repo/${name}`,
        },
      };
    };
    const input = (expandedWorkGroupIds?: ReadonlySet<string>): MessagesTimelineRowsInput => ({
      timelineEntries: [read("first.png", 1), read("second.png", 2)],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      ...(expandedWorkGroupIds ? { expandedWorkGroupIds } : {}),
    });
    const paths = ["/repo/first.png", "/repo/second.png"];
    const images = paths.map((path) => ({ path, pending: false }));
    const collapsed = deriveProcessRows(input());
    const live = collapsed.find((row) => row.kind === "work-live");
    if (live?.kind !== "work-live") throw new Error("Expected the live group");
    expect(collapsed.find((row) => row.kind === "viewed-images")).toMatchObject({ images });

    const expanded = deriveProcessRows(input(new Set([live.groupId])));
    expect(
      expanded.flatMap((row) => (row.kind === "work" ? [row.groupViewedImagePaths] : [])),
    ).toEqual([paths, paths]);
    expect(expanded.at(-1)).toMatchObject({ kind: "viewed-images", images });
  });

  it("names the running children on the run's subagent row while the run waits on them", () => {
    const runId = RunId.make("parent-run");
    const threadId = ThreadId.make("parent-thread");
    const at = (second: number) =>
      DateTime.makeUnsafe(`2026-10-06T10:00:${String(second).padStart(2, "0")}Z`);
    const base = (id: string, second: number) => ({
      id: TurnItemId.make(id),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: ProviderTurnId.make("parent-provider-turn"),
      nativeItemRef: null,
      parentItemId: null,
      ordinal: second,
      title: null,
      startedAt: at(second),
      completedAt: at(second),
      updatedAt: at(second),
    });
    const child = (id: string, second: number): OrchestrationV2TurnItem => ({
      ...base(id, second),
      status: "running",
      completedAt: null,
      type: "subagent",
      subagentId: NodeId.make(id),
      origin: "provider_native",
      driver: ProviderDriverKind.make("opencode"),
      providerInstanceId: ProviderInstanceId.make("opencode"),
      childThreadId: null,
      prompt: `Read ${id}`,
      result: null,
    });
    const subagentRow = (later: ReadonlyArray<OrchestrationV2TurnItem>) =>
      deriveProcessRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: (
            [
              {
                ...base("user", 0),
                status: "completed",
                type: "user_message",
                messageId: MessageId.make("user"),
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                text: "Research these in parallel",
                attachments: [],
              },
              child("a", 1),
              { ...child("b", 2), status: "completed", completedAt: at(2) },
              child("c", 3),
              ...later,
            ] satisfies OrchestrationV2TurnItem[]
          ).map((item) => ({
            position: item.ordinal,
            visibility: "local" as const,
            sourceThreadId: threadId,
            sourceItemId: item.id,
            item,
          })),
          optimisticMessages: [],
        }),
        latestRun: {
          runId,
          status: "running",
          startedAt: DateTime.formatIso(at(0)),
          completedAt: null,
        },
        isWorking: true,
        activeTurnStartedAt: DateTime.formatIso(at(0)),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      }).findLast((row) => row.kind === "event");
    expect(subagentRow([])).toMatchObject({ waitingLabel: "Waiting on 2 subagents" });
    const command: OrchestrationV2TurnItem = {
      ...base("command", 4),
      status: "running",
      completedAt: null,
      type: "command_execution",
      input: "sleep 5",
    };
    expect(subagentRow([command])).not.toHaveProperty("waitingLabel");
  });
});
