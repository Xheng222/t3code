---
change: omtpxoml
retention: permanent
summary: "Web/desktop timeline motion: expanding and collapsing rows animates their height with chevrons on the same clock, follow scrolls to the end after rows lay out, and paced reply text waits for motion to settle."
watch:
  - apps/web/src/components/chat/MessagesTimeline.tsx
  - apps/web/src/components/chat/useTimelineFollow.ts
---

# Timeline motion

## Behavior

Expanding and collapsing a row animates its height, and its disclosure chevron rotates on the same clock. Height animation stays apart from page scrolling: follow scrolls to the end once rows lay out, without a tween while rows animate or the viewport resizes. Toggling a disclosure releases follow and keeps the toggled row in place; the end coming into view without a scroll gesture does not resume follow.

Newly exposed buffered rows are measured before they animate. Collapsing content stays visible but inert until it closes, and final spacing holds through cleanup. An in-place shrink shows the new content at once and closes the trailing space; a group header whose content moves into its entry rows opening below hands them its space. A collapsing running subagent group closes the members other than the latest, which slides up. The working row and the turn fold share one id per turn, so a finishing turn's status changes in place.

Rows resized above the viewport and prepended history keep the reading position. Find, citation positioning, position restore, reduced motion, and hidden pages turn motion off. Opening a thread settles until a frame after its first synced layout, and nothing animates or paces before. Paced reply text waits while rows animate and for a 150 ms beat after, including text that arrives as the turn ends.

## Upstream files

- `apps/web/src/components/chat/MessagesTimeline.tsx`: `fork.attach` and `fork.attachAfterFollow` replace the content size schedule. `fork.listProps` leaves LegendList in charge of the end while a thread's saved position is restoring, then the fork's follow takes over. Keep upstream's text anchoring when the viewport width changes. `preserveDisclosurePosition` is declared before `fork`; closing over `fork` here leaves the callbacks, the shared row state, and every row unmemoized. Exiting rows render without their row and message IDs. The minimap treats a following list as at its end. When upstream changes this file, check the overridden list props, new row kinds, and disclosure toggles.
- `apps/web/src/components/chat/MessagesTimeline.browser.test.tsx`: the fold test checks that the reply stays inside its row across toggle cycles and that retained rows clear; the expanded-heading test expects the toggle to release follow and keep the heading in place; the minimap next-turn tests release follow before leaving the end.
- `apps/web/test/appScenarios.renders.tsx`: the streaming scenario allows the timeline two more renders, as motion pins the entering reply and releases it.
- `apps/web/src/components/chat/useTimelineFollow.ts`: follow scrolls to the end on the viewport's layout changes, which also replaces scrolling to the end when the composer inset or the footer grows. Releasing follow also stops a smooth DOM scroll. `resumeOnScroll` decides whether reaching the end re-arms follow: a scroll gesture does, a command does not.
- `apps/web/src/components/chat/timelineViewport.ts`, `apps/web/src/components/chat/timelineViewport.test.ts`: the viewport carries layout change events, and `reachedEnd` can leave follow released.
