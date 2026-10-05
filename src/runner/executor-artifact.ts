import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import axios from "axios";

export const stageExecutorArtifact = async (
  artifact: { url: string; sha256: string },
  destination: string,
): Promise<void> => {
  const url = new URL(artifact.url);
  if (
    (url.protocol !== "https:" &&
      !(
        process.env.NODE_ENV !== "production" &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Executor artifacts require HTTPS, or loopback HTTP outside production, without embedded credentials.",
    );
  const directory = await mkdtemp(join(dirname(destination), ".executor-"));
  try {
    const staged = join(directory, "executor");
    const response = await axios.get<Readable>(url.href, {
      responseType: "stream",
      maxRedirects: 0,
    });
    const hash = createHash("sha256");
    response.data.on("data", (chunk: Uint8Array) => {
      hash.update(chunk);
    });
    await pipeline(response.data, createWriteStream(staged, { flags: "wx", mode: 0o555 }));
    if (hash.digest("hex") !== artifact.sha256)
      throw new Error("The private executor artifact does not match its immutable digest.");
    await rename(staged, destination);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
