/**
 * pi SSH Extension
 *
 * Runs commands and moves files on remote hosts over SSH, and can turn a
 * password login into a key login without any external tooling.
 *
 * Tools:
 *   - ssh_setup: Store a host, user and credentials
 *   - ssh_status: List configured hosts, optionally testing a connection
 *   - ssh_profile: List, switch or delete hosts
 *   - ssh_exec: Run a command and return its output and exit code
 *   - ssh_list: List a remote directory over SFTP
 *   - ssh_upload: Copy a file to the remote host
 *   - ssh_download: Copy a file from the remote host
 *   - ssh_keygen: Create an ed25519 key pair in process
 *   - ssh_authorize: Install a key on a host and stop needing the password
 *   - ssh_doctor: Report what the environment can do and what needs fixing
 *   - ssh_tunnel: Open, close and list port forwards, and store named ones
 *
 * Nothing here shells out: ssh2 is a pure JavaScript SSH implementation and
 * keys are generated with Node's own crypto, so Windows, macOS and Linux all
 * work without ssh, ssh-keygen or ssh-copy-id being installed.
 *
 * Data-oriented design:
 *   - All domain data is represented as plain immutable interfaces (types.ts)
 *   - I/O is isolated in the client module (clients/)
 *   - Pure helpers have no sockets in them (keys.ts, known-hosts.ts, formatting/)
 *   - Each tool is a single-responsibility module (tools/)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getActiveProfile, getConfig, getProfiles, loadConfig } from "./src/config.ts";
import { SshSetupTool } from "./src/tools/ssh-setup.ts";
import { SshStatusTool } from "./src/tools/ssh-status.ts";
import { SshProfileTool } from "./src/tools/ssh-profile.ts";
import { SshExecTool } from "./src/tools/ssh-exec.ts";
import { SshListTool } from "./src/tools/ssh-list.ts";
import { SshUploadTool } from "./src/tools/ssh-upload.ts";
import { SshDownloadTool } from "./src/tools/ssh-download.ts";
import { SshKeygenTool } from "./src/tools/ssh-keygen.ts";
import { SshAuthorizeTool } from "./src/tools/ssh-authorize.ts";
import { SshDoctorTool } from "./src/tools/ssh-doctor.ts";
import { SshTunnelTool } from "./src/tools/ssh-tunnel.ts";
import { listTunnels, onTunnelsChanged, stopAllTunnels } from "./src/tunnels.ts";
import { createSshIndicator } from "./src/ui.ts";
import {
  formatCheckedAt,
  initialHostStatuses,
  isAbortError,
  mergeHostResources,
  probeHosts,
  reconcileHostStatuses,
  type HostStatus,
} from "./src/host-status.ts";
import {
  collectHostResources,
  describeHostMetricsError,
  isPermanentHostMetricsError,
} from "./src/host-metrics.ts";

const HOST_REFRESH_INTERVAL_MS = 30_000;
const TOOL_REFRESH_DELAY_MS = 300;

export default function (pi: ExtensionAPI) {
  // Load saved hosts on startup
  loadConfig();

  // Register all tools
  pi.registerTool(SshSetupTool);
  pi.registerTool(SshStatusTool);
  pi.registerTool(SshProfileTool);
  pi.registerTool(SshExecTool);
  pi.registerTool(SshListTool);
  pi.registerTool(SshUploadTool);
  pi.registerTool(SshDownloadTool);
  pi.registerTool(SshKeygenTool);
  pi.registerTool(SshAuthorizeTool);
  pi.registerTool(SshDoctorTool);
  pi.registerTool(SshTunnelTool);

  // The context carrying the interface only arrives with an event, so the
  // indicator is wired up on session_start and refreshed whenever a tunnel or
  // a host profile changes.
  let showSsh: ReturnType<typeof createSshIndicator> | null = null;
  let tunnels = listTunnels();
  let hosts: HostStatus[] = initialHostStatuses(getProfiles());
  let checkedAt: string | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let toolRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let probeAbort: AbortController | null = null;
  let metricsAbort: AbortController | null = null;
  let refreshing = false;
  let refreshAgain = false;
  let refreshingMetrics = false;
  let refreshMetricsAgain = false;

  function render(): void {
    showSsh?.({
      hosts,
      activeProfile: getActiveProfile(),
      tunnels,
      checkedAt,
    });
  }

  async function performRefresh(): Promise<void> {
    if (!showSsh) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }

    refreshing = true;
    try {
      do {
        refreshAgain = false;
        const profiles = getProfiles();
        hosts = reconcileHostStatuses(profiles, hosts);
        render();

        const controller = new AbortController();
        probeAbort = controller;
        try {
          const next = await probeHosts(profiles, { signal: controller.signal });
          if (controller.signal.aborted) return;
          hosts = mergeHostResources(next, hosts);
          checkedAt = formatCheckedAt(new Date());
        } finally {
          if (probeAbort === controller) probeAbort = null;
        }
        render();
        void refreshResources();
      } while (refreshAgain);
    } catch (error) {
      if (!isAbortError(error)) {
        const profiles = getProfiles();
        hosts = reconcileHostStatuses(profiles, hosts).map((host) => ({
          ...host,
          state: "error" as const,
          detail: "probe failed",
        }));
        checkedAt = formatCheckedAt(new Date());
        render();
      }
    } finally {
      refreshing = false;
    }
  }

  function refreshHosts(): void {
    void performRefresh();
  }

  /**
   * Resource sampling is a second SSH session, so it gets its own aborts and
   * never uses resolveForConnection: a passive refresh must not auto-upgrade
   * credentials or trust a new host key.
   */
  async function refreshResources(): Promise<void> {
    if (!showSsh) return;
    if (refreshingMetrics) {
      refreshMetricsAgain = true;
      return;
    }

    refreshingMetrics = true;
    try {
      do {
        refreshMetricsAgain = false;
        const profiles = getProfiles();
        const candidates = hosts.flatMap((host) => {
          if (host.state !== "up") return [];
          if (
            host.resourceState === "error"
            && host.resourceError
            && isPermanentHostMetricsError(host.resourceError)
          ) return [];
          const profile = profiles[host.name];
          return profile ? [{ name: host.name, profile }] : [];
        });
        if (candidates.length === 0) return;

        const candidateNames = new Set(candidates.map((candidate) => candidate.name));
        hosts = hosts.map((host) => (
          candidateNames.has(host.name) && host.resourceState !== "ready"
            ? { ...host, resourceState: "loading" as const, resourceError: undefined }
            : host
        ));
        render();

        const controller = new AbortController();
        metricsAbort = controller;
        let results: Array<
          | { name: string; resources: Awaited<ReturnType<typeof collectHostResources>> }
          | { name: string; error: string }
          | { name: string; aborted: true }
        >;
        try {
          results = await Promise.all(candidates.map(async (candidate) => {
            try {
              const resources = await collectHostResources(candidate.profile, {
                signal: controller.signal,
              });
              return { name: candidate.name, resources };
            } catch (error) {
              if (isAbortError(error) || controller.signal.aborted) {
                return { name: candidate.name, aborted: true as const };
              }
              return {
                name: candidate.name,
                error: describeHostMetricsError(error),
              };
            }
          }));
        } finally {
          if (metricsAbort === controller) metricsAbort = null;
        }

        if (controller.signal.aborted) return;
        const byName = new Map(results.map((result) => [result.name, result]));
        hosts = hosts.map((host) => {
          const result = byName.get(host.name);
          if (!result || "aborted" in result) return host;
          if ("resources" in result) {
            return {
              ...host,
              resources: result.resources,
              resourceState: "ready" as const,
              resourceError: undefined,
            };
          }
          return {
            ...host,
            resourceState: "error" as const,
            resourceError: result.error,
          };
        });
        render();
      } while (refreshMetricsAgain);
    } finally {
      refreshingMetrics = false;
    }
  }

  function clearPermanentResourceErrors(): void {
    hosts = hosts.map((host) => (
      host.resourceState === "error"
      && host.resourceError
      && isPermanentHostMetricsError(host.resourceError)
        ? { ...host, resourceState: "loading" as const, resourceError: undefined }
        : host
    ));
  }

  function scheduleRefresh(): void {
    if (!showSsh) return;
    if (toolRefreshTimer) clearTimeout(toolRefreshTimer);
    toolRefreshTimer = setTimeout(() => {
      toolRefreshTimer = null;
      clearPermanentResourceErrors();
      refreshHosts();
    }, TOOL_REFRESH_DELAY_MS);
    toolRefreshTimer.unref?.();
  }

  const unsubscribeTunnels = onTunnelsChanged((next) => {
    tunnels = next;
    render();
  });

  // A tunnel is the one thing here that outlives its tool call, so it must
  // not outlive the session that opened it.
  pi.on("session_shutdown", async () => {
    if (refreshTimer) clearInterval(refreshTimer);
    if (toolRefreshTimer) clearTimeout(toolRefreshTimer);
    refreshTimer = null;
    toolRefreshTimer = null;
    probeAbort?.abort();
    probeAbort = null;
    metricsAbort?.abort();
    metricsAbort = null;
    refreshingMetrics = false;
    refreshMetricsAgain = false;
    unsubscribeTunnels();
    showSsh?.({ hosts: [], activeProfile: null, tunnels: [], checkedAt: undefined });
    showSsh = null;
    await stopAllTunnels();
  });

  pi.on("session_start", async (_event: unknown, ctx: unknown) => {
    const uiCtx = ctx as { hasUI?: boolean; ui?: unknown };
    if (uiCtx.hasUI === false || !uiCtx.ui) {
      showSsh = null;
      return;
    }
    showSsh = createSshIndicator(ctx as never);
    tunnels = listTunnels();
    hosts = initialHostStatuses(getProfiles());
    checkedAt = undefined;
    refreshingMetrics = false;
    refreshMetricsAgain = false;
    render();
    refreshHosts();

    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshHosts, HOST_REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
  });

  // Tool results are the quickest signal that the profile file changed.
  pi.on("tool_result", (event) => {
    if (event.toolName.startsWith("ssh_")) scheduleRefresh();
  });

  // Run something on the active host without spelling out the tool call
  pi.registerCommand("ssh", {
    description: "Run a command on the active SSH host",
    handler: async (args, ctx) => {
      if (!getConfig()) {
        ctx.ui.notify("No SSH host configured. Use the ssh_setup tool first.", "error");
        return;
      }

      const command = args.trim();
      if (!command) {
        ctx.ui.notify("Usage: /ssh <command to run on the remote host>", "info");
        return;
      }

      pi.sendUserMessage(
        `Run this on the active SSH host with ssh_exec and show me the output: ${command}`,
        { deliverAs: "steer" },
      );
      ctx.ui.notify("Running on the remote host...", "info");
    },
  });

  // The one-time setup people forget until they are typing a password again
  pi.registerCommand("ssh-key", {
    description: "Set up passwordless login for the active SSH host",
    handler: async (_args, ctx) => {
      if (!getConfig()) {
        ctx.ui.notify("No SSH host configured. Use the ssh_setup tool first.", "error");
        return;
      }

      pi.sendUserMessage(
        "Use ssh_authorize on the active SSH profile to generate a key, install it on the host and verify that a key-only login works. Tell me the fingerprint and whether the verification succeeded.",
        { deliverAs: "steer" },
      );
      ctx.ui.notify("Setting up key-based login...", "info");
    },
  });
}
