import { createContext } from "react";

export interface ForkTimelineRowState {
  seenAssistantMessages: Set<string>;
  onPresentationPendingChange: (messageId: string, pending: boolean) => void;
}

export const ForkTimelineRowCtx = createContext<ForkTimelineRowState>(null!);
