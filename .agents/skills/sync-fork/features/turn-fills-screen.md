---
change: uvmsqzxw
retention: permanent
summary: "Web/desktop: space below the current turn lets its prompt rest at the top of the timeline whenever the turn is shorter than the screen, and a send scrolls it there before the turn starts presenting."
watch:
  - apps/web/src/components/chat/useTimelineFollow.ts
  - apps/web/src/components/ChatView.tsx
---

# Current turn fills the screen

## Behavior

When the current turn is shorter than the timeline, space below it lets the turn's latest prompt rest 24 px from the top with the end in view; a steer continues the turn. The space follows from the rows, the footer, and the viewport height, capped by the window, so it holds across thread switches, reopening, and resizing, and a finished thread whose last exchange is short opens the same way. It grows before shorter content commits and shrinks after taller content commits, so the end never clamps.

A send scrolls the end into view once the prompt's rows are measured, or at once for a prompt without a row of its own, such as a compaction. Until that scroll settles, the turn's process content, paced activity, reply text, and motion hold, and the prompt shows a working status at once. A send that fails before it lands releases the hold. This replaces upstream's anchoring, which kept the prompt near the top with anchored end space only until the turn's first tool activity.

## Upstream files

- `apps/web/src/components/chat/useTimelineFollow.ts`: a laid-out anchor starts a scroll to the end instead of anchoring the prompt with `scrollToIndex`, and the anchor stays until that scroll settles. `presentationPaused` covers an anchor and any scroll to the end in progress. Releasing follow releases the anchor. The tool activity release and the anchored end space size handling are removed. When upstream changes this file without a conflict, check new callers of `scrollToEnd` and new anchor releases.
- `apps/web/src/components/chat/timelineScrollAnchoring.ts`, `apps/web/src/components/chat/timelineScrollAnchoring.test.tsx`: `observeTimelineRun` does not re-anchor a run whose prompt a send already positioned.
- `apps/web/src/components/chat/useTimelinePositionRestore.ts`: `settleListScroll` can scroll smoothly, for the send scroll.
- `apps/web/src/components/ChatView.tsx`: upstream's release of an anchor whose run settled is replaced by releasing an anchor whose message left the timeline, and follow's `presentationPaused` reaches the timeline.
- `apps/web/src/components/ChatView.logic.ts`: `shouldReleaseTimelineAnchorForToolActivity` is removed.
- `apps/web/src/components/chat/MessagesTimeline.tsx`: takes `presentationPaused` for the presentation and the remembered position. The list no longer receives `anchoredEndSpace` or `contentInsetEndAdjustment`, and the footer keeps the composer inset and ends with `fork.endGap`. When upstream changes this file without a conflict, check new uses of `anchoredEndSpace`.
- `apps/web/src/components/chat/MessagesTimeline.logic.ts`: exports `messageIsSteer`.
- `apps/web/src/components/chat/MessagesTimeline.browser.test.tsx`: the fold test checks that a paused finished turn shows no waiting row and that a pending prompt gets one working row. The minimap test's later prompts are steers, so its one turn exceeds the screen and leaves no gap.
- `apps/web/src/components/chat/ReadOnlyThreadTimeline.tsx`: passes follow's `presentationPaused` for guest and linked threads.
