const { chmodSync, copyFileSync, linkSync, renameSync, rmSync } = require("node:fs");
const { dirname, join, sep } = require("node:path");
const { spawnSync } = require("node:child_process");

const packageRoot = __dirname;
if (!packageRoot.split(sep).includes("node_modules")) {
  process.exit(0);
}

const targetPackages = {
  "darwin-arm64": "@devboxes/cli-darwin-arm64",
  "darwin-x64": "@devboxes/cli-darwin-x64",
  "linux-arm64": "@devboxes/cli-linux-arm64",
  "linux-x64": "@devboxes/cli-linux-x64",
  "win32-x64": "@devboxes/cli-win32-x64",
};
const target = `${process.platform}-${process.arch}`;
const platformPackage = targetPackages[target];
if (!platformPackage) {
  throw new Error(
    `Devboxes does not publish a native binary for ${target}. ` +
      "Use macOS or glibc Linux on arm64/x64, or Windows x64.",
  );
}
if (process.platform === "linux" && !process.report?.getReport().header?.glibcVersionRuntime) {
  throw new Error("Devboxes publishes Linux binaries for glibc systems only.");
}

let platformPackageRoot;
try {
  platformPackageRoot = dirname(require.resolve(`${platformPackage}/package.json`));
} catch {
  throw new Error(
    `${platformPackage} is missing. Reinstall devboxes without --omit=optional, ` +
      "or use the native installer from https://github.com/firatoezcan/devboxes-cli.",
  );
}

const manifest = require(join(packageRoot, "package.json"));
const source = join(platformPackageRoot, "bin", "devboxes.exe");
const destination = join(packageRoot, "bin", "devboxes.exe");
const staged = join(packageRoot, "bin", `.devboxes-${process.pid}.exe`);

try {
  try {
    linkSync(source, staged);
  } catch {
    copyFileSync(source, staged);
  }
  if (process.platform !== "win32") chmodSync(staged, 0o755);

  const smoke = spawnSync(staged, ["--version"], { encoding: "utf8" });
  if (smoke.status !== 0 || smoke.stdout?.trim() !== manifest.version) {
    const diagnostic =
      smoke.error?.message ||
      smoke.stderr?.trim() ||
      smoke.stdout?.trim() ||
      `exit ${smoke.status ?? "unknown"}`;
    throw new Error(
      `${platformPackage} did not run as Devboxes ${manifest.version}: ${diagnostic}`,
    );
  }

  renameSync(staged, destination);
} finally {
  rmSync(staged, { force: true });
}
