import { homedir } from "node:os";
import { join } from "node:path";

import { NodeRuntime } from "@effect/platform-node";
import { prepareOpenCodeRuntimeAssets } from "./assets";
import { Effect, Schema } from "effect";

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        prepareOpenCodeRuntimeAssets(
          join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode", "bin"),
        ),
      );
      // Native PTY resolution needs the extracted executable before module initialization.
      const { ServerOptions } = yield* Effect.promise(() => import("@opencode-ai/server/options"));
      const options = yield* Schema.decodeUnknownEffect(ServerOptions)({
        hostname: process.env.OPENCODE_SERVER_HOSTNAME,
        port: process.env.OPENCODE_SERVER_PORT
          ? Number(process.env.OPENCODE_SERVER_PORT)
          : undefined,
        password: process.env.OPENCODE_SERVER_PASSWORD,
        database: { path: "opencode.db" },
        events: { persist: true },
        config: { file: process.env.OPENCODE_CONFIG },
      });
      const { ServerProcess } = yield* Effect.promise(() => import("@opencode-ai/server/process"));
      const server = yield* ServerProcess.start<never, never>(options);
      if (server.address._tag === "TcpAddress") {
        console.log(`OpenCode listening on ${server.address.hostname}:${server.address.port}`);
      }
      yield* server.shutdown;
    }),
  ),
);
