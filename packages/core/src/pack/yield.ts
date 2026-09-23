type SchedulerLike = { yield?: () => Promise<void> };

/** Node's `MessagePort` adds `unref()`; the DOM lib type doesn't declare it. */
type UnrefableMessagePort = MessagePort & { unref?: () => void };

/**
 * Builds an unclamped macrotask yield. `setTimeout(fn, 0)` is subject to the WHATWG
 * timer-nesting clamp — once a tight loop calls it enough times in a row (as `pump()`'s
 * per-packet loop below used to), browsers floor nested timeouts to a few milliseconds
 * regardless of the requested 0ms delay. For an N-packet capture that turned an O(N)
 * yield into an O(N * ~4ms) wall-clock cost — measured empirically at ~4.4ms/packet,
 * constant regardless of capture size, against real Chromium via Task 12's scale-metrics
 * spec — utterly dominating real parse+ingest time. `scheduler.yield()` (Chromium's
 * Prioritized Task Scheduling API) is unclamped where available; otherwise a
 * `MessageChannel` round trip is used, since posted-message macrotasks are exempt from
 * the setTimeout nesting clamp. The channel is created lazily on first use (rather than
 * at module load) and its ports are unref'd so a stray instance never keeps a Node
 * process — e.g. a vitest worker — alive waiting on an open handle.
 */
export const createYield = (): (() => Promise<void>) => {
  const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler;
  if (scheduler?.yield) return () => scheduler.yield!();

  let channel: MessageChannel | null = null;
  // Invariant: `pump()` is a strictly sequential loop — it always awaits the previous
  // yield before requesting another — so at most one resolver is ever pending at a time.
  let pending: (() => void) | null = null;
  return () =>
    new Promise<void>((resolve) => {
      if (!channel) {
        channel = new MessageChannel();
        (channel.port1 as UnrefableMessagePort).unref?.();
        (channel.port2 as UnrefableMessagePort).unref?.();
        channel.port1.onmessage = () => {
          const resolveNext = pending;
          pending = null;
          resolveNext?.();
        };
      }
      pending = resolve;
      channel.port2.postMessage(null);
    });
};
