import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { apiOrigin } from "./commands";

describe("devboxes entrypoint", () => {
  it("prints help instead of listening when invoked without a subcommand", async () => {
    const child = Bun.spawn([process.execPath, "src/cli.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, BROWSER: "none" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const completed = await Promise.race([
      child.exited.then((exitCode) => ({ exitCode })),
      Bun.sleep(2_000).then(() => null),
    ]);
    if (!completed) {
      child.kill();
      await child.exited;
    }

    expect(completed).not.toBeNull();
    expect(completed?.exitCode).toBe(0);
    expect(await stdout).toContain("Usage: devboxes");
    expect(await stderr).toBe("");
  });
});

describe("CLI API origin", () => {
  it("allows HTTPS and local HTTP without accepting credential or URL escapes", () => {
    expect(apiOrigin("https://api.example.com/api")).toBe("https://api.example.com");
    for (const host of ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]) {
      expect(apiOrigin(`http://${host}:3000/api`)).toBe(`http://${host}:3000`);
    }
    expect(() => apiOrigin("http://host.docker.internal:3000", "account")).toThrow();
    for (const api of [
      "not a url",
      "file:///srv/devboxes/api",
      "http://devboxes.internal/api",
      "https://user:secret@api.example.com/api",
      "https://api.example.com/api?tenant=1",
      "https://api.example.com/api#fragment",
      "https://api.example.com/other",
    ]) {
      expect(() => apiOrigin(api)).toThrow();
    }
  });
});
