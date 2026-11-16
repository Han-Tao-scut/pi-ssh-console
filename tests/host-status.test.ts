/**
 * Reachability probes and the text they produce.
 *
 * The success and refusal cases run against a real loopback socket. Error
 * classification is tested directly so a firewall or a DNS resolver cannot
 * make the suite flaky.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";

import { stripAnsi } from "../src/ansi.ts";
import {
  classifyProbeError,
  describeAuthMethod,
  displayValue,
  formatCheckedAt,
  formatHostLine,
  formatLatency,
  initialHostStatuses,
  isAbortError,
  mergeHostResources,
  probeHost,
  probeHosts,
  reconcileHostStatuses,
} from "../src/host-status.ts";
import type { SshProfile } from "../src/types.ts";

async function startServer(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: (server.address() as net.AddressInfo).port };
}

async function freePort(): Promise<number> {
  const { server, port } = await startServer();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const profile = (port: number): SshProfile => ({
  host: "127.0.0.1",
  port,
  user: "tester",
  privateKeyPath: "/secret/client-key",
  password: "super-secret",
});

describe("reachability probes", () => {
  it("measures a real TCP connection without authenticating", async () => {
    const { server, port } = await startServer();
    try {
      const status = await probeHost("local", profile(port), { timeoutMs: 1_000 });
      assert.strictEqual(status.state, "up");
      assert.strictEqual(status.address, "127.0.0.1");
      assert.ok((status.latencyMs ?? -1) >= 0);
      assert.strictEqual(status.detail, undefined);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports a closed port as refused", async () => {
    const port = await freePort();
    const status = await probeHost("closed", profile(port), { timeoutMs: 1_000 });
    assert.strictEqual(status.state, "refused");
    assert.strictEqual(status.detail, "ECONNREFUSED");
  });

  it("keeps profile order when probing several hosts", async () => {
    const { server, port } = await startServer();
    const closed = await freePort();
    try {
      const statuses = await probeHosts(
        { first: profile(port), second: profile(closed) },
        { timeoutMs: 1_000 },
      );
      assert.deepStrictEqual(statuses.map((status) => status.name), ["first", "second"]);
      assert.strictEqual(statuses[0].state, "up");
      assert.strictEqual(statuses[1].state, "refused");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects an invalid endpoint before touching the network", async () => {
    const status = await probeHost("broken", { ...profile(0), port: 0 });
    assert.strictEqual(status.state, "invalid");
    assert.match(status.detail ?? "", /host, user or port/);
  });

  it("honours an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      probeHost("local", profile(22), { signal: controller.signal }),
      (error: unknown) => isAbortError(error),
    );
  });
});

describe("error classification", () => {
  it("maps network errors to the labels the UI shows", () => {
    assert.strictEqual(classifyProbeError({ code: "ETIMEDOUT" }), "timeout");
    assert.strictEqual(classifyProbeError({ code: "ECONNREFUSED" }), "refused");
    assert.strictEqual(classifyProbeError({ code: "ENOTFOUND" }), "dns-error");
    assert.strictEqual(classifyProbeError({ code: "EAI_AGAIN" }), "dns-error");
    assert.strictEqual(classifyProbeError({ code: "ENETUNREACH" }), "unreachable");
    assert.strictEqual(classifyProbeError({ code: "ECONNRESET" }), "error");
  });
});

describe("host display", () => {
  it("names authentication methods without exposing the key path", () => {
    assert.strictEqual(describeAuthMethod(profile(22)), "key+password");
    assert.strictEqual(
      describeAuthMethod({ host: "h", port: 22, user: "u", password: "p" }),
      "password",
    );
    assert.strictEqual(
      describeAuthMethod({ host: "h", port: 22, user: "u", privateKeyPath: "/secret" }),
      "key",
    );
    assert.strictEqual(describeAuthMethod({ host: "h", port: 22, user: "u" }), "none");

    const line = formatHostLine(
      {
        name: "host",
        profile: profile(22),
        state: "up",
        address: "127.0.0.1",
        latencyMs: 4.6,
      },
      "host",
    );
    assert.ok(!line.includes("super-secret"));
    assert.ok(!line.includes("/secret/client-key"));
    assert.match(stripAnsi(line), /up 5 ms  key\+password/);
  });

  it("cleans control characters before they reach one line", () => {
    assert.strictEqual(displayValue("a\u0000b\nc\t d"), "a b c d");
    assert.strictEqual(displayValue("\u001b[31mred"), "[31mred");
  });

  it("formats latency at useful scales", () => {
    assert.strictEqual(formatLatency(0.4), "<1 ms");
    assert.strictEqual(formatLatency(12.4), "12 ms");
    assert.strictEqual(formatLatency(1_450), "1.5 s");
    assert.strictEqual(formatLatency(Number.NaN), "?");
  });

  it("formats the check time as HH:MM:SS", () => {
    assert.match(formatCheckedAt(new Date(2026, 0, 2, 3, 4, 5)), /^03:04:05$/);
  });

  it("starts every configured host as checking", () => {
    const statuses = initialHostStatuses({ a: profile(22), b: profile(23) });
    assert.deepStrictEqual(statuses.map((status) => status.name), ["a", "b"]);
    assert.ok(statuses.every((status) => status.state === "checking"));
    assert.ok(statuses.every((status) => status.resourceState === "loading"));
  });

  it("reuses an earlier status while the next probe runs", () => {
    const first = {
      name: "a",
      profile: profile(22),
      state: "up" as const,
      latencyMs: 2,
    };
    const statuses = reconcileHostStatuses({ a: first.profile, b: profile(23) }, [first]);
    assert.strictEqual(statuses[0].state, "up");
    assert.strictEqual(statuses[0].latencyMs, 2);
    assert.strictEqual(statuses[1].state, "checking");
  });

  it("starts checking again when the endpoint changes", () => {
    const first = {
      name: "a",
      profile: profile(22),
      state: "up" as const,
      latencyMs: 2,
    };
    const changed = { ...first.profile, host: "127.0.0.2" };
    const [status] = reconcileHostStatuses({ a: changed }, [first]);
    assert.strictEqual(status.state, "checking");
    assert.strictEqual(status.profile.host, "127.0.0.2");
  });

  it("keeps resource readings across a TCP recheck", () => {
    const resources = {
      cpuThreads: 8,
      cpuPercent: 20,
      memoryTotalBytes: 16 * 1024 ** 3,
      memoryUsedBytes: 4 * 1024 ** 3,
      memoryUsedPercent: 25,
    };
    const measured = {
      name: "a",
      profile: profile(22),
      state: "up" as const,
      resources,
      resourceState: "ready" as const,
    };
    const [next] = mergeHostResources(
      [{ name: "a", profile: profile(22), state: "up" as const, latencyMs: 3 }],
      [measured],
    );
    assert.deepStrictEqual(next.resources, resources);
    assert.strictEqual(next.resourceState, "ready");
  });

  it("drops resource readings when the host is down", () => {
    const measured = {
      name: "a",
      profile: profile(22),
      state: "up" as const,
      resources: {
        cpuThreads: 8,
        cpuPercent: 20,
        memoryTotalBytes: 16 * 1024 ** 3,
        memoryUsedBytes: 4 * 1024 ** 3,
        memoryUsedPercent: 25,
      },
      resourceState: "ready" as const,
    };
    const [next] = mergeHostResources(
      [{ name: "a", profile: profile(22), state: "timeout" as const }],
      [measured],
    );
    assert.strictEqual(next.resources, undefined);
    assert.strictEqual(next.resourceState, "loading");
  });
});