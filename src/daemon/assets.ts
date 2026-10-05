import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import arm64PtyBinary from "@opencode-ai/pty-linux-arm64-gnu/bin/opencode-pty" with { type: "file" };
import x64PtyBinary from "@opencode-ai/pty-linux-x64-gnu/bin/opencode-pty" with { type: "file" };

export const prepareOpenCodeRuntimeAssets = async (directory: string) => {
  if (process.platform !== "linux" || (process.arch !== "arm64" && process.arch !== "x64")) {
    throw new Error("The compiled OpenCode host requires Linux arm64 or x64 runtime assets.");
  }
  const asset = process.arch === "arm64" ? arm64PtyBinary : x64PtyBinary;
  const binary = join(directory, "opencode-pty");
  await mkdir(directory, { recursive: true });
  const temporary = `${binary}.${crypto.randomUUID()}`;
  try {
    await Bun.write(temporary, Bun.file(asset));
    await chmod(temporary, 0o755);
    await rename(temporary, binary);
  } finally {
    await rm(temporary, { force: true });
  }
  process.env.OPENCODE_PTY_BIN = binary;
};
