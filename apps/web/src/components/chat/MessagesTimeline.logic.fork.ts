import { msg } from "gt-react";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import {
  liveThoughtLine,
  normalizeCompactToolLabel,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  workEntriesViewedImagePaths,
  workEntryViewedImagePath,
} from "@t3tools/client-runtime/work-log/presentation";
import { searchToolLabelParts } from "@t3tools/shared/toolActivity";
import { dynamicToolTitle } from "@t3tools/shared/toolActivityCopy";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { m, type MessageResolver } from "../../i18n/messages";
import {
  workEntryDisplayIndicatesToolFailure,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import {
  LIVE_ACTIVITY_ROW_ID,
  lastResponseBoundaryIndex,
  workEntryIsActiveTurnActivity,
  workEntryReadRawPaths,
  workEntryToolDataRecord,
  viewedImagesRows,
  workGroupId,
  type MessagesTimelineRow,
  type MessagesTimelineRowsInput,
} from "./MessagesTimeline.logic";

export type WorkWaitingRow = {
  kind: "work-waiting";
  id: string;
  createdAt: string | null;
  label: string;
};

type WorkTimelineEntry = Extract<TimelineEntry, { kind: "work" }>;
type GroupInput = { readonly expandedWorkGroupIds?: ReadonlySet<string> | undefined };

function moreLabel(path: string, count: number, resolve: MessageResolver) {
  return resolve(
    msg("{count, plural, one {{path} +{count} more} other {{path} +{count} more}}", {
      path,
      count,
    }),
  );
}

/** Search labels name only what was searched; the row's icon carries the verb. */
function searchTargetLabel(data: Record<string, unknown> | undefined, resolve: MessageResolver) {
  const { query, glob, target } = searchToolLabelParts(data);
  if (query && target) return resolve(msg("{query} in {target}", { query, target }));
  if (glob && target) return resolve(msg("files {glob} in {target}", { glob, target }));
  if (glob) return resolve(msg("files {glob}", { glob }));
  if (query) return query;
  if (target) return resolve(msg("in {target}", { target }));
  return undefined;
}

/** Components pass `useMessages()` so the label follows a language switch. */
export function processEntryLabel(
  entry: WorkLogEntry,
  workspaceRoot: string | undefined,
  resolve: MessageResolver = m,
) {
  if (entry.itemType === "system_notice") return entry.label;
  if (entry.itemType === "reasoning" || entry.tone === "thinking") {
    const thought = entry.detail?.trim().replace(/\s+/g, " ");
    return thought || entry.label;
  }
  const action = toolGroupAction(entry);
  const paths =
    action === "read" || action === "edit"
      ? workEntryReadRawPaths(entry).map((path) => formatWorkspaceRelativePath(path, workspaceRoot))
      : [];
  if (paths[0]) {
    return paths.length === 1 ? paths[0] : moreLabel(paths[0], paths.length - 1, resolve);
  }
  const toolPresentation = resolveWorkEntryToolPresentation(entry, undefined, resolve);
  if (toolPresentation) return toolPresentation.displayName;
  if (entry.command?.trim()) return commandDisplayText(entry.command);
  if (action === "code-search" || action === "search") {
    const title = entry.label.trim();
    const searchLabel =
      entry.itemType === "file_search" && title && title.toLowerCase() !== "tool"
        ? title.replace(/^search(?:ed|ing)?\s+/i, "")
        : searchTargetLabel(workEntryToolDataRecord(entry), resolve);
    return searchLabel || resolve(msg("Search"));
  }
  const providerRetry =
    entry.projectedItem?.item.type === "error" && entry.projectedItem.item.retry !== undefined;
  const item = entry.structuredPayload;
  const title =
    item?.type === "dynamic_tool"
      ? dynamicToolTitle(item.toolName, item.input, item.title, resolve)
      : null;
  if (title) return title;
  const compactDetail = entry.detail?.trim();
  if (compactDetail && !providerRetry && action !== "read") {
    return compactDetail;
  }
  const [firstPath] = entry.changedFiles ?? [];
  if (firstPath) {
    const path = formatWorkspaceRelativePath(firstPath, workspaceRoot);
    return entry.changedFiles!.length === 1
      ? path
      : moreLabel(path, entry.changedFiles!.length - 1, resolve);
  }
  if (action === "read" && !entry.viewedImagePath) {
    return resolve(msg("File"));
  }
  const heading = normalizeCompactToolLabel(entry.toolTitle || entry.label);
  return `${heading.charAt(0).toUpperCase()}${heading.slice(1)}`;
}

type ProcessActivity = {
  action: "read" | "edit" | "command" | "search" | "browser" | "device" | "update" | "tool";
  tool: string;
};

function workEntryActivity(entry: WorkLogEntry): ProcessActivity {
  const action = toolGroupAction(entry);
  switch (action) {
    case "read":
    case "edit":
    case "command":
    case "search":
    case "browser":
    case "device":
    case "update":
      return { action, tool: "" };
    case "code-search":
      return { action: "search", tool: "" };
    default: {
      const item = entry.projectedItem?.item ?? entry.structuredPayload;
      const data = workEntryToolDataRecord(entry);
      const toolName =
        item?.type === "dynamic_tool"
          ? item.toolName
          : typeof data?.toolName === "string"
            ? data.toolName
            : null;
      return { action: "tool", tool: toolName?.trim() ?? "" };
    }
  }
}

/** Components pass `useMessages()` so the label follows a language switch. */
export function processActivityLabel(entry: WorkLogEntry, resolve: MessageResolver = m) {
  if (entry.itemType === "reasoning") return resolve(msg("Thinking"));
  const { action, tool } = workEntryActivity(entry);
  // An unnamed tool falls through to each message's `other` branch.
  const variables = { action: action === "tool" && !tool ? "unnamed" : action, tool };
  switch (entry.toolLifecycleStatus) {
    case "declined":
      return resolve(
        msg(
          "{action, select, read {Declined to read files} edit {Declined to edit files} command {Declined to run command} search {Declined to search} browser {Declined to use browser} device {Declined to use device} update {Declined to update progress} tool {Declined to use {tool}} other {Declined to use tool}}",
          variables,
        ),
      );
    case "stopped":
      return resolve(
        msg(
          "{action, select, read {Stopped reading files} edit {Stopped editing files} command {Stopped running command} search {Stopped searching} browser {Stopped using browser} device {Stopped using device} update {Stopped updating progress} tool {Stopped using {tool}} other {Stopped using tool}}",
          variables,
        ),
      );
    case "idle":
      return resolve(
        msg(
          "{action, select, read {Waiting to read files} edit {Waiting to edit files} command {Waiting to run command} search {Waiting to search} browser {Waiting to use browser} device {Waiting to use device} update {Waiting to update progress} tool {Waiting to use {tool}} other {Waiting to use tool}}",
          variables,
        ),
      );
    default:
      return resolve(
        msg(
          "{action, select, read {Reading files} edit {Editing files} command {Running command} search {Searching} browser {Using browser} device {Using device} update {Updating progress} tool {Using {tool}} other {Using tool}}",
          variables,
        ),
      );
  }
}

const FENCE_LINE = /^\s*(?:```|~~~)/;
const BOLD_TITLE = /^\*\*[^*\n]+\*\*$/;

/**
 * Splits reasoning text into the thoughts it presents as. Claude summarizes thinking as one item
 * of blank-line paragraphs; a lone bold title joins the paragraph after it, as Codex writes them.
 */
export function reasoningParagraphs(text: string): string[] {
  const paragraphs: string[] = [];
  let lines: string[] = [];
  let fenced = false;
  const flush = () => {
    const paragraph = lines.join("\n").trim();
    lines = [];
    if (!paragraph) return;
    const previous = paragraphs.at(-1);
    if (previous !== undefined && BOLD_TITLE.test(previous))
      paragraphs[paragraphs.length - 1] = `${previous}\n\n${paragraph}`;
    else paragraphs.push(paragraph);
  };
  for (const line of text.split(/\r?\n/)) {
    if (FENCE_LINE.test(line)) fenced = !fenced;
    if (!fenced && line.trim() === "") flush();
    else lines.push(line);
  }
  flush();
  return paragraphs;
}

/** Each reasoning paragraph counts as its own thought, matching how the group lists it. */
function presentedWorkEntries(entries: ReadonlyArray<WorkLogEntry>): WorkLogEntry[] {
  return entries.flatMap((entry) =>
    entry.itemType === "reasoning"
      ? reasoningParagraphs(entry.detail ?? "").map((detail) => ({ ...entry, detail }))
      : [entry],
  );
}

export function processAnswerPreview(entries: ReadonlyArray<TimelineEntry>): string | null {
  const boundary = lastResponseBoundaryIndex(entries);
  for (let index = entries.length - 1; index > boundary; index -= 1) {
    const entry = entries[index]!;
    const text =
      entry.kind === "message" && entry.message.role === "assistant"
        ? entry.message.text
        : entry.kind === "work" && entry.entry.itemType === "reasoning"
          ? (reasoningParagraphs(entry.entry.detail ?? "").at(-1) ?? "")
          : "";
    const line = liveThoughtLine(text);
    if (line !== "") return line;
  }
  return null;
}

/** Expanded groups list one row per entry; a collapsed live group previews its current entry. */
function workGroupEntryRows(
  groupId: string,
  groupedEntries: WorkLogEntry[],
  expanded: boolean,
  currentEntry?: WorkLogEntry,
): Extract<MessagesTimelineRow, { kind: "work" }>[] {
  const shown = expanded ? groupedEntries : currentEntry ? [currentEntry] : [];
  // An entry's image opens as a gallery of the whole group's viewed images.
  const viewedImagePaths = workEntriesViewedImagePaths(groupedEntries);
  return shown.map((entry, index) => ({
    kind: "work",
    id: expanded ? `${groupId}:entry:${entry.id}` : `${groupId}:preview`,
    createdAt: entry.createdAt,
    groupedEntries: [entry],
    isExpandedToolGroup: expanded,
    groupId,
    groupTail: index === shown.length - 1,
    ...(viewedImagePaths.length > 1 && workEntryViewedImagePath(entry) !== null
      ? { groupViewedImagePaths: viewedImagePaths }
      : {}),
  }));
}

/** The live group keeps its header after a failure and shows the latest entry's status. */
function liveRows(
  anchor: WorkTimelineEntry,
  entries: ReadonlyArray<WorkTimelineEntry>,
  input: GroupInput,
) {
  const groupId = workGroupId(anchor.id);
  const groupedEntries = entries.map((entry) => entry.entry);
  const entry = groupedEntries.at(-1)!;
  const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
  const active = workEntryIsActiveTurnActivity(entry);
  return {
    rows: [
      {
        kind: "work-live" as const,
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: anchor.createdAt,
        entry,
        groupedEntries,
        groupId,
        expanded,
        active,
      },
      ...workGroupEntryRows(groupId, groupedEntries, expanded, entry),
      ...viewedImagesRows(groupId, anchor.createdAt, groupedEntries),
    ],
    active,
  };
}

/** Every group outside the live one, single tools and running tools included, becomes a toggle. */
function groupRows(
  anchor: WorkTimelineEntry,
  entries: WorkLogEntry[],
  input: GroupInput,
  resolve: MessageResolver,
): MessagesTimelineRow[] {
  const groupId = workGroupId(anchor.id);
  const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
  const latestToolEntry = entries.findLast(workLogEntryIsToolLike);
  const singleEntry = entries.length === 1 ? (entries[0] ?? null) : null;
  const presentedEntries = presentedWorkEntries(entries);
  return [
    {
      kind: "work-toggle",
      id: `work-toggle:${anchor.id}`,
      createdAt: anchor.createdAt,
      runId: anchor.entry.runId ?? null,
      groupId,
      hiddenCount: presentedEntries.length,
      expanded,
      summary:
        singleEntry !== null &&
        singleEntry.itemType !== "reasoning" &&
        !workLogEntryIsToolLike(singleEntry)
          ? singleEntry.label
          : summarizeToolGroup(presentedEntries, resolve).summary,
      summaryKind: toolGroupSummaryKind(entries),
      hasFailure:
        latestToolEntry !== undefined && workEntryDisplayIndicatesToolFailure(latestToolEntry),
    },
    ...workGroupEntryRows(groupId, entries, expanded),
    ...viewedImagesRows(groupId, anchor.createdAt, entries),
  ];
}

/** Upstream lists an expanded failed group in one row under its thinking row; split per entry. */
function splitFailedGroupRow(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const index = rows.findIndex((row) => row.kind === "thinking" && row.expanded);
  const thinking = rows[index];
  const details = rows[index + 1];
  if (thinking?.kind !== "thinking" || !thinking.groupId || details?.kind !== "work") return rows;
  return rows.toSpliced(
    index + 1,
    1,
    ...workGroupEntryRows(thinking.groupId, details.groupedEntries, true),
  );
}

/** Assistant meta follows only trailing resource summaries, never the work groups after a reply. */
function attachTrailingResourcesToAssistant(
  rows: ReadonlyArray<MessagesTimelineRow>,
): MessagesTimelineRow[] {
  const messageRowsWithoutMeta = new Set<string>();
  const metaRowsAfterIndex = new Map<
    number,
    Extract<MessagesTimelineRow, { kind: "assistant-meta" }>
  >();

  for (const [messageIndex, row] of rows.entries()) {
    const runId = row.kind === "message" ? (row.message.runId ?? null) : null;
    if (
      row.kind !== "message" ||
      row.message.role !== "assistant" ||
      !row.showAssistantMeta ||
      runId === null
    ) {
      continue;
    }

    let lastResourceIndex = -1;
    for (let index = messageIndex + 1; index < rows.length; index += 1) {
      const candidate = rows[index];
      if (!candidate || candidate.kind === "message") {
        break;
      }
      if (
        candidate.kind === "event" &&
        candidate.resourceSummary &&
        candidate.projectedItem.item.runId === runId
      ) {
        lastResourceIndex = index;
      }
    }

    if (lastResourceIndex < 0) {
      continue;
    }

    messageRowsWithoutMeta.add(row.id);
    metaRowsAfterIndex.set(lastResourceIndex, {
      kind: "assistant-meta",
      id: `assistant-meta:${row.message.id}`,
      ...(row.projectedItem === undefined ? {} : { projectedItem: row.projectedItem }),
      createdAt: rows[lastResourceIndex]?.createdAt ?? row.message.updatedAt,
      message: row.message,
      showAssistantCopyButton: row.showAssistantCopyButton,
      assistantCopyStreaming: row.assistantCopyStreaming,
    });
  }

  const result: MessagesTimelineRow[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && messageRowsWithoutMeta.has(row.id)) {
      result.push({ ...row, showAssistantMeta: false, showAssistantCopyButton: false });
    } else {
      result.push(row);
    }
    const metaRow = metaRowsAfterIndex.get(index);
    if (metaRow) {
      result.push(metaRow);
    }
  }
  return result;
}

export const processRowHooks = {
  liveRows,
  groupRows,
  finishRows: (rows: MessagesTimelineRow[]) =>
    attachTrailingResourcesToAssistant(splitFailedGroupRow(rows)),
  // Turn presentation rebuilds admitted entry arrays during render.
  sameInputValue: (previous: unknown, next: unknown) =>
    Array.isArray(previous) &&
    Array.isArray(next) &&
    previous.length === next.length &&
    previous.every((item, index) => Object.is(item, next[index])),
};

export type ProcessRowHooks = typeof processRowHooks;

export function withProcessRows(input: MessagesTimelineRowsInput): MessagesTimelineRowsInput {
  return { ...input, processRows: processRowHooks };
}
