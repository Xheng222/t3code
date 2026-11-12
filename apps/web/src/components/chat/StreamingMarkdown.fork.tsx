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
  paused?: boolean;
  onPendingChange: (messageId: string, pending: boolean, textLength: number) => void;
};

export function StreamingMarkdown(props: Props) {
  const {
    messageId,
    seenMessages,
    animateInitial,
    immediate,
    paused = false,
    onPendingChange,
    ...markdown
  } = props;
  const startPresentation = (generation: number) => ({
    seenMessages,
    generation,
    live: markdown.isStreaming === true || animateInitial,
    initiallyVisible: seenMessages.has(messageId),
  });
  const [state, setState] = useState(() => startPresentation(0));
  let presentation = state;
  // A new visit takes the text this message already shows as history, without a reveal.
  if (presentation.seenMessages !== seenMessages) {
    presentation = startPresentation(presentation.generation + 1);
    setState(presentation);
  }
  if ((markdown.isStreaming || animateInitial) && !presentation.live) {
    presentation = { ...presentation, live: true };
    setState(presentation);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records mounted messages so virtualization cannot replay their existing text
  useLayoutEffect(() => {
    seenMessages.add(messageId);
  }, [messageId, seenMessages]);
  return presentation.live ? (
    <PresentedMarkdown
      key={presentation.generation}
      {...markdown}
      messageId={messageId}
      initiallyVisible={presentation.initiallyVisible}
      immediate={immediate}
      paused={paused}
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
  paused,
  onPendingChange,
  ...markdown
}: ComponentProps<typeof ChatMarkdown> & {
  messageId: string;
  initiallyVisible: boolean;
  immediate: boolean;
  paused: boolean;
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
    presentation.update(markdown.text, immediate || reducedMotion || document.hidden, paused);
    reveal.current?.refresh();
  }, [presentation, markdown.text, immediate, reducedMotion, paused]);
  const finishPresentation = useStableCallback(() =>
    onPendingChange(messageId, false, markdown.text.length),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases presentation when virtualization unmounts an offscreen message
  useLayoutEffect(() => () => finishPresentation(), [finishPresentation]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports source completion after reveal and the final character fade
  useLayoutEffect(() => {
    onPendingChange(messageId, presentation.getPending() || retained, markdown.text.length);
  }, [messageId, retained, markdown.text, presentation, onPendingChange]);
  return (
    <div ref={root} className="relative" data-streaming-presentation={retained ? "" : undefined}>
      <ChatMarkdown {...markdown} />
    </div>
  );
}
