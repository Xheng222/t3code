import { attachStreamingFade } from "./streamingFade.fork";

type Progress = { visible: number; received: number; complete: boolean };

export function attachStreamingReveal(
  root: HTMLElement,
  subscribe: (listener: () => void) => () => void,
  progress: () => Progress,
  fadeIn = true,
) {
  const fade = fadeIn ? attachStreamingFade(root) : undefined;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const originals = new WeakMap<Text, { full: string; applied: string }>();
  const displays = new WeakMap<Element, { value: string; priority: string; hidden: boolean }>();
  let texts: {
    node: Text;
    full: string;
    start: number;
    ends: number[] | undefined;
    length: number;
  }[] = [];
  let elements: { node: HTMLElement | SVGElement; start: number; end: number }[] = [];
  let total = 0;
  let shown = 0;
  let changed = true;

  function rebuild() {
    texts = [];
    elements = [];
    total = 0;
    const visit = (node: Node) => {
      if (node instanceof Text) {
        const previous = originals.get(node);
        const full = previous && node.data === previous.applied ? previous.full : node.data;
        const ends = /^[\x00-\x09\x0A-\x0C\x0E-\x7F]*$/.test(full)
          ? undefined
          : [0, ...Array.from(segmenter.segment(full), (part) => part.index + part.segment.length)];
        const length = ends ? ends.length - 1 : full.length;
        texts.push({ node, full, start: total, ends, length });
        originals.set(node, { full, applied: node.data });
        total += length;
        return;
      }
      if (!(node instanceof HTMLElement || node instanceof SVGElement)) return;
      if (node.hasAttribute("data-streaming-fade-overlay")) return;
      const start = total;
      const decorative =
        node.hasAttribute("data-thread-find-ignore") || node.getAttribute("aria-hidden") === "true";
      if (!decorative) {
        if (node.matches("svg,img,video,audio,canvas,iframe,math,hr,input,br")) total += 1;
        else for (const child of node.childNodes) visit(child);
      }
      if (node.tagName === "SPAN" && !node.getAttribute("class")) return;
      if (!displays.has(node))
        displays.set(node, {
          value: node.style.getPropertyValue("display"),
          priority: node.style.getPropertyPriority("display"),
          hidden: false,
        });
      elements.push({ node, start, end: total });
    };
    for (const child of root.childNodes) visit(child);
    changed = false;
  }

  function display(node: HTMLElement | SVGElement, visible: boolean) {
    const original = displays.get(node)!;
    if (original.hidden === !visible) return;
    const value = visible ? original.value : "none";
    const priority = visible ? original.priority : "important";
    if (
      node.style.getPropertyValue("display") !== value ||
      node.style.getPropertyPriority("display") !== priority
    ) {
      if (value) node.style.setProperty("display", value, priority);
      else node.style.removeProperty("display");
    }
    original.hidden = !visible;
  }

  const observer = new MutationObserver(() => {
    changed = true;
    present();
  });
  const observe = () =>
    observer.observe(root, { childList: true, characterData: true, subtree: true });

  function present() {
    if (observer.takeRecords().length) changed = true;
    observer.disconnect();
    if (changed) rebuild();
    const state = progress();
    const next = state.complete
      ? total
      : Math.floor((total * state.visible) / Math.max(1, state.received));
    shown = Math.max(Math.min(shown, total), next);
    for (const entry of elements)
      display(entry.node, shown > entry.start || (state.complete && entry.end === entry.start));
    for (const entry of texts) {
      const count = Math.max(0, Math.min(entry.length, shown - entry.start));
      const end = entry.ends ? entry.ends[count]! : count;
      const value = entry.full.slice(0, end);
      const original = originals.get(entry.node)!;
      if (original.applied !== value) {
        if (value.startsWith(original.applied))
          entry.node.appendData(value.slice(original.applied.length));
        else if (original.applied.startsWith(value))
          entry.node.deleteData(value.length, original.applied.length - value.length);
        else entry.node.data = value;
      }
      original.applied = value;
    }
    fade?.update(texts, shown);
    observe();
  }

  const unsubscribe = subscribe(present);
  present();
  return {
    refresh: () => {
      changed = true;
      present();
    },
    dispose: () => {
      unsubscribe();
      observer.disconnect();
      fade?.dispose();
      for (const entry of texts) entry.node.data = entry.full;
      for (const entry of elements) display(entry.node, true);
      texts = [];
      elements = [];
    },
  };
}
