import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  AuthDiagnosticsReadScope,
  isDelegatedAppThread,
  type ScopedThreadRef,
  WS_METHODS,
} from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { Atom } from "effect/reactivity";
import { useGT, useLocale } from "gt-react";
import { InfoIcon } from "lucide-react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadShells } from "../../state/threads";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const threadUsageCost = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:thread-usage-cost",
  tag: WS_METHODS.serverGetThreadUsageCost,
  refreshTrigger: ({ environmentId, input }) =>
    Atom.map(
      environmentThreadShells.threadShellAtom({ environmentId, threadId: input.threadId }),
      (thread) => thread?.latestRun?.completedAt ?? null,
    ),
});

export function ThreadDetailsCost(threadRef: ScopedThreadRef) {
  const canRead = useEnvironmentScope(threadRef.environmentId, AuthDiagnosticsReadScope);
  const thread = useAtomValue(environmentThreadShells.quietThreadShellAtom(threadRef));
  return canRead && thread && !isDelegatedAppThread(thread.source) ? (
    <ThreadCostRow {...threadRef} />
  ) : null;
}

function ThreadCostRow({ environmentId, threadId }: ScopedThreadRef) {
  const gt = useGT();
  const locale = useLocale();
  const result = useAtomValue(threadUsageCost({ environmentId, input: { threadId } }));
  if (result._tag !== "Success") return null;
  const { costUsd, partial } = result.value;
  const showPartial = costUsd !== null && partial;
  const label = gt("API estimate");
  return (
    <ThreadDetailsSection headingId="thread-details-cost-heading" title={label} showHeading={false}>
      <div className="flex h-6 items-center justify-between gap-2.5 px-2.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {label}
          <Tooltip>
            <TooltipTrigger
              aria-label={label}
              render={
                <span
                  tabIndex={0}
                  className="inline-flex rounded focus-visible:outline-2 focus-visible:outline-ring"
                />
              }
            >
              <InfoIcon aria-hidden className="size-3" />
            </TooltipTrigger>
            <TooltipPopup>
              <div className="flex flex-col gap-0.5">
                {showPartial ? <span>{gt("Some usage is missing or unpriced")}</span> : null}
                <span className={showPartial ? "text-muted-foreground" : undefined}>
                  {gt("This thread and all its subagents in this environment")}
                </span>
              </div>
            </TooltipPopup>
          </Tooltip>
        </span>
        <span className="font-medium tabular-nums">
          {costUsd === null
            ? gt("Unavailable")
            : `≈ ${formatUsd(costUsd, locale)}${showPartial ? "*" : ""}`}
        </span>
      </div>
    </ThreadDetailsSection>
  );
}
