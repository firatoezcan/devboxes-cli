import { describe, expect, it } from "bun:test";

import Value from "typebox/value";

import { opencodeWorkspaceLaunchProtocol, OpencodeLaunchSpecSchema } from "./launch-spec";

describe("current launch protocol", () => {
  it("accepts the current Workspace capability protocol", () => {
    expect(opencodeWorkspaceLaunchProtocol).toBe("devboxes-launch-v5");
    expect(
      Value.Check(OpencodeLaunchSpecSchema, {
        launchProtocol: opencodeWorkspaceLaunchProtocol,
        workspaceCapability: "agent-task",
        workingDir: "/workspace",
        entrypoint: "/bin/devboxes-task",
        env: {},
        memoryBackedPaths: [],
        labels: {},
        providerAuthSource: "organization",
      }),
    ).toBe(true);
    expect(
      Value.Check(OpencodeLaunchSpecSchema, {
        launchProtocol: opencodeWorkspaceLaunchProtocol,
        workspaceCapability: "provider-model-resolution",
        workingDir: "/workspace",
        entrypoint: "/bin/devboxes-task",
        env: {},
        memoryBackedPaths: [],
        labels: {},
        providerAuthSource: "local-broker",
      }),
    ).toBe(true);
  });
});
