import { log } from "@clack/prompts";
import { writeConfig, type DevboxesContext } from "@firops/connections/local/config";
import {
  credentialStoreExists,
  readCredentialStore,
} from "@firops/connections/local/credential-store";
import type { LocalCredentialStoreAccess } from "@firops/connections/local/local-provider-auth";
import { decodeOpencodeConnectorCatalog } from "@firops/connections/provider-connect/descriptor-schema";

import { apiRequestError, bearerBackend, cliVersion } from "../api";

const runnerRuntime = "docker";

export const runnerNativePlatform = `${process.platform}/${process.arch}`;

export const runnerSupportedPlatforms = [process.arch === "arm64" ? "linux/arm64" : "linux/amd64"];

export const registerMachine = async (
  context: DevboxesContext,
  credential: string,
  organizationId: string | undefined,
) => {
  const backend = bearerBackend(context.config.apiBaseUrl, credential);
  const result = await backend.api.internal["runner-machines"].register.post({
    organizationId,
    machineId: context.config.machineId,
    name: context.config.name ?? `${runnerRuntime}-${runnerNativePlatform}`,
    runtime: runnerRuntime,
    nativePlatform: runnerNativePlatform,
    supportedPlatforms: runnerSupportedPlatforms,
    listenerVersion: cliVersion,
  });
  if (result.error) {
    throw apiRequestError("Runner registration", result.error, "connect");
  }
  const registered = result.data;
  if (!registered?.machine) {
    throw new Error("Runner registration returned no machine.");
  }
  const registeredMachine = registered.machine;
  context.config.organizationId = registeredMachine.organizationId;
  context.config.machineId = registeredMachine.id;
  if (registered.apiKey) context.config.apiKey = registered.apiKey;
  await writeConfig(context);
  return { ...registered, machine: registeredMachine };
};

export const machineApiBackend = (context: DevboxesContext) => {
  const apiKey = context.config.apiKey;
  if (!apiKey) {
    throw new Error("This command requires a registered runner. Run `devboxes connect` first.");
  }
  return bearerBackend(context.config.apiBaseUrl, apiKey);
};

export const credentialStoreAccess = async (
  context: DevboxesContext,
): Promise<LocalCredentialStoreAccess> => {
  const result =
    await machineApiBackend(context).api.internal["runner-machines"][
      "credential-store-passphrase"
    ].get();
  if (result.error) throw apiRequestError("Credential store passphrase", result.error, "connect");
  if (!result.data) throw new Error("Credential store passphrase was not returned.");
  return { configPath: context.configPath, passphrase: result.data.passphrase };
};

export const openCredentialStoreIfPresent = async (context: DevboxesContext) => {
  if (!(await credentialStoreExists(context.configPath))) return undefined;
  const access = await credentialStoreAccess(context);
  return {
    access,
    store: await readCredentialStore(access),
  };
};

export const fetchOpencodeConnectors = async (context: DevboxesContext) => {
  const result = await machineApiBackend(context).api.internal["runner-machines"].connectors.get();
  if (result.error) throw apiRequestError("Connector catalog", result.error, "connect");
  const { connectors, unknownProviderIds } = decodeOpencodeConnectorCatalog(
    result.data?.connectors ?? [],
  );
  if (unknownProviderIds.length > 0) {
    log.warn(
      `This Devboxes version cannot connect ${unknownProviderIds.join(", ")}; install the latest Devboxes CLI to add support.`,
    );
  }
  return connectors;
};
