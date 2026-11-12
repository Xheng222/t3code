import { TimelinePendingApprovalRow } from "./TimelinePendingApprovalRow";
import { WorkLogBlock, WorkLogButton, WorkLogList, WorkLogRow } from "./WorkLog";
import type { WorktreeSetupSnapshot } from "@t3tools/contracts";
import { type ToolActivityIcon } from "@t3tools/contracts";
import {
  resolveViewedImageAsset,
  workEntriesViewedImagePaths,
} from "@t3tools/client-runtime/work-log/presentation";
import { useAssetUrls } from "~/assets/assetUrls";
import { tickTextContent } from "~/lib/tickTextContent";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { memo, use, type ReactNode } from "react";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { workEntryDisplayIndicatesToolFailure } from "../../session-logic";
import { assetMediaActionsSource } from "./ChatMarkdownMedia";
import { ChevronRightIcon, Minimize2Icon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { workEntryIsVisibleInGroup, type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { processActivityLabel } from "./MessagesTimeline.logic.fork";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { WorktreeSetupCard } from "./WorktreeSetupCard";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import {
  TimelineRowCtx,
  TimelineRowActivityCtx,
  type TimelineRow,
  type WorkGroupViewedImage,
} from "./timelineRowContext";
import { ForkTimelineRowCtx, ForkWorkGroupViewCtx } from "./timelineRowContext.fork";
import { TimelineRowTimestamp, ActivityShimmerOverlay } from "./TimelineRowParts";
import {
  failedToolIconClassName,
  toolIconAcceptsTint,
  type WorkEntryIconName,
  ToolActivityIconView,
} from "./TimelineToolActivityIcon";
import { SimpleWorkEntryRow } from "./TimelineWorkEntryRow.fork";
import { formatWorkingTimerNow } from "./TimelineWorkGroupRows.logic";

export const WorkGroupSection = memo(function WorkGroupSection({
  anchorKey,
  groupedEntries,
  isExpandedToolGroup,
  groupId,
  displayLabel,
  viewedImagePaths,
  preview = false,
}: {
  anchorKey: string;
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
  isExpandedToolGroup: boolean;
  groupId?: string | undefined;
  displayLabel?: string | undefined;
  /** The whole group's viewed images, when this section shows only some of its entries. */
  viewedImagePaths?: ReadonlyArray<string> | undefined;
  preview?: boolean;
}) {
  const { workspaceRoot, onToggleWorkEntry, pendingApprovals } = use(TimelineRowCtx);
  const { workGroupViewState } = use(ForkTimelineRowCtx);
  const onToggleEntry = (collapsed: boolean) => onToggleWorkEntry(anchorKey, collapsed);
  // Group members are already filtered together with their current status.
  const nonEmptyEntries = groupId
    ? groupedEntries
    : groupedEntries.filter((entry) => {
        const item = entry.projectedItem?.item;
        return (
          (item?.type === "approval_request" && pendingApprovals.has(item.requestId)) ||
          workEntryIsVisibleInGroup(entry, isExpandedToolGroup)
        );
      });
  const viewedImages = useWorkGroupViewedImages(
    viewedImagePaths ?? workEntriesViewedImagePaths(groupedEntries),
  );
  if (nonEmptyEntries.length === 0) return null;
  const content = nonEmptyEntries.map((workEntry) => (
    <SimpleWorkEntryRow
      key={workEntry.id}
      workEntry={workEntry}
      workspaceRoot={workspaceRoot}
      displayLabel={displayLabel}
      onToggleEntry={onToggleEntry}
      preview={preview}
    />
  ));
  if (!groupId) return <section aria-label="Activity">{content}</section>;
  return (
    <ForkWorkGroupViewCtx value={{ state: workGroupViewState, viewedImages, onToggleEntry }}>
      <WorkLogList>{content}</WorkLogList>
    </ForkWorkGroupViewCtx>
  );
});

// The gallery an expanded entry opens is built from the group's entries rather than from the
// thumbnail strip's mounted images, which form their own virtualized row.
function useWorkGroupViewedImages(
  paths: ReadonlyArray<string>,
): ReadonlyArray<WorkGroupViewedImage> {
  const { threadRef, workspaceRoot, activeThreadEnvironmentId } = use(TimelineRowCtx);
  const viewed = threadRef
    ? paths.flatMap((path) => {
        const asset = resolveViewedImageAsset(path, {
          threadId: threadRef.threadId,
          workspaceRoot,
        });
        return asset ? [{ path, asset }] : [];
      })
    : [];
  const environmentId = threadRef?.environmentId ?? activeThreadEnvironmentId;
  const urls = useAssetUrls(
    environmentId,
    viewed.map(({ asset }) => asset.resource),
  );
  return viewed.map(({ path, asset }, index) => {
    const url = urls[index];
    if (!url) return { path, item: null };
    const src = url + asset.srcFragment;
    const name = asset.alt.trim() || "image";
    return {
      path,
      item: {
        src,
        name,
        actionsSource: assetMediaActionsSource({
          environmentId,
          resource: asset.resource,
          kind: "image",
          name: asset.alt || "image",
          src,
          workspaceRoot,
        }),
      },
    };
  });
}

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  return formatDuration(elapsedSeconds * 1_000);
}

function WorkingTimer({
  createdAt,
  completedAt,
}: {
  createdAt: string;
  completedAt?: string | null;
}) {
  const { activeThreadEnvironmentId } = use(TimelineRowCtx);
  return (
    <span
      ref={tickTextContent(
        () =>
          completedAt
            ? (formatWorkingTimer(createdAt, completedAt) ?? "0s")
            : formatWorkingTimerNow(createdAt, activeThreadEnvironmentId),
        !completedAt,
      )}
      className="tabular-nums"
    />
  );
}

export function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const { isCompacting, isPreparingWorktree, backgroundWorktreeSetup } =
    use(TimelineRowActivityCtx);
  const compacting = row.compacting === true || isCompacting;
  const shimmer = isPreparingWorktree || compacting;
  const label = isPreparingWorktree ? (
    "Setting up worktree…"
  ) : compacting ? (
    <CompactingLabel createdAt={row.createdAt} />
  ) : row.createdAt ? (
    <>
      Working for <WorkingTimer createdAt={row.createdAt} completedAt={row.completedAt ?? null} />
    </>
  ) : (
    "Working..."
  );
  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <div className="flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
        <span
          ref={shimmer ? observeVisibleAnimation : undefined}
          className="relative shrink-0 overflow-hidden whitespace-nowrap"
        >
          {label}
          {shimmer ? <ActivityShimmerOverlay>{label}</ActivityShimmerOverlay> : null}
        </span>
        {backgroundWorktreeSetup ? (
          <BackgroundWorktreeSetupChip snapshot={backgroundWorktreeSetup} />
        ) : null}
      </div>
    </div>
  );
}

function BackgroundWorktreeSetupChip({ snapshot }: { snapshot: WorktreeSetupSnapshot }) {
  const ctx = use(TimelineRowCtx);
  const terminalId = snapshot.setupScript?.terminalId ?? null;
  const openTerminal = ctx.onOpenWorktreeSetupTerminal;
  const onOpenTerminal = openTerminal && terminalId ? () => openTerminal(terminalId) : null;
  const scriptName = snapshot.setupScript?.name ?? "Setup script";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost-muted"
            size="micro"
            className="ml-auto min-w-0 shrink-0"
            aria-label={`Background setup is still running: ${scriptName}. Show setup progress.`}
          />
        }
      >
        <Spinner className="size-3 shrink-0" />
        <span className="truncate">Background setup</span>
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="lg" padding="compact">
        <WorktreeSetupCard
          snapshot={snapshot}
          embedded
          onCancel={null}
          onWorkLocally={null}
          onOpenTerminal={onOpenTerminal}
        />
      </PopoverPopup>
    </Popover>
  );
}

function CompactingLabel({ createdAt }: { createdAt: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Minimize2Icon aria-hidden="true" className="size-3" />
      {createdAt ? (
        <span>
          Compacting for <WorkingTimer createdAt={createdAt} />
        </span>
      ) : (
        "Compacting…"
      )}
    </span>
  );
}

export function ThinkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "thinking" }> }) {
  const ctx = use(TimelineRowCtx);
  const { isCompacting, isPreparingWorktree, liveAnswerPreview, providerStartingLabel } =
    use(TimelineRowActivityCtx);
  if (isPreparingWorktree || isCompacting) return <WorkLogRow label="" />;
  // A failed group keeps this disclosure while an approval waits, but nothing is thinking then.
  const live = ctx.pendingApprovals.size === 0;
  const activity = (
    <LiveActivityRow
      label={providerStartingLabel ?? row.label ?? liveAnswerPreview ?? "Thinking"}
      iconName="brain"
      active={live}
      shimmer={live}
    />
  );
  const { groupId } = row;
  if (groupId === undefined) return activity;
  return (
    <button
      type="button"
      className="group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-expanded={row.expanded === true}
      onClick={() => ctx.onToggleWorkGroup(groupId, row.id)}
    >
      {activity}
    </button>
  );
}

function LiveActivityRow({
  label,
  iconName,
  toolIcon,
  failed = false,
  active = false,
  shimmer = false,
}: {
  label: ReactNode;
  iconName?: WorkEntryIconName;
  toolIcon?: ToolActivityIcon | undefined;
  failed?: boolean;
  active?: boolean;
  shimmer?: boolean;
}) {
  const animated = active && !failed;
  const showShimmer = animated && shimmer;
  return (
    <div
      ref={animated ? observeVisibleAnimation : undefined}
      className="relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed"
    >
      <LiveActivityContent
        label={label}
        iconName={iconName}
        toolIcon={toolIcon}
        failed={failed}
        announceFailure={failed}
        active={animated && !shimmer}
      />
      {showShimmer ? (
        <ActivityShimmerOverlay>
          <LiveActivityContent label={label} iconName={iconName} toolIcon={toolIcon} highlighted />
        </ActivityShimmerOverlay>
      ) : null}
    </div>
  );
}

function LiveActivityContent({
  label,
  iconName,
  toolIcon,
  failed = false,
  announceFailure = false,
  active = false,
  highlighted = false,
}: {
  label: ReactNode;
  iconName: WorkEntryIconName | undefined;
  toolIcon?: ToolActivityIcon | undefined;
  failed?: boolean;
  announceFailure?: boolean;
  active?: boolean;
  highlighted?: boolean;
}) {
  const showTrailingFailureMark =
    failed && iconName !== undefined && !toolIconAcceptsTint(toolIcon);

  return (
    <WorkLogRow
      icon={
        iconName ? (
          <span
            className={cn(
              "flex size-4 items-center justify-center",
              failed
                ? failedToolIconClassName
                : highlighted
                  ? "text-foreground"
                  : "text-icon-muted",
            )}
            role={announceFailure ? "img" : undefined}
            aria-label={announceFailure ? "Tool call failed" : undefined}
          >
            <ToolActivityIconView
              icon={toolIcon}
              fallbackName={iconName}
              className="block size-4 shrink-0 stroke-2"
              muted={!highlighted}
            />
          </span>
        ) : null
      }
      label={
        <span
          className={cn(
            "block truncate",
            highlighted && "text-foreground",
            active && "live-tool-shine",
          )}
        >
          {label}
        </span>
      }
      trailing={
        showTrailingFailureMark ? (
          <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
        ) : null
      }
    />
  );
}

function LiveWorkEntryTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "work-live" }> }) {
  const ctx = use(TimelineRowCtx);
  const label = processActivityLabel(row.entry);

  const item = row.entry.projectedItem?.item;
  const pendingApproval =
    item?.type === "approval_request" ? ctx.pendingApprovals.get(item.requestId) : undefined;
  if (pendingApproval) return <TimelinePendingApprovalRow approval={pendingApproval} />;

  const failed = workEntryDisplayIndicatesToolFailure(row.entry);
  return (
    <WorkGroupHeader
      label={label}
      active
      failed={failed}
      expanded={row.expanded}
      count={row.groupedEntries.length}
      createdAt={row.createdAt}
      timestampFormat={ctx.timestampFormat}
      onToggle={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    />
  );
}

export function ProcessGroupTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-live" | "work-toggle" | "work-waiting" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const { providerStartingLabel } = use(TimelineRowActivityCtx);
  return (
    <WorkLogBlock layout="group-header" continues={row.continuesWorkLog}>
      {row.kind === "work-waiting" ? (
        <WorkGroupHeader
          label={providerStartingLabel ?? row.label}
          active
          count={0}
          expanded={false}
          createdAt={row.createdAt}
          timestampFormat={ctx.timestampFormat}
          onToggle={() => {}}
        />
      ) : row.kind === "work-live" ? (
        <LiveWorkEntryTimelineRow row={row} />
      ) : (
        <WorkGroupToggleTimelineRow row={row} />
      )}
      {row.kind === "work-live" && !row.expanded ? (
        <div data-activity-preview className="ml-2 border-l border-border/60 pl-2 pb-1">
          <WorkGroupSection
            anchorKey={row.id}
            groupedEntries={[row.entry]}
            isExpandedToolGroup={false}
            groupId={row.groupId}
            preview
          />
        </div>
      ) : null}
    </WorkLogBlock>
  );
}

function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <WorkGroupHeader
      label={row.summary}
      count={row.hiddenCount}
      failed={row.hasFailure}
      expanded={row.expanded}
      createdAt={row.createdAt}
      timestampFormat={ctx.timestampFormat}
      onToggle={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    />
  );
}

export function WorkGroupHeader(props: {
  label: string;
  active?: boolean;
  trailing?: ReactNode;
  count: number;
  failed?: boolean | undefined;
  expanded: boolean;
  createdAt: string | null;
  timestampFormat: TimestampFormat;
  onToggle: () => void;
}) {
  const hasHistory = props.count > 0;
  const content = {
    label: (
      <span
        className={cn(
          "block min-w-0 ps-0.5",
          props.active && "truncate font-medium text-foreground",
        )}
      >
        <span
          ref={props.active ? observeVisibleAnimation : undefined}
          className={props.active ? "live-tool-shine" : undefined}
        >
          {props.label}
        </span>
      </span>
    ),
    wrapLabel: true,
    trailing: (
      <span className="flex h-6 shrink-0 items-center gap-1.5">
        {props.trailing ??
          (props.createdAt ? (
            <TimelineRowTimestamp
              createdAt={props.createdAt}
              timestampFormat={props.timestampFormat}
            />
          ) : null)}
        {hasHistory ? (
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3 shrink-0 text-icon-muted", props.expanded && "rotate-90")}
          />
        ) : null}
      </span>
    ),
  };
  const label = props.failed ? `${props.label}, tool call failed` : props.label;
  return hasHistory ? (
    <WorkLogButton
      {...content}
      aria-label={label}
      aria-expanded={props.expanded}
      onClick={props.onToggle}
    />
  ) : (
    <WorkLogRow {...content} aria-label={label} />
  );
}
