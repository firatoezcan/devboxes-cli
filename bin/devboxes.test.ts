import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const fixtureDirectories: string[] = [];
const require = createRequire(import.meta.url);
const { nativePackageByTarget } = require(join(import.meta.dir, "devboxes.cjs")) as {
  nativePackageByTarget: Record<string, string>;
};
const itOnPosix = process.platform === "win32" ? it.skip : it;
const nativeTermination =
  process.platform === "win32"
    ? {
        program: "setTimeout(() => process.exit(44), 10);",
        result: { code: 44, signal: null },
      }
    : {
        program: 'setTimeout(() => process.kill(process.pid, "SIGHUP"), 10);',
        result: { code: null, signal: "SIGHUP" },
      };

const createInstalledLauncher = async (
  nativeProgram: string,
  nativeVersion = "1.2.3",
  installNative = true,
) => {
  const packageRoot = await mkdtemp(join(tmpdir(), "devboxes-launcher-"));
  fixtureDirectories.push(packageRoot);

  const launcher = join(packageRoot, "bin", "devboxes.cjs");
  await mkdir(dirname(launcher), { recursive: true });
  await copyFile(join(import.meta.dir, "devboxes.cjs"), launcher);
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "devboxes", version: "1.2.3" })}\n`,
  );

  const target = `${process.platform}-${process.arch}`;
  const nativePackage = nativePackageByTarget[target];
  if (!nativePackage) throw new Error(`The launcher test host is unsupported: ${target}.`);
  if (!installNative) return launcher;

  const nativeRoot = join(packageRoot, "node_modules", nativePackage);
  const nativeBinary = join(nativeRoot, "bin", "devboxes.exe");
  await mkdir(dirname(nativeBinary), { recursive: true });
  await writeFile(
    join(nativeRoot, "package.json"),
    `${JSON.stringify({ name: nativePackage, version: nativeVersion })}\n`,
  );
  if (process.platform === "win32") {
    const nativeSource = join(nativeRoot, "bin", "devboxes.ts");
    await writeFile(nativeSource, nativeProgram);
    const compiler = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--target=bun-windows-x64",
        "--outfile",
        nativeBinary,
        nativeSource,
      ],
      { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
    );
    if ((await compiler.exited) !== 0) throw new Error("Failed to compile the native fixture.");
  } else {
    await writeFile(nativeBinary, `#!/usr/bin/env node\n${nativeProgram}\n`);
    await chmod(nativeBinary, 0o755);
  }

  return launcher;
};

const waitForExit = (child: ReturnType<typeof spawn>) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

afterEach(async () => {
  await Promise.all(
    fixtureDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("installed Devboxes launcher", () => {
  it("preserves arguments, stdio, and the native command exit code", async () => {
    const launcher = await createInstalledLauncher(`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ arguments: process.argv.slice(2), input }));
  process.stderr.write("native stderr");
  process.exit(23);
});
`);
    const child = spawn("node", [launcher, "dispatch", "task with spaces"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end("native stdin");

    await expect(waitForExit(child)).resolves.toEqual({ code: 23, signal: null });
    expect(JSON.parse(stdout)).toEqual({
      arguments: ["dispatch", "task with spaces"],
      input: "native stdin",
    });
    expect(stderr).toBe("native stderr");
  });

  itOnPosix("forwards a targeted noninteractive Ctrl-C to the native command", async () => {
    const launcher = await createInstalledLauncher(`
process.on("SIGINT", () => {
  process.stdout.write("forwarded");
  process.exit(42);
});
process.stdout.write("ready");
setInterval(() => {}, 1_000);
`);
    const child = spawn("node", [launcher], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout === "ready") child.kill("SIGINT");
    });

    await expect(waitForExit(child)).resolves.toEqual({ code: 42, signal: null });
    expect(stdout).toBe("readyforwarded");
  });

  itOnPosix("delivers one noninteractive process-group Ctrl-C", async () => {
    const launcher = await createInstalledLauncher(`
let signals = 0;
process.on("SIGINT", () => {
  signals += 1;
  process.stdout.write(\`signals:\${signals}\\n\`);
  if (signals === 1) {
    setTimeout(() => process.exit(signals === 1 ? 38 : 98), 100);
  }
});
process.stdout.write("ready\\n");
setInterval(() => {}, 1_000);
`);
    const child = spawn("node", [launcher], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let sentInterrupt = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!sentInterrupt && stdout.includes("ready")) {
        sentInterrupt = true;
        process.kill(-child.pid!, "SIGINT");
      }
    });

    await expect(waitForExit(child)).resolves.toEqual({ code: 38, signal: null });
    expect(stdout).toContain("signals:1");
    expect(stdout).not.toContain("signals:2");
  });

  it("delivers one terminal Ctrl-C to the native command", async () => {
    const launcher = await createInstalledLauncher(`
let signals = 0;
process.on("SIGINT", () => {
  signals += 1;
  process.stdout.write(\`signals:\${signals}\\n\`);
  if (signals === 1) {
    setTimeout(() => process.exit(signals === 1 ? 37 : 99), 100);
  }
});
process.stdout.write("ready\\n");
setInterval(() => {}, 1_000);
`);
    let output = "";
    let sentInterrupt = false;
    const child = Bun.spawn(["node", launcher], {
      terminal: {
        data(terminal, data) {
          output += new TextDecoder().decode(data);
          if (!sentInterrupt && output.includes("ready")) {
            sentInterrupt = true;
            terminal.write("\x03");
          }
        },
      },
    });

    const exitCode = await child.exited;
    child.terminal?.close();
    expect(exitCode).toBe(37);
    expect(output).toContain("signals:1");
    expect(output).not.toContain("signals:2");
  });

  itOnPosix("forwards a targeted SIGTERM from an interactive launcher", async () => {
    const launcher = await createInstalledLauncher(`
process.on("SIGTERM", () => {
  process.stdout.write("forwarded\\n");
  process.exit(43);
});
process.stdout.write("ready\\n");
setTimeout(() => process.exit(97), 500);
`);
    let output = "";
    let sentSignal = false;
    const child = Bun.spawn(["node", launcher], {
      terminal: {
        data(_terminal, data) {
          output += new TextDecoder().decode(data);
          if (!sentSignal && output.includes("ready")) {
            sentSignal = true;
            process.kill(child.pid, "SIGTERM");
          }
        },
      },
    });

    const exitCode = await child.exited;
    child.terminal?.close();
    expect(exitCode).toBe(43);
    expect(output).toContain("forwarded");
  });

  it("preserves native termination", async () => {
    const launcher = await createInstalledLauncher(nativeTermination.program);
    const child = spawn("node", [launcher], { stdio: "ignore" });

    await expect(waitForExit(child)).resolves.toEqual(nativeTermination.result);
  });

  it("rejects a native package from a different Devboxes release", async () => {
    const launcher = await createInstalledLauncher(
      'process.stdout.write("must not run");',
      "1.2.2",
    );
    const child = spawn("node", [launcher], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    await expect(waitForExit(child)).resolves.toEqual({ code: 1, signal: null });
    expect(stdout).toBe("");
    expect(stderr).toContain("Devboxes package version mismatch: devboxes is 1.2.3");
    expect(stderr).toContain("is 1.2.2. Reinstall devboxes.");
  });

  it("fails clearly when the current platform package is missing", async () => {
    const launcher = await createInstalledLauncher(
      'process.stdout.write("must not run");',
      "1.2.3",
      false,
    );
    const child = spawn("node", [launcher], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    await expect(waitForExit(child)).resolves.toEqual({ code: 1, signal: null });
    expect(stdout).toBe("");
    expect(stderr).toContain(nativePackageByTarget[`${process.platform}-${process.arch}`]);
    expect(stderr).toContain("optional dependencies enabled");
    expect(stderr).toContain("Reinstall devboxes");
  });
});
