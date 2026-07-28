import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { armor, Decrypter, Encrypter } from "age-encryption";
import Type from "typebox";
import Value from "typebox/value";

import { credentialStoreFileName, credentialStoreVersion } from "../protocol/frozen";
import { validateOpencodeProviderAuth, type OpencodeProviderAuth } from "../protocol/provider-auth";
import { writeSecretFile } from "../secret-file";

// On-device store for runner-owned provider credentials: subscription OAuth
// token families minted by `credentials setup` and manually entered API keys.
// The whole file is one armored age payload encrypted with the per-machine
// passphrase the dashboard serves — the runner holds the passphrase in
// memory only, so the file alone is useless and deleting the machine prevents
// future passphrase retrieval. Plaintext already exposed to a locally
// controlled running process is outside that server-side revocation boundary.

// Entries tolerate unknown keys: a newer Devboxes version may add optional entry
// fields, and a same-version store it wrote must stay readable after a
// downgrade instead of being misdiagnosed as unreadable.
const CredentialStoreSchema = Type.Object(
  {
    version: Type.Literal(credentialStoreVersion),
    entries: Type.Record(
      Type.String({ minLength: 1 }),
      Type.Object(
        {
          auth: Type.Object(
            { type: Type.String({ minLength: 1 }) },
            { additionalProperties: true },
          ),
          accountLabel: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

export type LocalCredentialStore = {
  version: typeof credentialStoreVersion;
  entries: Record<string, { auth: OpencodeProviderAuth; accountLabel?: string }>;
};

// The designed revocation outcome, made operator-facing: a store that stops
// decrypting is almost always a machine that was deleted or re-registered,
// which rotates the passphrase and permanently revokes the on-device copy.
// Only decrypt failures carry this diagnosis — a store that decrypts but does
// not parse gets its own message, and a newer store version must never be
// told to delete a perfectly recoverable file.
export class CredentialStoreUnreadableError extends Error {
  constructor(storePath: string, diagnosis: string, cause: unknown) {
    super(
      `The device credential store at ${storePath} ${diagnosis} Delete the file and run \`devboxes credentials setup\` to reconnect providers.`,
      { cause },
    );
  }
}

// The store decrypts fine but was written by a newer runner: the artifact
// is fully recoverable by upgrading, so no caller may self-heal over it.
class CredentialStoreVersionError extends Error {
  constructor(storePath: string, version: unknown) {
    super(
      `The device credential store at ${storePath} was written by a newer Devboxes version (store version ${String(version)}; this version reads ${credentialStoreVersion}). Upgrade Devboxes instead of deleting the file.`,
    );
  }
}

export const credentialStoreExists = async (configPath: string) => {
  try {
    await stat(join(dirname(configPath), credentialStoreFileName));
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    // An EACCES/EPERM store must surface as the real problem, not silently
    // stop advertising the stored providers.
    throw error;
  }
};

export const readCredentialStore = async (input: {
  configPath: string;
  passphrase: string;
}): Promise<LocalCredentialStore> => {
  const storePath = join(dirname(input.configPath), credentialStoreFileName);
  let armored: string;
  try {
    armored = await readFile(storePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { version: credentialStoreVersion, entries: {} };
    }
    throw error;
  }

  let plaintext: string;
  try {
    const decrypter = new Decrypter();
    decrypter.addPassphrase(input.passphrase);
    plaintext = await decrypter.decrypt(armor.decode(armored), "text");
  } catch (error) {
    throw new CredentialStoreUnreadableError(
      storePath,
      "could not be decrypted. Its passphrase rotates when the machine is deleted or re-registered, which permanently revokes the stored copy.",
      error,
    );
  }

  try {
    const raw: unknown = JSON.parse(plaintext);
    const version = raw && typeof raw === "object" && "version" in raw ? raw.version : undefined;
    if (version !== credentialStoreVersion) {
      throw new CredentialStoreVersionError(storePath, version);
    }
    const parsed = Value.Parse(CredentialStoreSchema, raw);
    const entries: LocalCredentialStore["entries"] = {};
    for (const [providerId, entry] of Object.entries(parsed.entries)) {
      entries[providerId] = {
        auth: validateOpencodeProviderAuth(providerId, entry.auth),
        ...(entry.accountLabel !== undefined ? { accountLabel: entry.accountLabel } : {}),
      };
    }
    return { version: credentialStoreVersion, entries };
  } catch (error) {
    if (error instanceof CredentialStoreVersionError) throw error;
    throw new CredentialStoreUnreadableError(storePath, "decrypts but does not parse.", error);
  }
};

export const writeCredentialStore = async (input: {
  configPath: string;
  passphrase: string;
  store: LocalCredentialStore;
}) => {
  const encrypter = new Encrypter();
  // The passphrase is 64 server-minted random bytes, so scrypt hardening buys
  // nothing against brute force — the default work factor (logN=18, ~256 MiB
  // and a visible pause per operation) would only slow every store read and
  // refresh down. Decryption reads the factor from the file header.
  encrypter.setScryptWorkFactor(12);
  encrypter.setPassphrase(input.passphrase);
  const ciphertext = await encrypter.encrypt(JSON.stringify(input.store));
  await writeSecretFile({
    path: join(dirname(input.configPath), credentialStoreFileName),
    contents: `${armor.encode(ciphertext)}\n`,
    tmpPrefix: ".provider-credentials.",
  });
};
