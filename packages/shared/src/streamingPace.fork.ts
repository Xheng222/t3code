/** Characters per second at which clients reveal streamed reply text. */
export const STREAMING_SPEED = { normal: 80, maximum: 200 };

/** Eases toward a speed that grows with the unrevealed backlog, `delta` milliseconds later. */
export function streamingSpeed(current: number, remaining: number, delta: number) {
  const target = Math.min(
    STREAMING_SPEED.maximum,
    STREAMING_SPEED.normal + Math.max(0, remaining - STREAMING_SPEED.normal) / 2,
  );
  return Math.max(
    STREAMING_SPEED.normal,
    Math.min(STREAMING_SPEED.maximum, current + (target - current) * (1 - Math.exp(-delta / 120))),
  );
}
