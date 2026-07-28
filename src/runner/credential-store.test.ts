import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { armor, Encrypter } from "age-encryption";

import { credentialStoreFileName } from "../protocol/frozen";
import { readCredentialStore, writeCredentialStore } from "./credential-store";

describe("local credential store", () => {
  it("round-trips entries as owner-only ciphertext and answers empty when absent", async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "devboxes-credential-store-"));
    const configPath = join(fixtureDir, "config.json");
    const passphrase = "store-test-passphrase";
    try {
      expect(await readCredentialStore({ configPath, passphrase })).toEqual({
        version: 1,
        entries: {},
      });

      const store = {
        version: 1 as const,
        entries: {
          openai: {
            auth: {
              type: "oauth" as const,
              refresh: "openai-refresh-token",
              access: "openai-access-token",
              expires: 1_751_600_000_000,
              accountId: "chatgpt-account",
            },
            accountLabel: "user@example.com",
          },
          anthropic: {
            auth: { type: "api" as const, key: "anthropic-key" },
          },
        },
      };
      await writeCredentialStore({ configPath, passphrase, store });

      const storePath = join(fixtureDir, credentialStoreFileName);
      const onDisk = await readFile(storePath, "utf8");
      expect(onDisk).toContain("AGE ENCRYPTED FILE");
      expect(onDisk).not.toContain("openai-refresh-token");
      expect(onDisk).not.toContain("anthropic-key");
      expect(((await stat(storePath)).mode & 0o777).toString(8)).toBe("600");

      expect(await readCredentialStore({ configPath, passphrase })).toEqual(store);
      // The designed revocation outcome is an operator-facing contract, not a
      // raw age library error: name the file and the recovery path.
      await expect(
        readCredentialStore({ configPath, passphrase: "wrong-passphrase" }),
      ).rejects.toThrow(
        /provider-credentials\.json\.age.*Delete the file and run `devboxes credentials setup`/,
      );
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("tells a downgraded binary to upgrade instead of deleting a newer store", async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "devboxes-credential-store-"));
    const configPath = join(fixtureDir, "config.json");
    const passphrase = "store-test-passphrase";
    try {
      // A store written by a hypothetical newer runner: decrypts fine, but
      // carries a format this binary does not read.
      const encrypter = new Encrypter();
      encrypter.setScryptWorkFactor(12);
      encrypter.setPassphrase(passphrase);
      const ciphertext = await encrypter.encrypt(JSON.stringify({ version: 2, entries: {} }));
      await writeFile(join(fixtureDir, credentialStoreFileName), `${armor.encode(ciphertext)}\n`);

      // The passphrase-rotation diagnosis (and its delete-the-file advice)
      // would destroy a fully recoverable artifact here.
      await expect(readCredentialStore({ configPath, passphrase })).rejects.toThrow(
        /written by a newer Devboxes version \(store version 2.*Upgrade Devboxes/,
      );
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
