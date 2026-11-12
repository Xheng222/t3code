import type { LegendListRef } from "@legendapp/list/react";
import { flushSync } from "react-dom";
import { observeResize } from "~/lib/observeResize";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { TimelineViewport } from "./timelineViewport";

type LayoutList = {
  getState: () => Pick<
    ReturnType<LegendListRef["getState"]>,
    "indexByKey" | "sizeAtIndex" | "startBuffered" | "endBuffered"
  >;
  setItemSize: LegendListRef["setItemSize"];
};
type MountedRow = { element: HTMLElement; content: HTMLElement; width: number };
type Indicator = { element: SVGSVGElement; angle: number; target: number };
type Slide = { id: string; height: number };
type Region = {
  keys: string[];
  natural: Map<string, number>;
  survivors: Map<string, { from: number; to: number; heldTo: number }>;
  handoffs: Map<string, number>;
  spaces: Map<string, { from: number; to: number }>;
  slides: Map<HTMLElement, Slide & { from: number; to: number }>;
  slideOffsets: Map<string, number>;
  collapsed: Map<string, number>;
  from: number;
  to: number;
  indicators: { indicator: Indicator; from: number; to: number }[];
  duration: number;
  startedAt: number | null;
};

// Content that waits for the motion starts this long after it settles, as a step of its own.
const SETTLE_BEAT_MS = 150;

function bodyHeight(content: HTMLElement, selector: string) {
  return [...content.querySelectorAll<HTMLElement>(selector)].reduce((height, body) => {
    const parent = body.parentElement?.closest(selector);
    return parent && content.contains(parent) ? height : height + body.offsetHeight;
  }, 0);
}

export function createTimelineLayout({
  animate,
  onExited,
  onPins,
}: {
  animate: () => boolean;
  onExited: (ids: ReadonlySet<string>) => void;
  onPins: (ids: ReadonlySet<string>) => void;
}) {
  const mounted = new Map<string, MountedRow>();
  const heights = new Map<string, number>();
  const measuredHeights = new Map<string, number>();
  const spaces = new Map<string, number>();
  const slides = new Map<HTMLElement, Slide & { offset: number }>();
  const settled = new Set<() => void>();
  const settleListeners = new Set<() => void>();
  // Parts of a row the animation skips. Content shifts up by the part above; cleanup adds an
  // opening's part above back, scrolling past it when most of the view is below it.
  const trims = new Map<
    string,
    { element: HTMLElement; cut: number; above: number; opening: boolean }
  >();
  const controlled = new Set<string>();
  const indicators = new Map<SVGSVGElement, Indicator>();
  let display: readonly MessagesTimelineRow[] = [];
  let desired: readonly MessagesTimelineRow[] = [];
  let desiredIds: ReadonlySet<string> = new Set();
  let entering: ReadonlySet<string> = new Set();
  let preparing: ReadonlySet<string> | null = null;
  let exits: ReadonlySet<string> = new Set();
  let viewport: Pick<TimelineViewport, "scrollNode" | "layoutChanged"> | null = null;
  let list: LayoutList | null = null;
  let before: Map<string, number> | null = null;
  let region: Region | null = null;
  let frame: number | null = null;
  let queued = false;
  let finishing = false;
  let initialized = false;
  let naturalDirty = true;
  let indicatorDirty = false;
  let settling = false;
  let beat: ReturnType<typeof setTimeout> | null = null;

  const publishSettling = (next: boolean) => {
    if (beat !== null) clearTimeout(beat);
    beat = null;
    if (settling === next) return;
    settling = next;
    for (const listener of settleListeners) listener();
  };
  const publishAnimating = () => {
    if (region !== null || !settling || !animate()) return publishSettling(region !== null);
    beat ??= setTimeout(() => publishSettling(false), SETTLE_BEAT_MS);
  };
  const durationOf = (job: Pick<Region, "from" | "to" | "survivors">) =>
    250 +
    Math.min(
      100,
      Math.max(
        Math.abs(job.to - job.from),
        ...[...job.survivors.values()].map((survivor) => Math.abs(survivor.to - survivor.from)),
      ) / 5,
    );
  const shift = (element: HTMLElement, above: number) => {
    element.style.translate = above > 0 ? `0 ${-above}px` : "";
    element.style.clipPath = above > 0 ? `inset(${above}px 0 0 0)` : "";
  };
  const clearTrims = () => {
    for (const { element } of trims.values()) shift(element, 0);
    trims.clear();
  };

  const capture = (id?: string) => {
    if (!finishing && !before && initialized) before = new Map(heights);
    const row = id ? mounted.get(id) : undefined;
    if (id && row && !finishing && animate())
      writeHeight(id, heights.get(id) ?? row.content.offsetHeight);
  };
  const writeHeight = (id: string, height: number, space = spaces.get(id) ?? 0) => {
    const row = mounted.get(id);
    const rounded = Math.max(0, Math.round(height));
    const blank = Math.max(0, Math.min(rounded, Math.round(space)));
    const visible = rounded - blank;
    if (blank > 0) spaces.set(id, blank);
    else spaces.delete(id);
    if (row) {
      const collapsed = region?.collapsed.get(id);
      const hidden =
        (region?.natural.get(id) ?? visible) - (region?.slideOffsets.get(id) ?? 0) - visible;
      const feather =
        collapsed === undefined ? 0 : Math.max(0, Math.min(24, visible - collapsed, hidden));
      row.element.style.maskImage =
        blank > 0
          ? `linear-gradient(to bottom, black ${visible - feather}px, transparent ${visible}px)`
          : feather > 0
            ? `linear-gradient(to bottom, black calc(100% - ${feather}px), transparent)`
            : "";
    }
    if (heights.get(id) === rounded && (!row || row.element.style.height === `${rounded}px`))
      return;
    heights.set(id, rounded);
    controlled.add(id);
    if (row) {
      row.element.style.height = `${rounded}px`;
      row.element.style.overflow = "clip";
    }
    if (list && list.getState().indexByKey(id) !== undefined)
      list.setItemSize(id, {
        height: rounded,
        width: row?.width ?? viewport?.scrollNode.clientWidth ?? 0,
      });
  };
  const writeAngle = (indicator: Indicator, angle: number) => {
    indicator.angle = angle;
    indicator.element.style.transform = `rotate(${angle}deg)`;
  };
  // A closing slide disclosure stays in place while the content after it moves up over it, and
  // its container ends where it will after cleanup.
  const writeSlide = (root: HTMLElement, slide: (Slide & { offset: number }) | null) => {
    const offset = slide?.offset ?? 0;
    const shown = (slide?.height ?? 0) - offset;
    const feather = Math.max(0, Math.min(24, offset, shown));
    root.style.maskImage =
      offset > 0
        ? `linear-gradient(to bottom, black ${shown - feather}px, transparent ${shown}px)`
        : "";
    if (root.parentElement)
      root.parentElement.style.clipPath = offset > 0 ? `inset(0 0 ${offset}px)` : "";
    for (let sibling = root.nextElementSibling; sibling; sibling = sibling.nextElementSibling)
      if (sibling instanceof HTMLElement)
        sibling.style.transform = offset > 0 ? `translateY(${-offset}px)` : "";
    if (slide && offset > 0) slides.set(root, slide);
    else slides.delete(root);
  };
  const clearSlides = () => {
    for (const root of slides.keys()) writeSlide(root, null);
  };
  const finish = () => {
    if (finishing) return;
    finishing = true;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    clearSlides();
    if (region) {
      for (const [id, survivor] of region.survivors)
        if (survivor.to > survivor.heldTo) writeHeight(id, survivor.to);
      for (const id of region.spaces.keys()) {
        const blank = spaces.get(id) ?? 0;
        if (blank > 0) writeHeight(id, (heights.get(id) ?? 0) - blank, 0);
      }
    }
    region = null;
    before = null;
    for (const indicator of indicators.values()) writeAngle(indicator, indicator.target);
    const departing = exits;
    flushSync(() => {
      if (departing.size > 0) onExited(departing);
      for (const callback of settled) callback();
      settled.clear();
      onPins(new Set());
    });
    const rows = [...controlled].flatMap((id) => {
      const row = mounted.get(id);
      return row ? [{ id, row }] : [];
    });
    let skippedOpening = 0;
    for (const { element, above, opening } of trims.values()) {
      if (!opening || !viewport || !element.isConnected) continue;
      // The skipped part returns at the body's layout top; the scroll keeps the larger side still.
      const { top, bottom } = viewport.scrollNode.getBoundingClientRect();
      if (element.getBoundingClientRect().top + above < (top + bottom) / 2) skippedOpening += above;
    }
    clearTrims();
    for (const { row } of rows) {
      row.element.style.height = "";
      row.element.style.overflow = "";
      row.element.style.maskImage = "";
    }
    const measured = rows.map(({ id, row }) => ({
      id,
      height: row.content.offsetHeight,
      width: row.width,
    }));
    for (const { id, height, width } of measured) {
      heights.set(id, height);
      measuredHeights.set(id, height);
      const index = list?.getState().indexByKey(id);
      if (index !== undefined && list?.getState().sizeAtIndex(index) !== height)
        list?.setItemSize(id, { height, width });
    }
    for (const id of departing) heights.delete(id);
    if (skippedOpening > 0 && viewport) {
      const node = viewport.scrollNode;
      const target = node.scrollTop + skippedOpening;
      node.scrollTop = target;
      // The list grows its content box after it commits the new size, so the end can clamp.
      if (node.scrollTop < target - 0.5) queueMicrotask(() => (node.scrollTop = target));
    }
    spaces.clear();
    entering = new Set();
    preparing = null;
    controlled.clear();
    viewport?.layoutChanged(false);
    finishing = false;
    publishAnimating();
  };
  const paint = (now: number) => {
    const job = region;
    if (!job) return;
    job.startedAt ??= now;
    const t = animate() ? Math.min(1, (now - job.startedAt) / job.duration) : 1;
    const progress = 1 - (1 - t) ** 4;
    let remaining = job.from + (job.to - job.from) * progress;
    job.slideOffsets.clear();
    for (const [root, slide] of job.slides) {
      const offset = Math.round(slide.from + (slide.to - slide.from) * progress);
      writeSlide(root, { id: slide.id, height: slide.height, offset });
      job.slideOffsets.set(slide.id, (job.slideOffsets.get(slide.id) ?? 0) + offset);
    }
    for (const id of job.keys) {
      const survivor = job.survivors.get(id);
      const height = survivor
        ? survivor.from + (survivor.heldTo - survivor.from) * progress
        : Math.min(job.handoffs.get(id) ?? job.natural.get(id) ?? 0, Math.max(0, remaining));
      const space = job.spaces.get(id);
      const blank = space ? space.from + (space.to - space.from) * progress : 0;
      writeHeight(id, height + blank, blank);
      if (!survivor) remaining -= height;
    }
    for (const { indicator, from, to } of job.indicators)
      writeAngle(indicator, from + (to - from) * progress);
    viewport?.layoutChanged(t < 1);
    if (t < 1) frame = requestAnimationFrame(paint);
    else finish();
  };
  const reconcile = () => {
    queued = false;
    if (finishing || !list) return;
    if (!naturalDirty && !before && !indicatorDirty) return;
    naturalDirty = false;
    const changedIndicators = indicatorDirty;
    indicatorDirty = false;
    const state = list.getState();
    const natural = new Map<string, number>();
    const target = new Map<string, number>();
    for (const item of display) {
      const row = mounted.get(item.id);
      const index = state.indexByKey(item.id);
      const height =
        row?.content.offsetHeight ??
        (entering.has(item.id) ? measuredHeights.get(item.id) : undefined) ??
        (index === undefined ? undefined : state.sizeAtIndex(index)) ??
        heights.get(item.id) ??
        90;
      natural.set(item.id, height);
      if (row) measuredHeights.set(item.id, height);
      const disclosure =
        item.kind === "work" ||
        item.kind === "work-live" ||
        item.kind === "work-toggle" ||
        item.kind === "event";
      target.set(
        item.id,
        !desiredIds.has(item.id)
          ? 0
          : row && disclosure
            ? Math.max(
                0,
                height -
                  bodyHeight(row.content, "[data-motion-closing-body]") +
                  bodyHeight(row.content, "[data-motion-preview-measure]"),
              )
            : height,
      );
    }
    for (const [id, trim] of trims) {
      natural.set(id, Math.max(0, (natural.get(id) ?? 0) - trim.cut));
      if (!trim.opening) continue;
      const end = (target.get(id) ?? 0) - trim.cut;
      // A row closed while it opened keeps its content's shift, but no longer skips anything.
      if (end < (heights.get(id) ?? 0) - 1) trim.opening = false;
      else target.set(id, Math.max(0, end));
    }
    if (!initialized || !animate()) {
      for (const [id, height] of target) heights.set(id, height);
      initialized = true;
      entering = new Set();
      preparing = null;
      for (const indicator of indicators.values()) writeAngle(indicator, indicator.target);
      if (region || exits.size > 0 || settled.size > 0 || controlled.size > 0) finish();
      before = null;
      return;
    }
    preparing ??= new Set(
      [...entering].filter((id) => {
        if (!desiredIds.has(id) || mounted.has(id)) return false;
        const index = state.indexByKey(id);
        return index !== undefined && index >= state.startBuffered && index <= state.endBuffered;
      }),
    );
    if ([...preparing].some((id) => !mounted.has(id))) {
      before ??= new Map(heights);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      region = null;
      for (const id of preparing) writeHeight(id, before.get(id) ?? 0);
      onPins(new Set([...mounted.keys(), ...preparing]));
      publishAnimating();
      return;
    }
    if (
      region &&
      region.keys.every(
        (id) => Math.abs((region!.natural.get(id) ?? 0) - (natural.get(id) ?? 0)) < 1,
      ) &&
      !before &&
      !changedIndicators
    )
      return;
    const previous = before ?? new Map(heights);
    const changed = display.flatMap((item, index) => {
      const old = previous.get(item.id) ?? 0;
      const height = target.get(item.id) ?? 0;
      if (mounted.get(item.id)?.element.dataset.timelineStreaming === "true" && !before) {
        heights.set(item.id, height);
        return [];
      }
      return Math.abs(old - height) >= 1 ? [index] : [];
    });
    before = null;
    const movingIndicators = [...indicators.values()].flatMap((indicator) =>
      indicator.angle === indicator.target
        ? []
        : [{ indicator, from: indicator.angle, to: indicator.target }],
    );
    if (changed.length === 0 && movingIndicators.length === 0) {
      if (!region && (settled.size > 0 || controlled.size > 0)) finish();
      viewport?.layoutChanged(region !== null);
      return;
    }
    const regionRows = changed.length > 0 ? display.slice(changed[0], changed.at(-1)! + 1) : [];
    const keys = regionRows.map((item) => item.id);
    const survivors = new Map<string, { from: number; to: number; heldTo: number }>();
    const handoffs = new Map<string, number>();
    const trailingSpaces = new Map<string, number>();
    const previousContentHeight = (id: string) =>
      Math.max(0, (previous.get(id) ?? 0) - (spaces.get(id) ?? 0));
    const receives = (item: MessagesTimelineRow, next: MessagesTimelineRow | undefined) =>
      next?.kind === "work" &&
      next.groupId !== undefined &&
      "groupId" in item &&
      item.groupId === next.groupId &&
      !exits.has(next.id) &&
      previousContentHeight(next.id) === 0 &&
      (target.get(next.id) ?? 0) > 0;
    // Keep closing content stationary and transfer its trailing space back to the header at cleanup.
    // A row whose own content shrank shows it at once and closes the space it left under the clip.
    // A group header whose content moves into its entry rows opening below hands them its space.
    const closing = keys.some((id) => exits.has(id));
    for (const [index, item] of regionRows.entries()) {
      const { id } = item;
      if (exits.has(id) || !previous.has(id)) continue;
      const from = previousContentHeight(id);
      const to = target.get(id) ?? 0;
      if (!closing && to >= from) continue;
      if (!closing && receives(item, regionRows[index + 1])) {
        handoffs.set(id, to);
        continue;
      }
      const header = item.kind === "work-live" || item.kind === "work-toggle";
      let tail: string | undefined;
      if (closing && header && to > from) {
        for (let next = index + 1; next < regionRows.length; next += 1) {
          const nextId = regionRows[next]!.id;
          if (!exits.has(nextId)) break;
          tail = nextId;
        }
      }
      if (tail !== undefined) {
        trailingSpaces.set(tail, (trailingSpaces.get(tail) ?? 0) + to - from);
      }
      survivors.set(id, { from, to, heldTo: tail === undefined ? to : from });
    }
    const regionSlides = new Map<HTMLElement, Slide & { from: number; to: number }>();
    for (const id of keys) {
      const content = mounted.get(id)?.content;
      if (!content || exits.has(id)) continue;
      for (const root of content.querySelectorAll<HTMLElement>("[data-motion-slide]")) {
        const outer = root.closest("[data-motion-closing-body]");
        if (outer && content.contains(outer)) continue;
        const height = root.offsetHeight;
        regionSlides.set(root, { id, height, from: slides.get(root)?.offset ?? 0, to: height });
      }
    }
    for (const [root, { id, height, offset }] of slides) {
      if (regionSlides.has(root)) continue;
      if (root.isConnected && keys.includes(id))
        regionSlides.set(root, { id, height, from: offset, to: 0 });
      else writeSlide(root, null);
    }
    const moving = keys.filter((id) => !survivors.has(id));
    const from = moving.reduce((sum, id) => sum + previousContentHeight(id), 0);
    const to = moving.reduce((sum, id) => sum + (target.get(id) ?? 0), 0);
    const collapsed = new Map(
      keys.map((id) => {
        const start = previousContentHeight(id);
        const end = target.get(id) ?? 0;
        return [id, end < start ? end : Math.min(start, region?.collapsed.get(id) ?? start)];
      }),
    );
    region = {
      keys,
      natural,
      survivors,
      handoffs,
      spaces: new Map(
        keys.flatMap((id) => {
          const from = spaces.get(id) ?? 0;
          const to = trailingSpaces.get(id) ?? 0;
          return from || to ? [[id, { from, to }] as const] : [];
        }),
      ),
      slides: regionSlides,
      slideOffsets: new Map(),
      collapsed,
      from,
      to,
      indicators: movingIndicators,
      duration: durationOf({ from, to, survivors }),
      startedAt: null,
    };
    onPins(new Set(keys.filter((id) => mounted.has(id))));
    if (frame !== null) cancelAnimationFrame(frame);
    for (const id of keys) writeHeight(id, previous.get(id) ?? 0);
    viewport?.layoutChanged(true);
    frame = requestAnimationFrame(paint);
    publishAnimating();
  };
  const layoutChanged = () => {
    if (queued || finishing) return;
    queued = true;
    queueMicrotask(reconcile);
  };
  return {
    capture,
    layoutChanged,
    isAnimating: () => region !== null,
    /** Whether rows are animating or settled less than `SETTLE_BEAT_MS` ago. */
    isSettling: () => settling,
    subscribeSettling(listener: () => void) {
      settleListeners.add(listener);
      return () => {
        settleListeners.delete(listener);
      };
    },
    /**
     * Starts a closing row from its visible part: `above` (scrolled past) and `below` (out of
     * view) go at once, with a scroll that keeps what remains in place. Call as the animation
     * starts. `element` is what shifts up by `above`.
     */
    trimClosing(id: string, above: number, below: number, element: HTMLElement) {
      const job = region;
      const survivor = job?.survivors.get(id);
      const current = heights.get(id);
      if (!job || job.startedAt !== null || !survivor || current === undefined) return;
      const skipAbove = Math.max(0, Math.min(current, above));
      const cut = Math.min(current, skipAbove + Math.max(0, below));
      if (cut < 1) return;
      survivor.from = Math.max(survivor.to, survivor.from - cut);
      job.natural.set(id, Math.max(0, (job.natural.get(id) ?? current) - cut));
      job.duration = durationOf(job);
      if (skipAbove < current) shift(element, skipAbove);
      trims.set(id, { element, cut, above: skipAbove, opening: false });
      writeHeight(id, current - cut);
      if (skipAbove > 0 && viewport) viewport.scrollNode.scrollTop -= skipAbove;
    },
    /**
     * Ends an opening row at its visible part: `above` will be scrolled past once it has opened,
     * so it opens with `element` shifted up by that much, and cleanup adds it back with a scroll
     * that keeps the view in place; `below` will end out of view and appears at cleanup. Call as
     * the animation starts.
     */
    trimOpening(id: string, above: number, below: number, element: HTMLElement) {
      const job = region;
      if (!job || job.startedAt !== null || !job.keys.includes(id) || job.survivors.has(id)) return;
      const natural = job.natural.get(id) ?? 0;
      const growth = natural - (heights.get(id) ?? 0);
      const skipAbove = Math.max(0, Math.min(growth, above));
      const cut = Math.min(growth, skipAbove + Math.max(0, below));
      if (cut < 1) return;
      job.natural.set(id, natural - cut);
      job.to -= cut;
      job.duration = durationOf(job);
      shift(element, skipAbove);
      trims.set(id, { element, cut, above: skipAbove, opening: true });
    },
    registerIndicator(element: SVGSVGElement) {
      const angle = element.dataset.expanded === "true" ? 90 : 0;
      const indicator = { element, angle, target: angle };
      indicators.set(element, indicator);
      writeAngle(indicator, angle);
      return () => {
        indicators.delete(element);
      };
    },
    setIndicatorExpanded(element: SVGSVGElement, expanded: boolean) {
      const indicator = indicators.get(element);
      const target = expanded ? 90 : 0;
      if (!indicator || indicator.target === target) return;
      indicator.target = target;
      indicatorDirty = true;
      layoutChanged();
    },
    setRows(
      rows: readonly MessagesTimelineRow[],
      source: readonly MessagesTimelineRow[],
      departing: ReadonlySet<string>,
      reset: boolean,
    ) {
      if (!reset && desired !== source) capture();
      if (reset) {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        region = null;
        before = null;
        heights.clear();
        measuredHeights.clear();
        spaces.clear();
        clearSlides();
        clearTrims();
        controlled.clear();
        for (const indicator of indicators.values()) writeAngle(indicator, indicator.target);
        indicatorDirty = false;
        initialized = false;
        for (const row of mounted.values()) {
          row.element.style.height = "";
          row.element.style.overflow = "";
          row.element.style.maskImage = "";
        }
        publishSettling(false);
      }
      display = rows;
      // A row that leaves without an exit, such as while motion is off, opens again from nothing.
      const displayIds = new Set(rows.map((row) => row.id));
      for (const id of heights.keys()) if (!displayIds.has(id)) heights.delete(id);
      const nextIds = new Set(source.map((row) => row.id));
      if (
        reset ||
        nextIds.size !== desiredIds.size ||
        [...nextIds].some((id) => !desiredIds.has(id))
      )
        preparing = null;
      entering = new Set(
        [...entering, ...nextIds].filter((id) => !desiredIds.has(id) || entering.has(id)),
      );
      desired = source;
      desiredIds = nextIds;
      exits = departing;
      naturalDirty = true;
      layoutChanged();
    },
    attach(
      nextViewport: Pick<TimelineViewport, "scrollNode" | "layoutChanged">,
      nextList: LayoutList,
    ) {
      viewport = nextViewport;
      list = nextList;
      const onVisibility = () => {
        if (!document.hidden) return;
        if (region || preparing?.size) finish();
        else publishSettling(false);
      };
      document.addEventListener("visibilitychange", onVisibility);
      return () => {
        document.removeEventListener("visibilitychange", onVisibility);
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        publishSettling(false);
        viewport = null;
        list = null;
      };
    },
    register(id: string, element: HTMLElement, content: HTMLElement) {
      const row = { element, content, width: element.offsetWidth };
      mounted.set(id, row);
      measuredHeights.set(id, content.offsetHeight);
      if ((!desiredIds.has(id) || entering.has(id)) && initialized && animate())
        writeHeight(id, heights.get(id) ?? 0);
      else if (!before && !region) heights.set(id, content.offsetHeight);
      if (region?.keys.includes(id)) writeHeight(id, heights.get(id) ?? 0);
      const stop = observeResize(content, () => {
        row.width = element.offsetWidth;
        naturalDirty = true;
        layoutChanged();
      });
      naturalDirty = true;
      layoutChanged();
      return () => {
        stop();
        if (mounted.get(id) === row) mounted.delete(id);
      };
    },
    afterSettled(callback: () => void) {
      settled.add(callback);
      naturalDirty = true;
      layoutChanged();
      return () => {
        settled.delete(callback);
      };
    },
  };
}
