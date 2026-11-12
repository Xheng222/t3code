import { toHtml } from "hast-util-to-html";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { isValidElement, useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

import type { highlightCodeToHast } from "../../lib/incrementalHighlighting";

type HighlightedRoot = ReturnType<typeof highlightCodeToHast>;
type HighlightedNode = HighlightedRoot["children"][number];
const runtime = { Fragment, jsx, jsxs };

function elementShell(node: Extract<HighlightedNode, { type: "element" }>) {
  const element = toJsxRuntime({ ...node, children: [] }, runtime);
  if (!isValidElement<HTMLAttributes<HTMLElement>>(element)) {
    throw new Error("Expected a highlighted code element");
  }
  return element;
}

/** Preserve completed lines' DOM to avoid reparsing unchanged tokens. */
export function HighlightedCodeLines({ root }: { root: HighlightedRoot }) {
  const codeRef = useRef<HTMLElement>(null);
  const rendered = useRef<HighlightedNode[]>([]);
  const pre = root.children[0];
  const code = pre?.type === "element" && pre.tagName === "pre" ? pre.children[0] : undefined;
  const lines = code?.type === "element" && code.tagName === "code" ? code.children : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes highlighted tail nodes without recreating completed lines or their selections
  useLayoutEffect(() => {
    const target = codeRef.current;
    if (!target || !lines) return;
    const previous = rendered.current;
    let unchanged = 0;
    while (unchanged < previous.length && unchanged < lines.length) {
      const before = previous[unchanged]!;
      const after = lines[unchanged]!;
      if (
        before !== after &&
        !(before.type === "text" && after.type === "text" && before.value === after.value)
      )
        break;
      unchanged += 1;
    }
    while (target.childNodes.length > unchanged) target.lastChild?.remove();
    if (unchanged < lines.length) {
      target.insertAdjacentHTML(
        "beforeend",
        toHtml({ type: "root", children: lines.slice(unchanged) }),
      );
    }
    rendered.current = lines;
  }, [lines]);
  if (pre?.type !== "element" || code?.type !== "element" || !lines)
    return toJsxRuntime(root, runtime);
  return (
    <pre {...elementShell(pre).props}>
      <code {...elementShell(code).props} ref={codeRef} data-incremental />
    </pre>
  );
}
