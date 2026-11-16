/**
 * Live reachability for configured SSH hosts.
 *
 * The SSH tools open a connection only for the duration of a call, so there is
 * no persistent session list to display. This module probes the configured
 * endpoint instead: DNS resolution followed by a TCP connection to the SSH
 * port. It never authenticates, so it cannot trigger auto-key, read a private
 * key, or write known_hosts.
 */

import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import * as net from "node:net";
import { performance } from "node:perf_hooks";

import { styled, type AnsiStyle } from "./ansi.ts";
import { formatMemory } from "./host-metrics.ts";
import type { HostResourceState, HostResources, SshProfile } from "./types.ts";

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

export type HostState =
  | "checking"
  | "up"
  | "timeout"
  | "refused"
  | "dns-error"
  | "unreachable"
  | "invalid"
  | "error";

export interface HostStatus {
  readonly name: string;
  readonly profile: SshProfile;
  readonly state: HostState;
  readonly address?: string;
  readonly latencyMs?: number;
  readonly detail?: string;
  /** CPU and memory readings, when an authenticated sample succeeded. */
  readonly resources?: HostResources;
  readonly resourceState?: HostResourceState;
  readonly resourceError?: string;
}

export interface ProbeOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function abortedError(): Error {
  const error = new Error("Connection probe aborted.");
  error.name = "AbortError";
  (error as Error & { code?: string }).code = "ABORT_ERR";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error
    && (error.name === "AbortError" || (error as Error & { code?: string }).code === "ABORT_ERR")
  );
}

/** Keep a value safe for one line of terminal output. */
export function displayValue(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Describe authentication without revealing a key path or anything secret. */
export function describeAuthMethod(profile: SshProfile): string {
  const methods: string[] = [];
  if (displayValue(profile.privateKeyPath)) methods.push("key");
  if (profile.password) methods.push("password");
  return methods.length > 0 ? methods.join("+") : "none";
}

export function classifyProbeError(error: unknown): HostState {
  const code = displayValue((error as { code?: unknown } | undefined)?.code);
  if (code === "ETIMEDOUT") return "timeout";
  if (code === "ECONNREFUSED") return "refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_FAIL") return "dns-error";
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH") return "unreachable";
  return "error";
}

function isValidProfile(profile: SshProfile): boolean {
  return Boolean(
    displayValue(profile.host)
    && displayValue(profile.user)
    && Number.isInteger(profile.port)
    && profile.port >= 1
    && profile.port <= 65_535
  );
}

function formatHostPort(host: string, port: number | "?"): string {
  return net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

function connectTcp(
  address: string,
  port: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  if (signal?.aborted) return Promise.reject(abortedError());

  return new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = net.createConnection({ host: address, port });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      resolve(performance.now() - started);
    };

    const onAbort = () => fail(abortedError());

    timer = setTimeout(() => {
      const error = new Error("TCP connection timed out.");
      (error as Error & { code?: string }).code = "ETIMEDOUT";
      fail(error);
    }, timeoutMs);
    timer.unref?.();

    socket.once("connect", succeed);
    socket.once("error", fail);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Probe one configured endpoint without authenticating. */
export async function probeHost(
  name: string,
  profile: SshProfile,
  options: ProbeOptions = {},
): Promise<HostStatus> {
  if (options.signal?.aborted) throw abortedError();

  if (!isValidProfile(profile)) {
    return { name, profile, state: "invalid", detail: "host, user or port" };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const dnsStarted = performance.now();
  let addresses: LookupAddress[];

  try {
    addresses = await lookup(profile.host, { all: true, verbatim: true });
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) throw abortedError();
    return {
      name,
      profile,
      state: "dns-error",
      detail: displayValue((error as { code?: unknown }).code) || "lookup failed",
    };
  }

  const dnsMs = performance.now() - dnsStarted;
  if (addresses.length === 0) {
    return { name, profile, state: "dns-error", detail: "no address" };
  }

  let lastError: unknown;
  for (const address of addresses) {
    try {
      const tcpMs = await connectTcp(address.address, profile.port, timeoutMs, options.signal);
      return {
        name,
        profile,
        state: "up",
        address: address.address,
        latencyMs: dnsMs + tcpMs,
      };
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw abortedError();
      lastError = error;
    }
  }

  return {
    name,
    profile,
    state: classifyProbeError(lastError),
    detail: displayValue((lastError as { code?: unknown } | undefined)?.code) || undefined,
  };
}

/** Probe every profile in the order it appears in the config file. */
export async function probeHosts(
  profiles: Readonly<Record<string, SshProfile>>,
  options: ProbeOptions = {},
): Promise<HostStatus[]> {
  return Promise.all(
    Object.entries(profiles).map(([name, profile]) => probeHost(name, profile, options)),
  );
}

export function initialHostStatuses(
  profiles: Readonly<Record<string, SshProfile>>,
): HostStatus[] {
  return Object.entries(profiles).map(([name, profile]) => ({
    name,
    profile,
    state: "checking" as const,
    resourceState: "loading" as const,
  }));
}

/**
 * Keep an earlier result for a host with the same name while a new probe runs.
 * A new or renamed profile starts as checking.
 */
export function reconcileHostStatuses(
  profiles: Readonly<Record<string, SshProfile>>,
  previous: ReadonlyArray<HostStatus>,
): HostStatus[] {
  const byName = new Map(previous.map((status) => [status.name, status]));
  return Object.entries(profiles).map(([name, profile]) => {
    const earlier = byName.get(name);
    const sameEndpoint = earlier
      && earlier.profile.host === profile.host
      && earlier.profile.port === profile.port
      && earlier.profile.user === profile.user;
    return sameEndpoint
      ? { ...earlier, profile }
      : { name, profile, state: "checking" as const, resourceState: "loading" as const };
  });
}

/** Keep a resource reading across a TCP recheck of the same endpoint. */
export function mergeHostResources(
  next: ReadonlyArray<HostStatus>,
  previous: ReadonlyArray<HostStatus>,
): HostStatus[] {
  const byName = new Map(previous.map((status) => [status.name, status]));
  return next.map((status) => {
    const earlier = byName.get(status.name);
    const sameEndpoint = earlier
      && earlier.profile.host === status.profile.host
      && earlier.profile.port === status.profile.port
      && earlier.profile.user === status.profile.user;
    if (!earlier || !sameEndpoint || status.state !== "up") {
      return { ...status, resourceState: "loading" as const };
    }
    return {
      ...status,
      resources: earlier.resources,
      resourceState: earlier.resourceState ?? "loading",
      resourceError: earlier.resourceError,
    };
  });
}

export function formatCheckedAt(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatLatency(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "?";
  if (milliseconds < 1) return "<1 ms";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(Math.round(milliseconds / 100) / 10).toFixed(1)} s`;
}

function stateLabel(status: HostStatus): string {
  switch (status.state) {
    case "checking":
      return "checking";
    case "up":
      return `up ${formatLatency(status.latencyMs ?? Number.NaN)}`;
    case "timeout":
      return "timeout";
    case "refused":
      return "refused";
    case "dns-error":
      return "dns failed";
    case "unreachable":
      return "unreachable";
    case "invalid":
      return "invalid config";
    case "error":
      return status.detail ? `error ${status.detail}` : "error";
  }
}

interface HostRow {
  readonly status: HostStatus;
  readonly name: string;
  readonly endpoint: string;
  readonly health: string;
  readonly auth: string;
  readonly hostKeyOff: boolean;
  readonly active: boolean;
}

interface RowWidths {
  readonly name: number;
  readonly endpoint: number;
  readonly health: number;
}

function hostRow(status: HostStatus, activeProfile: string | null): HostRow {
  const profile = status.profile;
  const name = displayValue(status.name) || "(unnamed)";
  const user = displayValue(profile.user) || "?";
  const host = displayValue(profile.host) || "?";
  const port = Number.isInteger(profile.port) ? profile.port : "?";
  const resolved = status.address && status.address !== host
    ? ` (${displayValue(status.address)})`
    : "";
  return {
    status,
    name,
    endpoint: `${user}@${formatHostPort(host, port)}${resolved}`,
    health: stateLabel(status),
    auth: describeAuthMethod(profile),
    hostKeyOff: profile.strictHostKey === false,
    active: status.name === activeProfile,
  };
}

function healthStyle(status: HostStatus): AnsiStyle {
  if (status.state === "up") return "green";
  if (status.state === "checking") return "yellow";
  return "red";
}

function healthDot(status: HostStatus): string {
  if (status.state === "up") return "●";
  if (status.state === "checking") return "◌";
  return "○";
}

function rowWidths(rows: ReadonlyArray<HostRow>): RowWidths {
  return {
    name: Math.max(...rows.map((row) => row.name.length)),
    endpoint: Math.max(...rows.map((row) => row.endpoint.length)),
    health: Math.max(...rows.map((row) => row.health.length)),
  };
}

function resourcePercentStyle(percent: number): AnsiStyle {
  if (percent >= 90) return "red";
  if (percent >= 70) return "yellow";
  return "green";
}

interface ResourceLines {
  readonly plain: string;
  readonly styled: string;
}

function resourceLines(status: HostStatus): ResourceLines | null {
  if (status.state !== "up" || status.resourceState === undefined) return null;

  const indent = "    ";
  if (status.resourceState === "loading") {
    return {
      plain: `${indent}CPU/memory checking...`,
      styled: `${indent}${styled("CPU/memory checking...", "dim")}`,
    };
  }
  if (status.resourceState === "error" || !status.resources) {
    const detail = status.resourceError ? `: ${status.resourceError}` : "";
    return {
      plain: `${indent}metrics unavailable${detail}`,
      styled: `${indent}${styled(`metrics unavailable${detail}`, "yellow")}`,
    };
  }

  const resources = status.resources;
  const threads = `${resources.cpuThreads} ${resources.cpuThreads === 1 ? "thread" : "threads"}`;
  const memory = `${formatMemory(resources.memoryTotalBytes)} RAM`;
  const cpu = `CPU ${resources.cpuPercent}%`;
  const usedMemory = `MEM ${resources.memoryUsedPercent}%`;
  return {
    plain: `${indent}${threads} · ${memory} · ${cpu} · ${usedMemory}`,
    styled: `${indent}${styled(threads, "dim")} ${styled("·", "dim")} ${styled(memory, "dim")} ${styled("·", "dim")} ${styled(cpu, resourcePercentStyle(resources.cpuPercent))} ${styled("·", "dim")} ${styled(usedMemory, resourcePercentStyle(resources.memoryUsedPercent))}`,
  };
}

function plainHostRow(row: HostRow, widths: RowWidths): string {
  const marker = row.active ? "▸" : " ";
  const auth = row.hostKeyOff ? `${row.auth}  hostkey off` : row.auth;
  return `${healthDot(row.status)} ${marker} ${row.name.padEnd(widths.name)}  ${row.endpoint.padEnd(widths.endpoint)}  ${row.health.padEnd(widths.health)}  ${auth}`.trimEnd();
}

function styledHostRow(row: HostRow, widths: RowWidths): string {
  const color = healthStyle(row.status);
  const marker = row.active ? styled("▸", "bold", "cyan") : " ";
  const name = row.active ? styled(row.name, "bold", "cyan") : row.name;
  const nameCell = name + " ".repeat(widths.name - row.name.length);
  const health = styled(row.health, color);
  const healthCell = health + " ".repeat(widths.health - row.health.length);
  const auth = styled(row.auth, "dim");
  const warning = row.hostKeyOff ? `  ${styled("hostkey off", "yellow")}` : "";
  return `${styled(healthDot(row.status), "bold", color)} ${marker} ${nameCell}  ${row.endpoint.padEnd(widths.endpoint)}  ${healthCell}  ${auth}${warning}`.trimEnd();
}

/** A plain row without ANSI, useful for narrow clients and tests. */
export function formatHostLine(status: HostStatus, activeProfile: string | null): string {
  const row = hostRow(status, activeProfile);
  return plainHostRow(row, rowWidths([row]));
}

export function renderHostLines(
  statuses: ReadonlyArray<HostStatus>,
  activeProfile: string | null,
  checkedAt?: string,
): string[] {
  if (statuses.length === 0) return [];

  const rows = statuses.map((status) => hostRow(status, activeProfile));
  const widths = rowWidths(rows);
  const total = rows.length;
  const up = rows.filter((row) => row.status.state === "up").length;
  const checking = rows.filter((row) => row.status.state === "checking").length;
  const failed = total - up - checking;
  const summary = checking === total
    ? "checking..."
    : `${up}/${total} up${checking > 0 ? ` · ${checking} checking` : ""}`;
  const summaryStyle: AnsiStyle = failed > 0 ? "red" : checking > 0 ? "yellow" : "green";
  const active = displayValue(activeProfile) || "none";

  const headerPlain = [
    "SSH",
    `● ${summary}`,
    `active ${active}`,
    checkedAt ? `updated ${checkedAt}` : "",
  ].filter(Boolean).join("  ");
  const header = [
    styled("SSH", "bold"),
    `${styled("●", "bold", summaryStyle)} ${styled(summary, summaryStyle)}`,
    `${styled("active", "dim")} ${styled(active, "bold", "cyan")}`,
    checkedAt ? styled(`updated ${checkedAt}`, "dim") : "",
  ].filter(Boolean).join("  ");

  const plainRows = rows.map((row) => plainHostRow(row, widths));
  const resourceRows = rows.map((row) => resourceLines(row.status));
  const ruleWidth = Math.min(100, Math.max(
    headerPlain.length,
    ...plainRows.map((line) => line.length),
    ...resourceRows.flatMap((line) => line ? [line.plain.length] : []),
  ));
  const body = rows.flatMap((row, index) => {
    const lines = [styledHostRow(row, widths)];
    const resources = resourceRows[index];
    if (resources) lines.push(resources.styled);
    return lines;
  });
  return [
    header,
    styled("─".repeat(ruleWidth), "dim"),
    ...body,
  ];
}