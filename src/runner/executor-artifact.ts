import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import {
  type ClaudeCodeArtifact,
  containerClaudeCodeUid,
} from "../protocol/task-runtime";
import { pack } from "tar-stream";

/** An artifact's URL: HTTPS, or loopback HTTP outside production, without embedded credentials. */
const artifactUrl = (location: string) => {
  const url = new URL(location);
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
      "Runner artifacts require HTTPS, or loopback HTTP outside production, without embedded credentials.",
    );
  return url;
};

/** How long the executor download may receive no data before Bun fails it with a TimeoutError. */
const executorStallSeconds = 30;

/**
 * The cause of a stalled executor download from `url`, for the Run's error: its host and the bound,
 * then `message`, the TimeoutError's own text.
 */
export const stalledExecutorDownload = (url: string, message: string) =>
  `The devboxes executor download from ${new URL(url).host} received no data for ${executorStallSeconds} seconds: ${message}`;

export const stageExecutorArtifact = async (
  artifact: { url: string; sha256: string },
  destination: string,
): Promise<void> => {
  const url = artifactUrl(artifact.url);
  const directory = await mkdtemp(join(dirname(destination), ".executor-"));
  try {
    const staged = join(directory, "executor");
    const response = await fetch(url, { redirect: "error", timeout: executorStallSeconds * 1000 });
    const body = response.body;
    if (!response.ok || !body)
      throw new Error(`The private executor artifact answered ${response.status}.`);
    const hash = createHash("sha256");
    await pipeline(
      async function* () {
        for await (const chunk of body) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(staged, { flags: "wx", mode: 0o555 }),
    );
    if (hash.digest("hex") !== artifact.sha256)
      throw new Error("The private executor artifact does not match its immutable digest.");
    await rename(staged, destination);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/**
 * A tar archive that holds the Claude Code binary from `artifact`'s npm tarball as `claude`, owned
 * by the Claude Code uid with mode 0500, after both match their pins.
 */
export const claudeCodeArchive = async (artifact: ClaudeCodeArtifact) => {
  const response = await fetch(artifactUrl(artifact.url), { redirect: "error" });
  if (!response.ok) throw new Error(`The Claude Code artifact answered ${response.status}.`);
  const tarball = await response.bytes();
  if (`sha512-${createHash("sha512").update(tarball).digest("base64")}` !== artifact.integrity)
    throw new Error("The Claude Code artifact does not match its pinned integrity.");
  const file = (await new Bun.Archive(tarball).files("package/claude")).get("package/claude");
  const binary = file && Buffer.from(await file.arrayBuffer());
  if (!binary || createHash("sha512").update(binary).digest("hex") !== artifact.binarySha512)
    throw new Error("The Claude Code artifact holds no package/claude that matches its pin.");
  const archive = pack();
  archive.entry(
    { name: "claude", mode: 0o500, uid: containerClaudeCodeUid, gid: containerClaudeCodeUid },
    binary,
  );
  archive.finalize();
  return archive;
};
