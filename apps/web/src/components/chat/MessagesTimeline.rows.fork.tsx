import { cn } from "~/lib/utils";
import { WorkLogBlock } from "./WorkLog";
import { type TimelineRow } from "./timelineRowContext";
import { V2SubagentGroup } from "./TimelineV2EventRow.fork";
import {
  ProcessGroupTimelineRow,
  ThinkingTimelineRow,
  WorkGroupSection,
  WorkingTimelineRow,
} from "./TimelineWorkGroupRows.fork";

/** Process groups and their entries, the turn status, zen thinking, and subagent groups. */
export function isForkTimelineRow(row: TimelineRow): boolean {
  switch (row.kind) {
    case "work":
    case "work-live":
    case "work-toggle":
    case "work-waiting":
    case "thinking":
    case "working":
      return true;
    case "event":
      return row.projectedItem.item.type === "subagent";
    default:
      return false;
  }
}

/**
 * Mirrors the wrapper `TimelineRowContent` renders for these kinds. A plain render function, so
 * a row that switches between a fork kind and an upstream one under one id keeps its wrapper.
 */
export function renderForkTimelineRow(row: TimelineRow, exiting: boolean) {
  return (
    <div
      className={cn(row.kind === "working" && "pb-1.5")}
      data-timeline-row-id={exiting ? undefined : row.id}
      data-timeline-row-kind={exiting ? undefined : row.kind}
    >
      <ForkTimelineRowContent row={row} />
    </div>
  );
}

function ForkTimelineRowContent({ row }: { row: TimelineRow }) {
  switch (row.kind) {
    case "work-live":
    case "work-toggle":
    case "work-waiting":
      return <ProcessGroupTimelineRow row={row} />;
    case "work":
      return (
        <WorkLogBlock
          continues={row.continuesWorkLog}
          layout={row.groupId === undefined ? "standalone" : "group-content"}
        >
          <div
            className={cn(
              row.groupId && "ml-2 border-l border-border/60 pl-2",
              row.groupTail && "pb-2",
            )}
          >
            <WorkGroupSection
              anchorKey={row.id}
              groupedEntries={row.groupedEntries}
              isExpandedToolGroup={row.isExpandedToolGroup}
              groupId={row.groupId}
              displayLabel={row.displayLabel}
              viewedImagePaths={row.groupViewedImagePaths}
            />
          </div>
        </WorkLogBlock>
      );
    case "thinking":
      return (
        <WorkLogBlock
          continues={row.continuesWorkLog}
          layout={row.expanded === true ? "group-header" : "standalone"}
        >
          <ThinkingTimelineRow row={row} />
        </WorkLogBlock>
      );
    case "working":
      return <WorkingTimelineRow row={row} />;
    case "event":
      return <V2SubagentGroup key={row.id} row={row} />;
    default:
      return null;
  }
}
