import { type RunId } from "@t3tools/contracts";
import { createContext } from "react";
import { type WorkGroupViewState, type WorkGroupViewedImage } from "./timelineRowContext";

export interface ForkTimelineRowState {
  /** Activity shows at once instead of pacing: find, citation positioning, zen, or a thread still opening. */
  activityImmediate: boolean;
  seenAssistantMessages: Set<string>;
  onPresentationPendingChange: (messageId: string, pending: boolean, textLength: number) => void;
  presentedAssistantMessages: ReadonlyMap<string, number>;
  pendingAssistantMessages: ReadonlySet<string>;
  onWorkEntryToggle: (anchorKey: string) => void;
  workGroupViewState: ForkWorkGroupViewState;
}

export const ForkTimelineRowCtx = createContext<ForkTimelineRowState>(null!);

export interface ForkWorkGroupViewState extends WorkGroupViewState {
  /** Runs whose live preview the user left expanded; new preview entries of the run open expanded. */
  expandedPreviewRuns: Set<RunId | null>;
}

export const ForkWorkGroupViewCtx = createContext<{
  state: ForkWorkGroupViewState;
  viewedImages: ReadonlyArray<WorkGroupViewedImage>;
  onToggleEntry: () => void;
} | null>(null);
