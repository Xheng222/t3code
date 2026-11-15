---
change: trxkummu
retention: permanent
summary: "Settings > Maintenance > Turn snapshots: a switch stops new turns from writing Git snapshot refs, and Delete removes every checkpoint ref in project repositories after marking ready checkpoints missing, so earlier turns lose changed files, turn diff and file revert while conversation rewind keeps working."
watch:
  - apps/server/src/orchestration-v2/CheckpointService.ts
  - apps/server/src/orchestration-v2/CheckpointRollbackService.ts
---

# Turn snapshots

## Behavior

With Record turn snapshots off (server setting `recordTurnSnapshots`, on by default), a turn writes neither a baseline nor a capture ref and records its checkpoint as `missing`, as side chats do. After it is turned back on, snapshots resume with the next turn; that turn shows its changed files, but its turn diff is unavailable.

Delete first marks every `ready` checkpoint as `missing`, deleted threads' too because a live fork still shows a deleted source's turns, and clears the changed-file lists on the checkpoint and its timeline item, through events under the thread lock. It then deletes every ref under `refs/t3/orchestration-v2/checkpoints/` and `refs/t3/checkpoints/` in each project's main repository, its tracked repositories, and their submodules, together with each repository's capture indexes. Earlier turns lose their changed-file list, turn diff and file revert; rewinding the conversation still works. Git's own gc reclaims the objects.

## Upstream files

- `packages/contracts/src/settings.ts`: adds `recordTurnSnapshots` to server settings and their patch, and `TurnSnapshotDeleteResult` and `TurnSnapshotsError` beside `StorageCleanupReport`.
- `packages/contracts/src/rpc.ts`: declares `server.deleteTurnSnapshots` and adds it to `WsRpcGroup`.
- `packages/contracts/src/clientRpcPermissions.ts`: guards `server.deleteTurnSnapshots` with the settings write scope.
- `packages/client-runtime/src/state/server.ts`: the `deleteTurnSnapshots` command beside `runStorageCleanup`.
- `packages/client-runtime/src/state/commandPermissions.test.ts`: covers the new guarded method.
- `apps/server/src/ws.ts`: serves `server.deleteTurnSnapshots` with `TurnSnapshots.deleteAll`.
- `apps/server/src/ws.test.ts`: mocks `TurnSnapshots` with the other unused services.
- `apps/server/src/observability/RpcInstrumentation.ts`: files the method under `server`.
- `apps/server/src/server.ts`: provides `TurnSnapshots.layer` with the runtime's event sink, projection store, ID allocator and thread command executor, so its events and thread locks are the runtime's own.
- `apps/server/src/vcs/VcsDriver.ts`: declares `deleteAllCheckpointRefs`.
- `apps/server/src/vcs/GitVcsDriver.ts`: `deleteAllCheckpointRefs` lists both checkpoint prefixes, deletes them in one `update-ref --no-deref --stdin` transaction, removes the repository's `t3-checkpoint-indexes` store as upstream's storage cleanup does for deleted scopes, and recurses into submodules as upstream's `deleteCheckpointRefs` does. When upstream changes where capture writes refs or keeps capture state, check that the deletion still reaches all of it.
- `apps/server/src/vcs/GitVcsDriver.test.ts`: the populated submodules test also deletes every checkpoint ref and the capture index store after a fresh capture.
- `apps/server/src/orchestration-v2/CheckpointCaptureService.ts`: `forceMissing` covers recording being off as well as side chats, for both the baseline and the capture. Skip tracked repository capture in either case.
- `apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts`: the side chat test that never touches Git is a table with a row for recording off.
- `apps/server/src/orchestration-v2/RunExecutionService.ts`: `captureRunBaseline` returns early when recording is off.
- `apps/server/src/orchestration-v2/RunExecutionService.test.ts`: the forked baseline test runs with recording on and off.
- `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts`: provides server settings, which checkpoint capture now reads.
- `apps/web/src/components/settings/StorageSettings.tsx`: `TurnSnapshotsSection` after Cleanup, with the switch and the Delete button and its confirmation.
- `apps/web/src/components/settings/settingsSearch.ts`: search entries for both rows.
- `apps/server/src/orchestration-v2/CheckpointService.ts`, watched only: when upstream changes it, check that checkpoint refs still live under `refs/t3/orchestration-v2/checkpoints/`, and that turns still write refs only through `CheckpointCaptureService` and `captureRunBaseline`, which skip them when recording is off.
- `apps/server/src/orchestration-v2/CheckpointRollbackService.ts`, watched only: when upstream changes it, check that a `missing` checkpoint still allows rewinding the conversation without files, which deletion relies on.
