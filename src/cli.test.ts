import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { createDevboxesCommand } from "./cli";

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
    expect(await stdout).toContain("login");
    expect(await stdout).toContain("listen");
    expect(await stderr).toBe("");
  });
});

describe("Devboxes root options", () => {
  it("keeps deployment overrides functional without advertising them", () => {
    const command = createDevboxesCommand();
    const help = command.helpInformation();

    expect(help).toContain("--organization <id>");
    expect(help).not.toContain("--api <url>");
    expect(help).not.toContain("--auth <url>");

    command.parseOptions([
      "--api",
      "https://api.example.com",
      "--auth",
      "https://auth.example.com",
    ]);
    expect(command.opts()).toMatchObject({
      api: "https://api.example.com",
      auth: "https://auth.example.com",
    });
  });
});
