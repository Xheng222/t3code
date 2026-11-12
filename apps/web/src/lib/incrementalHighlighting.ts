import {
  renderTokenLines,
  type DiffsHighlighter,
  type DiffsThemeNames,
  type ThemedToken,
  type TokensResult,
} from "@pierre/diffs";

const LINE_BREAK = { type: "text" as const, value: "\n" };

function highlightedDocument(
  result: TokensResult,
  lines = renderTokenLines(result.tokens, {}),
): { type: "root"; children: ReturnType<typeof renderTokenLines> } {
  const children: ReturnType<typeof renderTokenLines> = [];
  for (const line of lines) {
    if (children.length > 0) children.push(LINE_BREAK);
    children.push(line);
  }
  return {
    type: "root" as const,
    children: [
      {
        type: "element" as const,
        tagName: "pre",
        properties: {
          class: "diffs",
          style:
            result.rootStyle === false
              ? undefined
              : (result.rootStyle ??
                [
                  result.fg != null ? `color:${result.fg}` : "",
                  result.bg != null ? `background-color:${result.bg}` : "",
                ]
                  .filter(Boolean)
                  .join(";")),
          tabIndex: 0,
        },
        children: [
          {
            type: "element" as const,
            tagName: "code",
            properties: {},
            children,
          },
        ],
      },
    ],
  };
}

export function highlightCodeToHast(
  highlighter: DiffsHighlighter,
  code: string,
  language: string,
  theme: DiffsThemeNames,
) {
  return highlightedDocument(highlighter.codeToTokens(code, { lang: language, theme }));
}

export function createIncrementalHighlightedDocument(
  highlighter: DiffsHighlighter,
  language: string,
  theme: DiffsThemeNames,
  syntheticTrailingNewline = false,
) {
  const options = { lang: language, theme };
  let shell: TokensResult | undefined;
  let tokenizer: ReturnType<DiffsHighlighter["createStreamTokenizer"]> | undefined;
  let previous = "";
  const completedLines: ReturnType<typeof renderTokenLines> = [];

  function dispose() {
    tokenizer?.dispose();
    tokenizer = undefined;
    previous = "";
    completedLines.length = 0;
  }

  return Object.assign(
    (code: string) => {
      // ANSI and partial CRLF sequences need the full-source normalization path.
      if (language === "ansi" || code.includes("\r")) {
        dispose();
        return highlightCodeToHast(highlighter, code, language, theme);
      }
      // Markdown adds a display newline that moves as its unfinished final line grows.
      const trailingNewline = syntheticTrailingNewline && code.endsWith("\n");
      const source = trailingNewline ? code.slice(0, -1) : code;
      if (!source.startsWith(previous)) dispose();
      // Created on first use so an unknown language throws inside the caller's fallback.
      shell ??= highlighter.codeToTokens("", options);
      tokenizer ??= highlighter.createStreamTokenizer(options);
      const update = tokenizer.enqueue(source.slice(previous.length));
      if (update instanceof Promise) {
        dispose();
        void update.catch(() => {});
        return highlightCodeToHast(highlighter, code, language, theme);
      }
      previous = source;
      let line: ThemedToken[] = [];
      for (const token of update.stable) {
        if (token.content === "\n") {
          completedLines.push(...renderTokenLines([line], {}));
          line = [];
        } else line.push(token);
      }
      // Completed line nodes retain their identity while the final line changes.
      return highlightedDocument(shell, [
        ...completedLines,
        ...renderTokenLines(trailingNewline ? [update.unstable, []] : [update.unstable], {}),
      ]);
    },
    { dispose },
  );
}
