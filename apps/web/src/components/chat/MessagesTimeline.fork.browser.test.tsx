import { EnvironmentId, MessageId } from "@t3tools/contracts";
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

function setup({ scheduledTasks = [] as ReadonlyArray<{ id: string; title: string }> } = {}) {
  environmentQuery.data = { tasks: scheduledTasks };
}

it("paces new assistant packets, drains after completion, and reveals all text for find", async () => {
  setup();
  const props = baseProps();
  const history = message("Existing answer", { role: "assistant" }, "existing-answer");
  const source = `New reply 👩🏽‍💻 é ${"still streaming ".repeat(150)}`;
  const ui = (streaming: boolean | null, find = false) => (
    <MessagesTimeline
      {...props}
      isWorking={streaming === true}
      findExpanded={find}
      timelineEntries={[
        history,
        ...(streaming === null
          ? []
          : [message(source, { role: "assistant", streaming }, "new-answer")]),
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
  await act(() => vi.advanceTimersByTimeAsync(1000));
  const prefix = body()!.textContent!;
  expect(source.startsWith(prefix)).toBe(true);
  expect(prefix.length).toBeGreaterThan(0);
  expect(prefix.length).toBeLessThan(source.length);
  await screen.rerender(ui(false));
  expect(body()!.textContent).not.toBe(source);
  await screen.rerender(ui(false, true));
  expect(body()!.textContent).toBe(source.trimEnd());
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(screen.container.querySelector("[data-streaming-presentation]")).toBeNull();
});
