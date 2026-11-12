import { observeResize } from "../../lib/observeResize";

type TextSegment = { node: Text; start: number; length: number; ends: number[] | undefined };
type Rect = { left: number; top: number; right: number; bottom: number };
type Cohort = { start: number; end: number; born: number };
type Region = Rect & { color: string; born: number };

export const STREAMING_FADE_DURATION_MS = 180;
const LEVELS = [0.08, 0.22, 0.39, 0.56, 0.7, 0.8, 0.88, 0.94, 0.98, 1];

export function attachStreamingFade(root: HTMLElement) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const pixel = document.createElement("canvas");
  pixel.width = pixel.height = 1;
  const parser = pixel.getContext("2d", { willReadFrequently: true });
  if (!parser) return;
  const colors = new Map<string, { alpha: number; rgb: string }>();
  let cohorts: Cohort[] = [];
  let regions: Region[] = [];
  let previous: number | undefined;
  let lastUpdate = performance.now();
  let lastPaint = -Infinity;
  let frame: number | undefined;
  let queued = false;
  let disposed = false;
  let canvas: HTMLCanvasElement | undefined;
  let context: CanvasRenderingContext2D | null = null;
  let width = 0;
  let height = 0;
  let top = 0;
  let measured: { width: number; height: number } | undefined;

  function clear() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    cohorts = [];
    regions = [];
    if (canvas) {
      canvas.hidden = true;
      canvas.width = canvas.height = 0;
    }
  }

  function schedule() {
    if (frame !== undefined || queued || !regions.length) return;
    queued = true;
    // Let newly published text take precedence over a fade frame.
    queueMicrotask(() => {
      queued = false;
      if (!disposed && regions.length && frame === undefined)
        frame = requestAnimationFrame(animate);
    });
  }

  function parse(color: string) {
    const cached = colors.get(color);
    if (cached) return cached;
    parser!.clearRect(0, 0, 1, 1);
    parser!.fillStyle = color;
    parser!.fillRect(0, 0, 1, 1);
    const [r, g, b, alpha] = parser!.getImageData(0, 0, 1, 1).data;
    const value = { alpha: alpha!, rgb: `rgb(${r} ${g} ${b})` };
    if (colors.size >= 32) colors.clear();
    colors.set(color, value);
    return value;
  }

  function paint(now: number) {
    lastPaint = now;
    cohorts = cohorts.filter((item) => now - item.born < STREAMING_FADE_DURATION_MS);
    regions = regions.filter((item) => now - item.born < STREAMING_FADE_DURATION_MS);
    if (!regions.length || !canvas || !context) return clear();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    for (const rect of regions) {
      const progress =
        Math.max(0, Math.min(1, (now - rect.born) / STREAMING_FADE_DURATION_MS)) *
        (LEVELS.length - 1);
      const index = Math.floor(progress);
      const level =
        LEVELS[index]! + ((LEVELS[index + 1] ?? 1) - LEVELS[index]!) * (progress - index);
      context.clearRect(rect.left, rect.top - top, rect.right - rect.left, rect.bottom - rect.top);
      context.globalAlpha = 1 - level;
      context.fillStyle = rect.color;
      context.fillRect(rect.left, rect.top - top, rect.right - rect.left, rect.bottom - rect.top);
    }
    schedule();
  }

  function animate() {
    frame = undefined;
    const now = performance.now();
    if (now - lastPaint >= 1000 / 60 - 1) paint(now);
    else schedule();
  }

  function update(segments: TextSegment[], shown: number) {
    const now = performance.now();
    const selection = window.getSelection();
    const selected =
      selection &&
      !selection.isCollapsed &&
      selection.rangeCount > 0 &&
      selection.getRangeAt(0).intersectsNode(root);
    const skip = previous === undefined || shown < previous || motion.matches || selected;
    if (skip) clear();
    else if (shown > previous!)
      cohorts.push({
        start: Math.max(previous!, shown - 512),
        end: shown,
        born: now - Math.min(50, now - lastUpdate) / 2,
      });
    previous = shown;
    lastUpdate = now;
    cohorts = cohorts.filter((item) => now - item.born < STREAMING_FADE_DURATION_MS);
    if (!cohorts.length) return clear();

    const bounds = root.getBoundingClientRect();
    measured = { width: bounds.width, height: bounds.height };
    const styles = new Map<Element, CSSStyleDeclaration>();
    const backgrounds = new Map<Element, string | undefined>();
    const clips = new Map<Element, Rect | undefined>();
    const style = (element: Element) => {
      let value = styles.get(element);
      if (!value) {
        value = getComputedStyle(element);
        styles.set(element, value);
      }
      return value;
    };
    const background = (element: Element | null): string | undefined => {
      if (!element) return;
      if (backgrounds.has(element)) return backgrounds.get(element);
      const css = style(element);
      let value: string | undefined;
      if (css.backgroundImage === "none") {
        const own = parse(css.backgroundColor);
        if (own.alpha === 255) value = own.rgb;
        else {
          value = background(element.parentElement);
          if (value && own.alpha) {
            parser!.clearRect(0, 0, 1, 1);
            parser!.fillStyle = value;
            parser!.fillRect(0, 0, 1, 1);
            parser!.fillStyle = css.backgroundColor;
            parser!.fillRect(0, 0, 1, 1);
            const [r, g, b] = parser!.getImageData(0, 0, 1, 1).data;
            value = `rgb(${r} ${g} ${b})`;
          }
        }
      }
      backgrounds.set(element, value);
      return value;
    };
    const clip = (element: HTMLElement): Rect | undefined => {
      if (clips.has(element)) return clips.get(element);
      const parent =
        element === root || !element.parentElement ? bounds : clip(element.parentElement);
      const css = style(element);
      if (
        !parent ||
        (element !== root &&
          (Number(css.opacity) < 1 ||
            css.filter !== "none" ||
            css.mixBlendMode !== "normal" ||
            css.transform !== "none" ||
            css.backdropFilter !== "none" ||
            css.maskImage !== "none"))
      ) {
        clips.set(element, undefined);
        return;
      }
      let value: Rect = parent;
      if (css.overflowX !== "visible" || css.overflowY !== "visible") {
        const box = element.getBoundingClientRect();
        value = { left: parent.left, top: parent.top, right: parent.right, bottom: parent.bottom };
        if (css.overflowX !== "visible") {
          value.left = Math.max(parent.left, box.left + element.clientLeft);
          value.right = Math.min(parent.right, box.left + element.clientLeft + element.clientWidth);
        }
        if (css.overflowY !== "visible") {
          value.top = Math.max(parent.top, box.top + element.clientTop);
          value.bottom = Math.min(
            parent.bottom,
            box.top + element.clientTop + element.clientHeight,
          );
        }
      }
      clips.set(element, value);
      return value;
    };
    regions = [];
    for (const cohort of cohorts)
      for (const segment of segments) {
        const start = Math.max(cohort.start, segment.start) - segment.start;
        const end = Math.min(cohort.end, segment.start + segment.length) - segment.start;
        if (end <= start || !segment.node.parentElement) continue;
        const color = background(segment.node.parentElement);
        if (!color) continue;
        const range = document.createRange();
        range.setStart(segment.node, segment.ends ? segment.ends[start]! : start);
        range.setEnd(segment.node, segment.ends ? segment.ends[end]! : end);
        const clipped = clip(segment.node.parentElement);
        if (!clipped) continue;
        for (const rect of range.getClientRects()) {
          if (
            rect.bottom <= 0 ||
            rect.top >= innerHeight ||
            rect.right <= 0 ||
            rect.left >= innerWidth
          )
            continue;
          const left = Math.max(rect.left, clipped.left) - bounds.left;
          const right = Math.min(rect.right, clipped.right) - bounds.left;
          const y = Math.max(rect.top, clipped.top) - bounds.top;
          const bottom = Math.min(rect.bottom, clipped.bottom) - bounds.top;
          if (right > left && bottom > y)
            regions.push({ left, right, top: y, bottom, color, born: cohort.born });
        }
      }
    if (!regions.length) return clear();
    top = Math.min(...regions.map((rect) => rect.top));
    height = Math.max(...regions.map((rect) => rect.bottom)) - top;
    width = bounds.width;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.dataset.streamingFadeOverlay = "";
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.cssText = "position:absolute;left:0;pointer-events:none;z-index:1;width:100%";
      // A small software surface avoids allocating a GPU canvas context for this overlay.
      context = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!context) return clear();
    if (canvas.parentElement !== root) root.append(canvas);
    const scale = Math.min(devicePixelRatio || 1, 2);
    const pixelsWide = Math.ceil(width * scale);
    const pixelsHigh = Math.max(canvas.height, Math.ceil((height * scale) / 32) * 32);
    if (canvas.width !== pixelsWide) canvas.width = pixelsWide;
    if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
    canvas.style.top = `${top}px`;
    canvas.style.height = `${height}px`;
    canvas.hidden = false;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    paint(performance.now());
  }

  const onSelection = () => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) clear();
  };
  const events = ["pointerdown", "wheel", "scroll", "keydown"] as const;
  for (const event of events) root.addEventListener(event, clear, { capture: true, passive: true });
  document.addEventListener("selectionchange", onSelection);
  window.addEventListener("resize", clear);
  motion.addEventListener("change", clear);
  const theme = new MutationObserver(clear);
  theme.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme", "data-appearance"],
  });
  const stopResize = observeResize(root, (entries) => {
    const box = entries[0]?.borderBoxSize[0];
    if (
      box &&
      measured &&
      (Math.abs(box.inlineSize - measured.width) > 1 ||
        Math.abs(box.blockSize - measured.height) > 1)
    )
      clear();
  });
  return {
    update,
    dispose: () => {
      disposed = true;
      clear();
      canvas?.remove();
      stopResize();
      theme.disconnect();
      for (const event of events) root.removeEventListener(event, clear, true);
      document.removeEventListener("selectionchange", onSelection);
      window.removeEventListener("resize", clear);
      motion.removeEventListener("change", clear);
    },
  };
}
