import type { RunStore } from "../state/run-store.js";

interface ExecutorPool {
  concurrency: number;
  active: number;
  waiters: (() => void)[];
}
const pools = new Map<string, ExecutorPool>();
const admissions = new Map<string, Promise<void>>();

/** Register arrival before asynchronous state reads can reorder ready issues. */
export async function reserveExecutorAdmission(store: RunStore, runId: string) {
  const key = `${store.repositoryId}:${runId}`;
  const previous = admissions.get(key) ?? Promise.resolve();
  let release!: () => void;
  const ticket = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => ticket);
  admissions.set(key, tail);
  await previous;
  return () => {
    release();
    if (admissions.get(key) === tail) admissions.delete(key);
  };
}
/** The DAG and direct single-issue APIs share one canonical repository/run budget. */
export async function withExecutorSlot<T>(
  store: RunStore,
  runId: string,
  concurrency: number,
  execute: () => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(concurrency) || concurrency <= 0)
    throw new Error("Executor concurrency must be a positive integer");
  const key = `${store.repositoryId}:${runId}`;
  let pool = pools.get(key);
  if (!pool) {
    pool = { concurrency, active: 0, waiters: [] };
    pools.set(key, pool);
  }
  if (pool.concurrency !== concurrency)
    throw new Error("Executor concurrency changed while slots were leased");
  if (pool.active >= concurrency)
    await new Promise<void>((resolve) => pool.waiters.push(resolve));
  else pool.active++;
  try {
    return await execute();
  } finally {
    const next = pool.waiters.shift();
    if (next) next();
    else pool.active--;
    if (!pool.active && !pool.waiters.length) pools.delete(key);
  }
}
