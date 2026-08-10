import { describe, expect, it } from "bun:test";

import {
  defaultOpencodeDaemonPlatform,
  opencodeDaemonBootstrapProtocol,
  opencodeDaemonPlatforms,
} from "./daemon-artifact";
import {
  credentialStoreFileName,
  credentialStoreVersion,
  listenerRegistrationDeviceClientId,
  listenerUpgradeRequiredCode,
  opencodeEnginePermissionPolicyErrorCode,
  opencodeTaskCallbackTerminalCode,
  reconciliationLabels,
  runnerMachineApiPrefix,
  runnerMachineRoutePrefix,
} from "./frozen";
import { clientOwnedLaunchEnvKeys, opencodeWorkspaceLaunchProtocol } from "./launch-spec";
import { opencodeProviderAuthPath } from "./provider-auth";
import {
  containerBackendTokenFile,
  containerHome,
  containerOpencodeConfigJsonFile,
  containerSecretsDir,
  daemonEntrypoint,
  taskContainerName,
  taskStateImage,
  taskStateImageRepo,
} from "./task-runtime";

// A change-detector BY DESIGN — the one blessed kind: these values are
// compiled into shipped listener binaries and baked into published runner
// images. Red here means you are breaking artifacts in the wild; rev a
// protocol tag or add a field instead, and read FROZEN.md before touching
// anything. Every assertion is a literal on purpose: deriving expected
// values from the constants under test would hide exactly the drift this
// suite exists to catch.
describe("frozen runner contracts", () => {
  it("pins the protocol tags shipped binaries negotiate with", () => {
    expect(opencodeWorkspaceLaunchProtocol).toBe("devboxes-launch-v5");
    expect(opencodeDaemonBootstrapProtocol).toBe("devboxes-daemon-bootstrap-v1");
  });

  it("pins the env keys shipped runtimes overlay over served launch specs", () => {
    expect(clientOwnedLaunchEnvKeys).toEqual([
      "DEVBOX_BACKEND_BASE_URL",
      "DEVBOX_OPENCODE_PROVIDER_AUTH_URL",
      "DEVBOX_OPENCODE_CONFIG_JSON_FILE",
    ]);
  });

  it("pins the container paths baked into published Workspace Images", () => {
    expect(containerHome).toBe("/home/workspace");
    expect(containerSecretsDir).toBe("/run/devboxes/secrets");
    expect(containerBackendTokenFile).toBe("/run/devboxes/secrets/backend-token");
    expect(containerOpencodeConfigJsonFile).toBe("/run/devboxes/secrets/opencode-config.json");
    expect(daemonEntrypoint).toBe("/entrypoint.sh");
  });

  it("pins the derivations reconciliation re-computes across listener upgrades", () => {
    // sha256("task_1") = 5f5d08238327… — a stale derivation would strand
    // every container and state snapshot launched by an earlier build.
    expect(taskContainerName("task_1")).toBe("firops-opencode-task-5f5d08238327");
    expect(taskStateImageRepo).toBe("firops/opencode-task-state");
    expect(taskStateImage("task_1")).toEqual({
      repo: "firops/opencode-task-state",
      tag: "5f5d08238327",
      ref: "firops/opencode-task-state:5f5d08238327",
    });
  });

  it("pins the provider-auth route shape shipped daemons fetch from", () => {
    expect(opencodeProviderAuthPath).toBe("/opencode-tasks/:taskId/provider-auth");
  });

  it("pins the daemon platform vocabulary shipped artifacts are resolved by", () => {
    expect(opencodeDaemonPlatforms).toEqual(["linux/amd64", "linux/arm64"]);
    expect(defaultOpencodeDaemonPlatform).toBe("linux/amd64");
  });

  it("pins reconciliation, runner API, registration, and credential-store contracts", () => {
    expect(reconciliationLabels).toEqual({
      workload: "devboxes.firops.io/workload",
      workloadValue: "opencode-dispatch-task",
      taskId: "devboxes.firops.io/task-id",
      organizationId: "devboxes.firops.io/organization-id",
    });
    expect(runnerMachineApiPrefix).toBe("/api/internal/runner-machines");
    expect(runnerMachineRoutePrefix).toBe("/internal/runner-machines");
    expect(listenerUpgradeRequiredCode).toBe("listener_upgrade_required");
    expect(opencodeTaskCallbackTerminalCode).toBe("task_callback_terminal");
    expect(opencodeEnginePermissionPolicyErrorCode).toBe("engine_permission_policy_violation");
    expect(listenerRegistrationDeviceClientId).toBe("devboxes-listener-registration");
    expect(credentialStoreFileName).toBe("provider-credentials.json.age");
    expect(credentialStoreVersion).toBe(1);
  });
});
