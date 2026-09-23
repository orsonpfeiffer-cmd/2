export function createScheduler(pipeline, minutes, log = console) {
  const intervalMs = Math.max(1, minutes) * 60_000;
  let timer = null;
  let nextRunAt = null;

  async function tick() {
    nextRunAt = Date.now() + intervalMs;
    try {
      await pipeline.runCycle();
    } catch (err) {
      // A bug in one cycle must never kill the server; the next tick tries again.
      log.error('[cycle] failed:', err);
    }
  }

  return {
    intervalMinutes: minutes,
    start() {
      tick();
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      clearInterval(timer);
    },
    nextRunAt: () => nextRunAt,
    isRunning: () => pipeline.isRunning(),
  };
}
