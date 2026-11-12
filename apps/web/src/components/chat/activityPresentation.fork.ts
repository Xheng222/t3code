import { msg } from "gt-react";
import { useLayoutEffect, useEffectEvent, useRef, useState } from "react";
import { workEntryIsActiveTurnActivity, type MessagesTimelineRow } from "./MessagesTimeline.logic";

const MIN_ACTIVITY_DURATION_MS = 600;
const WAITING_VERBS = [
  "cogitating",
  "pondering",
  "contemplating",
  "reflecting",
  "mulling",
  "deliberating",
  "puzzling",
  "scheming",
  "brewing",
  "ideating",
  "sketching",
  "crafting",
  "distilling",
  "untangling",
  "weaving",
  "hatching",
  "fermenting",
  "simmering",
  "marinating",
  "noodling",
] as const;

/** A message for the row to resolve, so the derived rows stay language-independent. */
export function waitingResponseLabel(turnKey: string): string {
  let hash = 0;
  for (let index = 0; index < turnKey.length; index += 1) {
    hash = (Math.imul(hash, 31) + turnKey.charCodeAt(index)) | 0;
  }
  return msg(
    "{verb, select, cogitating {Cogitating} pondering {Pondering} contemplating {Contemplating} reflecting {Reflecting} mulling {Mulling} deliberating {Deliberating} puzzling {Puzzling} scheming {Scheming} brewing {Brewing} ideating {Ideating} sketching {Sketching} crafting {Crafting} distilling {Distilling} untangling {Untangling} weaving {Weaving} hatching {Hatching} fermenting {Fermenting} simmering {Simmering} marinating {Marinating} other {Noodling}}",
    {
      verb: WAITING_VERBS[(hash >>> 0) % WAITING_VERBS.length]!,
      $context: "playful status shown before the agent starts responding",
    },
  );
}

export function usePacedActivity<T>({
  identity,
  items,
  getId,
  getRevision,
  immediate,
}: {
  identity: string;
  items: ReadonlyArray<T>;
  getId: (item: T) => string;
  getRevision?: (item: T) => string | undefined;
  immediate: boolean;
}) {
  const latest = items.at(-1);
  const latestId = latest === undefined ? undefined : getId(latest);
  const [state, setState] = useState(() => ({ identity, id: latestId }));
  const timing = useRef<{
    identity: string;
    id: string | undefined;
    revision: string | undefined;
    shownAt: number;
  } | null>(null);
  let shown = state;
  const missing =
    state.id !== undefined &&
    state.id !== latestId &&
    !items.some((item) => getId(item) === state.id);
  if (
    state.identity !== identity ||
    missing ||
    (state.id !== latestId && (immediate || state.id === undefined))
  ) {
    shown = { identity, id: latestId };
    setState(shown);
  }
  const selected = shown.id === latestId ? latest : items.find((item) => getId(item) === shown.id);
  const revision = selected === undefined ? undefined : getRevision?.(selected);
  const waiting = shown.id !== latestId;
  const advance = useEffectEvent((expectedIdentity: string, expectedId: string | undefined) => {
    if (identity !== expectedIdentity) return;
    setState((current) =>
      current.identity === expectedIdentity && current.id === expectedId
        ? { identity, id: latestId }
        : current,
    );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the visible interval at commit and cancels pending switches on activity or thread changes
  useLayoutEffect(() => {
    const now = performance.now();
    if (
      timing.current?.identity !== identity ||
      timing.current.id !== shown.id ||
      timing.current.revision !== revision
    ) {
      timing.current = { identity, id: shown.id, revision, shownAt: now };
    }
    if (!waiting || immediate) return;
    const remaining = timing.current.shownAt + MIN_ACTIVITY_DURATION_MS - now;
    if (remaining <= 0) {
      advance(identity, shown.id);
      return;
    }
    const timer = setTimeout(() => advance(identity, shown.id), remaining);
    return () => clearTimeout(timer);
  }, [identity, shown.id, revision, waiting, immediate]);

  return selected;
}

export function usePacedActivityRows(
  rows: MessagesTimelineRow[],
  identity: string,
  immediate: boolean,
) {
  const index = rows.findIndex((row) => row.kind === "work-live");
  const row = rows[index];
  const group = row?.kind === "work-live" ? row : undefined;
  const entry = usePacedActivity({
    identity: `${identity}\0${group?.groupId ?? ""}`,
    items: group?.groupedEntries ?? [],
    getId: (item) => item.id,
    // A thought can receive its final paragraph in the same batch as the next tool.
    getRevision: (item) => (item.itemType === "reasoning" ? item.detail : undefined),
    immediate: immediate || !group || group.expanded,
  });
  if (!group || !entry || entry.id === group.entry.id) return rows;
  const next = rows.slice();
  next[index] = { ...group, entry, active: workEntryIsActiveTurnActivity(entry) };
  const body = rows[index + 1];
  if (body?.kind === "work" && body.groupId === group.groupId) {
    next[index + 1] = {
      ...body,
      createdAt: entry.createdAt,
      groupedEntries: [entry],
    };
  }
  return next;
}

type WaitingActivity = { label: string; createdAt: string | null } | null;

export function deriveProcessGroupRows(rows: MessagesTimelineRow[], waiting: WaitingActivity) {
  const result: MessagesTimelineRow[] = [];
  let boundary = "start";
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.kind === "work-live" || row.kind === "work-toggle") {
      const preview = rows[index + 1];
      const inline =
        row.kind === "work-live" &&
        !row.expanded &&
        preview?.kind === "work" &&
        preview.groupId === row.groupId;
      result.push({
        ...row,
        id: `process:${boundary}`,
        continuesWorkLog: (inline ? preview.continuesWorkLog : row.continuesWorkLog) === true,
      });
      if (inline) index += 1;
      boundary = row.groupId;
    } else if (row.kind === "event" && row.projectedItem.item.type === "subagent") {
      result.push({ ...row, id: `process:${boundary}` });
      boundary = row.id;
    } else {
      result.push(row);
      if (
        row.kind !== "working" &&
        row.kind !== "turn-fold" &&
        row.kind !== "viewed-images" &&
        !(row.kind === "work" && row.groupId)
      )
        boundary = row.id;
    }
  }
  const tail = result.at(-1);
  if (
    waiting &&
    (!tail || tail.kind === "working" || tail.kind === "message" || tail.kind === "sent-message")
  ) {
    result.push({ kind: "work-waiting", id: `process:${boundary}`, ...waiting });
  }
  return result;
}
