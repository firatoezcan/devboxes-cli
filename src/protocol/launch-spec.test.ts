import { describe, expect, it } from "bun:test";

import Value from "typebox/value";

import { opencodeExactProviderIdsLaunchProtocol, OpencodeLaunchSpecSchema } from "./launch-spec";

describe("current launch protocol", () => {
  it("accepts a spec tagged with the exact-provider-ids protocol", () => {
    expect(opencodeExactProviderIdsLaunchProtocol).toBe("devboxes-launch-v2");
    expect(
      Value.Check(OpencodeLaunchSpecSchema, {
        launchProtocol: opencodeExactProviderIdsLaunchProtocol,
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
