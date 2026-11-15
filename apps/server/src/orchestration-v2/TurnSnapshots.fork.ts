import {
  CommandId,
  type OrchestrationV2DomainEvent,
  ThreadId,
  type TurnSnapshotDeleteResult,
  TurnSnapshotsError,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import type * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { projectFolders } from "../workspace/WorkspaceFolders.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

/** Read per operation; settings that cannot be read keep the default, recording. */
export const recordsTurnSnapshots = (settings: ServerSettings.ServerSettingsService["Service"]) =>
  settings.getSettings.pipe(
    Effect.map((value) => value.recordTurnSnapshots),
    Effect.orElseSucceed(() => true),
  );

export interface TurnSnapshotsShape {
  /** Marks ready records missing before deleting refs, so a failed delete leaves only unused refs. */
  readonly deleteAll: Effect.Effect<TurnSnapshotDeleteResult, TurnSnapshotsError>;
}

export class TurnSnapshots extends Context.Service<TurnSnapshots, TurnSnapshotsShape>()(
  "t3/orchestration-v2/TurnSnapshots.fork/TurnSnapshots",
) {}

export const layer = Layer.effect(
  TurnSnapshots,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const random = yield* SecureRandom.SecureRandom;
    const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
    const eventSink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;

    // Deleted threads included: a live fork still shows a deleted source's turns.
    const threadsWithReadyCheckpoints = sql<{ readonly threadId: string }>`
      SELECT DISTINCT thread_id AS "threadId"
      FROM orchestration_v2_projection_checkpoints
      WHERE status = 'ready'
      ORDER BY thread_id
    `.pipe(Effect.map((rows) => rows.map((row) => ThreadId.make(row.threadId))));

    // Missing is the state turns without snapshots already use: no file list or file revert, but
    // conversation rewind still works.
    const markThreadMissing = Effect.fn("TurnSnapshots.markThreadMissing")(function* (
      threadId: ThreadId,
    ) {
      // Rollback rewrites this thread's checkpoints under the same lock.
      yield* threadCommands.withLock(
        threadId,
        Effect.gen(function* () {
          const { checkpoints, turnItems } = yield* projections.getThreadRecords(
            threadId,
            ["checkpoints", "turnItems"],
            { turnItemTypes: ["checkpoint"] },
          );
          const ready = checkpoints.filter((checkpoint) => checkpoint.status === "ready");
          if (ready.length === 0) return;
          const now = yield* DateTime.now;
          const commandId = CommandId.make(
            `server:turn-snapshots.delete:${threadId}:${yield* random.uuidV4()}`,
          );
          const events: Array<OrchestrationV2DomainEvent> = [];
          for (const checkpoint of ready) {
            const { filesTotal: _filesTotal, ...record } = checkpoint;
            events.push({
              id: yield* ids.allocate.event({ threadId, commandId }),
              type: "checkpoint.captured",
              threadId,
              ...(checkpoint.runId === null ? {} : { runId: checkpoint.runId }),
              nodeId: checkpoint.nodeId,
              occurredAt: now,
              payload: { ...record, status: "missing", files: [] },
            });
            // The timeline's changed-files card reads its own copy of the file list.
            const item = turnItems.find(
              (candidate) =>
                candidate.type === "checkpoint" && candidate.checkpointId === checkpoint.id,
            );
            if (item?.type !== "checkpoint") continue;
            const {
              filesTotal: _itemFilesTotal,
              filesOmitted: _filesOmitted,
              ...itemRecord
            } = item;
            events.push({
              id: yield* ids.allocate.event({ threadId, commandId }),
              type: "turn-item.updated",
              threadId,
              ...(item.runId === null ? {} : { runId: item.runId }),
              ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
              occurredAt: now,
              payload: { ...itemRecord, files: [], updatedAt: now },
            });
          }
          yield* eventSink.commitCommand({
            commandId,
            threadId,
            commandType: "turn-snapshots.delete",
            acceptedAt: now,
            events,
            effects: [],
          });
        }),
      );
    });

    const deleteAll = Effect.gen(function* () {
      for (const threadId of yield* threadsWithReadyCheckpoints) {
        yield* markThreadMissing(threadId);
      }
      const git = yield* vcsRegistry.get("git");
      const failures: Array<TurnSnapshotDeleteResult["failures"][number]> = [];
      const roots = new Set<string>();
      for (const project of yield* projects.list()) {
        roots.add(project.workspaceRoot);
        const folders = yield* projectFolders(project).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        for (const folder of folders) roots.add(folder.path);
      }
      let refsDeleted = 0;
      // One at a time: projects inside the same repository share its refs.
      for (const workspaceRoot of roots) {
        refsDeleted += yield* Effect.gen(function* () {
          if (!(yield* fileSystem.exists(workspaceRoot))) return 0;
          if ((yield* git.detectRepository(workspaceRoot)) === null) return 0;
          return yield* git.checkpoints.deleteAllCheckpointRefs(workspaceRoot);
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              failures.push({ path: workspaceRoot, reason: error.message });
              return 0;
            }),
          ),
        );
      }
      return { refsDeleted, failures } satisfies TurnSnapshotDeleteResult;
    }).pipe(
      Effect.tapError((cause) => Effect.logError("turn snapshot deletion failed", { cause })),
      Effect.mapError(
        () => new TurnSnapshotsError({ reason: "Turn snapshots could not be deleted." }),
      ),
      Effect.withSpan("TurnSnapshots.deleteAll"),
    );

    return TurnSnapshots.of({ deleteAll });
  }),
);
