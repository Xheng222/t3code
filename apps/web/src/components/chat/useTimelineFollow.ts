import { useStableCallback } from "../../hooks/useStableCallback";
import { type MessageId, type RunId } from "@t3tools/contracts";
import { Debouncer } from "@tanstack/react-pacer";
import {
  type SetStateAction,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type LegendListRef } from "@legendapp/list/react";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  timelineContentOverflowsViewport,
  readTimelinePosition,
  observeTimelineRun,
  type TimelineRunObservation,
} from "./timelineScrollAnchoring";
import { createPageScrollController, type PageScrollKey } from "./pageScrollController";
import {
  FOLLOWING,
  initialTimelineFollow,
  navigationReleasesFollow,
  transitionTimelineFollow,
  type TimelineFollow,
  type TimelineFollowEvent,
  type TimelineNavigation,
  type TimelineViewport,
} from "./timelineViewport";
import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import { measuredEndOffset, settleListScroll } from "./useTimelinePositionRestore";
import { releaseChatTimelineAnchor } from "../ChatView.logic";
import type { Dispatch, RefObject } from "react";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { deriveThreadActivityRun } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import type { TimelineEntry } from "../../session-logic";

const ignoreAnchorSizeChange = (_messageId: MessageId, _size: number) => {};

interface TimelineAnchor {
  readonly threadKey: string | null;
  readonly messageId: MessageId | null;
}

/** One visit to a thread; a switch starts a new one from the remembered position. */
interface TimelineFollowVisit {
  readonly threadKey: string | null;
  readonly followEnd: boolean;
}

/**
 * Scroll bookkeeping that belongs to one visit. Handlers fetch it for the
 * current visit, so a thread switch leaves the old one behind instead of
 * resetting it.
 */
function createVisitScrollState(
  visit: TimelineFollowVisit,
  showScrollToBottom: (visit: TimelineFollowVisit) => void,
) {
  return {
    visit,
    // Debounce *showing* the scroll-to-bottom pill so it doesn't flash during
    // thread switches. LegendList fires scroll events with isAtEnd=false while
    // initialScrollAtEnd is settling; hiding is always immediate.
    showScrollDebouncer: new Debouncer(() => showScrollToBottom(visit), { wait: 150 }),
    positionedAnchor: null as MessageId | null,
    generation: 0,
    positioning: false,
    resumeOnScroll: false,
    releaseAnchorScrollHold: null as (() => void) | null,
  };
}
type VisitScrollState = ReturnType<typeof createVisitScrollState>;

function stopAnchorPositioning(scroll: VisitScrollState) {
  scroll.positionedAnchor = null;
  scroll.generation += 1;
  scroll.positioning = false;
  scroll.releaseAnchorScrollHold?.();
  scroll.releaseAnchorScrollHold = null;
}

/**
 * The follow mode, read by scroll listeners at event time and by render
 * through useSyncExternalStore. State recorded for an earlier visit is
 * discarded, so a thread switch needs no reset step.
 */
function createTimelineFollowStore() {
  let snapshot: { readonly visit: TimelineFollowVisit | null; readonly follow: TimelineFollow } = {
    visit: null,
    follow: FOLLOWING,
  };
  const listeners = new Set<() => void>();
  // Page keys read the overlay at keypress time; it changes no rendered state.
  let composerOverlay: HTMLElement | null = null;
  const read = (visit: TimelineFollowVisit) =>
    snapshot.visit === visit ? snapshot.follow : initialTimelineFollow(visit.followEnd);
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    read,
    /** Ref callback for the composer overlay. */
    attachComposerOverlay: (element: HTMLElement | null) => {
      composerOverlay = element;
    },
    readComposerOverlayHeight: () => composerOverlay?.getBoundingClientRect().height ?? 0,
    dispatch: (visit: TimelineFollowVisit, event: TimelineFollowEvent) => {
      const before = read(visit);
      const after = transitionTimelineFollow(before, event);
      if (snapshot.visit !== visit || after !== snapshot.follow) {
        snapshot = { visit, follow: after };
        for (const listener of listeners) listener();
      }
      return { before, after };
    },
  };
}

function sameRunObservation(
  next: TimelineRunObservation,
  previous: TimelineRunObservation | null,
): boolean {
  return (
    previous !== null &&
    next.threadKey === previous.threadKey &&
    next.hydrated === previous.hydrated &&
    next.runId === previous.runId
  );
}

interface TimelineFollowInput {
  readonly legendListRef: RefObject<LegendListRef | null>;
  readonly composerTimelineInset: number;
  readonly routeThreadKey: string;
  readonly activeThreadKey: string | null;
  readonly isServerThread: boolean;
  readonly serverProjection: ThreadStructure | null;
  readonly threadStatus: EnvironmentThreadStatus;
  readonly activeActivityRun: ReturnType<typeof deriveThreadActivityRun>;
  readonly activeRunningTurnId: RunId | null;
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly timelineAnchorMessageId: MessageId | null;
  readonly setTimelineAnchor: Dispatch<SetStateAction<TimelineAnchor>>;
}

/**
 * Keeps the timeline following the live end, positioning a newly sent turn,
 * and letting the user scroll away. Follow lives in a store the
 * viewport's navigation signal writes, so a scroll gesture does not re-render
 * ChatView unless the follow mode flips.
 */
export function useTimelineFollow(input: TimelineFollowInput) {
  const {
    legendListRef,
    composerTimelineInset,
    routeThreadKey,
    activeThreadKey,
    isServerThread,
    serverProjection,
    threadStatus,
    activeActivityRun,
    timelineAnchorMessageId,
    setTimelineAnchor,
  } = input;
  const [visitState, setVisit] = useState<TimelineFollowVisit>({
    threadKey: activeThreadKey,
    followEnd: true,
  });
  let visit = visitState;
  if (visit.threadKey !== activeThreadKey) {
    visit = {
      threadKey: activeThreadKey,
      followEnd: readTimelinePosition(routeThreadKey)?.atEnd !== false,
    };
    setVisit(visit);
  }
  // Keyed by visit, so a pill decision from the previous thread (a pending
  // debounce) never shows here.
  const [pill, setPill] = useState<{ readonly visit: TimelineFollowVisit; readonly show: boolean }>(
    { visit, show: false },
  );
  const showScrollToBottom = pill.visit === visit ? pill.show : !visit.followEnd;
  // Called on every streamed chunk while following; an unchanged pill must
  // bail out instead of re-rendering ChatView.
  const setShowScrollToBottom = (show: boolean) =>
    setPill((current) =>
      current.visit === visit && current.show === show ? current : { visit, show },
    );
  const [followStore] = useState(createTimelineFollowStore);
  const followSnapshot = useSyncExternalStore(followStore.subscribe, followStore.snapshot);
  const follow =
    followSnapshot.visit === visit ? followSnapshot.follow : initialTimelineFollow(visit.followEnd);
  const timelineLiveFollowEnabled = follow.mode === "following";
  const readFollow = () => followStore.read(visit);
  // Async settles outlive their render; this reads the visit shown now.
  const readCurrentFollow = useStableCallback(readFollow);
  const readCurrentVisit = useStableCallback(() => visit);
  const isTimelineAtLogicalEnd = () => {
    const current = readFollow();
    return (
      resolveTimelineIsAtEnd(legendListRef.current?.getState()) ??
      (current.mode === "following" || current.atEnd)
    );
  };
  const visitScrollRef = useRef<VisitScrollState | null>(null);
  /** Only from handlers: the bookkeeping of the visit they run in. */
  const visitScroll = () => {
    if (visitScrollRef.current?.visit !== visit) {
      visitScrollRef.current = createVisitScrollState(visit, (shownVisit) => {
        // A debounce that outlived its visit must not overwrite the current one's pill.
        if (visitScrollRef.current?.visit === shownVisit)
          setPill({ visit: shownVisit, show: true });
      });
    }
    return visitScrollRef.current;
  };
  // The anchor whose list position LegendList reported ready; until then a
  // newly started run must not re-anchor.
  const [laidOutAnchor, setLaidOutAnchor] = useState<MessageId | null>(null);
  const [positioningVisit, setPositioningVisit] = useState<TimelineFollowVisit | null>(null);
  const presentationPaused = timelineAnchorMessageId !== null || positioningVisit === visit;
  const anchorPending =
    timelineAnchorMessageId !== null && laidOutAnchor !== timelineAnchorMessageId;
  const viewportRef = useRef<TimelineViewport | null>(null);
  const releaseFollowForNavigation = () => {
    const { before } = followStore.dispatch(visit, { type: "navigated" });
    if (before.mode === "following") viewportRef.current?.followReleased();
    const scroll = visitScroll();
    stopAnchorPositioning(scroll);
    setPositioningVisit(null);
    setTimelineAnchor(releaseChatTimelineAnchor);
    if (before.mode === "following") {
      const list = legendListRef.current;
      list?.cancelScroll();
      // Layout follow also starts smooth DOM scrolls outside the list's tracker.
      const node = list?.getScrollableNode() as HTMLElement | undefined;
      if (node) {
        const top = node.scrollTop;
        node.scrollTop = top;
      }
    }
  };

  // A newly dispatched run positions the end unless a send is already positioning it.
  const [observedRun, setObservedRun] = useState<TimelineRunObservation | null>(null);
  const dispatchedUserItem =
    observedRun?.hydrated &&
    observedRun.threadKey === activeThreadKey &&
    activeActivityRun !== null &&
    observedRun.runId !== activeActivityRun.runId
      ? serverProjection?.visibleTurnItems.find(
          (row) => row.item.type === "user_message" && row.item.runId === activeActivityRun.runId,
        )
      : undefined;
  const runObservation = observeTimelineRun(observedRun, {
    threadKey: activeThreadKey,
    hydrated: !isServerThread || (serverProjection !== null && threadStatus === "live"),
    runId: activeActivityRun?.runId ?? null,
    queued: activeActivityRun?.status === "queued",
    messageId:
      dispatchedUserItem?.item.type === "user_message" ? dispatchedUserItem.item.messageId : null,
    positionedMessageId: laidOutAnchor,
  });
  if (!sameRunObservation(runObservation.observation, observedRun)) {
    setObservedRun(runObservation.observation);
    const startedRunAnchor = runObservation.anchorMessageId;
    if (startedRunAnchor !== null && !anchorPending && timelineLiveFollowEnabled) {
      setShowScrollToBottom(false);
      setTimelineAnchor({ threadKey: activeThreadKey, messageId: startedRunAnchor });
    }
  }
  const timelineRealContentOverflowsViewport = () =>
    timelineContentOverflowsViewport(legendListRef.current?.getState(), {
      composerInset: composerTimelineInset,
      anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
    });
  const pageScrollControllerRef = useRef<ReturnType<typeof createPageScrollController> | null>(
    null,
  );
  const handlePageScrollStart = useStableCallback((key: PageScrollKey) => {
    if ((key === "PageUp" && timelineRealContentOverflowsViewport()) || !isTimelineAtLogicalEnd()) {
      // Through the viewport, so a running position restore stops too.
      viewportRef.current?.navigate({ releasesFollow: true });
    }
    visitScroll().resumeOnScroll = true;
  });
  const onComposerPageScrollKeyDown = (key: PageScrollKey) => {
    pageScrollControllerRef.current?.handleKeyDown(key);
  };
  const onComposerPageScrollKeyDownStable = useStableCallback(onComposerPageScrollKeyDown);
  const onComposerPageScrollKeyUp = (key: string) => {
    pageScrollControllerRef.current?.handleKeyUp(key);
  };
  const onComposerPageScrollKeyUpStable = useStableCallback(onComposerPageScrollKeyUp);
  const onComposerPageScrollRelease = () => {
    pageScrollControllerRef.current?.releaseActiveKey();
  };
  const onComposerPageScrollReleaseStable = useStableCallback(onComposerPageScrollRelease);
  const scrollToEnd = (animated: boolean = false) => {
    // Stops a running position restore; follow itself is re-armed below.
    viewportRef.current?.navigate({ releasesFollow: false });
    followStore.dispatch(visit, { type: "followEnd" });
    visitScroll().showScrollDebouncer.cancel();
    setShowScrollToBottom(false);
    const scroll = visitScroll();
    stopAnchorPositioning(scroll);
    const generation = scroll.generation;
    scroll.positioning = true;
    setPositioningVisit(visit);
    const releaseHold = viewportRef.current?.holdProgrammaticScroll() ?? (() => {});
    scroll.releaseAnchorScrollHold = releaseHold;
    const cancelled = () =>
      scroll.generation !== generation ||
      readCurrentVisit() !== visit ||
      visitScrollRef.current !== scroll ||
      readCurrentFollow().mode !== "following";
    requestAnimationFrame(() => {
      const list = legendListRef.current;
      if (!list || cancelled()) {
        releaseHold();
        if (!cancelled()) {
          scroll.positioning = false;
          setPositioningVisit(null);
          setTimelineAnchor(releaseChatTimelineAnchor);
        }
        return;
      }
      const animate = animated && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      void list.scrollToEnd({ animated: animate }).then(async () => {
        if (cancelled()) return;
        await settleListScroll(list, measuredEndOffset, cancelled, animate);
        if (cancelled()) return;
        scroll.positioning = false;
        scroll.releaseAnchorScrollHold = null;
        releaseHold();
        setTimelineAnchor(releaseChatTimelineAnchor);
        setPositioningVisit(null);
      });
    });
  };
  const scrollToEndStable = useStableCallback(scrollToEnd);
  // The list does not follow footer layout, so the resting composer cannot scroll it. Growth
  // above the composer (a new notice) would cover the last rows instead.
  const followedInsetRef = useRef(composerTimelineInset);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the list after its bottom inset grows
  useLayoutEffect(() => {
    const grew = composerTimelineInset > followedInsetRef.current;
    followedInsetRef.current = composerTimelineInset;
    if (grew) viewportRef.current?.layoutChanged(false);
  }, [composerTimelineInset]);

  const handleNavigation = (navigation: TimelineNavigation) => {
    if (navigation.source === "command") visitScroll().resumeOnScroll = false;
    else if (navigation.source !== "pointer" || navigation.onScrollbar)
      visitScroll().resumeOnScroll = true;
    const awayFromEnd = () => resolveTimelineIsAtEnd(legendListRef.current?.getState()) === false;
    const releases = navigationReleasesFollow(navigation, {
      contentScrollsUp: timelineRealContentOverflowsViewport,
      awayFromEnd,
    });
    if (releases) releaseFollowForNavigation();
  };
  const handleNavigationStable = useStableCallback(handleNavigation);
  const followLayoutStable = useStableCallback((viewport: TimelineViewport, animating: boolean) => {
    if (
      viewportRef.current !== viewport ||
      readFollow().mode !== "following" ||
      timelineAnchorMessageId !== null ||
      visitScroll().positioning
    )
      return;
    const node = viewport.scrollNode;
    const end = Math.max(0, measuredEndOffset(node));
    if (Math.abs(node.scrollTop - end) <= 1) return;
    node.scrollTo({
      top: end,
      behavior:
        animating || window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
    });
  });
  /**
   * Attached by the timeline's list ref callback, so follow hears the
   * viewport's navigation exactly as long as the scroll node exists.
   */
  const attachTimelineViewport = (viewport: TimelineViewport) => {
    viewportRef.current = viewport;
    const unsubscribe = viewport.subscribe(handleNavigationStable);
    let attached = true;
    let layoutQueued = false;
    let regionAnimating = false;
    let followWithoutTween = false;
    const stopLayout = viewport.onLayoutChanged((animating) => {
      followWithoutTween ||= animating || regionAnimating;
      regionAnimating = animating;
      if (layoutQueued) return;
      layoutQueued = true;
      queueMicrotask(() => {
        layoutQueued = false;
        if (attached) followLayoutStable(viewport, followWithoutTween);
        followWithoutTween = false;
      });
    });
    const controller = createPageScrollController({
      getContainer: () => viewport.scrollNode,
      getScrollPaddingBottomPx: followStore.readComposerOverlayHeight,
      onScrollStart: handlePageScrollStart,
    });
    pageScrollControllerRef.current = controller;
    return () => {
      unsubscribe();
      stopLayout();
      attached = false;
      controller.dispose();
      if (pageScrollControllerRef.current === controller) pageScrollControllerRef.current = null;
      if (viewportRef.current === viewport) viewportRef.current = null;
      const scroll = visitScrollRef.current;
      if (scroll) stopAnchorPositioning(scroll);
    };
  };

  const onTimelineAnchorReady = (messageId: MessageId) => {
    setLaidOutAnchor(messageId);
    if (readFollow().mode !== "following" || timelineAnchorMessageId !== messageId) return;
    const scroll = visitScroll();
    if (scroll.positionedAnchor === messageId || scroll.positioning) return;
    scrollToEndStable(true);
    scroll.positionedAnchor = messageId;
  };
  const onTimelineAnchorReadyStable = useStableCallback(onTimelineAnchorReady);
  // The timeline leaves no anchored end space, so it never reports one's size.
  const onTimelineAnchorSizeChangedStable = ignoreAnchorSizeChange;

  // The list ignores footer layout, so a new queued turn or status line there would land
  // under the composer. Follow it when the reader was following the end.
  const onTimelineFooterGrow = () => {
    viewportRef.current?.layoutChanged(false);
  };
  const onTimelineFooterGrowStable = useStableCallback(onTimelineFooterGrow);

  const onIsAtEndChange = (isAtEnd: boolean) => {
    const scroll = visitScroll();
    if (!isAtEnd && readFollow().mode === "following") {
      scroll.showScrollDebouncer.cancel();
      setShowScrollToBottom(false);
      return;
    }
    const { before, after } = followStore.dispatch(
      visit,
      isAtEnd ? { type: "reachedEnd", rearm: scroll.resumeOnScroll } : { type: "leftEnd" },
    );
    if (after === before) return;
    if (isAtEnd) {
      if (after.mode === "following" && !scroll.positioning)
        setTimelineAnchor(releaseChatTimelineAnchor);
      scroll.showScrollDebouncer.cancel();
      setShowScrollToBottom(false);
    } else {
      scroll.showScrollDebouncer.maybeExecute();
    }
  };
  const onIsAtEndChangeStable = useStableCallback(onIsAtEndChange);

  /** Arms the anchor for a message the user just sent, before its run exists. */
  const anchorNewTurn = (threadKey: string, messageId: MessageId) => {
    stopAnchorPositioning(visitScroll());
    setPositioningVisit(null);
    followStore.dispatch(visit, { type: "followEnd" });
    visitScroll().showScrollDebouncer.cancel();
    setShowScrollToBottom(false);
    setTimelineAnchor({ threadKey, messageId });
  };

  return {
    showScrollToBottom,
    timelineLiveFollowEnabled,
    presentationPaused,
    onComposerPageScrollKeyDownStable,
    onComposerPageScrollKeyUpStable,
    onComposerPageScrollReleaseStable,
    scrollToEnd,
    onTimelineAnchorReadyStable,
    onTimelineAnchorSizeChangedStable,
    onTimelineFooterGrowStable,
    onIsAtEndChangeStable,
    anchorNewTurn,
    attachTimelineViewport,
    attachComposerOverlay: followStore.attachComposerOverlay,
  };
}
