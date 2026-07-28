// DEVBOX_OPENCODE_* host configuration for the docker task runtime, parsed once
// at module load. This is runner-host configuration: where the operator's
// opencode config lives, where per-task secret files are rooted, and which
// Docker socket to drive.

import { dockerSocketPath } from "./docker-socket";

export const runnerRuntimeEnv = Object.freeze({
  opencodeConfigDir: process.env.DEVBOX_OPENCODE_CONFIG_DIR,
  opencodeHomeRoot: process.env.DEVBOX_OPENCODE_HOME_ROOT,
  dockerSocketPath: dockerSocketPath(),
});
