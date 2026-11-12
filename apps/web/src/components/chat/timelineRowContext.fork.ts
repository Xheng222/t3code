import { type RunId } from "@t3tools/contracts";
import { createContext } from "react";
import { type WorkGroupViewState, type WorkGroupViewedImage } from "./timelineRowContext";

export interface ForkTimelineRowState {
  /** Activity shows at once instead of pacing: find, citation positioning, zen, or a thread still opening. */
  activityImmediate: boolean;
  seenAssistantMessages: Set<string>;
  onPresentationPendingChange: (messageId: string, pending: boolean, textLength: number) => void;
  pendingAssistantMessages: ReadonlySet<string>;
  presentationPaused: boolean;
  onWorkEntryToggle: (anchorKey: string, toggle: WorkEntryToggle) => void;
  workGroupViewState: ForkWorkGroupViewState;
}

export const ForkTimelineRowCtx = createContext<ForkTimelineRowState>(null!);

export interface ForkWorkGroupViewState extends WorkGroupViewState {
  /** Runs whose live preview the user left expanded; new preview entries of the run open expanded. */
  expandedPreviewRuns: Set<RunId | null>;
}

export interface WorkEntryToggle {
  readonly entry: HTMLElement;
  /** The entry's header line, marked `data-stuck` while it sticks to the top of the timeline. */
  readonly line: HTMLElement;
  readonly expanding: boolean;
  /** The entry is the live preview's. */
  readonly preview: boolean;
}

export const ForkWorkGroupViewCtx = createContext<{
  state: ForkWorkGroupViewState;
  viewedImages: ReadonlyArray<WorkGroupViewedImage>;
  onToggleEntry: (toggle: WorkEntryToggle) => void;
} | null>(null);
