import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureRoots: string[] = [];
const cliPackage = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const smokeCommand = cliPackage.scripts["build:smoke"];
if (!smokeCommand) throw new Error("The Devboxes CLI package has no executable smoke command.");

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

const runSmoke = async (artifactMode: "working" | "missing" | "non-executable" | "broken") => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "devboxes-cli-smoke-")));
  fixtureRoots.push(root);

  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const buildScript = join(scripts, "build-cli-binaries.ts");
  const compiler = join(bin, "bun");
  const compilerLog = join(root, "compiler.log");
  const artifactLog = join(root, "artifact.log");
  const artifact = join(root, "dist", "devboxes");

  await Promise.all([mkdir(scripts, { recursive: true }), mkdir(bin, { recursive: true })]);
  await writeFile(
    buildScript,
    await readFile(new URL("./build-cli-binaries.ts", import.meta.url), "utf8"),
  );
  const artifactSource = `#!/bin/sh
printf '%s\\t%s\\n' "$0" "$*" >> "$ARTIFACT_LOG"
exit "\${ARTIFACT_EXIT_CODE:-0}"
`;
  await writeFile(
    compiler,
    `#!${process.execPath}
import { appendFile, chmod, writeFile } from "node:fs/promises";

if (Bun.argv[2] !== "build") {
  const runtime = Bun.spawnSync([Bun.env.REAL_BUN!, ...Bun.argv.slice(2)], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(runtime.exitCode);
}

await appendFile(Bun.env.COMPILER_LOG!, "compile\\n");
const outfileOption = Bun.argv.findIndex(
  (argument) => argument === "--outfile" || argument.startsWith("--outfile="),
);
const option = Bun.argv[outfileOption];
const outfile = option === "--outfile" ? Bun.argv[outfileOption + 1] : option?.slice(10);
if (!outfile) process.exit(91);

if (Bun.env.ARTIFACT_MODE !== "missing") {
  await writeFile(outfile, ${JSON.stringify(artifactSource)});
  await chmod(outfile, Bun.env.ARTIFACT_MODE === "non-executable" ? 0o644 : 0o755);
}
`,
  );
  await chmod(compiler, 0o755);

  const result = Bun.spawnSync(["/bin/sh", "-c", smokeCommand], {
    cwd: root,
    env: {
      ...process.env,
      ARTIFACT_EXIT_CODE: artifactMode === "broken" ? "23" : "0",
      ARTIFACT_LOG: artifactLog,
      ARTIFACT_MODE: artifactMode,
      COMPILER_LOG: compilerLog,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      REAL_BUN: process.execPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  return { artifact, artifactLog, compilerLog, result };
};

describe("Devboxes CLI executable smoke", () => {
  test("compiles once and executes the exact output with --help", async () => {
    const { artifact, artifactLog, compilerLog, result } = await runSmoke("working");

    expect(result.exitCode).toBe(0);
    expect(await readFile(compilerLog, "utf8")).toBe("compile\n");
    expect(await readFile(artifactLog, "utf8")).toBe(`${artifact}\t--help\n`);
  });

  for (const [artifactMode, error] of [
    ["missing", "is missing after compilation"],
    ["non-executable", "is not executable"],
    ["broken", "failed its --help check"],
  ] as const) {
    test(`rejects a ${artifactMode} compiler output at the artifact boundary`, async () => {
      const { artifact, compilerLog, result } = await runSmoke(artifactMode);

      expect(result.exitCode).not.toBe(0);
      expect(await readFile(compilerLog, "utf8")).toBe("compile\n");
      expect(result.stderr.toString()).toContain(`Devboxes CLI artifact ${artifact} ${error}`);
    });
  }
});
