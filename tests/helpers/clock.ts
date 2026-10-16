import type { Clock } from "../../src/execution/attempts.js";
export function controllableClock() {
  let now = 0;
  const timers = new Set<{ due: number; callback: () => void }>();
  const clock: Clock = {
    now: () => now,
    schedule(ms, callback) {
      const timer = { due: now + ms, callback };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
  };
  return {
    clock,
    get pending() {
      return timers.size;
    },
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers])
        if (timer.due <= now) {
          timers.delete(timer);
          timer.callback();
        }
    },
  };
}
export async function eventually(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Fixture did not reach expected state");
}
