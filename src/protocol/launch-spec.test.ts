import { describe, expect, it } from "bun:test";

import Value from "typebox/value";

import { opencodeWorkspaceLaunchProtocol, OpencodeLaunchSpecSchema } from "./launch-spec";

describe("current launch protocol", () => {
  it("accepts the current Workspace capability protocol", () => {
    const shared = {
      launchProtocol: opencodeWorkspaceLaunchProtocol,
      workingDir: "/workspace",
      entrypoint: "/bin/devboxes-task",
      memoryBackedPaths: [],
      labels: {},
      providerAuthSource: "organization",
    } as const;
    expect(
      Value.Check(OpencodeLaunchSpecSchema, {
        ...shared,
        workspaceCapability: "agent-task",
        env: {
          DEVBOX_WORKSPACE_CAPABILITY: "agent-task",
          DEVBOX_WORKSPACE_CAPABILITY_ID: "task_test",
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(OpencodeLaunchSpecSchema, {
        ...shared,
        launchProtocol: "devboxes-launch-v5",
        workspaceCapability: "agent-task",
        env: {
          DEVBOX_WORKSPACE_CAPABILITY: "agent-task",
          DEVBOX_WORKSPACE_CAPABILITY_ID: "task_test",
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(OpencodeLaunchSpecSchema, {
        ...shared,
        workspaceCapability: "provider-model-resolution",
        env: {
          DEVBOX_WORKSPACE_CAPABILITY: "provider-model-resolution",
          DEVBOX_WORKSPACE_CAPABILITY_ID: "resolution_test",
          DEVBOX_MODEL_PROVIDER_ID: "github-copilot",
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(OpencodeLaunchSpecSchema, {
        ...shared,
        workspaceCapability: "agent-task",
        env: {
          DEVBOX_WORKSPACE_CAPABILITY: "provider-model-resolution",
          DEVBOX_WORKSPACE_CAPABILITY_ID: "resolution_test",
          DEVBOX_MODEL_PROVIDER_ID: "github-copilot",
        },
      }),
    ).toBe(false);
  });
});
