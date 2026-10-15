import { beforeAll, afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadContext, writeConfig } from "./config";

describe("Devboxes configuration", () => {
  const origin = "http://127.0.0.1:3000";
  let configDir: string;

  beforeAll(async () => {
    configDir = await mkdtemp(join(tmpdir(), "devboxes-cli-config-"));
  });

  afterAll(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it("loads an explicit existing config without changing the file", async () => {
    const configPath = join(configDir, `read-only-${randomUUID()}.json`);
    const contents = `${JSON.stringify({ apiBaseUrl: `${origin}/api` }, null, 2)}\n`;
    await writeFile(configPath, contents);
    await chmod(configPath, 0o444);

    const loaded = await loadContext({ config: configPath });

    expect(loaded.config.apiBaseUrl).toBe(`${origin}/api`);
    expect(await readFile(configPath, "utf8")).toBe(contents);
    expect((await stat(configPath)).mode & 0o777).toBe(0o444);
  });

  it("persists credentials in an owner-only file and replaces an older credential", async () => {
    const configPath = join(configDir, `credentials-${randomUUID()}.json`);
    const context = await loadContext({ config: configPath });
    context.config.apiBaseUrl = `${origin}/api`;
    context.config.sessionToken = randomUUID();
    await writeConfig(context);
    await chmod(configPath, 0o644);
    context.config.sessionToken = randomUUID();
    await writeConfig(context);

    expect((await loadContext({ config: configPath })).config).toEqual(context.config);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });
});
