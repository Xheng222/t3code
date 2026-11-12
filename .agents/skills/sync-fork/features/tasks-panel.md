---
change: lworkqus
retention: permanent
summary: "Web/desktop Tasks panel: the thread's latest unfinished todo list shows beside thread details instead of in the timeline."
---

# Tasks panel

## Behavior

The panel shows the latest todo list that is not superseded, by run and then by turn item, while any step is unfinished; completed or empty lists hide it, and drafts have none. Todo lists do not appear in the timeline.

## Upstream files

- `apps/web/src/components/chat/ThreadDetailsCard.tsx`, `apps/web/src/components/chat/ThreadDetailsCard.browser.test.tsx`: an `after` slot stacks content below the card, inline and in the popover. Its height counts toward the card's density, so a tall panel makes the card compact instead of overflowing.
- `apps/web/src/components/chat/ThreadDetailsPanel.tsx`: passes `ThreadTasksPanel` as the card's `after` content, except for drafts.
- `apps/web/src/components/chat/ThreadTimeline.tsx`: filters `todo_list` work entries out of the timeline.
