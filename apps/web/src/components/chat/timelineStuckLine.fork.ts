/**
 * Marks a sticky `line` `data-stuck` while it is stuck at the top of `root` and on screen, and
 * `root` `data-entry-stuck` while any of its lines is.
 */
export function observeStuckLine(line: HTMLElement, root: HTMLElement) {
  const mark = (stuck: boolean) => {
    if (stuck === line.hasAttribute("data-stuck")) return;
    line.toggleAttribute("data-stuck", stuck);
    root.toggleAttribute("data-entry-stuck", root.querySelector("[data-stuck]") !== null);
  };
  // The observed edge sits 1px below the top, so a line crosses it as it sticks. Leaving the root,
  // as when the end of its row pushes it out, ends it.
  const observer = new IntersectionObserver(
    (records) => {
      const record = records.at(-1);
      if (!record?.rootBounds) return;
      mark(record.isIntersecting && record.boundingClientRect.top < record.rootBounds.top);
    },
    { root, rootMargin: "-1px 0px 0px 0px", threshold: [0, 1] },
  );
  observer.observe(line);
  return () => {
    observer.disconnect();
    mark(false);
  };
}
