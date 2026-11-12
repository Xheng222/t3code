import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { createRef, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, fakeTimers, render } from "../../../test/render";
import { MessagesTimeline } from "./MessagesTimeline";

const environmentQuery = vi.hoisted(() => ({
  error: "Pull request not found",
  data: null as unknown,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: environmentQuery.data,
    dataUpdatedAt: 0,
    error: environmentQuery.error,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

// The timeline remembers scroll position and open disclosures per thread key,
// so every render gets a fresh thread.
function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
  };
}

function message(
  text: string,
  overrides: Partial<Extract<Entry, { kind: "message" }>["message"]> = {},
  id = "message-1",
): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
      ...overrides,
    },
  };
}

function work(id: string, entry: Record<string, unknown>): Entry {
  return {
    id,
    kind: "work",
    createdAt: CREATED_AT,
    entry: { id, createdAt: CREATED_AT, ...entry },
  } as Entry;
}

function v2Item(type: string, fields: Record<string, unknown>) {
  const id = (fields.id as string | undefined) ?? type;
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: "thread-1",
    sourceItemId: id,
    item: {
      id,
      threadId: "thread-1",
      runId: "run-1",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: {},
      type,
      ...fields,
    },
  } as never;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

function setup({ scheduledTasks = [] as ReadonlyArray<{ id: string; title: string }> } = {}) {
  environmentQuery.data = { tasks: scheduledTasks };
}

it("paces activity changes while keeping progress live and selecting the newest pending entry", async () => {
  setup();
  const props = baseProps();
  const history = message("Earlier reply", { role: "assistant" }, "activity-history");
  const prompt = message("Run the checks", {}, "activity-prompt");
  let thought = work("activity-thought", {
    runId: null,
    itemType: "reasoning",
    tone: "thinking",
    label: "Thinking",
    detail: "This thought should remain readable.",
    toolLifecycleStatus: "inProgress",
  });
  const command = (id: string, detail = "initial output") =>
    work(id, {
      itemType: "command_execution",
      tone: "tool",
      label: "Command",
      command: `echo ${id}`,
      detail,
      toolLifecycleStatus: "inProgress",
    });
  const first = command("first");
  const latest = command("latest");
  const nextThought = work("activity-next-thought", {
    runId: null,
    itemType: "reasoning",
    tone: "thinking",
    label: "Thinking",
    detail: "The next thought.",
    toolLifecycleStatus: "inProgress",
  });
  const ui = (entries: Entry[], routeThreadKey = props.routeThreadKey, findExpanded = false) => (
    <MessagesTimeline
      {...props}
      routeThreadKey={routeThreadKey}
      isWorking
      runlessWorkActive
      findExpanded={findExpanded}
      timelineEntries={[history, prompt, ...entries]}
    />
  );
  await using screen = await render(<MessagesTimeline {...props} timelineEntries={[history]} />);
  await expect.element(screen.getByText("Earlier reply")).toBeVisible();
  using _timers = fakeTimers();
  const preview = () => screen.container.querySelector("[data-activity-preview]")?.textContent;
  const previewRow = () => screen.container.querySelector("[data-activity-preview]");
  const status = () =>
    screen.container.querySelector('[data-timeline-row-kind="work-live"] .live-tool-shine')
      ?.textContent;
  await screen.rerender(ui([]));
  let waiting = screen.container.querySelector('[data-timeline-row-kind="work-waiting"]')!;
  const waitingLabel = waiting.textContent;
  expect(waitingLabel).toMatch(/Cogitating|Pondering|Contemplating|Reflecting/);
  expect(previewRow()).toBeNull();
  await screen.rerender(ui([]));
  expect(waiting.textContent).toBe(waitingLabel);
  await screen.rerender(
    ui([message("Also check the types", { inputIntent: "steer" }, "activity-steer")]),
  );
  expect(
    screen.container.querySelector('[data-timeline-row-kind="work-waiting"]')!.textContent,
  ).toBe(waitingLabel);
  await screen.rerender(ui([]));
  waiting = screen.container.querySelector('[data-timeline-row-kind="work-waiting"]')!;
  await screen.rerender(ui([thought]));
  expect(preview()).toContain("This thought should remain readable.");
  expect(screen.container.querySelector('[data-timeline-row-kind="work-live"]')).toBe(waiting);
  const mountedPreview = previewRow();
  const mountedGroup = mountedPreview!.closest("[data-timeline-row-id]");
  await act(() => vi.advanceTimersByTimeAsync(3600));
  thought = work("activity-thought", {
    runId: null,
    itemType: "reasoning",
    tone: "thinking",
    label: "Thinking",
    detail: "This thought should remain readable.\n\nThe final paragraph arrived with the tool.",
    toolLifecycleStatus: "completed",
  });
  await screen.rerender(ui([thought, first]));
  expect(status()).toBe("Thinking");
  expect(preview()).toBe("The final paragraph arrived with the tool.");
  await act(() => vi.advanceTimersByTimeAsync(400));
  await screen.rerender(ui([thought, first, latest]));
  expect(status()).toBe("Thinking");
  await act(() => vi.advanceTimersByTimeAsync(199));
  expect(preview()).toBe("The final paragraph arrived with the tool.");
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(status()).toBe("Running command");
  expect(preview()).toContain("echo latest");
  expect(previewRow()).toBe(mountedPreview);
  expect(screen.container.textContent).not.toContain("echo first");
  await screen.getByRole("button", { name: "echo latest", exact: true }).click();
  await screen.rerender(ui([thought, first, command("latest", "updated output")]));
  expect(preview()).toContain("updated output");
  await act(() => vi.advanceTimersByTimeAsync(100));
  await screen.rerender(ui([thought, first, command("latest", "newest output"), nextThought]));
  expect(status()).toBe("Running command");
  expect(preview()).toContain("newest output");
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(status()).toBe("Thinking");
  expect(preview()).toContain("The next thought.");
  const paragraph = screen.container.querySelector(
    ".process-reasoning .chat-markdown[data-streaming] > p",
  )!;
  expect(getComputedStyle(paragraph).transitionDuration).toBe("0s");
  await act(() => vi.advanceTimersByTimeAsync(700));
  await screen.rerender(ui([thought, first, latest, nextThought, command("after-idle")]));
  expect(preview()).toContain("echo after-idle");
  await screen.rerender(
    ui(
      [
        thought,
        first,
        latest,
        nextThought,
        command("after-idle"),
        message("Moving on to the next step.", { role: "assistant" }, "activity-prose"),
      ],
      props.routeThreadKey,
      true,
    ),
  );
  expect(screen.container.querySelector('[data-timeline-row-kind="work-toggle"]')).toBe(
    mountedGroup,
  );
  expect(mountedGroup!.querySelector("[data-activity-preview]")).toBeNull();
  await screen.rerender(
    ui([thought, first, latest, nextThought, command("find")], props.routeThreadKey, true),
  );
  expect(preview()).toContain("echo find");
  await screen.rerender(ui([command("another-thread")], "activity-other-thread"));
  expect(preview()).toContain("echo another-thread");
});

it("carries the live preview's expansion through its turn, apart from the group's history", async () => {
  setup();
  const props = baseProps();
  const turnOne = RunId.make("preview-turn-1");
  const turnTwo = RunId.make("preview-turn-2");
  const history = message("Earlier reply", { role: "assistant" }, "preview-history");
  const prompt = (runId: RunId) => message(`Start ${runId}`, { runId }, `prompt-${runId}`);
  const command = (id: string, runId = turnOne) =>
    work(id, {
      runId,
      itemType: "command_execution",
      tone: "tool",
      label: "Command",
      command: `echo ${id}`,
      detail: `${id} output`,
      toolLifecycleStatus: "inProgress",
    });
  const thought = work("preview-thought", {
    runId: turnOne,
    itemType: "reasoning",
    tone: "thinking",
    label: "Thinking",
    detail: "Weighing the next step.",
    toolLifecycleStatus: "inProgress",
  });
  const prose = message("First step done.", { role: "assistant", runId: turnOne }, "preview-prose");
  const ui = (runId: RunId, entries: Entry[]) => (
    <MessagesTimeline
      {...props}
      isWorking
      latestRun={{ runId, status: "running", startedAt: CREATED_AT, completedAt: null }}
      timelineEntries={[history, ...entries]}
    />
  );
  await using screen = await render(<MessagesTimeline {...props} timelineEntries={[history]} />);
  await expect.element(screen.getByText("Earlier reply")).toBeVisible();
  using _timers = fakeTimers();
  const liveRow = '[data-timeline-row-kind="work-live"]';
  const preview = () => screen.container.querySelector(`${liveRow} [data-activity-preview]`);
  const previewExpanded = () =>
    preview()?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded");
  const historyToggle = (id: string) =>
    screen.container.querySelector<HTMLElement>(
      `[data-timeline-row-id$=":entry:${id}"] [aria-expanded]`,
    )!;
  const toggleGroup = () =>
    click(screen.container.querySelector<HTMLElement>(`${liveRow} button[aria-expanded]`)!);
  await screen.rerender(ui(turnOne, [prompt(turnOne), command("a")]));
  expect(previewExpanded()).toBe("false");
  await click(preview()!.querySelector<HTMLElement>("[aria-expanded]")!);
  expect(previewExpanded()).toBe("true");
  await toggleGroup();
  expect(historyToggle("a").getAttribute("aria-expanded")).toBe("false");
  await click(historyToggle("a"));
  await click(historyToggle("a"));
  expect(historyToggle("a").getAttribute("aria-expanded")).toBe("false");
  await toggleGroup();
  expect(previewExpanded()).toBe("true");
  await screen.rerender(ui(turnOne, [prompt(turnOne), command("a"), thought]));
  await act(() => vi.advanceTimersByTimeAsync(600));
  expect(preview()?.textContent).toContain("Weighing the next step.");
  await screen.rerender(ui(turnOne, [prompt(turnOne), command("a"), thought, prose, command("b")]));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(preview()?.textContent).toContain("echo b");
  expect(previewExpanded()).toBe("true");
  await screen.rerender(
    ui(turnTwo, [
      prompt(turnOne),
      command("a"),
      thought,
      prose,
      command("b"),
      prompt(turnTwo),
      command("c", turnTwo),
    ]),
  );
  expect(preview()?.textContent).toContain("echo c");
  expect(previewExpanded()).toBe("false");
});

it.each(["had not started", "was streaming"])(
  "shows a reply that finished away at once when the thread opened on a copy where it %s",
  async (stale) => {
    const props = baseProps();
    const runId = RunId.make("background-run");
    const reply = "The background turn finished while you were away. ".repeat(60);
    const answer = (text: string, streaming: boolean) =>
      message(text, { role: "assistant", runId, streaming }, "background-reply");
    const ui = (later: Entry[], running: boolean, synced: boolean) => (
      <MessagesTimeline
        {...props}
        isWorking={running}
        synced={synced}
        latestRun={{
          runId,
          status: running ? "running" : "completed",
          startedAt: CREATED_AT,
          completedAt: running ? null : CREATED_AT,
          turnEnded: !running,
        }}
        timelineEntries={[
          message("Earlier answer", { role: "assistant" }, "earlier"),
          message("Do the background work", { runId, inputIntent: "turn_start" }, "prompt"),
          ...later,
        ]}
      />
    );
    await using screen = await render(
      ui(stale === "was streaming" ? [answer(reply.slice(0, 120), true)] : [], true, false),
    );
    using _timers = fakeTimers();
    await screen.rerender(ui([answer(reply, false)], false, true));
    const body = () =>
      screen.container.querySelector(
        '[data-timeline-row-id="entry-background-reply"] .chat-markdown',
      );
    await vi.waitFor(() => expect(body()).not.toBeNull());
    await act(() => vi.advanceTimersByTimeAsync(16));
    expect(body()!.textContent).toBe(reply.trimEnd());
    expect(screen.container.querySelector("[data-streaming-presentation]")).toBeNull();
  },
);

it("paces new assistant packets, drains after completion, and reveals all text for find", async () => {
  setup();
  environmentQuery.error = "";
  environmentQuery.data = { running: false, output: { text: "", truncated: false } };
  const props = baseProps();
  const history = message("Existing answer", { role: "assistant" }, "existing-answer");
  const source = `New reply 👩🏽‍💻 é ${"still streaming ".repeat(150)}`;
  const ui = (
    streaming: boolean | null,
    find = false,
    commandRunning = streaming === true,
    afterCommand = false,
  ) => (
    <MessagesTimeline
      {...props}
      isWorking={streaming === true}
      runlessWorkActive={streaming === true}
      findExpanded={find}
      timelineEntries={[
        history,
        ...(streaming === null
          ? []
          : [
              message(source, { role: "assistant", streaming }, "new-answer"),
              work("later-command", {
                command: "echo later",
                label: "Ran echo",
                tone: "tool",
                itemType: "command_execution",
                toolLifecycleStatus: commandRunning ? "inProgress" : "completed",
                projectedItem: v2Item("command_execution", {
                  input: "echo later",
                  output: "",
                  status: commandRunning ? "running" : "completed",
                }),
              }),
              ...(afterCommand
                ? [
                    message(
                      "Command finished; continuing with the reply.",
                      { role: "assistant", streaming: true },
                      "next-explanation",
                    ),
                  ]
                : []),
            ]),
      ]}
    />
  );
  await using screen = await render(<MessagesTimeline {...props} timelineEntries={[]} />);
  await screen.rerender(ui(null));
  await expect.element(screen.getByText("Existing answer")).toBeVisible();
  using _timers = fakeTimers();
  await screen.rerender(ui(true));
  const body = () =>
    screen.container.querySelector('[data-timeline-row-id="entry-new-answer"] .chat-markdown');
  await vi.waitFor(() => expect(body()).not.toBeNull());
  expect(body()!.textContent).not.toBe(source);
  expect(screen.container.textContent).not.toContain("echo later");
  await act(() => vi.advanceTimersByTimeAsync(1000));
  const prefix = body()!.textContent!;
  expect(source.startsWith(prefix)).toBe(true);
  expect(prefix.length).toBeGreaterThan(0);
  expect(prefix.length).toBeLessThan(source.length);
  await screen.rerender(ui(false));
  expect(body()!.textContent).not.toBe(source);
  expect(screen.container.textContent).not.toContain("echo later");
  await screen.rerender(ui(false, true));
  expect(body()!.textContent).toBe(source.trimEnd());
  expect(screen.container.textContent).not.toContain("echo later");
  const group = screen.getByRole("button", { name: /^(Running command|Ran 1 command)$/ });
  await expect.element(group).toHaveAttribute("aria-expanded", "false");
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(screen.container.querySelector("[data-streaming-presentation]")).toBeNull();
  await screen.rerender(ui(true, true));
  expect(group.element().querySelector(".live-tool-shine")?.textContent).toBe("Running command");
  expect(group.element().textContent).not.toContain("Ran 1 command");
  expect(screen.container.querySelector("[data-activity-preview]")?.textContent).toContain(
    "echo later",
  );
  await group.click();
  await expect.element(group).toHaveAttribute("aria-expanded", "true");
  await screen.rerender(ui(true, true, false));
  expect(group.element().querySelector(".live-tool-shine")?.textContent).toBe("Running command");
  await expect.element(group).toHaveAttribute("aria-expanded", "true");
  expect(screen.container.textContent).toContain("echo later");
  expect(group.element().querySelector(".live-tool-shine")).not.toBeNull();
  await screen.rerender(ui(true, true, false, true));
  await expect.element(group).toHaveAttribute("aria-expanded", "false");
  expect(screen.container.textContent).not.toContain("echo later");
  await group.click();
  await screen.getByRole("button", { name: "echo later", exact: true }).click();
  await expect
    .element(screen.getByRole("group", { name: "Command output" }))
    .toHaveTextContent("└─No output");
  await screen.rerender(
    <MessagesTimeline
      {...props}
      isWorking
      runlessWorkActive
      timelineEntries={[
        work("latest-thought", {
          itemType: "reasoning",
          tone: "thinking",
          label: "Thinking",
          detail: "The full latest thought remains visible.",
          toolLifecycleStatus: "completed",
        }),
      ]}
    />,
  );
  const thoughtGroup = screen.getByRole("button", { name: "Thinking", exact: true });
  await expect.element(thoughtGroup).toBeVisible();
  await expect.element(screen.getByText("The full latest thought remains visible.")).toBeVisible();
  expect(thoughtGroup.element().querySelector(".live-tool-shine")).not.toBeNull();
  await screen.rerender(
    <MessagesTimeline
      {...props}
      isWorking
      runlessWorkActive
      timelineEntries={[
        work("read-file", {
          itemType: "dynamic_tool",
          tone: "tool",
          toolLifecycleStatus: "completed",
          label: "Read src/filter.ts",
          structuredPayload: {
            type: "dynamic_tool",
            toolName: "Read",
            input: { path: "src/filter.ts" },
          },
        }),
        work("search", {
          itemType: "file_search",
          tone: "tool",
          toolLifecycleStatus: "completed",
          label: "Tool",
          toolData: { pattern: "filterEntries" },
          structuredPayload: { type: "file_search", pattern: "filterEntries" },
        }),
      ]}
    />,
  );
  const searchGroup = screen.getByRole("button", { name: "Searching", exact: true });
  await searchGroup.click();
  await expect.element(screen.getByText("src/filter.ts", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("filterEntries", { exact: true })).toBeVisible();
  const drainingRun = RunId.make("draining-final-run");
  const finalText = "The final response is still being presented. ".repeat(100);
  const finalUi = (running: boolean, findExpanded = false) => (
    <MessagesTimeline
      {...props}
      isWorking={running}
      findExpanded={findExpanded}
      activeTurnStartedAt={running ? CREATED_AT : null}
      latestRun={{
        runId: drainingRun,
        status: running ? "running" : "completed",
        startedAt: CREATED_AT,
        completedAt: running ? null : "2026-03-17T19:12:48.000Z",
        turnEnded: !running,
      }}
      timelineEntries={[
        history,
        message(
          "Finish the response",
          { runId: drainingRun, inputIntent: "turn_start" },
          "draining-prompt",
        ),
        work("draining-thought", {
          runId: drainingRun,
          itemType: "reasoning",
          tone: "thinking",
          label: "Thinking",
          detail: "Preparing the final response.",
          toolLifecycleStatus: "completed",
        }),
        message(
          finalText,
          { role: "assistant", runId: drainingRun, streaming: running },
          "draining-final",
        ),
      ]}
    />
  );
  await screen.rerender(finalUi(true));
  await screen.rerender(finalUi(false));
  const durationHeader = () => screen.container.querySelector('[data-timeline-row-kind="working"]');
  expect(durationHeader()?.textContent).toBe("Working for 20s");
  const finalBody = () =>
    screen.container.querySelector('[data-timeline-row-id="entry-draining-final"] .chat-markdown');
  expect(finalBody()?.textContent).not.toBe(finalText.trimEnd());
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(durationHeader()?.textContent).toBe("Working for 20s");
  await screen.rerender(finalUi(false, true));
  await expect
    .element(screen.getByRole("button", { name: "Worked for 20s", exact: true }))
    .toBeVisible();
  expect(durationHeader()).toBeNull();
});
