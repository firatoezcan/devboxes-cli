import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const staleTmpMs = 60 * 60 * 1000;

export const writeSecretFile = async (input: {
  path: string;
  contents: string;
  tmpPrefix: string;
}) => {
  const dir = dirname(input.path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(dir)) {
    if (!entry.startsWith(input.tmpPrefix) || !entry.endsWith(".tmp")) continue;
    const leftoverPath = join(dir, entry);
    const leftover = await stat(leftoverPath).catch(() => null);
    if (leftover && Date.now() - leftover.mtimeMs > staleTmpMs) {
      await rm(leftoverPath, { force: true }).catch(() => {});
    }
  }
  const tmpPath = join(dir, `${input.tmpPrefix}${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(tmpPath, "w", 0o600);
    try {
      await handle.writeFile(input.contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, input.path);
    await chmod(input.path, 0o600);
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
};
