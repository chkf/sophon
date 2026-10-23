import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface InstanceOwner {
  pid: number;
  startedAt: string;
  takeoverToken: string;
}

function lockDir(dataDir: string): string {
  return join(dataDir, "runtime", "gateway-instance.lock");
}

export function instanceOwnerAlive(owner: InstanceOwner): boolean {
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export async function readInstanceOwner(dataDir: string): Promise<InstanceOwner | undefined> {
  try {
    const value = JSON.parse(
      await readFile(join(lockDir(dataDir), "owner.json"), "utf8"),
    ) as Partial<InstanceOwner>;
    if (
      !Number.isInteger(value.pid) ||
      typeof value.startedAt !== "string" ||
      typeof value.takeoverToken !== "string" ||
      value.takeoverToken.length < 32
    ) {
      return undefined;
    }
    return value as InstanceOwner;
  } catch {
    return undefined;
  }
}

export interface InstanceLock extends InstanceOwner {
  release(): Promise<void>;
}

export async function waitForInstanceRelease(
  dataDir: string,
  pid: number,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const owner = await readInstanceOwner(dataDir);
    if (!owner || owner.pid !== pid || !instanceOwnerAlive(owner)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export async function acquireInstanceLock(dataDir: string): Promise<InstanceLock> {
  const dir = lockDir(dataDir);
  await mkdir(dirname(dir), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(dir);
      const owner: InstanceOwner = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        takeoverToken: randomBytes(32).toString("hex"),
      };
      await writeFile(join(dir, "owner.json"), JSON.stringify(owner, null, 2) + "\n", "utf8");

      let released = false;
      return {
        ...owner,
        async release() {
          if (released) return;
          released = true;
          const current = await readInstanceOwner(dataDir);
          if (!current || (
            current.pid === owner.pid &&
            current.takeoverToken === owner.takeoverToken
          )) {
            await rm(dir, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const owner = await readInstanceOwner(dataDir);
      if (owner && instanceOwnerAlive(owner)) {
        throw new Error(
          "Another Gateway instance is still active (pid=" + owner.pid + ").",
        );
      }
      await rm(dir, { recursive: true, force: true });
    }
  }

  throw new Error("Could not acquire the Gateway instance lock.");
}
