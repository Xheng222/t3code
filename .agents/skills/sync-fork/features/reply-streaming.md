---
change: pxklsrno
retention: permanent
summary: "Web/desktop reply presentation: client-side pacing independent of incoming packet size, adaptive speed (80 normal / 200 maximum source graphemes per second), a 180 ms text fade, and incremental Markdown/code rendering."
watch:
  - apps/web/src/components/ChatMarkdown.tsx
  - apps/web/src/components/chat/TimelineAssistantRows.tsx
---

# Reply streaming

## Behavior

Preserve stable completed Markdown blocks and code lines. History, interrupted replies, find/citation navigation, reduced motion, and hidden pages show received text immediately; normal completion drains pending text. Keep this frontend feature independent of `quzytuxx`.

## Upstream files

- `apps/web/src/components/ChatMarkdown.tsx`: a reply that has streamed keeps rendering by blocks (`hasStreamed`), so finishing it keeps its DOM and does not replay the fade. `StreamingMarkdown` passes every prop through; when upstream changes this file, check that new behavior still applies through the wrapper.
- `apps/web/src/components/chat/TimelineAssistantRows.tsx`: the assistant row renders `StreamingMarkdown`, keyed by thread and message, with the text and pacing props from `useForkAssistantText`. When upstream changes this file, check that new text rules, such as empty or suppressed replies, still apply through the hook.
- `apps/web/src/components/chat/MessagesTimeline.tsx`: `useForkTimelinePresentation` tracks the replies seen when the visit opened and those still revealing. `useForkTimeline` replaces `useStableRows`, `withRowFrame` provides the fork row context, and the row state is part of the list's extra data, so rows re-render when it changes.
- `apps/web/test/appScenarios.renders.tsx`: the streaming scenario allows the assistant row at most one render per delta, since paced reveal renders it on its own clock.
- `apps/web/src/components/chat/HighlightedCodeLines.tsx`: rewritten to append changed tail lines to the code element directly, so completed lines keep their DOM and selection on every frame. On conflict, keep the fork version and carry over upstream's intent.
- `apps/web/src/lib/incrementalHighlighting.ts`, `apps/web/src/lib/incrementalHighlighting.test.ts`, `apps/web/src/components/chat/MarkdownCodeBlock.tsx`: the highlighter ignores the display newline Markdown appends to an unfinished fence, so one stream tokenizer serves the whole block.
- `apps/web/src/components/chat/markdownStreamBlocks.ts`, `apps/web/src/components/chat/markdownStreamBlocks.test.tsx`: also cut after a closed top-level fence and before a fence opener, so finished code blocks stay stable while text follows.
- `apps/web/src/components/chat/markdownSyntaxGates.ts`, `apps/web/src/components/chat/markdownRenderer.test.tsx`: while a reply is one open fence, the parser returns a code node without reparsing the growing body; the test checks that every prefix renders as a full parse does.
- `apps/web/src/index.css`: incremental code lines lay out as block lines, and inside a presentation the paced fade replaces upstream's per-block fade.
