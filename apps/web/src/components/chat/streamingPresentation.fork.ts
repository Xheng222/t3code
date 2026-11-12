export const DEFAULT_STREAMING_SPEED = { normal: 80, maximum: 200 };

function streamingSpeed(current: number, remaining: number, delta: number) {
  const speeds = DEFAULT_STREAMING_SPEED;
  const target = Math.min(
    speeds.maximum,
    speeds.normal + Math.max(0, remaining - speeds.normal) / 2,
  );
  return Math.max(
    speeds.normal,
    Math.min(speeds.maximum, current + (target - current) * (1 - Math.exp(-delta / 120))),
  );
}

export function createStreamingPresentation(initialText: string, initiallyVisible: boolean) {
  const listeners = new Set<() => void>();
  const pendingListeners = new Set<() => void>();
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let source = "";
  let received = 0;
  let lastGrapheme = 0;
  let visible = 0;
  let speed = DEFAULT_STREAMING_SPEED.normal;
  let frame: number | undefined;
  let lastFrame = 0;
  let lastPublish = -Infinity;
  let pending = false;

  function readText(text: string) {
    const appended = text.startsWith(source);
    const from = appended && received > 0 ? lastGrapheme : 0;
    let count = from > 0 ? received - 1 : 0;
    for (const part of segmenter.segment(text.slice(from))) {
      count += 1;
      lastGrapheme = from + part.index;
    }
    source = text;
    received = count;
    return appended;
  }

  function publish() {
    const nextPending = visible < received;
    for (const listener of listeners) listener();
    if (pending !== nextPending) {
      pending = nextPending;
      for (const listener of pendingListeners) listener();
    }
  }

  function cancel() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  }

  function tick(now: number) {
    frame = undefined;
    const delta = Math.min(100, now - lastFrame);
    lastFrame = now;
    speed = streamingSpeed(speed, received - visible, delta);
    visible = Math.min(received, visible + (speed * delta) / 1000);
    if (now - lastPublish >= 1000 / 30 || visible >= received) {
      lastPublish = now;
      publish();
    }
    if (visible < received) frame = requestAnimationFrame(tick);
    else speed = DEFAULT_STREAMING_SPEED.normal;
  }

  readText(initialText);
  visible = initiallyVisible ? received : 0;
  pending = visible < received;

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    subscribePending: (listener: () => void) => {
      pendingListeners.add(listener);
      return () => void pendingListeners.delete(listener);
    },
    getPending: () => pending,
    getProgress: () => ({
      visible: Math.floor(visible),
      received,
      complete: visible >= received,
    }),
    update: (text: string, immediate = false) => {
      const appended = text === source || readText(text);
      if (immediate || !appended) {
        visible = received;
        cancel();
        speed = DEFAULT_STREAMING_SPEED.normal;
      }
      publish();
      if (visible < received && frame === undefined) {
        lastFrame = performance.now();
        frame = requestAnimationFrame(tick);
      }
    },
    dispose: cancel,
  };
}
