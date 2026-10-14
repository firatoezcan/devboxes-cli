import type { OpencodeConnectorDescriptor } from "./descriptor-schema";

const openaiIssuer = "https://auth.openai.com";

export const opencodeProviderConnectors: readonly OpencodeConnectorDescriptor[] = [
  {
    providerId: "openai",
    label: "ChatGPT Pro/Plus",
    description: "Authorize an OpenAI ChatGPT Pro or Plus subscription.",
    kind: "openai-device",
    // The Codex CLI's public client; opencode reuses it for the same reason.
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    usercodeUrl: `${openaiIssuer}/api/accounts/deviceauth/usercode`,
    pollUrl: `${openaiIssuer}/api/accounts/deviceauth/token`,
    tokenUrl: `${openaiIssuer}/oauth/token`,
    redirectUri: `${openaiIssuer}/deviceauth/callback`,
    verificationUrl: `${openaiIssuer}/codex/device`,
  },
  {
    providerId: "github-copilot",
    label: "GitHub Copilot",
    description: "Authorize GitHub Copilot on github.com.",
    kind: "github-device",
    clientId: "Ov23li8tweQw6odWQebz",
    scope: "read:user",
    webUrl: "https://github.com",
    apiUrl: "https://api.github.com",
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
  },
  {
    providerId: "claude-subscription",
    label: "Claude subscription",
    description: "Authorize a Claude Pro, Max, Team or Enterprise subscription.",
    kind: "anthropic-pkce",
    // Claude Code's public client, asking for the inference-only token with a one-year lifetime that
    // Claude Code asks for when it issues a long-lived token. The owner chose this client for the
    // sign-in step only; model requests go through Claude Code unchanged.
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.com/cai/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    redirectUri: "https://platform.claude.com/oauth/code/callback",
    scope: "user:inference",
    tokenLifetimeSeconds: 31_536_000,
  },
];
