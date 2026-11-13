import { RunId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { workLogEntryIsToolLike, type TimelineEntry } from "../../session-logic";

function isProcessContent(entry: TimelineEntry) {
  if (entry.kind === "message") return entry.message.role === "assistant";
  if (
    entry.kind === "proposed-plan" ||
    entry.kind === "html-render" ||
    entry.kind === "mcp-app" ||
    entry.kind === "sent-message"
  )
    return true;
  if (entry.kind === "event") return entry.projectedItem.item.type === "subagent";
  if (
    entry.kind !== "work" ||
    entry.entry.questionAnswer !== undefined ||
    entry.entry.tone === "error"
  )
    return false;
  const { itemType } = entry.entry;
  if (
    itemType === "approval_request" ||
    itemType === "user_input_request" ||
    itemType === "todo_list" ||
    itemType === "notification" ||
    itemType === "error" ||
    itemType === "system_notice"
  )
    return false;
  return (
    itemType === "reasoning" ||
    entry.entry.tone === "thinking" ||
    workLogEntryIsToolLike(entry.entry)
  );
}

function textIsPresented(text: string, presented: number | undefined) {
  // Source replacements display immediately; only appended text can need more reveal.
  return presented !== undefined && presented >= text.length;
}

export function holdTurnContent(
  entries: ReadonlyArray<TimelineEntry>,
  held: ReadonlyArray<TimelineEntry>,
) {
  const previous = new Map(held.map((entry) => [entry.id, entry]));
  return entries.flatMap((entry) => {
    if (!isProcessContent(entry)) return [entry];
    const existing = previous.get(entry.id);
    return existing ? [existing] : [];
  });
}

export function admitTurnContent(
  entries: ReadonlyArray<TimelineEntry>,
  completed: ReadonlyMap<string, number>,
  pending: ReadonlySet<string>,
  latestRunId: RunId | null,
) {
  let blocked = false;
  let shown: TimelineEntry[] | undefined;
  for (const [index, entry] of entries.entries()) {
    if (
      entry.kind === "message" &&
      entry.message.role === "user" &&
      entry.message.inputIntent !== "steer" &&
      entry.message.inputIntent !== "promoted_queued_to_steer"
    )
      blocked = false;
    if (blocked && isProcessContent(entry)) {
      shown ??= entries.slice(0, index);
      continue;
    }
    shown?.push(entry);
    if (
      entry.kind === "message" &&
      entry.message.role === "assistant" &&
      (pending.has(entry.message.id) ||
        entry.message.streaming ||
        (latestRunId !== null && entry.message.runId === latestRunId))
    ) {
      blocked =
        Boolean(entry.message.streaming) ||
        pending.has(entry.message.id) ||
        !textIsPresented(entry.message.text, completed.get(entry.message.id));
    }
  }
  return shown ?? entries;
}

export function useTurnPresentation({
  identity,
  entries: source,
  latestRunId,
  isWorking,
  immediate: immediateInput,
  paused = false,
  synced = true,
}: {
  identity: string;
  entries: ReadonlyArray<TimelineEntry>;
  latestRunId: RunId | null;
  isWorking: boolean;
  immediate: boolean;
  paused?: boolean;
  /** False while the entries are a copy held from before the thread's detail synced. */
  synced?: boolean;
}) {
  const [held, setHeld] = useState({ identity, entries: source });
  if (held.identity !== identity || (!paused && held.entries !== source))
    setHeld({ identity, entries: source });
  const hydrated = synced && source.length > 0;
  const createVisit = () => ({
    identity,
    hydrated,
    seen: new Set<string>(
      source.flatMap((entry) =>
        entry.kind === "message" && entry.message.role === "assistant" ? [entry.message.id] : [],
      ),
    ),
    completed: new Map<string, number>(
      source.flatMap((entry) =>
        entry.kind === "message" && entry.message.role === "assistant"
          ? [[entry.message.id, entry.message.text.length] as const]
          : [],
      ),
    ),
    pending: new Set<string>(),
    startedRuns: new Set<RunId>(),
  });
  const [state, setState] = useState(createVisit);
  let visit = state;
  // The visit starts from the first synced entries; everything shown before is history.
  if (
    visit.identity !== identity ||
    (!visit.hydrated &&
      (hydrated ||
        source.some(
          (entry) =>
            entry.kind === "message" &&
            entry.message.role === "assistant" &&
            !visit.seen.has(entry.message.id),
        )))
  ) {
    visit = createVisit();
    setState(visit);
  }
  const immediate = immediateInput || !visit.hydrated;
  const entries =
    paused && held.identity === identity && !immediate
      ? holdTurnContent(source, held.entries)
      : source;
  const onPendingChange = useStableCallback(
    (messageId: string, pending: boolean, textLength: number) => {
      setState((current) => {
        if (current.identity !== identity) return current;
        if (
          current.pending.has(messageId) === pending &&
          (pending || current.completed.get(messageId) === textLength)
        )
          return current;
        const entry = entries.find(
          (candidate) => candidate.kind === "message" && candidate.message.id === messageId,
        );
        if (!entry && !current.pending.has(messageId)) return current;
        const nextPending = new Set(current.pending);
        const completed = new Map(current.completed);
        const startedRuns = new Set(current.startedRuns);
        if (pending) {
          nextPending.add(messageId);
          if (entry?.kind === "message" && entry.message.runId)
            startedRuns.add(entry.message.runId);
        } else {
          nextPending.delete(messageId);
          completed.set(messageId, textLength);
        }
        return { ...current, pending: nextPending, completed, startedRuns };
      });
    },
  );
  const presentingRunIds = new Set(visit.startedRuns);
  for (const entry of entries) {
    if (entry.kind !== "message" || entry.message.role !== "assistant" || !entry.message.runId)
      continue;
    if (
      entry.message.runId === latestRunId &&
      (entry.message.streaming ||
        visit.pending.has(entry.message.id) ||
        !textIsPresented(entry.message.text, visit.completed.get(entry.message.id)))
    ) {
      presentingRunIds.add(entry.message.runId);
    }
  }
  const readyRunKey = [...presentingRunIds]
    .filter((runId) => {
      if (isWorking && runId === latestRunId) return false;
      return entries.every(
        (entry) =>
          entry.kind !== "message" ||
          entry.message.role !== "assistant" ||
          entry.message.runId !== runId ||
          (!entry.message.streaming &&
            !visit.pending.has(entry.message.id) &&
            textIsPresented(entry.message.text, visit.completed.get(entry.message.id))),
      );
    })
    .join("\0");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leaves a visible boundary between changed files appearing and the process folding
  useEffect(() => {
    if (!readyRunKey || immediate) return;
    const timer = setTimeout(
      () =>
        setState((current) => {
          if (current.identity !== identity) return current;
          const startedRuns = new Set(current.startedRuns);
          for (const runId of readyRunKey.split("\0")) startedRuns.delete(RunId.make(runId));
          return { ...current, startedRuns };
        }),
      160,
    );
    return () => clearTimeout(timer);
  }, [identity, readyRunKey, immediate]);
  const admittedEntries = immediate
    ? entries
    : admitTurnContent(entries, visit.completed, visit.pending, latestRunId);
  return {
    visit,
    onPendingChange,
    entries: admittedEntries,
    presentingRunIds: immediate ? new Set<RunId>() : presentingRunIds,
  };
}
