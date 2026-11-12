import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render, stubGlobal } from "../../../test/render";
import { createTimelineLayout } from "./timelineLayout.fork";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

it("preserves measured sizes through collapse and a delayed remount, and reopens rows that left unanimated from nothing", async () => {
  // This exercises the layout coordinator without navigation or RPCs.
  await using screen = await render(<div data-testid="viewport" />, { router: false });
  using _observer = stubGlobal("ResizeObserver", undefined);
  using _timers = fakeTimers();
  using cleanup = new DisposableStack();
  const viewport = screen.container.querySelector<HTMLDivElement>("[data-testid=viewport]")!;
  const makeRow = (height: number) => {
    const element = document.createElement("div");
    const content = document.createElement("div");
    content.style.height = `${height}px`;
    element.append(content);
    viewport.append(element);
    return { element, content };
  };
  const header: MessagesTimelineRow = { kind: "working", id: "header", createdAt: null };
  const body: MessagesTimelineRow = { kind: "working", id: "body", createdAt: null };
  const expanded = [header, body];
  const collapsed = [header];
  let data = expanded;
  const sizes = new Map([
    ["header", 40],
    ["body", 120],
  ]);
  const headerDom = makeRow(40);
  const indicator = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  indicator.dataset.expanded = "true";
  headerDom.content.append(indicator);
  const angle = () => Number(indicator.style.transform.match(/rotate\((.*)deg\)/)?.[1]);
  let bodyDom = makeRow(120);
  let detachBody = () => {};
  const headerHeightsAtExit: number[] = [];
  let animating = true;
  let motion: ReturnType<typeof createTimelineLayout>;
  motion = createTimelineLayout({
    animate: () => animating,
    onPins: () => {},
    onExited: () => {
      headerHeightsAtExit.push(sizes.get(header.id)!);
      detachBody();
      bodyDom.element.remove();
      data = collapsed;
      motion.setRows(data, data, new Set(), false);
    },
  });
  cleanup.defer(
    motion.attach(
      { scrollNode: viewport, layoutChanged: () => {} },
      {
        getState: () => ({
          startBuffered: 0,
          endBuffered: data.length - 1,
          indexByKey: (id) => {
            const index = data.findIndex((row) => row.id === id);
            return index < 0 ? undefined : index;
          },
          sizeAtIndex: (index) => sizes.get(data[index]!.id) ?? 0,
        }),
        setItemSize: (id, size) => {
          sizes.set(id, size.height);
        },
      },
    ),
  );
  cleanup.defer(motion.register(header.id, headerDom.element, headerDom.content));
  cleanup.defer(motion.registerIndicator(indicator));
  await act(() => {
    detachBody = motion.register(body.id, bodyDom.element, bodyDom.content);
    motion.setRows(data, data, new Set(), false);
  });
  await act(() => {
    motion.capture(header.id);
    motion.setIndicatorExpanded(indicator, false);
    headerDom.content.style.height = "20px";
    motion.setRows(expanded, collapsed, new Set([body.id]), false);
  });
  await act(() => vi.advanceTimersByTimeAsync(400));
  expect(sizes.get(body.id)).toBe(0);
  expect(headerHeightsAtExit).toEqual([20]);
  expect(angle()).toBe(0);
  await act(() => {
    motion.capture(header.id);
    motion.setIndicatorExpanded(indicator, true);
    data = expanded;
    motion.setRows(data, data, new Set(), false);
  });
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(angle()).toBe(0);
  bodyDom = makeRow(120);
  await act(() => {
    detachBody = motion.register(body.id, bodyDom.element, bodyDom.content);
  });
  cleanup.defer(() => detachBody());
  expect(bodyDom.element.style.height).toBe("0px");
  await act(() => vi.advanceTimersByTimeAsync(80));
  expect(bodyDom.element.offsetHeight).toBeGreaterThan(0);
  expect(bodyDom.element.offsetHeight).toBeLessThan(120);
  expect(Math.abs(bodyDom.element.offsetHeight / 120 - angle() / 90)).toBeLessThan(0.01);
  const partialHeight = bodyDom.element.offsetHeight;
  const partialAngle = angle();
  await act(() => {
    motion.capture(header.id);
    motion.setIndicatorExpanded(indicator, false);
    motion.setRows(expanded, collapsed, new Set([body.id]), false);
  });
  expect(bodyDom.element.offsetHeight).toBe(partialHeight);
  expect(angle()).toBe(partialAngle);
  await act(() => vi.advanceTimersByTimeAsync(64));
  expect(bodyDom.element.offsetHeight).toBeLessThan(partialHeight);
  expect(angle()).toBeLessThan(partialAngle);
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(bodyDom.element.isConnected).toBe(false);
  expect(angle()).toBe(0);
  // A thread opening replaces rows without motion; a row it removed opens again from nothing.
  animating = false;
  bodyDom = makeRow(120);
  await act(() => {
    data = expanded;
    motion.setRows(data, data, new Set(), false);
    detachBody = motion.register(body.id, bodyDom.element, bodyDom.content);
  });
  await act(() => {
    detachBody();
    bodyDom.element.remove();
    data = collapsed;
    motion.setRows(data, data, new Set(), false);
  });
  animating = true;
  await act(() => {
    motion.capture(header.id);
    data = expanded;
    motion.setRows(data, data, new Set(), false);
  });
  bodyDom = makeRow(120);
  await act(() => {
    detachBody = motion.register(body.id, bodyDom.element, bodyDom.content);
  });
  expect(bodyDom.element.style.height).toBe("0px");
});

it("closes a shrinking row's trailing space, or hands it to its group's rows opening below", async () => {
  // This exercises the layout coordinator without navigation or RPCs.
  await using screen = await render(<div data-testid="viewport" />, { router: false });
  using _observer = stubGlobal("ResizeObserver", undefined);
  using _timers = fakeTimers();
  using cleanup = new DisposableStack();
  const viewport = screen.container.querySelector<HTMLDivElement>("[data-testid=viewport]")!;
  const makeRow = (height: number) => {
    const element = document.createElement("div");
    const content = document.createElement("div");
    content.style.height = `${height}px`;
    element.append(content);
    viewport.append(element);
    return { element, content };
  };
  const { element, content } = makeRow(120);
  let rows: MessagesTimelineRow[] = [
    {
      kind: "work-toggle",
      id: "row",
      groupId: "group",
      summary: "Ran 1 command",
      summaryKind: "command",
      hiddenCount: 1,
      hasFailure: false,
      expanded: false,
      createdAt: "2026-11-10T00:00:00Z",
    },
  ];
  const sizes = new Map([["row", 120]]);
  const motion = createTimelineLayout({
    animate: () => true,
    onPins: () => {},
    onExited: () => {},
  });
  cleanup.defer(
    motion.attach(
      { scrollNode: viewport, layoutChanged: () => {} },
      {
        getState: () => ({
          startBuffered: 0,
          endBuffered: rows.length - 1,
          indexByKey: (id) => {
            const index = rows.findIndex((row) => row.id === id);
            return index < 0 ? undefined : index;
          },
          sizeAtIndex: (index) => sizes.get(rows[index]!.id) ?? 0,
        }),
        setItemSize: (id, size) => {
          sizes.set(id, size.height);
        },
      },
    ),
  );
  cleanup.defer(motion.register("row", element, content));
  await act(() => motion.setRows(rows, rows, new Set(), false));
  await act(() => {
    motion.capture("row");
    content.style.height = "40px";
    motion.layoutChanged();
  });
  await act(() => vi.advanceTimersByTimeAsync(60));
  expect(element.offsetHeight).toBeGreaterThan(40);
  expect(element.offsetHeight).toBeLessThan(120);
  expect(element.style.maskImage).toBe("");
  await act(() => vi.advanceTimersByTimeAsync(400));
  expect(element.style.height).toBe("");
  expect(sizes.get("row")).toBe(40);

  await act(() => {
    motion.capture("row");
    content.style.height = "120px";
    motion.layoutChanged();
  });
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(sizes.get("row")).toBe(120);
  const reply = makeRow(160);
  await act(() => {
    motion.capture("row");
    content.style.height = "40px";
    cleanup.defer(motion.register("reply", reply.element, reply.content));
    rows = [...rows, { kind: "working", id: "reply", createdAt: null }];
    motion.setRows(rows, rows, new Set(), false);
  });
  await act(() => vi.advanceTimersByTimeAsync(60));
  expect(element.offsetHeight).toBeGreaterThan(40);
  expect(element.offsetHeight).toBeLessThan(120);
  await act(() => vi.advanceTimersByTimeAsync(500));

  await act(() => {
    motion.capture("row");
    content.style.height = "120px";
    motion.layoutChanged();
  });
  await act(() => vi.advanceTimersByTimeAsync(500));
  const entry = makeRow(160);
  await act(() => {
    motion.capture("row");
    content.style.height = "40px";
    cleanup.defer(motion.register("entry", entry.element, entry.content));
    rows = [
      rows[0]!,
      {
        kind: "work",
        id: "entry",
        groupId: "group",
        groupedEntries: [],
        isExpandedToolGroup: true,
        createdAt: "2026-11-10T00:00:00Z",
      },
      ...rows.slice(1),
    ];
    motion.setRows(rows, rows, new Set(), false);
  });
  await act(() => vi.advanceTimersByTimeAsync(60));
  expect(element.offsetHeight).toBe(40);
  expect(entry.element.offsetHeight).toBeGreaterThan(80);
  expect(entry.element.offsetHeight).toBeLessThan(160);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(entry.element.style.height).toBe("");
});

it("preserves input and reply geometry while surrounding process rows close", async () => {
  // This exercises measured row geometry without navigation or RPCs.
  await using screen = await render(<div data-testid="viewport" />, { router: false });
  using _observer = stubGlobal("ResizeObserver", undefined);
  using _timers = fakeTimers();
  using cleanup = new DisposableStack();
  const viewport = screen.container.querySelector<HTMLDivElement>("[data-testid=viewport]")!;
  const makeRow = (id: string, height: number) => {
    const element = document.createElement("div");
    const content = document.createElement("div");
    content.style.height = `${height}px`;
    element.append(content);
    viewport.append(element);
    return { id, element, content };
  };
  const first = makeRow("first", 100);
  const input = makeRow("input", 40);
  const last = makeRow("last", 200);
  const reply = makeRow("reply", 800);
  const dom = [first, input, last, reply];
  const rows: MessagesTimelineRow[] = dom.map(({ id }) => ({
    kind: "working",
    id,
    createdAt: null,
  }));
  let data = rows;
  const collapsed = rows.filter((row) => row.id === input.id || row.id === reply.id);
  const sizes = new Map(dom.map((row) => [row.id, row.content.offsetHeight]));
  let finalGeometry:
    | { inputTop: number; inputHeight: number; replyTop: number; replyHeight: number }
    | undefined;
  const motion = createTimelineLayout({
    animate: () => true,
    onPins: () => {},
    onExited: () => {
      const top = viewport.getBoundingClientRect().top;
      finalGeometry = {
        inputTop: input.element.getBoundingClientRect().top - top,
        inputHeight: input.element.offsetHeight,
        replyTop: reply.element.getBoundingClientRect().top - top,
        replyHeight: reply.element.offsetHeight,
      };
      first.element.remove();
      last.element.remove();
      data = collapsed;
      motion.setRows(data, data, new Set(), false);
    },
  });
  cleanup.defer(
    motion.attach(
      { scrollNode: viewport, layoutChanged: () => {} },
      {
        getState: () => ({
          startBuffered: 0,
          endBuffered: data.length - 1,
          indexByKey: (id) => {
            const index = data.findIndex((row) => row.id === id);
            return index < 0 ? undefined : index;
          },
          sizeAtIndex: (index) => sizes.get(data[index]!.id) ?? 0,
        }),
        setItemSize: (id, size) => {
          sizes.set(id, size.height);
        },
      },
    ),
  );
  for (const row of dom) cleanup.defer(motion.register(row.id, row.element, row.content));
  await act(() => motion.setRows(rows, rows, new Set(), false));
  await act(() => {
    motion.capture(first.id);
    reply.content.style.height = "810px";
    motion.setRows(rows, collapsed, new Set([first.id, last.id]), false);
  });
  await act(() => vi.advanceTimersByTimeAsync(80));
  expect(input.element.offsetHeight).toBe(40);
  expect(input.element.style.maskImage).toBe("");
  await act(() => vi.advanceTimersByTimeAsync(400));
  expect(finalGeometry).toEqual({ inputTop: 0, inputHeight: 40, replyTop: 40, replyHeight: 810 });
});

it("preserves a closing group's trailing space through cleanup", async () => {
  // This exercises measured row geometry without navigation or RPCs.
  await using screen = await render(<div data-testid="viewport" />, { router: false });
  using _observer = stubGlobal("ResizeObserver", undefined);
  using _timers = fakeTimers();
  using cleanup = new DisposableStack();
  const viewport = screen.container.querySelector<HTMLDivElement>("[data-testid=viewport]")!;
  const makeRow = (height: number) => {
    const element = document.createElement("div");
    const content = document.createElement("div");
    content.style.height = `${height}px`;
    element.append(content);
    viewport.append(element);
    return { element, content };
  };
  const header: MessagesTimelineRow = {
    kind: "work-toggle",
    id: "header",
    groupId: "group",
    summary: "Ran 1 command",
    summaryKind: "command",
    hiddenCount: 1,
    hasFailure: false,
    expanded: false,
    createdAt: "2026-11-10T00:00:00Z",
  };
  const body: MessagesTimelineRow = { kind: "working", id: "body", createdAt: null };
  const expanded = [header, body];
  const collapsed = [header];
  let data = expanded;
  const sizes = new Map([
    [header.id, 24],
    [body.id, 120],
  ]);
  const headDom = makeRow(24);
  const bodyDom = makeRow(120);
  const following = document.createElement("p");
  following.textContent = "Following reply";
  following.style.margin = "0";
  viewport.append(following);
  const followingTop = () =>
    following.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  let beforeCleanup: number | undefined;
  let heightAfterRemoval: number | undefined;
  let detachBody = () => {};
  const motion = createTimelineLayout({
    animate: () => true,
    onPins: () => {},
    onExited: () => {
      beforeCleanup = followingTop();
      detachBody();
      bodyDom.element.remove();
      data = collapsed;
      heightAfterRemoval = data.reduce((total, row) => total + (sizes.get(row.id) ?? 0), 0);
      motion.setRows(data, data, new Set(), false);
    },
  });
  cleanup.defer(
    motion.attach(
      { scrollNode: viewport, layoutChanged: () => {} },
      {
        getState: () => ({
          startBuffered: 0,
          endBuffered: data.length - 1,
          indexByKey: (id) => {
            const index = data.findIndex((row) => row.id === id);
            return index < 0 ? undefined : index;
          },
          sizeAtIndex: (index) => sizes.get(data[index]!.id) ?? 0,
        }),
        setItemSize: (id, size) => {
          sizes.set(id, size.height);
        },
      },
    ),
  );
  cleanup.defer(motion.register(header.id, headDom.element, headDom.content));
  detachBody = motion.register(body.id, bodyDom.element, bodyDom.content);
  cleanup.defer(() => detachBody());
  await act(() => motion.setRows(expanded, expanded, new Set(), false));
  const bodyTop = bodyDom.content.getBoundingClientRect().top;
  await act(() => {
    motion.capture(header.id);
    headDom.content.style.height = "32px";
    motion.setRows(expanded, collapsed, new Set([body.id]), false);
  });
  await act(() => vi.advanceTimersByTimeAsync(80));
  expect(bodyDom.content.getBoundingClientRect().top).toBe(bodyTop);
  expect(followingTop()).toBeGreaterThanOrEqual(32);
  const reversingTop = followingTop();
  await act(() => {
    motion.capture(header.id);
    headDom.content.style.height = "24px";
    motion.setRows(expanded, expanded, new Set(), false);
  });
  expect(followingTop()).toBe(reversingTop);
  await act(() => vi.advanceTimersByTimeAsync(400));
  expect(followingTop()).toBe(144);
  await act(() => {
    motion.capture(header.id);
    headDom.content.style.height = "32px";
    motion.setRows(expanded, collapsed, new Set([body.id]), false);
  });
  await act(() => vi.advanceTimersByTimeAsync(400));
  expect(beforeCleanup).toBe(32);
  expect(heightAfterRemoval).toBe(32);
  expect(followingTop()).toBe(32);
});
