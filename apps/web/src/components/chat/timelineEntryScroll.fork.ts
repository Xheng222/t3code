import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  resolveDisclosureRevealScrollDelta,
} from "./timelineScrollAnchoring";
import type { TimelineViewport } from "./timelineViewport";

type EntryScroll = {
  /** The motion row of the toggled entry or row. */
  readonly row: HTMLElement;
  trimmed: boolean;
} & (
  | {
      readonly kind: "reveal";
      /** Where the opened content starts. */
      readonly head: HTMLElement;
      /** Where it ends: `null` past the rendered rows, `undefined` until it renders. */
      readonly end: () => HTMLElement | null | undefined;
      /** An opened entry, whose animation is trimmed to the part that ends in view. */
      readonly entry: HTMLElement | null;
      /** Whether it scrolls, or only trims while follow scrolls. */
      readonly scrolls: boolean;
      readonly clearance: number;
    }
  | {
      readonly kind: "hold";
      readonly entry: HTMLElement;
      readonly line: HTMLElement;
      /** Where the collapsed row ends, below the held line, from the top of the scroll node. */
      readonly floor: number;
    }
);

/**
 * Keeps toggled content in view while its height animates: opening content rises from under the
 * composer by upstream's disclosure reveal rule, and an entry closed from its stuck line keeps that
 * line in place. A reveal outlives its animation because fetched output can grow it later;
 * navigation or the next toggle ends either.
 */
export function attachTimelineEntryScroll(
  viewport: TimelineViewport,
  options: {
    readonly composerInset: () => number;
    /** The gap the list leaves below its last row, kept below revealed content too. */
    readonly endClearance: () => number;
    readonly isAnimating: () => boolean;
    readonly trimClosing: (id: string, above: number, below: number, element: HTMLElement) => void;
    readonly trimOpening: (id: string, above: number, below: number, element: HTMLElement) => void;
    /** The list must not anchor its visible content while a line is held. */
    readonly onHold: (holding: boolean) => void;
  },
) {
  const node = viewport.scrollNode;
  let scroll: EntryScroll | null = null;
  let queued = false;
  const stop = () => {
    if (scroll?.kind === "hold") options.onHold(false);
    scroll = null;
  };
  const rowOf = (element: HTMLElement) =>
    element.closest<HTMLElement>("[data-timeline-motion-row]");
  const lineTop = (element: HTMLElement) =>
    element.getBoundingClientRect().top +
    (Number.parseFloat(getComputedStyle(element).paddingTop) || 0);
  const revealDelta = (top: number, bottom: number, clearance: number) => {
    const viewportTop = node.getBoundingClientRect().top;
    return resolveDisclosureRevealScrollDelta({
      rowTop: top,
      rowBottom: bottom,
      viewportTop,
      viewportBottom: viewportTop + node.clientHeight,
      composerOverlayHeight: options.composerInset() + clearance,
      anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
    });
  };
  const trim = (current: EntryScroll) => {
    current.trimmed = true;
    const id = current.row.dataset.timelineMotionRow;
    const body = current.entry?.querySelector<HTMLElement>("[data-motion-disclosure]");
    if (!current.entry || !id || !body) return;
    const top = node.getBoundingClientRect().top;
    const visibleBottom = top + node.clientHeight - options.composerInset();
    if (current.kind === "hold") {
      const above = current.line.getBoundingClientRect().top - lineTop(current.entry);
      const below = current.row.getBoundingClientRect().bottom - visibleBottom;
      options.trimClosing(id, above, Math.max(0, below), body);
      return;
    }
    // The entry already has its opened height under the row's clip.
    const line = lineTop(current.entry);
    const bottom = current.entry.getBoundingClientRect().bottom;
    const end = visibleBottom - current.clearance;
    // Follow keeps the end in view.
    const reveal = current.scrolls
      ? revealDelta(line, bottom, current.clearance)
      : Math.max(0, bottom - end);
    options.trimOpening(id, top - (line - reveal), bottom - reveal - end, body);
  };
  const step = () => {
    queued = false;
    const current = scroll;
    if (!current) return;
    if (
      !current.row.isConnected ||
      !(current.kind === "reveal" ? current.head : current.line).isConnected
    )
      return stop();
    if (!current.trimmed && options.isAnimating()) trim(current);
    if (current.kind === "reveal") {
      if (!current.scrolls) return;
      const end = current.end();
      if (end === undefined) return;
      // A row's animated height clips its content until it has fully opened.
      const bottom = end
        ? Math.min(
            end.getBoundingClientRect().bottom,
            rowOf(end)?.getBoundingClientRect().bottom ?? Infinity,
          )
        : Infinity;
      const delta = revealDelta(lineTop(current.head), bottom, current.clearance);
      if (delta <= 1) return;
      // A height animation eases the scroll that tracks it frame by frame.
      const instant =
        options.isAnimating() || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      node.scrollBy({ top: delta, behavior: instant ? "instant" : "smooth" });
      return;
    }
    const top = node.getBoundingClientRect().top;
    const shortfall = top + current.floor - current.row.getBoundingClientRect().bottom;
    if (shortfall > 0.5) node.scrollTop -= shortfall;
    if (current.line.dataset.sticky === undefined && !options.isAnimating()) stop();
  };
  const stopNavigation = viewport.subscribe(stop);
  const stopLayout = viewport.onLayoutChanged(() => {
    if (!scroll || queued) return;
    queued = true;
    queueMicrotask(step);
  });
  return {
    /** An opening entry; `scrolls: false` leaves scrolling to follow, which goes at least as far. */
    reveal(entry: HTMLElement, { scrolls = true }: { readonly scrolls?: boolean } = {}) {
      stop();
      const row = rowOf(entry);
      if (!row) return;
      const clearance = options.endClearance();
      const end = () => entry;
      scroll = { kind: "reveal", row, head: entry, end, entry, scrolls, clearance, trimmed: false };
    },
    /** Opening rows, from the top of the motion row `row` down to what `end` finds. */
    revealRows(row: HTMLElement, end: () => HTMLElement | null | undefined) {
      stop();
      const clearance = options.endClearance();
      scroll = {
        kind: "reveal",
        row,
        head: row,
        end,
        entry: null,
        scrolls: true,
        clearance,
        trimmed: false,
      };
    },
    hold(entry: HTMLElement, line: HTMLElement) {
      stop();
      const row = rowOf(entry);
      const content = row?.firstElementChild;
      if (!row || !content) return;
      const below =
        content.getBoundingClientRect().bottom -
        entry.getBoundingClientRect().bottom +
        (Number.parseFloat(getComputedStyle(entry).paddingBottom) || 0);
      const floor = line.getBoundingClientRect().bottom - node.getBoundingClientRect().top + below;
      scroll = { kind: "hold", entry, line, row, floor, trimmed: false };
      options.onHold(true);
    },
    stop,
    dispose() {
      stop();
      stopNavigation();
      stopLayout();
    },
  };
}
