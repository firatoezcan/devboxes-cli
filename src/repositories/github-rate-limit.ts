/**
 * Whether GitHub refused a request for a primary or secondary rate limit, recognized as the
 * throttling plugin does, and the time it named to retry after, if any. A secondary limit without
 * `retry-after` waits the plugin's default of 60 seconds. Returns null for any other refusal.
 * `message` is Octokit's error message, or the body of an answer read with plain fetch, since both
 * carry GitHub's message text.
 */
export const githubRateLimit = (cause: {
  status: number;
  message: string;
  response?: { headers: Record<string, string | number | undefined> };
}) => {
  const headers = cause.response?.headers ?? {};
  const retryAfter = Number(headers["retry-after"]);
  const reset = Number(headers["x-ratelimit-reset"]);
  if (cause.status !== 403 && cause.status !== 429) return null;
  if (/\bsecondary rate\b/i.test(cause.message) || retryAfter > 0)
    return { retryAt: new Date(Date.now() + (retryAfter || 60) * 1000) };
  if (cause.status === 429 || headers["x-ratelimit-remaining"] === "0")
    return { retryAt: reset > 0 ? new Date(reset * 1000) : null };
  return null;
};
