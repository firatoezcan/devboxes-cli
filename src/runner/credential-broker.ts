import { createHash, timingSafeEqual } from "node:crypto";

import Elysia from "elysia";

import { opencodeProviderAuthPath, type OpencodeProviderAuthJson } from "../protocol/provider-auth";

export type ActiveOpencodeCredentialTask = {
  taskId: string;
  organizationId: string;
  modelProviderId: string;
  perTaskToken: string;
  providerAuth?: OpencodeProviderAuthJson;
};

// The runner-side implementation of the shared provider-auth contract: the
// dashboard serves the same route shape from organization material retained at
// claim, and this broker serves the retained local material, gated by the
// per-task token of a currently active task. It never rereads a mutable auth file
// or credential store after the claim succeeds.
export const createOpencodeCredentialBroker = (input: {
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

      if (!active.providerAuth?.[active.modelProviderId]) {
        return status(404, {
          error: "The claimed local provider credential is not available for this task.",
        });
      }
      return active.providerAuth;
    },
    {
      detail: { operationId: "getLocalOpencodeProviderAuth" },
    },
  );
};

export type OpencodeCredentialBrokerApi = ReturnType<typeof createOpencodeCredentialBroker>;
