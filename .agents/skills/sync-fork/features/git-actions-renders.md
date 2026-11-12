---
change: mqsrnwxl
retention: temporary
summary: "Git actions control re-renders only when the thread's branch or whether it has a run changes, not on every thread update."
---

# Git actions renders

## Behavior

`GitActionsControl` subscribes to the thread's branch and whether it has a run, through selector overloads of `useQuietThreadShell` and `useQuietThreadProjection`.

## Upstream coverage

Covered when upstream's `GitActionsControl` stops re-rendering on thread updates that change neither of those.
