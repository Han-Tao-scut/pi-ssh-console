import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import {
  collectHostResources,
  describeHostMetricsError,
  formatMemory,
  parseHostMetrics,
} from "../src/host-metrics.ts";
import type { SshProfile } from "../src/types.ts";
import { startTestServer } from "./sshd.ts";

describe("resource metrics", () => {
  it("calculates CPU and memory use from two /proc samples", () => {
    const metrics = parseHostMetrics([
      "cpu1_total=1000",
      "cpu1_idle=800",
      "cpu2_total=1100",
      "cpu2_idle=850",
      "mem_total_kb=16000000",
      "mem_available_kb=8000000",
      "threads=8",
    ].join("\n"));

    assert.deepStrictEqual(metrics, {
      cpuThreads: 8,
      cpuPercent: 50,
      memoryTotalBytes: 16_000_000 * 1024,
      memoryUsedBytes: 8_000_000 * 1024,
      memoryUsedPercent: 50,
    });
  });

  it("rejects an unsupported or incomplete reading", () => {
    assert.throws(() => parseHostMetrics("unsupported"), /unsupported/);
    assert.throws(() => parseHostMetrics("cpu1_total=1\nthreads=8"), /missing cpu1_idle/);
    assert.throws(
      () => parseHostMetrics([
        "cpu1_total=1",
        "cpu1_idle=1",
        "cpu2_total=2",
        "cpu2_idle=2",
        "mem_total_kb=0",
        "mem_available_kb=0",
        "threads=8",
      ].join("\n")),
      /no total memory/,
    );
  });

  it("formats total memory at useful scales", () => {
    assert.strictEqual(formatMemory(16 * 1024 ** 3), "16 GiB");
    assert.strictEqual(formatMemory(15.5 * 1024 ** 3), "15.5 GiB");
    assert.strictEqual(formatMemory(512 * 1024 ** 2), "512 MiB");
  });

  it("turns connection failures into short UI labels", () => {
    assert.strictEqual(describeHostMetricsError(new Error("metrics timeout")), "timeout");
    assert.strictEqual(describeHostMetricsError(new Error("unsupported: no /proc")), "unsupported");
    assert.strictEqual(describeHostMetricsError(new Error("random failure")), "unavailable");
  });

  it("reads a real Linux host over SSH", async (t) => {
    if (process.platform !== "linux") return t.skip("Linux-only /proc metrics");
    const server = await startTestServer();
    if (!server) return t.skip("no sshd on this machine");
    try {
      const profile: SshProfile = {
        host: "127.0.0.1",
        port: server.port,
        user: server.user,
        privateKeyPath: server.clientKeyPath,
        knownHostsFile: path.join(server.dir, "known_hosts"),
        strictHostKey: false,
      };
      const metrics = await collectHostResources(profile, { timeoutMs: 10_000 });
      assert.ok(metrics.cpuThreads >= 1);
      assert.ok(metrics.cpuPercent >= 0 && metrics.cpuPercent <= 100);
      assert.ok(metrics.memoryTotalBytes > 0);
      assert.ok(metrics.memoryUsedPercent >= 0 && metrics.memoryUsedPercent <= 100);
    } finally {
      server.stop();
    }
  });
});