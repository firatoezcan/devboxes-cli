import { setTimeout as sleep } from "node:timers/promises";

import type { DevboxesContext } from "@firops/connections/local/config";
import {
  startCredentialBroker,
  type ActiveOpencodeCredentialTask,
} from "@firops/connections/local/credential-broker";
import { ambiguousOpencodeCredentialMessage } from "@firops/connections/local/credential-store";
import {
  LocalRunnerOpencodeProviderAuthRuntime,
  type LocalOpencodeProviderCredentialReference,
  type LocalProviderCredentialIdentity,
} from "@firops/connections/local/local-provider-auth";
import { taskContainerApiBaseUrl } from "@firops/devbox/runner/docker-socket";
import { runClaimedModelResolution } from "@firops/devbox/runner/model-resolution";
import { restoreTaskCredentials } from "@firops/devbox/runner/restore-task-credentials";
import { listenerUpgradeRequiredCode } from "@firops/platform/protocol/frozen";
import {
  OpencodeLaunchSpecSchema,
  opencodeWorkspaceLaunchProtocol,
} from "@firops/platform/protocol/launch-spec";
import { opencodeProviderAuthFingerprint } from "@firops/platform/protocol/provider-auth";
import { taskContainerName } from "@firops/platform/protocol/task-runtime";
import Value from "typebox/value";

import { ApiRequestError, apiRequestError, bearerBackend, cliUserAgent, cliVersion } from "../api";
import {
  credentialStoreAccess,
  fetchOpencodeConnectors,
  openCredentialStoreIfPresent,
  runnerNativePlatform,
  runnerSupportedPlatforms,
} from "./backend";

type ActiveTask = ActiveOpencodeCredentialTask & {
  containerId: string | null;
  containerName: string | null;
  attemptCount: number;
};

const reportRaceIsBenign = (error: ApiRequestError) =>
  error.status === 409 &&
  (error.code === "task_not_running" || error.code === "task_other_machine");

export const listen = async (context: DevboxesContext, options: { maxConcurrent?: number }) => {
  // The first signal stops the loop gracefully (interrupting any poll/backoff
  // sleep immediately); a second signal force-exits for operators who cannot
  // wait out an in-flight iteration.
  const stop = new AbortController();
  const requestStop = (signal: string) => {
    if (stop.signal.aborted) {
      console.info(`Received ${signal} again; exiting immediately.`);
      process.exit(130);
    }
    console.info(`Received ${signal}; finishing the current iteration...`);
    stop.abort();
  };
  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));
  const stoppableSleep = async (ms: number) => {
    try {
      await sleep(ms, undefined, { signal: stop.signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      throw error;
    }
  };

  const maxConcurrent = options.maxConcurrent ?? 1;
  const activeTasks = new Map<string, ActiveTask>();
  const activeModelResolutions = new Map<string, ActiveOpencodeCredentialTask>();
  console.info(`Devboxes ${cliVersion} starting container runtime...`);
  const { DockerOpencodeTaskRuntime } = await import("@firops/devbox/runner/docker-task-runtime");
  const taskRuntime = new DockerOpencodeTaskRuntime({
    daemonApiBaseUrl: taskContainerApiBaseUrl(context.config.apiBaseUrl),
  });
  const apiKey = context.config.apiKey;
  if (!apiKey) {
    throw new Error("This command requires a registered runner. Run `devboxes connect` first.");
  }
  const backend = bearerBackend(context.config.apiBaseUrl, apiKey);
  const heartbeat = async (localProviderCredentials: LocalProviderCredentialIdentity[]) => {
    const result = await backend.api.internal["runner-machines"].heartbeat.post({
      nativePlatform: runnerNativePlatform,
      supportedPlatforms: runnerSupportedPlatforms,
      listenerVersion: cliVersion,
      localProviderCredentials,
    });
    if (result.error) throw apiRequestError("Heartbeat", result.error, "connect");
    return result.data;
  };
  const openedStore = await openCredentialStoreIfPresent(context).catch((error) => {
    console.error(
      `Device credential store is unavailable for runner claims: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  });
  let providerSnapshotPassphrase = openedStore?.access.passphrase;
  const credentialSnapshotPassphrase = async () => {
    if (!providerSnapshotPassphrase) {
      providerSnapshotPassphrase = (await credentialStoreAccess(context)).passphrase;
    }
    return providerSnapshotPassphrase;
  };
  const configuredCredentials: LocalOpencodeProviderCredentialReference[] = [];
  for (const credential of context.config.opencodeProviderCredentials ?? []) {
    if (credential.providerId === "opencode" && credential.providerIdFormat !== "exact") {
      console.error(
        `Local provider credential opencode is unavailable for runner claims: ${ambiguousOpencodeCredentialMessage}`,
      );
      continue;
    }
    configuredCredentials.push(credential);
  }
  // Provider sources this machine can read from disk are fixed at startup;
  // `devboxes credentials setup` needs a restart to advertise a new source.
  // The credential behind an existing id is read before every claim so replacing
  // an API key with OAuth, or OAuth with an API key, changes the next claim's
  // immutable monetary authority. Org-stored credentials qualify further tasks
  // server-side and those launch against the dashboard route instead.
  const localProviderCredentialIds = new Set([
    ...configuredCredentials.map((credential) => credential.providerId),
    ...Object.keys(openedStore?.store.entries ?? {}),
  ]);
  const credentialRuntime = new LocalRunnerOpencodeProviderAuthRuntime(
    configuredCredentials,
    openedStore?.access,
    () => fetchOpencodeConnectors(context),
  );
  const credentialBroker = startCredentialBroker(activeTasks);
  const modelResolutionCredentialBroker = startCredentialBroker(activeModelResolutions);
  // Claim-time refresh cannot keep an idle subscription token family alive.
  // Sweep at startup for anything that expired while the runner was off, then
  // hourly; the 70-minute window outlasts a full cron period so nothing expires
  // between fires. The sweep shares the claim runtime, so cron and claim refresh
  // single-flight per family.
  const credentialRefreshWindowMs = 70 * 60 * 1000;
  if (openedStore) {
    void credentialRuntime.refreshExpiringStoredCredentials({
      windowMs: credentialRefreshWindowMs,
    });
  }
  const credentialRefreshJob = openedStore
    ? Bun.cron("0 * * * *", () =>
        credentialRuntime.refreshExpiringStoredCredentials({
          windowMs: credentialRefreshWindowMs,
        }),
      ).unref()
    : undefined;
  const runnerProviderSnapshot = async () => {
    const snapshot = await credentialRuntime.snapshotProviderCredentials(
      localProviderCredentialIds,
    );
    for (const providerId of snapshot.unavailableProviderIds) {
      console.error(
        `Local provider credential ${providerId} could not be loaded or refreshed. Run \`devboxes credentials status --live\`, repair this provider, then restart \`devboxes listen\`.`,
      );
    }
    return snapshot;
  };
  let modelResolutionWork: Promise<void> | null = null;
  try {
    console.info("Connecting to Devboxes...");
    let providerSnapshot = await runnerProviderSnapshot();
    await heartbeat(providerSnapshot.localProviderCredentials);

    // A lease refresh here would falsely report task liveness.
    console.info("Reconciling tasks after restart...");
    const leftovers = await taskRuntime.listLeftoverTasks();
    const listingResult = await backend.api.internal["runner-machines"].tasks.get({
      query:
        leftovers.length > 0
          ? { taskIds: leftovers.map((leftover) => leftover.taskId).join(",") }
          : {},
    });
    if (listingResult.error) {
      // Without server truth, deleting local state would be deleting on
      // uncertainty. Keep everything for the next startup.
      console.info(
        `Skipped task reconciliation: ${apiRequestError("Task listing", listingResult.error, "connect")}`,
      );
    } else {
      const listing = listingResult.data;
      const knownTasks = new Map(listing.tasks.map((task) => [task.taskId, task] as const));

      // Re-adopt running tasks assigned to this machine whose container is still
      // alive, so lease refresh and stopRequestedAt handling resume after the
      // restart. A running task whose container is gone can never finish: report
      // it failed and clean up its secrets.
      for (const task of listing.tasks) {
        if (!task.runningOnThisMachine || !task.containerName) continue;
        let state: { Running: boolean } | null;
        try {
          state = await taskRuntime.inspectTask({
            taskId: task.taskId,
            containerId: task.containerId,
            containerName: task.containerName,
          });
        } catch (error) {
          // An inspect failure is not "container gone": do not fail the task on
          // uncertainty. It stays untracked until the next restart or the reaper.
          console.info(`Failed to inspect container for task ${task.taskId}: ${String(error)}`);
          continue;
        }
        if (state?.Running) {
          if (
            !task.modelProviderId ||
            !task.perTaskToken ||
            !task.providerAuthSource ||
            !task.providerCredentialFingerprint
          ) {
            console.info(
              `Skipped re-adopting task ${task.taskId}: provider auth context is absent.`,
            );
            continue;
          }
          let localCredential: { passphrase: string; fingerprint: string } | undefined;
          if (task.providerAuthSource === "local-broker") {
            try {
              localCredential = {
                passphrase: await credentialSnapshotPassphrase(),
                fingerprint: task.providerCredentialFingerprint,
              };
            } catch (error) {
              console.info(
                `Skipped re-adopting task ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
              );
              continue;
            }
          }
          const restored = await restoreTaskCredentials({
            taskRuntime,
            task: {
              organizationId: task.organizationId,
              taskId: task.taskId,
              modelProviderId: task.modelProviderId,
              perTaskToken: task.perTaskToken,
            },
            localCredential,
          });
          if (restored.status === "credential_unavailable") {
            const errorMessage =
              "The claim-captured local provider credential is unavailable after runner restart.";
            await taskRuntime.stopTask({
              taskId: task.taskId,
              organizationId: task.organizationId,
              containerId: task.containerId,
            });
            const reported = await backend.api.internal["runner-machines"]
              .tasks({ taskId: task.taskId })
              .report.post({
                status: "failed",
                errorMessage,
                attemptCount: task.attemptCount,
              });
            if (reported.error) {
              throw apiRequestError("Credential authority report", reported.error, "connect");
            }
            console.info(`Failed task ${task.taskId}: ${errorMessage}`);
            continue;
          }
          if (restored.tokenRefreshError !== null) {
            console.info(
              `Failed to refresh the token file for task ${task.taskId}: ${restored.tokenRefreshError}`,
            );
          }
          activeTasks.set(task.taskId, {
            taskId: task.taskId,
            organizationId: task.organizationId,
            modelProviderId: task.modelProviderId,
            perTaskToken: task.perTaskToken,
            containerId: task.containerId,
            containerName: task.containerName,
            attemptCount: task.attemptCount,
            providerAuth: restored.providerAuth,
          });
          console.info(`Re-adopted running task ${task.taskId}.`);
          continue;
        }
        const containerFate = state
          ? "exited before reporting a final status"
          : "disappeared while the runner was restarting";
        const reported = await backend.api.internal["runner-machines"]
          .tasks({ taskId: task.taskId })
          .report.post({
            status: "failed",
            errorMessage: `Runner container ${containerFate}.`,
            attemptCount: task.attemptCount,
          });
        if (reported.error) {
          const reportError = apiRequestError("Report", reported.error, "connect");
          console.info(
            reportRaceIsBenign(reportError)
              ? `Task ${task.taskId} was already resolved server-side (${reportError.code}); cleaning up its missing container.`
              : `Failed to report missing container for task ${task.taskId}: ${reportError}`,
          );
        }
        await taskRuntime
          .stopTask({
            taskId: task.taskId,
            organizationId: task.organizationId,
            containerId: task.containerId,
          })
          .catch((error) => {
            console.info(`Failed to clean up task ${task.taskId}: ${error}`);
          });
        console.info(`Reported task ${task.taskId} failed: its container ${containerFate}.`);
      }

      // Queued tasks keep their containers: relaunch on this machine reuses the
      // committed container state.
      for (const leftover of leftovers) {
        if (activeTasks.has(leftover.taskId)) continue;
        const known = knownTasks.get(leftover.taskId);
        if (known && (known.status === "queued" || known.runningOnThisMachine)) continue;
        const stopped = await taskRuntime
          .stopTask({
            ...leftover,
            organizationId: known?.organizationId ?? leftover.organizationId,
          })
          .catch((error) => {
            console.info(`Failed to clean up leftover task ${leftover.taskId}: ${error}`);
            return null;
          });
        if (stopped) console.info(`Cleaned up leftover task ${leftover.taskId}.`);
      }
    }

    console.info("Listening for queued tasks.");

    // Transient API failures must never kill the daemon: every iteration's API
    // work is wrapped, failures back off exponentially (bounded), success resets.
    let consecutiveFailures = 0;
    while (!stop.signal.aborted) {
      try {
        await heartbeat(providerSnapshot.localProviderCredentials);

        for (const task of activeTasks.values()) {
          // A daemon that dies before reporting (provider auth unavailable, a
          // crash during boot) leaves a dead container behind a still-leased
          // task; blind lease refreshes would keep it "running" forever, so
          // every iteration checks the container is actually alive.
          if (task.containerId || task.containerName) {
            const state = await taskRuntime
              .inspectTask({
                taskId: task.taskId,
                containerId: task.containerId,
                containerName: task.containerName ?? taskContainerName(task.taskId),
              })
              .catch(() => null);
            if (state && !state.Running) {
              const reported = await backend.api.internal["runner-machines"]
                .tasks({ taskId: task.taskId })
                .report.post({
                  status: "failed",
                  errorMessage: `Runner container exited with code ${state.ExitCode} before reporting a final status.`,
                  attemptCount: task.attemptCount,
                });
              if (reported.error) {
                const reportError = apiRequestError("Report", reported.error, "connect");
                console.info(
                  reportRaceIsBenign(reportError)
                    ? `Task ${task.taskId} was already resolved server-side (${reportError.code}); cleaning up its dead container.`
                    : `Failed to report dead container for task ${task.taskId}: ${reportError}`,
                );
              }
              await taskRuntime.stopTask(task).catch((stopError) => {
                console.info(
                  `Failed to clean up ${task.containerName ?? task.taskId}: ${stopError}`,
                );
              });
              activeTasks.delete(task.taskId);
              console.info(`Task ${task.taskId} exited before reporting; cleaned it up.`);
              continue;
            }
          }

          const leaseResult = await backend.api.internal["runner-machines"]
            .tasks({ taskId: task.taskId })
            .lease.post({});
          if (leaseResult.error) {
            const leaseError = apiRequestError("Lease", leaseResult.error, "connect");
            if (
              leaseError.code !== "task_not_found" &&
              leaseError.code !== "task_other_organization" &&
              leaseError.code !== "task_other_machine"
            ) {
              throw leaseError;
            }
          }
          if (
            leaseResult.error ||
            leaseResult.data.terminal ||
            leaseResult.data.status !== "running"
          ) {
            const reason = leaseResult.error ? "gone or reassigned" : "no longer active";
            const stopped = await taskRuntime.stopTask(task).catch((error) => {
              console.info(`Failed to clean up ${task.containerName ?? task.taskId}: ${error}`);
              return null;
            });
            activeTasks.delete(task.taskId);
            console.info(
              `Task ${task.taskId} is ${reason}${stopped ? "; removed its container and secrets." : "."}`,
            );
            continue;
          }
          const lease = leaseResult.data;
          if (lease.stopRequested) {
            console.info(`Stopping task ${task.taskId}...`);
            const stopped = await taskRuntime.stopTask(task);
            const acked = await backend.api.internal["runner-machines"]
              .tasks({ taskId: task.taskId })
              ["stop-ack"].post({
                stopped: stopped.stopped,
                containerId: stopped.containerId ?? undefined,
                containerName: stopped.containerName,
                errorMessage: lease.stopReason ?? undefined,
              });
            if (acked.error) throw apiRequestError("Stop ack", acked.error, "connect");
            activeTasks.delete(task.taskId);
            console.info(`Stopped task ${task.taskId}.`);
          }
        }

        providerSnapshot = await runnerProviderSnapshot();
        if (!modelResolutionWork) {
          const resolutionClaim = await backend.api.internal["runner-machines"][
            "model-resolutions"
          ].claim.post({
            launchProtocols: [opencodeWorkspaceLaunchProtocol],
          });
          if (resolutionClaim.error) {
            throw apiRequestError("Model resolution claim", resolutionClaim.error, "connect");
          }
          const resolution = resolutionClaim.data;
          if (resolution && resolution !== "No Content") {
            const providerAuth =
              resolution.action === "resolve" && resolution.source === "local-broker"
                ? providerSnapshot.claimProviderAuth.get(resolution.providerId)
                : undefined;
            modelResolutionWork = runClaimedModelResolution({
              resolution,
              apiBaseUrl: context.config.apiBaseUrl,
              apiKey,
              userAgent: cliUserAgent,
              taskRuntime,
              providerAuth,
              activeCredentials: activeModelResolutions,
              providerAuthUrl: modelResolutionCredentialBroker.providerAuthUrl,
              stopSignal: stop.signal,
            }).finally(() => {
              modelResolutionWork = null;
            });
          }
        }

        if (activeTasks.size < maxConcurrent) {
          const claimResult = await backend.api.internal["runner-machines"].claim.post({
            leaseMs: 120_000,
            // The launch-spec protocols this binary executes; a server that
            // serves none of them answers listener_upgrade_required.
            launchProtocols: [opencodeWorkspaceLaunchProtocol],
          });
          if (claimResult.error) throw apiRequestError("Claim", claimResult.error, "connect");
          // An empty queue answers 204, which Eden types as the "No Content" literal.
          const task = claimResult.data;
          if (task && task !== "No Content") {
            console.info(`Claimed task ${task.taskId}; launching on ${task.platform}...`);
            const providerAuth =
              task.launchSpec.providerAuthSource === "local-broker"
                ? providerSnapshot.claimProviderAuth.get(task.modelProviderId)
                : undefined;
            const pinnedAuth = providerAuth?.[task.modelProviderId];
            if (
              task.launchSpec.providerAuthSource === "local-broker" &&
              (!pinnedAuth ||
                (pinnedAuth.type !== "api" && pinnedAuth.type !== "oauth") ||
                opencodeProviderAuthFingerprint(task.modelProviderId, pinnedAuth) !==
                  task.providerCredentialFingerprint)
            ) {
              throw new Error(
                `Claimed task ${task.taskId} did not retain its local credential authority.`,
              );
            }
            if (providerAuth) {
              await taskRuntime.persistProviderAuthSnapshot({
                organizationId: task.organizationId,
                taskId: task.taskId,
                providerId: task.modelProviderId,
                providerAuth,
                passphrase: await credentialSnapshotPassphrase(),
              });
            }
            const activeTask: ActiveTask = {
              taskId: task.taskId,
              organizationId: task.organizationId,
              modelProviderId: task.modelProviderId,
              perTaskToken: task.perTaskToken,
              containerId: null,
              containerName: null,
              attemptCount: task.attemptCount,
              providerAuth,
            };
            activeTasks.set(task.taskId, activeTask);
            const launchLeaseRefresh = setInterval(() => {
              void backend.api.internal["runner-machines"]
                .tasks({ taskId: task.taskId })
                .lease.post({})
                .then((refreshed) => {
                  if (refreshed.error) {
                    console.info(
                      `Failed to refresh launch lease for ${task.taskId}: ${apiRequestError("Lease", refreshed.error, "connect")}`,
                    );
                  }
                })
                .catch((error) => {
                  console.info(`Failed to refresh launch lease for ${task.taskId}: ${error}`);
                });
            }, 30_000);
            try {
              // Eden types are compile-time only: the served spec crosses a
              // real decode boundary here, validated before anything runs.
              const launchSpec = Value.Parse(OpencodeLaunchSpecSchema, task.launchSpec);
              const container = await taskRuntime.launchTask({
                organizationId: task.organizationId,
                taskId: task.taskId,
                runId: task.runId,
                apiKey: task.perTaskToken,
                // The server decided the provider-auth source (it computes the
                // availability union at claim); this machine owns the URLs.
                providerAuthUrl:
                  launchSpec.providerAuthSource === "local-broker"
                    ? credentialBroker.providerAuthUrl
                    : `${taskContainerApiBaseUrl(context.config.apiBaseUrl)}/internal`,
                imageRef: task.imageRef,
                launchSpec,
              });
              activeTask.containerId = container.containerId;
              activeTask.containerName = container.containerName;
              const reported = await backend.api.internal["runner-machines"]
                .tasks({ taskId: task.taskId })
                .report.post({
                  status: "launched",
                  containerId: container.containerId,
                  containerName: container.containerName,
                  attemptCount: task.attemptCount,
                });
              if (reported.error) {
                throw apiRequestError("Launch report", reported.error, "connect");
              }
              console.info(`Launched ${container.containerName}.`);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              activeTasks.delete(task.taskId);
              const stopped = await taskRuntime.stopTask(activeTask).catch((stopError) => {
                console.info(
                  `Failed to clean up ${activeTask.containerName ?? activeTask.taskId}: ${stopError}`,
                );
                return null;
              });
              if (stopped?.stopped) {
                console.info(
                  `Cleaned up ${activeTask.containerName ?? activeTask.taskId} after launch failure.`,
                );
              }
              const failureReport = await backend.api.internal["runner-machines"]
                .tasks({ taskId: task.taskId })
                .report.post({
                  status: "failed",
                  errorMessage: message,
                  attemptCount: task.attemptCount,
                })
                .catch((reportError) => ({ error: reportError }));
              if (failureReport.error) {
                console.info(
                  `Failed to report launch failure for ${task.taskId}: ${JSON.stringify(failureReport.error)}`,
                );
              }
              console.info(`Launch failed for ${task.taskId}: ${message}`);
            } finally {
              clearInterval(launchLeaseRefresh);
            }
          }
        }

        consecutiveFailures = 0;
        await stoppableSleep(10_000);
      } catch (error) {
        // Reserved upgrade lever: when the API someday answers this code,
        // binaries already in the wild stop with the server's message instead
        // of retrying a contract they can no longer speak.
        if (error instanceof ApiRequestError && error.code === listenerUpgradeRequiredCode) {
          // A running CLI can do nothing about being too old except stop
          // deliberately: exit non-zero so process supervisors notice, and
          // leave active containers running — startup reconciliation re-adopts
          // them after the upgrade, exactly like recovering from a crash.
          console.error(error.message);
          if (activeTasks.size > 0) {
            console.info(
              `Leaving ${activeTasks.size} running task container(s) untouched; the upgraded Devboxes CLI re-adopts them on startup.`,
            );
          }
          process.exitCode = 1;
          break;
        }
        consecutiveFailures += 1;
        const backoffMs = Math.min(10_000 * 2 ** Math.min(consecutiveFailures - 1, 5), 300_000);
        console.info(
          `Poll failed (${consecutiveFailures} in a row, retrying in ${Math.round(
            backoffMs / 1000,
          )}s): ${String(error)}`,
        );
        await stoppableSleep(backoffMs);
      }
    }
  } finally {
    if (modelResolutionWork) await modelResolutionWork;
    credentialRefreshJob?.stop();
    await credentialBroker.close();
    await modelResolutionCredentialBroker.close();
  }
};
