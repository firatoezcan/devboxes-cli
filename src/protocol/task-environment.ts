import { containerCaBundle, containerJavaTrustStore } from "./task-runtime";

export const runnerPassthroughEnvironmentKeys = [
  "PATH",
  "HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

/**
 * The settings that turn off telemetry in common tools that a Task runs. Bun, Turborepo, Nuxt and
 * Wrangler honor DO_NOT_TRACK; the other tools read only their own setting. A Project environment
 * variable of the same name replaces a value.
 */
export const telemetryOptOutEnvironment = {
  DO_NOT_TRACK: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  ASTRO_TELEMETRY_DISABLED: "1",
  GATSBY_TELEMETRY_DISABLED: "1",
  STORYBOOK_DISABLE_TELEMETRY: "1",
  EXPO_NO_TELEMETRY: "1",
  FLUTTER_SUPPRESS_ANALYTICS: "true",
  DASH__SUPPRESS_ANALYTICS: "true",
  CHECKPOINT_DISABLE: "1",
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  npm_config_update_notifier: "false",
};

/**
 * Points the TLS clients a Task starts at the Workspace Image's trust store, which holds no eMudhra
 * emSign root (DEC-emudhra-trust-scope), instead of the roots each carries: Node, nixpkgs' certifi,
 * Python's requests, curl, Java and Deno. `SSL_CERT_FILE` comes from the image. A Project's own
 * value of a variable replaces it.
 */
export const systemTrustStoreEnvironment = {
  NODE_OPTIONS: "--use-openssl-ca",
  NIX_SSL_CERT_FILE: containerCaBundle,
  REQUESTS_CA_BUNDLE: containerCaBundle,
  CURL_CA_BUNDLE: containerCaBundle,
  JAVA_TOOL_OPTIONS: `-Djavax.net.ssl.trustStore=${containerJavaTrustStore}`,
  DENO_TLS_CA_STORE: "system",
};

const runnerExactEnvironmentKeys = new Set([
  ...runnerPassthroughEnvironmentKeys,
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GH_CONFIG_DIR",
  "GH_PROMPT_DISABLED",
  "GIT_TERMINAL_PROMPT",
  "GIT_TRACE_REDACT",
]);

const taskShellManagedEnvironmentKeys = new Set(["IFS", "OLDPWD", "PPID", "PWD", "SHLVL", "_"]);

export const taskEnvironmentKeyError = (key: string) => {
  const normalizedKey = key.toUpperCase();
  if (taskShellManagedEnvironmentKeys.has(normalizedKey)) {
    return `Environment key ${normalizedKey} is managed by the task shell. Choose another name.`;
  }
  if (
    normalizedKey.startsWith("DEVBOX_") ||
    normalizedKey.startsWith("OPENCODE_") ||
    normalizedKey.startsWith("GIT_CONFIG_") ||
    normalizedKey.endsWith("_JSON_B64") ||
    runnerExactEnvironmentKeys.has(normalizedKey)
  ) {
    return `Environment key ${normalizedKey} is reserved by devboxes or the runner. Choose another name.`;
  }
  return null;
};

export const requireTaskEnvironmentKeyAllowed = (key: string) => {
  const error = taskEnvironmentKeyError(key);
  if (error) throw new Error(error);
};

/** The parts of a request that may carry a secret. Headers include HTTP Basic credentials. */
export const secretSwapParts = ["header", "path", "query", "body"] as const;

export type SecretSwapPart = (typeof secretSwapParts)[number];

/**
 * A lowercase host name of at least two labels of up to 63 characters each, whose last label starts
 * with a letter, such as github.com: what Cilium takes as a name to match.
 */
export const hostNamePattern =
  "([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?";

/** A host a secret may be sent to: a host name as a Task's egress policy names one. */
const secretHost = new RegExp(`^${hostNamePattern}$`);

const listFormat = new Intl.ListFormat("en-GB", { type: "conjunction" });

/** What unprotected secrets risk, which their entries carry and the web states and asks to accept. */
export const unprotectedSecretWarning = (keys: readonly [string, ...string[]]) =>
  keys.length === 1
    ? `devboxes can't protect ${keys[0]}. Runs get its real value, so the agent can read it and send it anywhere, and that risk is yours.`
    : `devboxes can't protect ${listFormat.format(keys)}. Runs get their real values, so the agent can read them and send them anywhere, and that risk is yours.`;

/** A name tasks read an entry from: a letter or underscore, then letters, digits and underscores. */
export const environmentKeyPattern = "^[A-Za-z_][A-Za-z0-9_]*$";

/** The longest name a variable or secret takes. */
export const environmentKeyMaxLength = 256;

/** The suffix of the key under which devboxes stores a database's read-only password. */
const readOnlyLoginSuffix = "__READ_ONLY";

/** Where devboxes stores the password of database `key`'s read-only login, beside its URL. */
export const readOnlyLoginKey = (key: string) => `${key}${readOnlyLoginSuffix}`;

/** Why `key` can't name a variable or secret, or null when it can. */
export const environmentKeyError = (key: string) => {
  if (!new RegExp(environmentKeyPattern).test(key))
    return "Name it with letters, digits and underscores, starting with a letter or underscore, for example STRIPE_API_KEY.";
  if (key.length > environmentKeyMaxLength)
    return `Keep the name to ${environmentKeyMaxLength} characters.`;
  if (key.toUpperCase().endsWith(readOnlyLoginSuffix))
    return `Names ending in ${readOnlyLoginSuffix} are reserved for a database's read-only login. Choose another name.`;
  return taskEnvironmentKeyError(key);
};

/** Why `value` can't be a variable's value, or null when it can. */
export const variableValueError = (value: string) =>
  !value.trim() || value.includes("\0") || new TextEncoder().encode(value).length > 64 * 1024
    ? "Variable values must be nonblank, contain no NUL bytes, and fit in 64 KiB."
    : null;

/** Why `value` can't be a secret's value, or null when it can. */
export const secretValueError = (value: string) => {
  if (!value.trim()) return "Secret values cannot be blank.";
  if (value.includes("\0")) return "Secret values cannot contain NUL bytes.";
  if (value.length < 16) return "Secret values must contain at least 16 characters.";
  if (new TextEncoder().encode(value).length > 64 * 1024)
    return "Secret values cannot exceed 64 KiB.";
  return null;
};

/** A secret's hosts as devboxes stores them: lowercase, each once. */
export const secretHosts = (hosts: string[]) => [
  ...new Set(hosts.map((host) => host.toLowerCase())),
];

/** The most hosts a secret may be sent to. */
export const secretHostsMax = 20;

/** Why `hosts`, as `secretHosts` gives them, can't be a secret's hosts, or null when they can. */
export const secretHostsError = (hosts: string[]) => {
  if (hosts.length === 0) return "Name at least one host, for example api.github.com.";
  if (hosts.length > secretHostsMax) return `Name at most ${secretHostsMax} hosts.`;
  if (hosts.some((host) => host.includes("*")))
    return "Name each host exactly. devboxes doesn't send a secret to every subdomain of a host.";
  if (hosts.some((host) => /:\d+$/.test(host)))
    return "devboxes sends a secret only over HTTPS on port 443. Enter the host without a port, for example api.github.com.";
  if (hosts.some((host) => host.length > 253 || !secretHost.test(host)))
    return "Enter the host alone, a name of at least two labels, for example api.github.com.";
  return null;
};

/** The URL schemes of a database secret: devboxes connects Postgres only. */
const databaseSchemes = ["postgres:", "postgresql:"];

/** The TLS modes devboxes connects a database with; each encrypts the connection. */
export const databaseSslModes = ["require", "verify-ca", "verify-full"] as const;

/** The ports a Task's egress policy never opens to a database: DNS, HTTP and HTTPS. */
const reservedDatabasePorts = [53, 80, 443];

/**
 * Where a database secret's URL connects, and as whom: an exact host name, a port that defaults
 * to 5432, a user and password, one database, a TLS mode that defaults to `verify-full`, and the
 * client `parameters` that the Task's own URL carries.
 */
export type DatabaseTarget = {
  host: string;
  port: number;
  user: string;
  password: string;
  name: string;
  sslmode: (typeof databaseSslModes)[number];
  parameters: DatabaseClientParameters;
};

/**
 * The query parameters of a database URL that libpq reads on the client side, which the Task's own
 * URL carries so the Task's client applies them as it would on a direct connection.
 */
export const databaseClientParameters = ["application_name", "options", "connect_timeout"] as const;

/** The client parameters a database URL names. */
export type DatabaseClientParameters = Partial<
  Record<(typeof databaseClientParameters)[number], string>
>;

/** The name PgBouncer keeps for its own console, which no database it connects may have. */
const reservedDatabaseName = "pgbouncer";

/**
 * The refusal codes of a database URL: another scheme than Postgres, a query parameter devboxes
 * can't honor, or a URL devboxes can't connect safely.
 */
export const databaseUrlRefusals = {
  scheme: "DATABASE_SCHEME_UNSUPPORTED",
  parameter: "DATABASE_PARAMETER_UNSUPPORTED",
  invalid: "INVALID_ENVIRONMENT_ENTRY",
} as const;

/** The longest user or database name PostgreSQL keeps, in bytes. */
const postgresNameBytes = 63;

/** A control character, which PgBouncer's configuration can't carry in a login or database name. */
const controlCharacter = /\p{Cc}/u;

/**
 * The longest password devboxes connects with, in bytes as PgBouncer's auth file holds it, where a
 * double quote is doubled. PgBouncer 1.26.1 refuses a longer one (`MAX_PASSWORD` in bouncer.h),
 * because PostgreSQL refuses an authentication message over 65535 bytes.
 */
export const authFilePasswordBytes = 65530;

/** Why devboxes can't connect with `password`, or null when it can. */
export const passwordLengthError = (password: string) =>
  new TextEncoder().encode(password.replaceAll('"', '""')).length > authFilePasswordBytes
    ? `devboxes connects with a password of at most ${authFilePasswordBytes} bytes, counting a double quote as two.`
    : null;

/** `component` of a URL percent-decoded, or false when its escapes or decoded text are malformed. */
const decoded = (component: string) => {
  try {
    const text = decodeURIComponent(component);
    return controlCharacter.test(text) ? false : text;
  } catch {
    return false;
  }
};

/**
 * The target of `value`, a database secret's `postgres://` or `postgresql://` URL, or why it can't
 * be stored, with its refusal code.
 */
export const databaseTarget = (
  value: string,
):
  | { code: (typeof databaseUrlRefusals)[keyof typeof databaseUrlRefusals]; error: string }
  | { target: DatabaseTarget } => {
  const invalid = (error: string) => ({ code: databaseUrlRefusals.invalid, error });
  const url = URL.parse(value);
  if (!url)
    return invalid(
      "Enter the database's connection URL, for example postgresql://app:<password>@db.example.com:5432/orders.",
    );
  if (!databaseSchemes.includes(url.protocol))
    return {
      code: databaseUrlRefusals.scheme,
      error: "devboxes connects Postgres databases only: enter a postgres:// or postgresql:// URL.",
    };
  const host = url.hostname.toLowerCase();
  if (!secretHost.test(host) || host.length > 253)
    return invalid(
      "Name the database's host exactly, a name of at least two labels such as db.example.com. devboxes doesn't connect to an IP address.",
    );
  const port = url.port === "" ? 5432 : Number(url.port);
  if (port === 0 || reservedDatabasePorts.includes(port))
    return invalid("devboxes connects a database on its own port: never 0, 53, 80 or 443.");
  const [user, password, name] = [url.username, url.password, url.pathname.slice(1)].map(decoded);
  if (user === false || password === false || name === false)
    return invalid(
      "The URL's user, password and database name can't hold control characters or a malformed % escape.",
    );
  if (!user || !password) return invalid("Include the database user and password in the URL.");
  const passwordError = passwordLengthError(password);
  if (passwordError) return invalid(passwordError);
  if (new TextEncoder().encode(user).length > postgresNameBytes)
    return invalid(`PostgreSQL keeps a user name of at most ${postgresNameBytes} bytes.`);
  if (!name || name.includes("/")) return invalid("Name one database in the URL's path.");
  if (new TextEncoder().encode(name).length > postgresNameBytes)
    return invalid(`PostgreSQL keeps a database name of at most ${postgresNameBytes} bytes.`);
  if (name.includes("'") || name === reservedDatabaseName)
    return invalid(
      `devboxes can't connect a database named ${reservedDatabaseName} or whose name holds a single quote (').`,
    );
  const parameter = (key: string) => url.searchParams.get(key);
  const unsupported = [...new Set(url.searchParams.keys())].find(
    (key) =>
      !["sslmode", "channel_binding", ...databaseClientParameters].some((known) => known === key),
  );
  if (unsupported)
    return {
      code: databaseUrlRefusals.parameter,
      error: `devboxes can't honor ${unsupported} in a database URL. Remove it, or connect without it.`,
    };
  if (parameter("channel_binding") === "require")
    return {
      code: databaseUrlRefusals.parameter,
      error:
        "devboxes' connection to your database can't bind the channel. Remove channel_binding=require from the URL.",
    };
  if (![null, "prefer", "disable"].includes(parameter("channel_binding")))
    return invalid("Set channel_binding to prefer or disable, or leave it out.");
  const requested = parameter("sslmode") ?? "verify-full";
  const sslmode = databaseSslModes.find((mode) => mode === requested);
  if (!sslmode)
    return invalid(
      "Set sslmode to require, verify-ca or verify-full, so the password never crosses the internet unencrypted.",
    );
  const named = databaseClientParameters.flatMap((key) => {
    const value = parameter(key);
    return value === null ? [] : [[key, value] as const];
  });
  const refused = named.find(([, value]) => controlCharacter.test(value));
  if (refused) return invalid(`${refused[0]} can't hold control characters.`);
  return {
    target: {
      host,
      port,
      user,
      password,
      name,
      sslmode,
      parameters: Object.fromEntries(named),
    },
  };
};

/**
 * Why a database's read-only login can't be stored as given, with the field to fix, or null when
 * it can: its user and password come together, `readOnly` needs them, neither is blank or holds a
 * control character, the user fits PostgreSQL's 63 bytes, and the password fits PgBouncer's auth
 * file.
 */
export const readOnlyLoginError = ({
  readOnly,
  readOnlyUser,
  readOnlyPassword,
}: {
  readOnly?: boolean;
  readOnlyUser?: string;
  readOnlyPassword?: string;
}): { field: "readOnlyUser" | "readOnlyPassword"; error: string } | null => {
  if (readOnlyUser === undefined && readOnlyPassword === undefined)
    return readOnly
      ? {
          field: "readOnlyUser",
          error: "Paste the read-only login's user and password to enforce read-only.",
        }
      : null;
  if (readOnlyUser === undefined || readOnlyPassword === undefined)
    return {
      field: readOnlyUser === undefined ? "readOnlyUser" : "readOnlyPassword",
      error: "Give the read-only login's user and password together.",
    };
  if (!readOnlyUser.trim())
    return { field: "readOnlyUser", error: "The read-only login's user can't be blank." };
  if (!readOnlyPassword.trim())
    return { field: "readOnlyPassword", error: "The read-only login's password can't be blank." };
  if (controlCharacter.test(readOnlyUser))
    return {
      field: "readOnlyUser",
      error: "The read-only login's user can't hold control characters.",
    };
  if (controlCharacter.test(readOnlyPassword))
    return {
      field: "readOnlyPassword",
      error: "The read-only login's password can't hold control characters.",
    };
  if (new TextEncoder().encode(readOnlyUser).length > postgresNameBytes)
    return {
      field: "readOnlyUser",
      error: `PostgreSQL keeps a user name of at most ${postgresNameBytes} bytes.`,
    };
  const passwordError = passwordLengthError(readOnlyPassword);
  return passwordError ? { field: "readOnlyPassword", error: passwordError } : null;
};

/**
 * Why `secrets.set` can't store `entry`, with its refusal code, or null when it can. A secret names
 * the hosts it may be sent to, is a database, or carries its owner's choice to leave it
 * unprotected. A variable reaches tasks as it is, so it takes none of these. A database's URL must
 * be one `databaseTarget` reads, and it may carry a read-only login, which `readOnly` requires.
 */
export const environmentEntryError = ({
  key,
  kind,
  value,
  hosts,
  swapIn,
  unprotected,
  database,
  readOnly,
  readOnlyUser,
  readOnlyPassword,
}: {
  key: string;
  kind: "secret" | "var";
  value: string;
  hosts?: string[];
  swapIn?: SecretSwapPart[];
  unprotected?: boolean;
  database?: boolean;
  readOnly?: boolean;
  readOnlyUser?: string;
  readOnlyPassword?: string;
}): {
  code: (typeof databaseUrlRefusals)[keyof typeof databaseUrlRefusals];
  error: string;
} | null => {
  const invalid = (error: string | null) =>
    error === null ? null : { code: databaseUrlRefusals.invalid, error };
  const keyError = environmentKeyError(key);
  if (keyError) return invalid(keyError);
  const readOnlyLogin =
    readOnly !== undefined || readOnlyUser !== undefined || readOnlyPassword !== undefined;
  if (kind === "var")
    return invalid(
      hosts || swapIn || unprotected || database || readOnlyLogin
        ? "A variable reaches Runs as it is, so it takes no hosts, swapIn, unprotected, database or read-only login."
        : variableValueError(value),
    );
  const valueError = secretValueError(value);
  if (valueError) return invalid(valueError);
  if (database) {
    if (hosts || swapIn || unprotected)
      return invalid(
        "A database takes no hosts, swapIn or unprotected: devboxes connects it through its own port.",
      );
    const target = databaseTarget(value);
    if ("error" in target) return target;
    return invalid(readOnlyLoginError({ readOnly, readOnlyUser, readOnlyPassword })?.error ?? null);
  }
  if (readOnlyLogin) return invalid("Only a database takes a read-only login.");
  if (unprotected)
    return invalid(hosts || swapIn ? "An unprotected secret takes no hosts or swapIn." : null);
  if (!hosts)
    return invalid(
      `Name the hosts that ${key} may be sent to in hosts, for example ["api.github.com"]. If devboxes can't protect it, set unprotected to true instead: the agent can then read it and send it anywhere.`,
    );
  return invalid(secretHostsError(hosts));
};

/**
 * What a database secret's entry stores beside its URL in Infisical: where it connects, its
 * read-only setting and the user of its read-only login, never a password.
 */
export type DatabaseEntry = Omit<DatabaseTarget, "password"> & {
  readOnly: boolean;
  readOnlyUser: string | null;
};

/**
 * The entry of a database whose URL `value` is, as `secrets.set` stores it once
 * `environmentEntryError` accepts the URL: its address and parameters, never the password, with
 * `readOnly` and the read-only login's user.
 */
export const databaseEntry = (
  value: string,
  login: { readOnly: boolean; readOnlyUser: string | null },
): DatabaseEntry | null => {
  const parsed = databaseTarget(value);
  if ("error" in parsed) return null;
  const { password: _, ...address } = parsed.target;
  return { ...address, ...login };
};

/**
 * A bound secret as a Run's snapshot records it at admission: a secret bound to the hosts it may be
 * sent to, or a database with the address its Tasks reach and whether they get its read-only login.
 */
export type SecretBinding =
  | { key: string; hosts: string[]; swapIn: SecretSwapPart[] }
  | { key: string; database: { host: string; port: number; readOnly: boolean } };

/**
 * The entries a Run of one Project receives, from `entries` in any order: each key's entry, the
 * Project's own in place of the Organization's.
 */
export const effectiveEntries = <Entry extends { key: string; projectId: string | null }>(
  entries: readonly Entry[],
) => [
  ...new Map(
    [...entries]
      .sort((left, right) => Number(left.projectId !== null) - Number(right.projectId !== null))
      .map((entry) => [entry.key, entry]),
  ).values(),
];

/**
 * The bound secrets a Run of one Project receives from `entries`, each with its binding. A
 * database's Tasks get its read-only login when the entry or the Run's Blueprint Version
 * (`databaseReadOnly`) asks for it.
 */
export const boundSecrets = <
  Entry extends {
    key: string;
    projectId: string | null;
    kind: string;
    hosts: string[] | null;
    swapIn: SecretSwapPart[] | null;
    database: DatabaseEntry | null;
  },
>(
  entries: readonly Entry[],
  databaseReadOnly: boolean,
) =>
  effectiveEntries(entries).flatMap((entry): { entry: Entry; binding: SecretBinding }[] => {
    const { key, kind, hosts, swapIn, database } = entry;
    if (kind !== "secret") return [];
    if (database)
      return [
        {
          entry,
          binding: {
            key,
            database: {
              host: database.host,
              port: database.port,
              readOnly: database.readOnly || databaseReadOnly,
            },
          },
        },
      ];
    return hosts && swapIn ? [{ entry, binding: { key, hosts, swapIn } }] : [];
  });

/** The bindings of the bound secrets a Run of one Project receives from `entries`. */
export const secretBindings = (
  entries: Parameters<typeof boundSecrets>[0],
  databaseReadOnly: boolean,
) => boundSecrets(entries, databaseReadOnly).map(({ binding }) => binding);

/** A key whose binding changed, how, and whether it is a database's. */
type SecretBindingChange = {
  key: string;
  change: "bound" | "unbound" | "rebound";
  database: boolean;
};

/** `binding` as one string, the same for hosts and swap parts in any order. */
const bindingText = (binding: SecretBinding) =>
  "database" in binding
    ? JSON.stringify([
        "database",
        binding.database.host,
        binding.database.port,
        binding.database.readOnly,
      ])
    : JSON.stringify([[...binding.hosts].sort(), [...binding.swapIn].sort()]);

/**
 * The keys, sorted, whose binding differs between `recorded` and `live`, and how: `bound` since,
 * `unbound` since, or `rebound` to other hosts or parts, or another database address or read-only
 * setting. Work keeps the bindings it was admitted with, so a Run refuses its next Task when any
 * key changed.
 */
export const changedSecretBindings = (
  recorded: readonly SecretBinding[],
  live: readonly SecretBinding[],
): SecretBindingChange[] => {
  const byKey = (bindings: readonly SecretBinding[]) =>
    new Map(bindings.map((binding) => [binding.key, binding]));
  const before = byKey(recorded);
  const after = byKey(live);
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((key) => {
    const old = before.get(key);
    const current = after.get(key);
    if (old && current && bindingText(old) === bindingText(current)) return [];
    const binding = current ?? old;
    return [
      {
        key,
        change: !old ? "bound" : !current ? "unbound" : "rebound",
        database: binding !== undefined && "database" in binding,
      },
    ];
  });
};

const changePhrase = ({ key, change, database }: SecretBindingChange) => {
  if (change === "bound")
    return database ? `${key} was connected as a database` : `${key} was bound to hosts`;
  if (change === "unbound")
    return database
      ? `${key} is no longer connected as a database`
      : `${key} is no longer bound to its hosts`;
  return database
    ? `the database host, port or read-only setting of ${key} changed`
    : `the hosts or request parts of ${key} changed`;
};

/** Why started work can't go on after `changes`, as `changedSecretBindings` names them. */
export const secretBindingChangeMessage = (
  changes: readonly [SecretBindingChange, ...SecretBindingChange[]],
) =>
  `Since this work started, ${listFormat.format(changes.map(changePhrase))}, so devboxes won't give the Run its environment. Start the work again.`;
