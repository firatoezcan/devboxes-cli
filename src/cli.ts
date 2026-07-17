#!/usr/bin/env bun

import { createDevboxesCommand } from "./devboxes";

// Bun's util.styleText applies colors unconditionally, where Node validates
// the target stream — so piped output would carry raw ANSI codes. Strip them
// at the process boundary when the stream is not a terminal; FORCE_COLOR opts
// back in for callers that want colored captures (with the conventional
// FORCE_COLOR=0/false meaning "no color", not an opt-in). Only string chunks
// are touched: all styled output enters as strings, while Buffer writes may
// carry binary data or multi-byte characters split across chunks, which a
// decode/strip/re-encode round trip would corrupt.
const forceColor = process.env.FORCE_COLOR;
for (const stream of [process.stdout, process.stderr]) {
  if (stream.isTTY || (forceColor && forceColor !== "0" && forceColor !== "false")) continue;
  const write = stream.write.bind(stream);
  stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
    write(
      typeof chunk === "string" ? Bun.stripANSI(chunk) : chunk,
      ...(rest as []),
    )) as typeof stream.write;
}

try {
  await createDevboxesCommand().parseAsync(Bun.argv, { from: "node" });
} catch (error) {
  // User-facing failures end as one readable line, not a stack trace.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(process.exitCode && process.exitCode !== 0 ? Number(process.exitCode) : 1);
}
