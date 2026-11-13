---
change: nwpkpqut
retention: permanent
summary: "Web/desktop work rows: a disclosure chevron sits right after its label, and hovering an expandable row brightens its label instead of tinting its background."
watch:
  - apps/web/src/components/chat/WorkLog.tsx
---

# Disclosure rows

## Behavior

Work groups and entries place their chevron right after the label instead of at the row's end. Hovering an expandable row brightens its label; entry labels take the row's label color, so tool and other entries match. A subagent link brightens its title on hover instead of tinting its background.

## Upstream files

- `apps/web/src/components/chat/WorkLog.tsx`: rows take an `indicator` placed after the label, an interactive row's label brightens on hover, and `WorkLogDisclosureIndicator` fills that slot with the motion chevron. When upstream changes this file without a conflict, check callers that add a trailing chevron.
- `apps/web/src/components/chat/V2LifecycleRow.tsx`: the subagent link brightens its title on hover in place of the row's background tint.
