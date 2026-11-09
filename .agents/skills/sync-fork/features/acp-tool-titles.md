---
change: zmnzlvkr
retention: temporary
summary: "Preserve ACP tool titles when result-only updates omit tool identity."
---

# ACP tool titles

## Behavior

A tool call keeps its title when a later ACP update carries only results and a synthesized fallback title. An update that sets the title to null still clears it, as upstream's nulled fields do.

## Upstream coverage

Covered when upstream's `mergeToolCallState` keeps the earlier title for an update that carries no tool identity, and its tests cover that case.
