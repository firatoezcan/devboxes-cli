import { describe, expect, it } from "bun:test";

import Value from "typebox/value";

import {
  opencodeExactProviderIdsLaunchProtocol,
  OpencodeLaunchSpecSchema,
  opencodeUsageAuthorityLaunchProtocol,
} from "./launch-spec";

describe("current launch protocol", () => {
  it("keeps the shipped exact-provider-ids protocol literal", () => {
    expect(opencodeExactProviderIdsLaunchProtocol).toBe("devboxes-launch-v2");
  });

  it("accepts a spec tagged with immutable usage authority", () => {
    expect(opencodeUsageAuthorityLaunchProtocol).toBe("devboxes-launch-v3");
    expect(
      Value.Check(OpencodeLaunchSpecSchema, {
        launchProtocol: opencodeUsageAuthorityLaunchProtocol,
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
