import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { $ } from "bun";

// Mirrors the daemon release script (apps/elysia-opencode/scripts/
// build-daemon-release.ts): every build passes an explicit --target so the
// artifact's platform never silently depends on the publishing machine.
const platformTargets = {
  "linux/amd64": "bun-linux-x64-baseline",
  "linux/arm64": "bun-linux-arm64",
  "darwin/amd64": "bun-darwin-x64-baseline",
  "darwin/arm64": "bun-darwin-arm64",
  "windows/amd64": "bun-windows-x64",
} as const;

type CliPlatform = keyof typeof platformTargets;

const hostPlatform = (): CliPlatform => {
  const os =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const platform = `${os}/${arch}`;
  if (!(platform in platformTargets)) {
    throw new Error(`Unsupported Devboxes build host platform ${platform}.`);
  }
  return platform as CliPlatform;
};

const argValue = (name: string) => {
  const index = Bun.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = Bun.argv[index + 1]?.trim();
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
};

const requestedPlatform = argValue("--platform");
const smoke = Bun.argv.includes("--smoke");
if (smoke && requestedPlatform !== undefined) {
  throw new Error("The Devboxes CLI smoke builds and executes the host artifact only.");
}
const platforms: CliPlatform[] =
  requestedPlatform === "all"
    ? (Object.keys(platformTargets) as CliPlatform[])
    : [(requestedPlatform as CliPlatform | undefined) ?? hostPlatform()];
for (const platform of platforms) {
  if (!(platform in platformTargets)) {
    throw new Error(
      `Devboxes build platform must be one of ${Object.keys(platformTargets).join(", ")} or all.`,
    );
  }
}

const packageRoot = join(import.meta.dir, "..");
const outdir = join(packageRoot, "dist");
const shell = $.cwd(packageRoot);

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

for (const platform of platforms) {
  const target = platformTargets[platform];
  const filename = platform.startsWith("windows/") ? "devboxes.exe" : "devboxes";
  // The default non-Windows build keeps the package bin path (dist/devboxes).
  // Cross-platform artifacts use a deterministic platform directory so release
  // automation never has to infer a path from the runner architecture.
  const outfile =
    requestedPlatform === undefined &&
    platform === hostPlatform() &&
    !platform.startsWith("windows/")
      ? join(outdir, filename)
      : join(outdir, platform.replace("/", "-"), filename);

  await shell`bun build --compile --sourcemap=external --no-compile-autoload-dotenv --no-compile-autoload-bunfig --target=${target} --external cpu-features --outfile ${outfile} src/cli.ts`;
  if (!smoke && !platform.startsWith("windows/")) await chmod(outfile, 0o755);

  if (smoke) {
    const artifact = await stat(outfile);
    if (!artifact.isFile()) {
      throw new Error(`Devboxes CLI artifact ${outfile} is not a file.`);
    }
    if (!platform.startsWith("windows/") && (artifact.mode & 0o111) === 0) {
      throw new Error(`Devboxes CLI artifact ${outfile} is not executable.`);
    }

    const help = Bun.spawn([outfile, "--help"], {
      cwd: packageRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await help.exited;
    if (exitCode !== 0) {
      throw new Error(`The artifact exited with status ${exitCode}.`);
    }
    console.info(`Executed Devboxes CLI artifact ${outfile} with --help.`);
  } else {
    console.info(`Built ${platform} Devboxes CLI at ${outfile}.`);
  }
}
