---
change: svskvtkq
retention: permanent
summary: "Web/desktop turn presentation: a turn's reasoning, tool calls, and subagents form a process group with a current status line, a preview of the latest entry, and expandable history; assistant prose comes before later activity, and changed files follow the reply."
watch:
  - apps/web/src/components/chat/MessagesTimeline.tsx
  - apps/web/src/components/chat/MessagesTimeline.logic.ts
  - apps/web/src/components/chat/TimelineV2EventRow.tsx
---

# Turn presentation

## Behavior

Keep the active status and detail synchronized, retain the activity label on tool failure, show the latest full thought in italic, and collapse completed groups to their summary. Keep Working for visible while the final reply drains; show file changes after the reply. Keep presentation sequencing within each user turn, with text an agent sends to the user ordered like its prose; a steer, promoted from the queue or not, stays within it. An expanded live preview stays expanded for later entries of the same run until collapsed.

A thread's visit starts from its first synced entries: the copy shown while it syncs, and what arrives with the sync, are history and do not reveal or pace. Find, zen, and a citation while it positions show activity at once; once the citation lands, pacing resumes. Reasoning splits into one thought per blank-line paragraph: the active detail shows the latest paragraph, a lone bold title joins the paragraph after it, fenced code stays whole, and each paragraph counts as one thought.

## Upstream files

- `apps/web/src/components/chat/MessagesTimeline.logic.ts`: `deriveMessagesTimelineRows` takes `processRows` hooks that build the live group, work groups, and trailing tool groups as process rows, and skip upstream's trailing thinking row outside zen. `sourceTimelineEntries` keeps terminal replies computed from entries before presentation held any back; `presentingRunIds` keeps the working header and an unfolded turn while a run's reply presents. Process groups keep upstream's viewed-image strip below them, and an expanded entry's image opens among the whole group's images through `groupViewedImagePaths`. While the open run waits on subagents it launched, the run's subagent row carries upstream's waiting label as `waitingLabel`, read from `sourceTimelineEntries`. New row kinds and fields join row equality and the streaming-replacement check, and helpers the fork reuses are exported. When upstream changes this file without a conflict, check fixes in the branches the hooks skip, new row kinds the process grouping must place, and callers of `liveWorkEntryLabel`, `workEntryDisplayLabel`, and `liveAnswerPreview`, which the fork replaces with `processActivityLabel`, `processEntryLabel`, and `processAnswerPreview`.
- `apps/web/src/components/chat/MessagesTimeline.tsx`: `useAssistantCitationTarget` runs before `useForkTimelinePresentation`, so pacing knows whether a citation is positioning before rows derive; the cited row's phase and its kept-mounted key come from the derived rows afterwards. A `synced` prop starts the visit. `useForkTimelinePresentation` admits entries in presentation order and supplies the fork's derivation input, spread last; `useForkTimeline` turns derived rows into paced process rows and collapses work groups that finish. `TimelineRowContent` hands fork rows to `renderForkTimelineRow`, `getItemType` asks `forkTimelineItemType` first, and the work group view state carries `expandedPreviewRuns`. When upstream changes this file without a conflict, check the wrapper `TimelineRowContent` renders, which `MessagesTimeline.rows.fork.tsx` mirrors for fork rows.
- `apps/web/src/components/chat/TimelineV2EventRow.tsx`, watched only: fork rows render subagent groups with `V2SubagentGroup` from `TimelineV2EventRow.fork.tsx`. When upstream changes its `V2SubagentGroup`, port what applies.
- `apps/web/src/components/chat/TimelineAssistantRows.tsx`: changed files render only once `useForkAssistantText` reports the reply presented.
- `apps/web/src/components/chat/useAssistantCitationTarget.ts`: takes whether the cited history failed instead of the row phase, and no longer returns the cited row to keep mounted, which the timeline derives itself.
- `apps/web/src/components/chat/ThreadTimeline.tsx`: passes `synced` while the thread's detail is no longer syncing.
- `apps/web/src/components/chat/MessagesTimeline.browser.test.tsx`: the citation test checks that pacing resumes after the citation lands; the follow test waits longer, because the fold also holds the turn's earlier reply.
- `apps/web/src/components/chat/V2ItemInspector.tsx`, `apps/web/src/components/chat/V2LifecycleRow.tsx`: export `ToolCallBody` and `subagentStatusVisual` for the copied entry row and the fork's subagent group.
- `apps/web/src/components/chat/WorkLog.tsx`: `WorkLogIcon` is extracted for the copied entry row, and group headers keep standalone bottom padding.
- `apps/web/src/components/chat/timelineScrollAnchoring.ts`: remembered disclosures use `ForkWorkGroupViewState`, so a restored thread keeps its expanded previews.
- `apps/web/src/components/guest/GuestPage.browser.test.tsx`: a finished turn's commands sit in a process group, which the test opens before the command.
- `apps/web/src/index.css`: `.process-reasoning` keeps reasoning Markdown in the row's text style with code upright, and replaces upstream's block fade there as a presentation does.
