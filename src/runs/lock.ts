import type { OwnedRecord, RunOwner } from "./owner.js";
import { ownershipOf } from "./owner.js";
import type { RunRecord } from "./store.js";

/**
 * A live run of another session in the same cwd. It blocks a job the same way a local run does:
 * only one non-shared run per cwd at a time, whichever session started it.
 */
export function foreignCwdHolder(
  records: Array<RunRecord & OwnedRecord>,
  cwd: string,
  me: Pick<RunOwner, "id" | "pid" | "label">,
  alive?: (pid: number) => boolean,
): RunRecord | null {
  for (const record of records) {
    if (record.status !== "running" || record.cwd !== cwd) continue;
    if (ownershipOf(record, me, alive).foreign) return record;
  }
  return null;
}

/** Promise-chain mutex keyed by string. Calls with the same key run strictly one after another. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
