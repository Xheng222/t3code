---
change: kkrkuvuv
retention: permanent
summary: "Web/desktop timeline: an opened work entry, work group, or subagent group rises from under the composer by upstream's reveal rule while its height animates; an open entry's header line sticks to the top edge and collapses it in place, and only the part of an entry visible at the end animates."
watch:
  - apps/web/src/components/chat/TimelineWorkEntryRow.tsx
---

# Entry reveal

## Behavior

Opening a work entry, a work group, or a subagent group scrolls what opened up from under the composer until its end shows, with the clearance the list leaves below its last row, or until its start reaches the anchor offset below the top, by upstream's `resolveDisclosureRevealScrollDelta`. A group reveals from its header through its last entry row. The scroll tracks the height animation frame by frame and lasts until navigation or the next toggle, since fetched output can grow the content later. A live preview toggled while following stays in follow, which shows its growing end.

An open entry's header line sticks to the top edge while its body scrolls beneath, and the timeline's top fade turns off while a line is stuck. Collapsing from a stuck line holds the line in place, with LegendList's visible-content anchoring off.

Only the part of a toggled entry visible at the end animates; the parts above or below the view change at once. Cleanup scrolls an opening's skipped top back in only when that keeps the view still, and an opening reversed midway keeps its shift without that scroll.

## Upstream files

- `apps/web/src/components/chat/MessagesTimeline.tsx`: passes `liveFollowEnabled` and `contentInsetEndAdjustment` to `useForkTimeline`, and the top fade class adds `data-[entry-stuck]:mask-none`. `preserveDisclosurePosition` tells `fork.captureDisclosure` whether the disclosure opens, so the fork's reveal replaces upstream's `revealExpandedDisclosure`, which never runs.
- `apps/web/src/components/chat/MessagesTimeline.browser.test.tsx`: upstream's reveal cases open the group first in every mode, since the fork shows a single tool as a group.
- `apps/web/src/components/chat/WorkLog.tsx`: `WorkLogRow` takes a `lineRef` for its header line. A line marked `data-sticky` sticks to the top; one marked `data-stuck` gets a fade below it and the foreground label color.
- `apps/web/src/components/chat/TimelineWorkEntryRow.tsx`: the fork's copy reports its toggles with the entry and its line, and marks the line sticky while the body shows. When upstream changes how opened content scrolls into view, compare it with the fork's reveal and bring the differences to the user; only one of them may run.
