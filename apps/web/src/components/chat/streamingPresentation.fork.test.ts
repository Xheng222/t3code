import { expect, it, vi } from "vite-plus/test";
import { STREAMING_SPEED } from "@t3tools/shared/streamingPace";
import { createStreamingPresentation } from "./streamingPresentation.fork";

function frames() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  return {
    callbacks,
    advance: (now: number) => {
      const current = [...callbacks.values()];
      callbacks.clear();
      for (const callback of current) callback(now);
    },
    [Symbol.dispose]: () => vi.unstubAllGlobals(),
  };
}

it("paces appended graphemes within the speed limit and flushes source replacements", () => {
  using clock = frames();
  using _now = vi.spyOn(performance, "now").mockReturnValue(0);
  const presentation = createStreamingPresentation("A", true);
  presentation.update("A👩🏽");
  presentation.update("A👩🏽‍💻e");
  const text = `A👩🏽‍💻éZ${"x".repeat(2000)}`;
  presentation.update(text);
  expect(presentation.getProgress()).toEqual({ visible: 1, received: 2004, complete: false });
  for (let tick = 1; tick <= 20; tick++) clock.advance(tick * 100);
  expect(presentation.getProgress().visible).toBeGreaterThanOrEqual(1 + STREAMING_SPEED.normal * 2);
  expect(presentation.getProgress().visible).toBeLessThanOrEqual(1 + STREAMING_SPEED.maximum * 2);
  presentation.update(text);
  expect(presentation.getPending()).toBe(true);
  presentation.update(text, true);
  expect(presentation.getProgress()).toEqual({ visible: 2004, received: 2004, complete: true });
  expect(clock.callbacks.size).toBe(0);
  presentation.update("replacement");
  expect(presentation.getProgress()).toEqual({ visible: 11, received: 11, complete: true });
});

it("shows an existing snapshot immediately and cancels work on disposal", () => {
  using clock = frames();
  const presentation = createStreamingPresentation("existing reply", true);
  expect(presentation.getPending()).toBe(false);
  expect(clock.callbacks.size).toBe(0);
  presentation.update("existing reply with new content");
  expect(presentation.getProgress().visible).toBe(14);
  expect(presentation.getPending()).toBe(true);
  expect(clock.callbacks.size).toBe(1);
  presentation.update("existing reply with new content", false, true);
  expect(clock.callbacks.size).toBe(0);
  clock.advance(1000);
  expect(presentation.getProgress().visible).toBe(14);
  presentation.update("existing reply with new content");
  expect(clock.callbacks.size).toBe(1);
  presentation.dispose();
  expect(clock.callbacks.size).toBe(0);
});
