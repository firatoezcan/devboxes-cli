export const runnerPassthroughEnvironmentKeys = [
  "PATH",
  "HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

const runnerExactEnvironmentKeys = new Set([
  ...runnerPassthroughEnvironmentKeys,
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GH_CONFIG_DIR",
  "GH_PROMPT_DISABLED",
  "GIT_TERMINAL_PROMPT",
  "GIT_TRACE_REDACT",
]);

const taskShellManagedEnvironmentKeys = new Set(["IFS", "OLDPWD", "PPID", "PWD", "SHLVL", "_"]);

export const taskEnvironmentKeyError = (key: string) => {
  const normalizedKey = key.toUpperCase();
  if (taskShellManagedEnvironmentKeys.has(normalizedKey)) {
    return `Environment key ${normalizedKey} is managed by the task shell. Choose another name.`;
  }
  if (
    normalizedKey.startsWith("DEVBOX_") ||
    normalizedKey.startsWith("OPENCODE_") ||
    normalizedKey.startsWith("GIT_CONFIG_") ||
    normalizedKey.endsWith("_JSON_B64") ||
    runnerExactEnvironmentKeys.has(normalizedKey)
  ) {
    return `Environment key ${normalizedKey} is reserved by Devboxes or the runner. Choose another name.`;
  }
  return null;
};

export const requireTaskEnvironmentKeyAllowed = (key: string) => {
  const error = taskEnvironmentKeyError(key);
  if (error) throw new Error(error);
};

export const organizationSecretValueMinimumLength = 16;

export const organizationSecretValueError = (value: string) => {
  if (!value.trim()) return "Secret values cannot be blank.";
  if (value.includes("\0")) return "Secret values cannot contain NUL bytes.";
  if (value.length < organizationSecretValueMinimumLength) {
    return `Secret values must contain at least ${organizationSecretValueMinimumLength} characters.`;
  }
  if (new TextEncoder().encode(value).length > 64 * 1024) {
    return "Secret values cannot exceed 64 KiB.";
  }
  return null;
};
