import { createHash, timingSafeEqual } from "node:crypto";

import Elysia from "elysia";

import { opencodeProviderAuthPath } from "../protocol/provider-auth";
import {
  TransientProviderRefreshError,
  type LocalRunnerOpencodeProviderAuthRuntime,
} from "./local-provider-auth";

export type ActiveOpencodeCredentialTask = {
  taskId: string;
  organizationId: string;
  modelProviderId: string;
  perTaskToken: string;
};

// The runner-side implementation of the shared provider-auth contract: the
// dashboard serves the same route shape from Postgres-backed org credentials,
// this broker serves it from the operator's local auth files and the on-device
// credential store, gated by the per-task token of a currently active task.
// The runtime is shared with the listen loop's keep-alive refresh cron so
// both sides go through one single-flight map per token family.
export const createOpencodeCredentialBroker = (input: {
  runtime: LocalRunnerOpencodeProviderAuthRuntime;
  activeCredentials: ReadonlyMap<string, ActiveOpencodeCredentialTask>;
}) => {
  return new Elysia({ name: "opencode.credential-broker", normalize: "typebox" }).get(
    opencodeProviderAuthPath,
    async ({ params, request, status }) => {
      const active = input.activeCredentials.get(params.taskId);
      const authorization = request.headers.get("Authorization");
      const token = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : null;
      if (!active || !token) {
        return status(401, { error: "Unauthorized." });
      }

      const tokenMatches = timingSafeEqual(
        createHash("sha256").update(token).digest(),
        createHash("sha256").update(active.perTaskToken).digest(),
      );
      if (!tokenMatches) {
        return status(401, { error: "Unauthorized." });
      }

      try {
        return await input.runtime.providerAuthForProvider({
          providerId: active.modelProviderId,
        });
      } catch (error) {
        // A vendor blip during refresh is retryable: the daemon retries 5xx
        // and fails the boot immediately on anything below, so only missing
        // or definitively rejected credentials may answer 404 (mirrors the
        // dashboard route's 502/409 split).
        if (error instanceof TransientProviderRefreshError) {
          return status(502, { error: error.message });
        }
        return status(404, {
          error:
            error instanceof Error
              ? error.message
              : "Opencode provider credentials are not configured.",
        });
      }
    },
    {
      detail: { operationId: "getLocalOpencodeProviderAuth" },
    },
  );
};

export type OpencodeCredentialBrokerApi = ReturnType<typeof createOpencodeCredentialBroker>;
