import { describe, expect, it } from "bun:test";

import { validatedProviderAuthUrl } from "./task-runtime";

describe("validatedProviderAuthUrl", () => {
  it("accepts absolute http(s) base URLs and strips trailing slashes", () => {
    expect(validatedProviderAuthUrl("http://host.docker.internal:43111")).toBe(
      "http://host.docker.internal:43111",
    );
    expect(validatedProviderAuthUrl("http://host.docker.internal:3001/api/internal/")).toBe(
      "http://host.docker.internal:3001/api/internal",
    );
    expect(validatedProviderAuthUrl("https://dashboard.example/")).toBe(
      "https://dashboard.example",
    );
  });

  it("rejects relative or unparseable values", () => {
    for (const value of ["", "/api/internal", "not a url"]) {
      expect(() => validatedProviderAuthUrl(value)).toThrow(
        "Opencode provider-auth URL must be an absolute HTTP(S) URL.",
      );
    }
  });

  it("rejects non-http(s) protocols", () => {
    // "host:3001" parses as a URL with the scheme "host:", so it lands here.
    for (const value of [
      "ftp://host/api",
      "file:///etc/passwd",
      "unix:///var/run/docker.sock",
      "host:3001",
    ]) {
      expect(() => validatedProviderAuthUrl(value)).toThrow(
        "Opencode provider-auth URL must be an HTTP(S) URL.",
      );
    }
  });

  it("rejects embedded credentials, query, and fragment data", () => {
    for (const value of [
      "http://user:pass@host:3001/api",
      "http://user@host:3001/api",
      "http://host:3001/api?token=1",
      "http://host:3001/api#fragment",
    ]) {
      expect(() => validatedProviderAuthUrl(value)).toThrow(
        "Opencode provider-auth URL must not contain credentials, query, or fragment data.",
      );
    }
  });
});
