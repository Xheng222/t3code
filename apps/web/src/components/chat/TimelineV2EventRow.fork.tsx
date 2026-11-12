import { WorkLogBlock } from "./WorkLog";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { environmentThreadDetails } from "../../state/threads";
import { subagentGroupSummary } from "@t3tools/client-runtime/state/subagent-display";
import { memo, use, useState } from "react";
import { SubagentElapsed, subagentStatusVisual, V2LifecycleRow } from "./V2LifecycleRow";
import { subagentGroupTiming } from "./TimelineV2EventRow.logic";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";
import { ForkTimelineRowCtx } from "./timelineRowContext.fork";
import { WorkGroupHeader } from "./TimelineWorkGroupRows.fork";
import { usePacedActivity } from "./activityPresentation.fork";

/** Every subagent row renders as a process group, even with a single member. */
export const V2SubagentGroup = memo(function V2SubagentGroup({
  row,
}: {
  row: Extract<TimelineRow, { kind: "event" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const forkCtx = use(ForkTimelineRowCtx);
  const groupId = `subagent-group:${row.id}`;
  const [expanded, setExpanded] = useState(() =>
    ctx.workGroupViewState.expandedEntries.has(groupId),
  );
  const members = (row.subagents ?? [row.projectedItem]).flatMap(({ item }) =>
    item.type === "subagent" ? [item] : [],
  );
  const liveAgents = useAtomValue(
    environmentThreadDetails.threadAtom(
      scopeThreadRef(ctx.activeThreadEnvironmentId, row.projectedItem.item.threadId),
    ),
    (thread) => thread?.projection.subagents,
  );
  const agents = members.map((item) => {
    const live = liveAgents?.find((agent) => agent.id === item.subagentId);
    return {
      item,
      status: live?.status ?? item.status,
      startedAt: live?.startedAt ?? item.startedAt,
      completedAt: live?.completedAt ?? item.completedAt,
    };
  });
  const current = row.processGroupActive === true;
  const latest = usePacedActivity({
    identity: `${ctx.routeThreadKey}\0${groupId}`,
    items: agents,
    getId: (agent) => agent.item.id,
    immediate: !current || expanded || forkCtx.activityImmediate,
  });
  const header =
    current && latest
      ? {
          label:
            row.waitingLabel ??
            subagentStatusVisual(latest.status === "completed" ? "running" : latest.status).label,
          failed: latest.status === "failed",
        }
      : subagentGroupSummary(agents);
  const [wasCurrent, setWasCurrent] = useState(current);
  if (wasCurrent !== current) {
    setWasCurrent(current);
    if (!current) {
      setExpanded(false);
      ctx.workGroupViewState.expandedEntries.delete(groupId);
    }
  }
  const toggle = () => {
    ctx.onToggleWorkEntry(row.id, expanded);
    if (expanded) ctx.workGroupViewState.expandedEntries.delete(groupId);
    else ctx.workGroupViewState.expandedEntries.add(groupId);
    setExpanded(!expanded);
  };
  const shown = expanded ? members : current && latest ? [latest.item] : [];
  const content = shown.map((item) => (
    <V2LifecycleRow
      environmentId={ctx.activeThreadEnvironmentId}
      key={item.id}
      item={item}
      runs={ctx.runs}
      onOpenThread={ctx.onOpenThread}
    />
  ));
  return (
    <div data-subagent-group>
      <WorkLogBlock layout="group-header" continues={shown.length > 0}>
        <WorkGroupHeader
          label={header.label}
          active={current}
          trailing={
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              <SubagentElapsed agent={subagentGroupTiming(agents)} />
            </span>
          }
          count={members.length}
          failed={header.failed}
          expanded={expanded}
          createdAt={row.createdAt}
          timestampFormat={ctx.timestampFormat}
          onToggle={toggle}
        />
      </WorkLogBlock>
      {shown.length > 0 ? (
        <WorkLogBlock continues={row.continuesWorkLog} layout="group-content">
          <div className="ml-2 border-l border-border/60 pl-2 pb-2">{content}</div>
        </WorkLogBlock>
      ) : null}
    </div>
  );
});
