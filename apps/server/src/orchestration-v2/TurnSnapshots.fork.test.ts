import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  NodeId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as TurnSnapshots from "./TurnSnapshots.fork.ts";

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerTest = TurnSnapshots.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      RuntimeLayer.layerEventSink,
      ProjectionStore.layer,
      ProjectStore.layer,
      IdAllocator.layer,
      ThreadCommandExecutor.layer,
      VcsDriverRegistry.layer.pipe(Layer.provideMerge(layerVcsProcess)),
    ),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const projectId = ProjectId.make("project:turn-snapshots");
const providerInstanceId = ProviderInstanceId.make("codex");
const files = [{ path: "src/a.ts", kind: "modified", additions: 2, deletions: 1 }];
const filesTotal = { count: 1, additions: 2, deletions: 1 };

function threadEvents(input: {
  readonly key: string;
  readonly cwd: string;
  readonly now: DateTime.Utc;
  readonly archived?: boolean;
  readonly deleted?: boolean;
  readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint["status"]>;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const threadId = ThreadId.make(`thread:${input.key}`);
  const scopeId = CheckpointScopeId.make(`scope:${input.key}`);
  const rootNodeId = NodeId.make(`node:${input.key}`);
  const event = (name: string) => ({
    id: EventId.make(`event:${input.key}:${name}`),
    threadId,
    occurredAt: input.now,
  });
  return [
    {
      ...event("thread"),
      type: "thread.created",
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId,
        title: input.key,
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: input.cwd,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: input.now,
        updatedAt: input.now,
        archivedAt: input.archived === true ? input.now : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: input.deleted === true ? input.now : null,
      },
    },
    {
      ...event("scope"),
      type: "checkpoint-scope.created",
      nodeId: rootNodeId,
      payload: {
        id: scopeId,
        threadId,
        runId: null,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId: null,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: input.cwd,
        createdAt: input.now,
      },
    },
    ...input.checkpoints.flatMap((status, index): ReadonlyArray<OrchestrationV2DomainEvent> => {
      const ordinal = index + 1;
      const runId = RunId.make(`run:${input.key}:${ordinal}`);
      const checkpointId = CheckpointId.make(`checkpoint:${input.key}:${ordinal}`);
      return [
        {
          ...event(`checkpoint:${ordinal}`),
          type: "checkpoint.captured",
          runId,
          nodeId: rootNodeId,
          payload: {
            id: checkpointId,
            threadId,
            scopeId,
            runId,
            nodeId: rootNodeId,
            parentCheckpointId: null,
            ordinalWithinScope: ordinal,
            appRunOrdinal: ordinal,
            ref: CheckpointRef.make(`refs/t3/orchestration-v2/checkpoints/${input.key}/${ordinal}`),
            status,
            files,
            filesTotal,
            capturedAt: input.now,
          },
        },
        {
          ...event(`turn-item:${ordinal}`),
          type: "turn-item.updated",
          runId,
          nodeId: rootNodeId,
          payload: {
            id: TurnItemId.make(`turn-item:${input.key}:${ordinal}`),
            threadId,
            runId,
            nodeId: rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100 + 99,
            status: "completed",
            title: null,
            startedAt: input.now,
            completedAt: input.now,
            updatedAt: input.now,
            type: "checkpoint",
            checkpointId,
            scopeId,
            files,
            filesTotal,
          },
        },
      ];
    }),
  ];
}

it.effect(
  "marks ready records missing, then deletes every snapshot ref in project repositories",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const turnSnapshots = yield* TurnSnapshots.TurnSnapshots;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-turn-snapshots-" });
      const repo = path.join(root, "repo");
      const trackedRepo = path.join(root, "tracked");
      const plainFolder = path.join(root, "plain");
      const git = (args: ReadonlyArray<string>, cwd = repo) =>
        vcsProcess.run({ operation: "TurnSnapshots.test.git", command: "git", cwd, args });
      const listRefs = git(["for-each-ref", "--format=%(refname)"]).pipe(
        Effect.map((result) => result.stdout.trim().split("\n")),
      );
      yield* fs.makeDirectory(repo);
      yield* fs.makeDirectory(plainFolder);
      yield* git(["init", "--initial-branch=main"]);
      yield* git([
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "--allow-empty",
        "-m",
        "a",
      ]);
      yield* git(["clone", "--quiet", repo, trackedRepo], root);
      yield* git(
        ["update-ref", "refs/t3/orchestration-v2/checkpoints/tracked/1", "HEAD"],
        trackedRepo,
      );
      yield* git(["branch", "keep"]);
      for (const ref of [
        "refs/t3/orchestration-v2/checkpoints/live/0",
        "refs/t3/orchestration-v2/checkpoints/live/1",
        "refs/t3/checkpoints/legacy/turn/1",
        "refs/t3/review-guide/x/base",
      ]) {
        yield* git(["update-ref", ref, "HEAD"]);
      }
      yield* git(["symbolic-ref", "refs/t3/checkpoints/alias", "refs/heads/keep"]);

      const now = yield* DateTime.now;
      // Folders that are not repositories, or no longer exist, are skipped rather than failed.
      const workspaceRoots = [repo, plainFolder, path.join(root, "removed")];
      yield* Effect.forEach(workspaceRoots, (workspaceRoot, index) =>
        projects.apply({
          sequence: index + 1,
          eventId: EventId.make(`event:turn-snapshots:project:${index}`),
          aggregateKind: "project",
          aggregateId: ProjectId.make(`project:turn-snapshots:${index}`),
          occurredAt: DateTime.formatIso(now),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId: ProjectId.make(`project:turn-snapshots:${index}`),
            title: `Turn snapshots ${index}`,
            workspaceRoot,
            trackedFolders: index === 0 ? [{ path: trackedRepo, name: "tracked" }] : [],
            defaultModelSelection: null,
            scripts: [],
            createdAt: DateTime.formatIso(now),
            updatedAt: DateTime.formatIso(now),
          },
        }),
      );
      const seeded = [
        ...threadEvents({ key: "live", cwd: repo, now, checkpoints: ["ready", "missing"] }),
        ...threadEvents({
          key: "archived",
          cwd: repo,
          now,
          archived: true,
          checkpoints: ["ready"],
        }),
        ...threadEvents({
          key: "deleted",
          cwd: path.join(root, "removed"),
          now,
          deleted: true,
          checkpoints: ["ready"],
        }),
      ];
      yield* Effect.forEach(seeded, (event) => projections.apply(event), { discard: true });

      assert.deepEqual(yield* turnSnapshots.deleteAll, { refsDeleted: 5, failures: [] });
      const trackedSnapshotRefs = yield* git(["for-each-ref", "refs/t3/"], trackedRepo);
      assert.equal(trackedSnapshotRefs.stdout, "");
      assert.deepEqual(yield* listRefs, [
        "refs/heads/keep",
        "refs/heads/main",
        "refs/t3/review-guide/x/base",
      ]);

      const records = (key: string) =>
        projections.getThreadRecords(ThreadId.make(`thread:${key}`), ["checkpoints", "turnItems"], {
          turnItemTypes: ["checkpoint"],
        });
      const summary = ({ checkpoints, turnItems }: Effect.Success<ReturnType<typeof records>>) => ({
        checkpoints: checkpoints.map(({ status, files, filesTotal }) => ({
          status,
          files: files.length,
          filesTotal: filesTotal !== undefined,
        })),
        turnItemFiles: turnItems.map((item) =>
          item.type === "checkpoint" ? item.files.length : -1,
        ),
      });
      const cleared = { status: "missing", files: 0, filesTotal: false };
      assert.deepEqual(summary(yield* records("live")), {
        checkpoints: [cleared, { status: "missing", files: 1, filesTotal: true }],
        turnItemFiles: [0, 1],
      });
      assert.deepEqual(summary(yield* records("archived")), {
        checkpoints: [cleared],
        turnItemFiles: [0],
      });
      assert.deepEqual(summary(yield* records("deleted")), {
        checkpoints: [cleared],
        turnItemFiles: [0],
      });

      yield* git(["update-ref", "refs/t3/orchestration-v2/checkpoints/late/1", "HEAD"]);
      assert.deepEqual(yield* turnSnapshots.deleteAll, { refsDeleted: 1, failures: [] });
    }).pipe(Effect.provide(layerTest)),
);
