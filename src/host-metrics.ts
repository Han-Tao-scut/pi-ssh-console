/**
 * CPU and memory readings from a configured host.
 *
 * The reachability indicator uses an unauthenticated TCP probe. Resource
 * numbers need a real SSH command, so this module deliberately uses the
 * ordinary connection path without auto-key: a background refresh must never
 * replace the user's credentials or trust a new host key on its own.
 */

import { execCommand, withConnection } from "./clients/ssh-client.ts";
import type { HostResources, SshProfile } from "./types.ts";
import {
  HostKeyChangedError,
  SshAuthError,
  UnknownHostKeyError,
} from "./types.ts";

const DEFAULT_METRICS_TIMEOUT_MS = 8_000;

/**
 * Two /proc/stat samples one second apart avoid the meaningless first reading
 * after boot. Memory uses MemAvailable when present and falls back to the
 * older free + buffers + cached calculation.
 */
const RESOURCE_COMMAND = [
  "if [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ]; then echo unsupported; exit 0; fi",
  String.raw`awk '/^cpu / { total=$2+$3+$4+$5+$6+$7+$8+$9; idle=$5+$6; printf "cpu1_total=%d\ncpu1_idle=%d\n", total, idle; exit }' /proc/stat`,
  "sleep 1",
  String.raw`awk '/^cpu / { total=$2+$3+$4+$5+$6+$7+$8+$9; idle=$5+$6; printf "cpu2_total=%d\ncpu2_idle=%d\n", total, idle; exit }' /proc/stat`,
  String.raw`awk '/^MemTotal:/ { total=$2 } /^MemAvailable:/ { available=$2 } /^MemFree:/ { free=$2 } /^Buffers:/ { buffers=$2 } /^Cached:/ { cached=$2 } END { if (available == "") available=free+buffers+cached; printf "mem_total_kb=%d\nmem_available_kb=%d\n", total, available }' /proc/meminfo`,
  "(nproc --all 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0) | awk '{ print \"threads=\" $1 }'",
].join("\n");

export interface HostMetricsOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function numberValue(values: ReadonlyMap<string, number>, key: string): number {
  const value = values.get(key);
  if (value === undefined) throw new Error(`Metrics output is missing ${key}.`);
  return value;
}

export function parseHostMetrics(stdout: string): HostResources {
  if (stdout.trim() === "unsupported") {
    throw new Error("unsupported: /proc/stat or /proc/meminfo is unavailable.");
  }

  const values = new Map<string, number>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = Number(line.slice(separator + 1));
    if (Number.isFinite(value)) values.set(key, value);
  }

  const cpuTotal1 = numberValue(values, "cpu1_total");
  const cpuIdle1 = numberValue(values, "cpu1_idle");
  const cpuTotal2 = numberValue(values, "cpu2_total");
  const cpuIdle2 = numberValue(values, "cpu2_idle");
  const totalDelta = cpuTotal2 - cpuTotal1;
  const idleDelta = cpuIdle2 - cpuIdle1;
  const cpuPercent = totalDelta > 0
    ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
    : 0;

  const memoryTotalKb = numberValue(values, "mem_total_kb");
  const memoryAvailableKb = numberValue(values, "mem_available_kb");
  if (memoryTotalKb <= 0) throw new Error("Metrics reported no total memory.");
  const usedKb = Math.max(0, memoryTotalKb - memoryAvailableKb);
  const cpuThreads = numberValue(values, "threads");
  if (cpuThreads <= 0) throw new Error("Metrics reported no CPU threads.");

  return {
    cpuThreads: Math.round(cpuThreads),
    cpuPercent: Math.round(cpuPercent),
    memoryTotalBytes: memoryTotalKb * 1024,
    memoryUsedBytes: usedKb * 1024,
    memoryUsedPercent: Math.max(0, Math.min(100, Math.round((usedKb / memoryTotalKb) * 100))),
  };
}

export async function collectHostResources(
  profile: SshProfile,
  options: HostMetricsOptions = {},
): Promise<HostResources> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_METRICS_TIMEOUT_MS;
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);
  timer.unref?.();

  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    return await withConnection(profile, { signal }, async (connection) => {
      const result = await execCommand(connection, RESOURCE_COMMAND, { timeoutMs, signal });
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `Metrics command exited with code ${result.code}.`);
      }
      return parseHostMetrics(result.stdout);
    });
  } catch (error) {
    if (timedOut && !options.signal?.aborted) {
      throw new Error("metrics timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function describeHostMetricsError(error: unknown): string {
  if (error instanceof SshAuthError) return "auth";
  if (error instanceof UnknownHostKeyError || error instanceof HostKeyChangedError) return "host key";
  const message = error instanceof Error ? error.message : String(error);
  if (/unsupported/i.test(message)) return "unsupported";
  if (/timed out|timeout|cancelled|canceled/i.test(message)) return "timeout";
  return "unavailable";
}

/** Permanent labels are not retried on the regular refresh timer. */
export function isPermanentHostMetricsError(label: string): boolean {
  return label === "auth" || label === "host key" || label === "unsupported";
}

export function formatMemory(bytes: number): string {
  const gib = Math.round((bytes / 1024 ** 3) * 10) / 10;
  if (gib >= 1) return `${Number.isInteger(gib) ? gib.toFixed(0) : gib.toFixed(1)} GiB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MiB`;
}