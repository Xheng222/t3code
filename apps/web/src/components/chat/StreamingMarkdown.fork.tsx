import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useStableCallback } from "../../hooks/useStableCallback";
import ChatMarkdown from "../ChatMarkdown";
import { createStreamingPresentation } from "./streamingPresentation.fork";
import { attachStreamingReveal } from "./streamingReveal.fork";
import { STREAMING_FADE_DURATION_MS } from "./streamingFade.fork";

type Props = ComponentProps<typeof ChatMarkdown> & {
  messageId: string;
  seenMessages: Set<string>;
  animateInitial: boolean;
  immediate: boolean;
  onPendingChange: (messageId: string, pending: boolean) => void;
};

export function StreamingMarkdown(props: Props) {
  const { messageId, seenMessages, animateInitial, immediate, onPendingChange, ...markdown } =
    props;
  const [live, setLive] = useState(markdown.isStreaming === true || animateInitial);
  if ((markdown.isStreaming || animateInitial) && !live) setLive(true);
  const [initiallyVisible] = useState(() => seenMessages.has(messageId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records mounted messages so virtualization cannot replay their existing text
  useLayoutEffect(() => {
    seenMessages.add(messageId);
  }, [messageId, seenMessages]);
  return live ? (
    <PresentedMarkdown
      {...markdown}
      messageId={messageId}
      initiallyVisible={initiallyVisible}
      immediate={immediate}
      onPendingChange={onPendingChange}
    />
  ) : (
    <ChatMarkdown {...markdown} />
  );
}

function PresentedMarkdown({
  messageId,
  initiallyVisible,
  immediate,
  onPendingChange,
  ...markdown
}: ComponentProps<typeof ChatMarkdown> & {
  messageId: string;
  initiallyVisible: boolean;
  immediate: boolean;
  onPendingChange: Props["onPendingChange"];
}) {
  const [presentation] = useState(() =>
    createStreamingPresentation(markdown.text, initiallyVisible),
  );
  const pending = useSyncExternalStore(presentation.subscribePending, presentation.getPending);
  const root = useRef<HTMLDivElement>(null);
  const reveal = useRef<ReturnType<typeof attachStreamingReveal> | undefined>(undefined);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const active = markdown.isStreaming === true || pending;
  const [retained, setRetained] = useState(active);
  if (active && !retained) setRetained(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lets the final characters finish fading before disposing the DOM presenter
  useLayoutEffect(() => {
    if (active || !retained) return;
    const timer = setTimeout(() => setRetained(false), STREAMING_FADE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [active, retained]);
  const onVisibility = useStableCallback(() => {
    if (document.hidden) presentation.update(markdown.text, true);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the animation scheduler and flushes hidden-page content without background animation
  useLayoutEffect(() => {
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      presentation.dispose();
    };
  }, [presentation, onVisibility]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports only presentation start/end to the timeline's smooth-follow state
  useLayoutEffect(() => {
    onPendingChange(messageId, pending);
    return () => onPendingChange(messageId, false);
  }, [messageId, pending, onPendingChange]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the DOM reveal subscription only while text is arriving or draining
  useLayoutEffect(() => {
    if (!retained || !root.current) return;
    const controller = attachStreamingReveal(
      root.current,
      presentation.subscribe,
      presentation.getProgress,
    );
    reveal.current = controller;
    return () => {
      controller.dispose();
      reveal.current = undefined;
    };
  }, [retained, presentation]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies each committed source update before paint while presentation frames stay outside React
  useLayoutEffect(() => {
    presentation.update(markdown.text, immediate || reducedMotion || document.hidden);
    reveal.current?.refresh();
  }, [presentation, markdown.text, immediate, reducedMotion]);
  return (
    <div ref={root} className="relative" data-streaming-presentation={retained ? "" : undefined}>
      <ChatMarkdown {...markdown} />
    </div>
  );
}
