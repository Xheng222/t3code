import {
  NodeId,
  PlanId,
  RunId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { findLatestTodoList } from "./session-logic.fork";
import { makeThreadProjectionFixture } from "./test-fixtures";

describe("V2 session presentation", () => {
  it.each(["pending", "running", "completed"] as const)(
    "shows a %s todo update in the timeline where the agent wrote it",
    (stepStatus) => {
      const projection = makeThreadProjectionFixture();
      const now = DateTime.makeUnsafe("2026-09-04T00:00:00.000Z");
      const runId = RunId.make("run-tasks");
      const nodeId = NodeId.make("node-tasks");
      const planId = PlanId.make("plan-tasks");
      const steps = [{ id: "step-1", text: "Verify the change", status: stepStatus }];
      const item = {
        id: TurnItemId.make("item-tasks"),
        threadId: projection.thread.id,
        runId,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "todo_list" as const,
        planId,
        steps,
      } satisfies OrchestrationV2TurnItem;
      const plans = [
        {
          id: planId,
          threadId: projection.thread.id,
          runId,
          nodeId,
          kind: "todo_list" as const,
          status: "active" as const,
          steps,
        },
      ];

      expect(findLatestTodoList({ ...projection, plans, turnItems: [item] })?.steps).toEqual(steps);
      const replacement = {
        ...plans[0]!,
        id: PlanId.make("replacement"),
        steps: [{ ...steps[0]!, status: "completed" as const }],
      };
      expect(
        findLatestTodoList({ ...projection, plans: [...plans, replacement], turnItems: [item] })
          ?.id,
      ).toBe(replacement.id);
    },
  );
});
