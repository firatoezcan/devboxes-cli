#!/usr/bin/env node

"use strict";

const { spawn } = require("node:child_process");
const { join } = require("node:path");

const nativePackageByTarget = Object.freeze({
  "darwin-arm64": "@devboxes/cli-darwin-arm64",
  "darwin-x64": "@devboxes/cli-darwin-x64",
  "linux-arm64": "@devboxes/cli-linux-arm64",
  "linux-x64": "@devboxes/cli-linux-x64",
  "win32-x64": "@devboxes/cli-win32-x64",
});

const run = () => {
  const target = `${process.platform}-${process.arch}`;
  const nativePackage = nativePackageByTarget[target];
  if (!nativePackage) {
    console.error(
      `Devboxes does not publish a native binary for ${target}. ` +
        "Use macOS or glibc Linux on arm64/x64, or Windows x64.",
    );
    process.exitCode = 1;
    return;
  }
  if (process.platform === "linux" && !process.report?.getReport().header?.glibcVersionRuntime) {
    console.error("Devboxes publishes Linux binaries for glibc systems only.");
    process.exitCode = 1;
    return;
  }

  let binary;
  let nativeVersion;
  try {
    binary = require.resolve(`${nativePackage}/bin/devboxes.exe`);
    nativeVersion = require(`${nativePackage}/package.json`).version;
  } catch {
    console.error(
      `${nativePackage} is missing. Reinstall devboxes with optional dependencies enabled, ` +
        "or use a native download from https://github.com/firatoezcan/devboxes-cli/releases/latest.",
    );
    process.exitCode = 1;
    return;
  }
  const wrapperVersion = require(join(__dirname, "..", "package.json")).version;
  if (nativeVersion !== wrapperVersion) {
    console.error(
      `Devboxes package version mismatch: devboxes is ${wrapperVersion}, ` +
        `${nativePackage} is ${nativeVersion}. Reinstall devboxes.`,
    );
    process.exitCode = 1;
    return;
  }

  const childSharesTerminal =
    process.stdin.isTTY === true || process.stdout.isTTY === true || process.stderr.isTTY === true;
  const detachedProcessGroup = !childSharesTerminal && process.platform !== "win32";
  const child = spawn(binary, process.argv.slice(2), {
    detached: detachedProcessGroup,
    stdio: "inherit",
  });

  const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const signalHandlers = {};
  for (const signal of forwardedSignals) {
    const isTerminalBroadcast = childSharesTerminal && signal !== "SIGTERM";
    const handleSignal = isTerminalBroadcast
      ? () => {}
      : () => {
          try {
            if (detachedProcessGroup && child.pid !== undefined) {
              process.kill(-child.pid, signal);
            } else {
              child.kill(signal);
            }
          } catch {}
        };
    signalHandlers[signal] = handleSignal;
    process.on(signal, handleSignal);
  }

  const removeSignalHandlers = () => {
    for (const signal of forwardedSignals) {
      process.removeListener(signal, signalHandlers[signal]);
    }
  };
  child.once("error", (error) => {
    removeSignalHandlers();
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    removeSignalHandlers();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
};

module.exports = { nativePackageByTarget };

if (require.main === module) run();
