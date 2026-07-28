import type { OpencodeConnectorDescriptor } from "./descriptor-schema";

// The single source of truth for provider connect wiring — everything a
// vendor controls (endpoints, public client ids, scopes) as plain data. The
// dashboard executes its own flows from this module AND serves it verbatim to
// runners over `GET /internal/runner-machines/connectors`, so the served
// copy and the executed copy are structurally incapable of disagreeing. A
// vendor moving a URL, or a new provider with an existing flow shape, ships
// server-side with zero binary releases; only a genuinely new flow shape revs
// a `kind` in descriptor-schema.ts.
//
// This module is imported by the web app for rendering; keep it free of
// node/fetch dependencies. Runner binaries must never import it (ast-grep
// enforced) — they receive this data served.

const openaiIssuer = "https://auth.openai.com";

export const opencodeProviderConnectors: readonly OpencodeConnectorDescriptor[] = [
  {
    providerId: "openai",
    label: "ChatGPT Pro/Plus",
    description:
      "Authorize an OpenAI ChatGPT Pro or Plus subscription. Runs on this credential use the Codex model set included with the subscription.",
    kind: "openai-device",
    // The Codex CLI's public client; opencode reuses it for the same reason.
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    usercodeUrl: `${openaiIssuer}/api/accounts/deviceauth/usercode`,
    pollUrl: `${openaiIssuer}/api/accounts/deviceauth/token`,
    tokenUrl: `${openaiIssuer}/oauth/token`,
    redirectUri: `${openaiIssuer}/deviceauth/callback`,
    verificationUrl: `${openaiIssuer}/codex/device`,
    refresh: {
      tokenUrl: `${openaiIssuer}/oauth/token`,
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    },
  },
  {
    providerId: "github-copilot",
    label: "GitHub Copilot",
    description: "Authorize GitHub Copilot on github.com.",
    kind: "github-device",
    clientId: "Ov23li8tweQw6odWQebz",
    scope: "read:user",
    deviceCodeUrl: "https://github.com/login/device/code",
    accessTokenUrl: "https://github.com/login/oauth/access_token",
    verificationUrlHosts: ["github.com"],
  },
  {
    providerId: "xai",
    label: "xAI Grok",
    description: "Authorize an xAI Grok (SuperGrok) subscription.",
    kind: "rfc8628-form",
    // The public Grok-CLI OAuth client xAI ships for desktop/device flows;
    // opencode reuses it for the same reason we do.
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    scope: "openid profile email offline_access grok-cli:access api:access",
    deviceAuthorizationUrl: "https://auth.x.ai/oauth2/device/code",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    verificationUrlHosts: ["x.ai"],
    // xAI defaults its device codes to five minutes when expires_in is absent.
    defaultDeviceCodeTtlSeconds: 300,
    refresh: {
      tokenUrl: "https://auth.x.ai/oauth2/token",
      clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    },
  },
];
