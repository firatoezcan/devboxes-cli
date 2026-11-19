import { statSync } from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import Type, { type Static } from "typebox";
import Value from "typebox/value";

import { writeSecretFile } from "../secret-file";

export type DevboxesCliOptions = {
  config?: string;
  api?: string;
};

export type DevboxesContext = {
  config: ConfigFile;
  configPath: string;
};

const ConfigFileSchema = Type.Object({
  apiBaseUrl: Type.Optional(Type.String({ minLength: 1 })),
  sessionToken: Type.Optional(Type.String({ minLength: 1 })),
  cookieJar: Type.Optional(Type.String({ minLength: 1 })),
});

type ConfigFile = Static<typeof ConfigFileSchema>;

const windowsApplicationDataHome = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");

export const platformConfigHome = () => {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  if (process.platform === "win32") return windowsApplicationDataHome;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return join(homedir(), ".config");
};

const defaultConfigPath = () => join(platformConfigHome(), "devboxes", "config.json");

export const writeConfig = async ({ configPath, config }: DevboxesContext) => {
  await writeSecretFile({
    path: configPath,
    contents: `${JSON.stringify(config, null, 2)}\n`,
    tmpPrefix: ".config.",
  });
  if (configPath === defaultConfigPath()) {
    await chmod(dirname(configPath), 0o700);
  }
};

export const loadContext = async (
  options: Pick<DevboxesCliOptions, "config">,
): Promise<DevboxesContext> => {
  const configPath = options.config ?? defaultConfigPath();
  let fileConfig: ConfigFile = {};
  if (statSync(configPath, { throwIfNoEntry: false })) {
    const rawConfigText = await readFile(configPath, "utf8");
    if (options.config === undefined) {
      await chmod(dirname(configPath), 0o700);
      await chmod(configPath, 0o600);
    }
    fileConfig = Value.Parse(ConfigFileSchema, JSON.parse(rawConfigText));
  }
  const { apiBaseUrl, sessionToken, cookieJar } = fileConfig;
  return { configPath, config: { apiBaseUrl, sessionToken, cookieJar } };
};
