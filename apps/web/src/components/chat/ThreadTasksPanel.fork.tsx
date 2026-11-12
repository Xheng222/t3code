import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon, CircleIcon, CircleDotIcon } from "lucide-react";
import { environmentThreadDetails } from "../../state/threads";
import { findLatestTodoList } from "../../session-logic.fork";
import { cn } from "../../lib/utils";

export function ThreadTasksPanel({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const plan = useAtomValue(
    environmentThreadDetails.quietThreadAtom(scopeThreadRef(environmentId, threadId)),
    (thread) => findLatestTodoList(thread?.projection ?? null),
  );
  if (!plan || !plan.steps.some((step) => step.status !== "completed")) return null;
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  return (
    <section
      className="dropdown-glass rounded-2xl p-3.5"
      aria-label="Tasks"
      data-thread-tasks-panel
    >
      <div className="mb-3 flex items-center justify-between gap-3 text-xs">
        <h3 className="font-medium text-foreground">Tasks</h3>
        <span className="text-muted-foreground tabular-nums">
          {completed}/{plan.steps.length}
        </span>
      </div>
      <ol className="space-y-2.5">
        {plan.steps.map((step) => {
          const Icon =
            step.status === "completed"
              ? CheckIcon
              : step.status === "running"
                ? CircleDotIcon
                : CircleIcon;
          return (
            <li
              key={step.id}
              className="flex items-start gap-2.5 text-xs leading-relaxed"
              aria-label={`${step.status}: ${step.text}`}
            >
              <Icon
                aria-hidden
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  step.status === "running" ? "text-foreground" : "text-muted-foreground",
                )}
              />
              <span
                className={cn(
                  "min-w-0 wrap-anywhere",
                  step.status === "running"
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {step.text}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
