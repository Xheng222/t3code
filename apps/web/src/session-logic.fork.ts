import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { OrchestrationV2PlanArtifact } from "@t3tools/contracts";

export function findLatestTodoList(projection: ThreadStructure | null) {
  if (projection === null) return null;
  const runOrdinals = new Map(projection.runs.map((run) => [run.id, run.ordinal]));
  const itemOrdinals = new Map(
    projection.turnItems.flatMap((item) =>
      item.type === "todo_list" ? [[item.planId, item.ordinal] as const] : [],
    ),
  );
  let latest: Extract<OrchestrationV2PlanArtifact, { kind: "todo_list" }> | null = null;
  let latestRunOrdinal = -Infinity;
  for (const plan of projection.plans) {
    if (plan.kind !== "todo_list" || plan.status === "superseded") continue;
    const runOrdinal = plan.runId === null ? -1 : (runOrdinals.get(plan.runId) ?? -1);
    if (runOrdinal < latestRunOrdinal) continue;
    if (runOrdinal === latestRunOrdinal && latest) {
      const previousItem = itemOrdinals.get(latest.id);
      const nextItem = itemOrdinals.get(plan.id);
      if (previousItem !== undefined && nextItem !== undefined && previousItem > nextItem) continue;
    }
    latest = plan;
    latestRunOrdinal = runOrdinal;
  }
  return latest;
}
