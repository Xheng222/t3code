import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { createRef, type ComponentProps, type ReactElement } from "react";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { environmentThreadDetails } from "../../state/threads";
import { act, fakeTimers, render, type Screen } from "../../../test/render";
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

async function renderElement(element: ReactElement, options: { router?: false } = {}) {
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(element, { container, ...options });
  const buttons = (name: string | RegExp) =>
    [...container.querySelectorAll<HTMLElement>("button, [role=button]")].filter((button) => {
      const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof name === "string" ? label === name : name.test(label);
    });
  return Object.assign(screen, {
    text: () => container.textContent ?? "",
    buttons,
    button: (name: string | RegExp) => {
      const [match] = buttons(name);
      if (!match) throw new Error(`Missing button: ${String(name)}`);
      return match;
    },
  });
}

function renderTimeline(entries: ReadonlyArray<Entry>, props: Partial<TimelineProps> = {}) {
  return renderElement(
    <MessagesTimeline {...baseProps()} timelineEntries={entries as Entry[]} {...props} />,
  );
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

function setup({ scheduledTasks = [] as ReadonlyArray<{ id: string; title: string }> } = {}) {
  environmentQuery.data = { tasks: scheduledTasks };
}

type FoldTimeline = (key: string, entries: Entry[], synced?: boolean) => ReactElement;

/** Context rows, then a finished turn whose progress folds under "Worked for". */
function foldThread(name: string): Entry[] {
  const runId = RunId.make(`${name}-run`);
  return [
    ...Array.from({ length: 12 }, (_, index) =>
      message(`${name} context ${index}`, {}, `${name}-context-${index}`),
    ),
    message(`${name} progress\n\n`.repeat(20), { role: "assistant", runId }, `${name}-progress`),
    message(`${name} done`, { role: "assistant", runId }, `${name}-final`),
  ];
}

async function foldSettled(screen: Screen) {
  const heading = screen.getByRole("button", { name: /^Worked for/ });
  // LegendList keeps rows click-through until its initial scroll settles on animation frames.
  await expect.element(heading).toHaveStyle({ pointerEvents: "auto" });
  await vi.waitFor(() =>
    expect(heading.element().checkVisibility({ opacityProperty: true })).toBe(true),
  );
}

describe("MessagesTimeline work rows", () => {
  it.each([
    {
      opening: "the list identity changes with identical rows",
      reopen: async (screen: Screen, ui: FoldTimeline, key: string, entries: Entry[]) => {
        await screen.rerender(ui(`${key}-copy`, entries));
      },
    },
    {
      opening: "a stale copy syncs with new rows in the frame it opens",
      reopen: async (screen: Screen, ui: FoldTimeline, key: string, entries: Entry[]) => {
        await screen.rerender(ui(`${key}-other`, foldThread("other")));
        await foldSettled(screen);
        using _timers = fakeTimers();
        await screen.rerender(ui(key, entries, false));
        // Same heights, new message objects: the synced detail of the same thread.
        await screen.rerender(
          ui(
            key,
            entries.map((entry) =>
              entry.kind === "message" ? { ...entry, message: { ...entry.message } } : entry,
            ),
          ),
        );
        await act(() => vi.advanceTimersByTimeAsync(2000));
      },
    },
  ])("animates the first turn fold toggle after $opening", async ({ reopen }) => {
    const props = baseProps();
    const ui: FoldTimeline = (key, entries, synced = true) => (
      <MessagesTimeline {...props} routeThreadKey={key} synced={synced} timelineEntries={entries} />
    );
    const container = document.createElement("div");
    container.style.cssText =
      "height: min(600px, 100vh); width: 900px; display: flex; flex-direction: column;";
    const entries = foldThread("fold");
    await using screen = await render(ui(props.routeThreadKey, entries), { container });
    await foldSettled(screen);
    await reopen(screen, ui, props.routeThreadKey, entries);
    await foldSettled(screen);
    using _timers = fakeTimers();
    await screen.getByRole("button", { name: /^Worked for/ }).click();
    await act(() => vi.advanceTimersByTimeAsync(60));
    const row = screen.container.querySelector<HTMLElement>(
      '[data-timeline-motion-row="entry-fold-progress"]',
    )!;
    const natural = (row.firstElementChild as HTMLElement).offsetHeight;
    expect(natural).toBeGreaterThan(0);
    expect(Number.parseFloat(row.style.height)).toBeGreaterThan(0);
    expect(Number.parseFloat(row.style.height)).toBeLessThan(natural);
  });

  it("slides the latest running subagent up while its group collapses", async () => {
    setup();
    using _threadAtom = vi
      .spyOn(environmentThreadDetails, "threadAtom")
      .mockReturnValue(
        Atom.make({ projection: { subagents: [], turnItems: [], visibleTurnItems: [] } }) as never,
      );
    const subagent = (id: string) =>
      ({
        id,
        kind: "event",
        createdAt: CREATED_AT,
        projectedItem: v2Item("subagent", {
          id,
          runId: null,
          status: "running",
          title: `Agent ${id}`,
          subagentId: id,
          origin: "provider_native",
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
          childThreadId: null,
          prompt: `Inspect ${id}`,
          result: null,
        }),
      }) as Entry;
    await using screen = await renderTimeline(
      [
        message("Earlier reply", { role: "assistant" }, "history"),
        message("Delegate the review", {}, "prompt"),
        subagent("a"),
        subagent("b"),
        subagent("c"),
      ],
      { isWorking: true, runlessWorkActive: true },
    );
    const group = () => screen.container.querySelector<HTMLElement>("[data-subagent-group]")!;
    const latest = () =>
      [...group().querySelectorAll<HTMLElement>('[data-v2-item-type="subagent"]')].find((row) =>
        row.textContent?.includes("Agent c"),
      )!;
    await vi.waitFor(() => {
      expect(latest()).toBeDefined();
      // Legend keeps rows transparent and unclickable until its initial scroll settles.
      expect(getComputedStyle(group()).pointerEvents).toBe("auto");
      expect(group().checkVisibility({ opacityProperty: true })).toBe(true);
    });
    using _timers = fakeTimers();
    const toggle = group().querySelector<HTMLElement>("button[aria-expanded]")!;
    await click(toggle);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    const expandedTop = latest().getBoundingClientRect().top;
    await click(toggle);
    await act(() => vi.advanceTimersByTimeAsync(60));
    const sliding = latest().getBoundingClientRect();
    const row = group().closest<HTMLElement>("[data-timeline-motion-row]")!;
    const rowBottom = row.getBoundingClientRect().bottom;
    const rowMask = row.style.maskImage;
    await act(() => vi.advanceTimersByTimeAsync(1000));
    const collapsedTop = latest().getBoundingClientRect().top;
    expect(collapsedTop).toBeLessThan(expandedTop - 20);
    expect(sliding.top).toBeGreaterThan(collapsedTop);
    expect(sliding.top).toBeLessThan(expandedTop);
    expect(sliding.bottom).toBeLessThanOrEqual(rowBottom + 1);
    expect(rowMask).toBe("");
  });
});

describe("MessagesTimeline messages", () => {
  it("preserves the visible message when earlier history is prepended", async () => {
    const props = baseProps();
    const entries = Array.from({ length: 20 }, (_, index) =>
      message(`Context ${index}\n\n${"Conversation details. ".repeat(12)}`, {}, `context-${index}`),
    );
    const earlier = Array.from({ length: 6 }, (_, index) =>
      message(`Earlier ${index}\n\n${"Conversation details. ".repeat(12)}`, {}, `earlier-${index}`),
    );
    const container = document.createElement("div");
    container.style.cssText = "height: 400px; width: 800px; display: flex; flex-direction: column;";
    const timeline = (items: Entry[]) => (
      <MessagesTimeline {...props} liveFollowEnabled={false} timelineEntries={items} />
    );
    await using screen = await render(timeline(entries), { container });
    await act(() => props.listRef.current!.scrollToIndex({ index: 8, animated: false }));
    const top = props.listRef.current!.getState().elementAtIndex(8)!.getBoundingClientRect().top;
    await screen.rerender(timeline([...earlier, ...entries]));
    await vi.waitFor(() => {
      const state = props.listRef.current!.getState();
      const index = state.indexByKey("entry-context-8")!;
      const after = state.elementAtIndex(index)!.getBoundingClientRect().top;
      // LegendList anchors to the browser's whole-pixel scroll offset, so a fractional row top
      // can land up to a pixel away.
      expect(Math.abs(after - top)).toBeLessThan(1);
    });
  });
});

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
  expect(waitingLabel).toMatch(/^[A-Z][a-z]+ing/);
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
    .toHaveTextContent("└─No output.");
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
  await act(() => vi.advanceTimersByTimeAsync(1000));
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

it("holds a new reply's paced text until a beat after the live preview collapses", async () => {
  setup();
  const runId = RunId.make("collapse-run");
  const command = (id: string) =>
    work(id, {
      runId,
      itemType: "command_execution",
      tone: "tool",
      label: "Command",
      command: `echo ${id}`,
      detail: `${id} output`,
      toolLifecycleStatus: "completed",
    });
  const entries = [message("Run the commands", { runId }, "prompt"), command("a"), command("b")];
  const source = "The commands finished cleanly. ".repeat(20);
  const props = {
    ...baseProps(),
    isWorking: true,
    latestRun: { runId, status: "running", startedAt: CREATED_AT, completedAt: null },
  } satisfies Omit<TimelineProps, "timelineEntries">;
  const ui = (reply: Entry[]) => (
    <MessagesTimeline {...props} timelineEntries={[...entries, ...reply]} />
  );
  const container = document.createElement("div");
  container.style.cssText = "height: 600px; width: 800px; display: flex; flex-direction: column;";
  await using screen = await render(ui([]), { container });
  await vi.waitFor(() =>
    expect(
      screen.container
        .querySelector('[data-timeline-row-kind="work-live"]')!
        .checkVisibility({ opacityProperty: true }),
    ).toBe(true),
  );
  using _timers = fakeTimers();
  const reply = (streaming: boolean, text = source) => [
    message(text, { role: "assistant", runId, streaming }, "reply"),
  ];
  const body = () =>
    screen.container.querySelector('[data-timeline-row-id="entry-reply"] .chat-markdown')!;
  const animating = () =>
    screen.container.querySelector("[data-timeline-motion-row][style*=height]");
  await screen.rerender(ui(reply(true)));
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(screen.container.querySelector('[data-timeline-row-kind="work-toggle"]')).not.toBeNull();
  expect(animating()).not.toBeNull();
  expect(body().textContent).toBe("");
  await act(() => vi.advanceTimersByTimeAsync(180));
  expect(animating()).toBeNull();
  expect(body().textContent).toBe("");
  await act(() => vi.advanceTimersByTimeAsync(1000));
  const resumed = body().textContent!;
  expect(resumed.length).toBeGreaterThan(0);
  expect(source.startsWith(resumed)).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(body().textContent).toBe(source.trimEnd());
  // The final chunk lands with the end of the reply while rows animate.
  await click(
    screen.container.querySelector<HTMLElement>(
      '[data-timeline-row-kind="work-toggle"] button[aria-expanded]',
    )!,
  );
  const final = `${source}Done.`;
  await screen.rerender(ui(reply(false, final)));
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(body().textContent).toBe(source.trimEnd());
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(body().textContent).toBe(final);
});
