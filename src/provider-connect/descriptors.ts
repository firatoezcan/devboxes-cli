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
];
