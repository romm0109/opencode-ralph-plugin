import type { OpenCodeAdapter } from "../opencode/adapter.js";
import type { RunStore } from "../state/run-store.js";
import type { AttemptOptions } from "./attempts.js";
import type { IssueAttempt } from "./execute-issue.js";
import { integrateSubmission } from "./integrate-issue.js";

/** Shared by the single-issue and DAG paths, including separate store instances. */
const queues = new Map<string, IntegrationQueue>();
export class IntegrationQueue {
  readonly listeners = new Set<() => Promise<void>>();
  private entries = new Map<string, Promise<IssueAttempt>>();
  private order: string[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  get positions(): string[] {
    return [...this.order];
  }
  enqueue(
    store: RunStore,
    adapter: OpenCodeAdapter,
    runId: string,
    issueId: string,
    options: AttemptOptions = {},
  ) {
    const existing = this.entries.get(issueId);
    if (existing) return existing;
    this.order.push(issueId);
    const result = this.tail
      .then(async () => {
        await this.changed();
        return integrateSubmission(store, adapter, runId, issueId, options);
      })
      .finally(async () => {
        this.order = this.order.filter((id) => id !== issueId);
        this.entries.delete(issueId);
        await this.changed();
      });
    this.entries.set(issueId, result);
    this.tail = result.catch(() => {});
    // Arrival is observable even while another candidate is validating.
    void this.changed().catch(() => {});
    return result;
  }
  private async changed() {
    for (const listener of this.listeners) await listener();
  }
}
export function integrationQueue(store: RunStore, runId: string) {
  const key = `${store.repositoryId}:${runId}`;
  let queue = queues.get(key);
  if (!queue) {
    queue = new IntegrationQueue();
    queues.set(key, queue);
  }
  return queue;
}
