import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { processIdentity } from "../process/ownership.js";

interface Owner {
  pid: number;
  startedAt: string;
  token: string;
  status: "initializing" | "active" | "closing";
  locations: string[];
}
/** Filesystem coordination also spans OpenCode's isolated plugin module graphs. */
export async function acquireHostLease(root: string) {
  const identity = await processIdentity(process.pid);
  if (!identity) throw new Error("Plugin host identity unavailable");
  const startedAt = identity.startedAt;
  const file = join(root, "host.json");
  const lock = join(root, "host.lock");
  const location = randomUUID();
  async function read(): Promise<Owner | undefined> {
    try {
      const owner = JSON.parse(await readFile(file, "utf8")) as Owner;
      if (!owner.token || !owner.startedAt || !Array.isArray(owner.locations))
        throw new Error("Invalid plugin host lease; inspect host.json");
      return owner;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
  }
  async function write(owner: Owner) {
    const temporary = `${file}.${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(owner));
    await rename(temporary, file);
  }
  async function transact<T>(action: () => Promise<T>): Promise<T> {
    for (let retry = 0; ; retry++) {
      try {
        try {
          await access(`${lock}.recovery`);
          if (retry >= 250) throw new Error("Host lock recovery is uncertain");
          await Bun.sleep(20);
          continue;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
        await mkdir(lock);
        await writeFile(
          join(lock, "owner.json"),
          JSON.stringify({ pid: process.pid, startedAt }),
        );
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST" || retry >= 250)
          throw cause;
        // A separate recovery guard prevents two reclaimers deleting a new lock.
        const guard = `${lock}.recovery`;
        try {
          await mkdir(guard);
          try {
            const raw = await readFile(join(lock, "owner.json"), "utf8");
            const previous = JSON.parse(raw) as Owner;
            const live = await processIdentity(previous.pid);
            if (
              previous.startedAt &&
              (!live || live.startedAt !== previous.startedAt) &&
              (await readFile(join(lock, "owner.json"), "utf8")) === raw
            )
              await rm(lock, { recursive: true });
          } finally {
            await rm(guard, { recursive: true });
          }
        } catch {
          /* Ambiguous lock identity is never reclaimed. */
        }
        await Bun.sleep(20);
      }
    }
    try {
      return await action();
    } finally {
      await rm(lock, { recursive: true });
    }
  }
  let token = "";
  let recover = false;
  for (let retry = 0; ; retry++) {
    const acquired = await transact(async () => {
      let owner = await read();
      if (owner) {
        const live = await processIdentity(owner.pid);
        if (!live || live.startedAt !== owner.startedAt) owner = undefined;
        else if (owner.pid !== process.pid || owner.startedAt !== startedAt)
          throw new Error(
            "Another live OpenCode host owns this repository; close it before activating Ralph here",
          );
      }
      if (!owner) {
        token = randomUUID();
        recover = true;
        await write({
          pid: process.pid,
          startedAt,
          token,
          status: "initializing",
          locations: [location],
        });
        return true;
      }
      if (owner.status !== "active") return false;
      token = owner.token;
      owner.locations.push(location);
      await write(owner);
      return true;
    });
    if (acquired) break;
    if (retry >= 1500)
      throw new Error("Plugin host activation or shutdown did not complete");
    await Bun.sleep(20);
  }
  let released = false;
  return {
    recover,
    async ready() {
      await transact(async () => {
        const owner = await read();
        if (owner?.token !== token)
          throw new Error("Plugin host ownership changed");
        owner.status = "active";
        await write(owner);
      });
    },
    async release() {
      if (released) return false;
      released = true;
      return transact(async () => {
        const owner = await read();
        if (owner?.token !== token) return false;
        owner.locations = owner.locations.filter((id) => id !== location);
        const last = !owner.locations.length;
        if (last) owner.status = "closing";
        await write(owner);
        return last;
      });
    },
    async finish() {
      await transact(async () => {
        const owner = await read();
        if (
          owner?.token === token &&
          owner.status === "closing" &&
          !owner.locations.length
        )
          await rm(file);
      });
    },
  };
}
