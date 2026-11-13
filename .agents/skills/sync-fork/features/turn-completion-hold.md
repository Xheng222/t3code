---
change: lvorlsrz
retention: permanent
summary: "The server keeps a finished turn running while a visible desktop or web client showing the thread still reveals its reply, so completion signals, queued turns, and subagent results do not run ahead of the reveal."
watch:
  - apps/server/src/orchestration-v2/RunExecutionService.ts
  - apps/server/src/orchestration-v2/CheckpointCaptureService.ts
  - apps/server/src/background/BackgroundPolicy.ts
  - apps/web/src/lib/backgroundActivityReporter.ts
---

# Turn completion hold

## Behavior

A turn that finishes normally stays running until a visible desktop or web client showing its thread would finish revealing the reply. The server estimates that moment from each reply's length and arrival with the client's reveal speed, which client and server share, adds a margin, and holds at most 30 seconds. A turn watched only from a phone, from a hidden window, or by nobody completes at once, as do failed, interrupted, and cancelled turns.

## Upstream files

- `apps/server/src/orchestration-v2/RunExecutionService.ts`: `writeFinalRunEvents` asks `TurnPresentationDelay` how long to hold a completed run. A positive delay keeps the run and root node waiting and gives the checkpoint effect an `availableAt`. A zero delay uses the regular upstream completion path.
- `apps/server/src/orchestration-v2/CheckpointCaptureService.ts`, watched only: checkpoint capture finalizes a run that is still waiting. When upstream changes this file, check that this branch still settles held runs and that disabled snapshots also reach it.
- `apps/server/src/orchestration-v2/RunExecutionService.test.ts`: the termination helper takes `presentationDelayMs`; a test holds a completed run's checkpoint, and the stop test checks that a stopped run's is not held.
- `apps/server/src/server.ts`: provides `TurnPresentationDelay.layer` to the orchestration runtime with the shared background policy and projection store.
- `apps/server/src/background/BackgroundPolicy.ts`, watched only: the hold reads client activity leases, and no server work is gated on `thread` scopes. When upstream changes this file, check that leases still carry client kind, visibility, and scopes, and that nothing starts gating work on the `thread` scopes web clients now report.
- `apps/web/src/lib/backgroundActivityReporter.ts`: exports `retainBackgroundScope`, through which `useWatchedThread` reports the thread on screen. When upstream changes this file without a conflict, check that reports still include retained scopes and visibility, and whether upstream now reports thread scopes itself.
- `apps/web/src/components/chat/ThreadTimeline.tsx`: calls `useWatchedThread` with the thread whose detail it shows.
- `packages/shared/package.json`: exports `./streamingPace`, the reveal speed the web client paces with and the server estimates with.
