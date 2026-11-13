import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";
import { retainBackgroundScope } from "./backgroundActivityReporter";

/**
 * Reports the thread on screen through client activity, so the server holds a finished turn's
 * completion while this client still reveals its reply.
 */
export function useWatchedThread(threadRef: ScopedThreadRef | null) {
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the shown thread with the client activity report the server reads
  useEffect(() => {
    if (environmentId === undefined || threadId === undefined) return;
    return retainBackgroundScope(environmentId, { type: "thread", threadId });
  }, [environmentId, threadId]);
}
