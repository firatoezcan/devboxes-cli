import { describe, expect, it } from "bun:test";

import Value from "typebox/value";

import {
  opencodeExactProviderIdsLaunchProtocol,
  opencodeIsolatedAgentLaunchProtocol,
  OpencodeLaunchSpecSchema,
  opencodeUsageAuthorityLaunchProtocol,
} from "./launch-spec";

describe("current launch protocol", () => {
  it("keeps the shipped exact-provider-ids protocol literal", () => {
    expect(opencodeExactProviderIdsLaunchProtocol).toBe("devboxes-launch-v2");
  });

  it("keeps the shipped usage-authority protocol literal", () => {
    expect(opencodeUsageAuthorityLaunchProtocol).toBe("devboxes-launch-v3");
  });

  it("accepts a spec tagged with isolated agent execution", () => {
    expect(opencodeIsolatedAgentLaunchProtocol).toBe("devboxes-launch-v4");
    expect(
      Value.Check(OpencodeLaunchSpecSchema, {
        launchProtocol: opencodeIsolatedAgentLaunchProtocol,
        workingDir: "/workspace",
        entrypoint: "/bin/devboxes-task",
        env: {},
        memoryBackedPaths: [],
        labels: {},
        providerAuthSource: "organization",
      }),
    ).toBe(true);
  });
});
