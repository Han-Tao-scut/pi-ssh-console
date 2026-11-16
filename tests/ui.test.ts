/**
 * Keeping open tunnels on screen.
 *
 * The display has to survive the two things that make it useful: an interface
 * that does not exist (rpc, json and print modes, or an older pi without
 * these methods), and a tunnel closing, which must clear the surface rather
 * than leave a stale entry claiming a forward is still open.
 */
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { stripAnsi } from "../src/ansi.ts";
import {
  createSshIndicator,
  renderSshLines,
  renderSshStatus,
  renderTunnelLines,
  renderTunnelStatus,
} from "../src/ui.ts";
import { renderHostLines } from "../src/host-status.ts";
import type { HostStatus } from "../src/host-status.ts";
import {
  _clearListeners,
  onTunnelsChanged,
  startTunnel,
  stopAllTunnels,
  stopTunnel,
} from "../src/tunnels.ts";
import type { RunningTunnel, SshProfile } from "../src/types.ts";
import { startTestServer, type TestServer } from "./sshd.ts";

const local: RunningTunnel = {
  id: "staging:db",
  profile: "staging",
  name: "db",
  definition: { kind: "local", listenPort: 5432, destHost: "db.internal", destPort: 5432 },
  listenAddress: "127.0.0.1:5432",
  startedAt: "2026-09-02T10:00:00.000Z",
  connections: 3,
};

const remote: RunningTunnel = {
  ...local,
  id: "staging:preview",
  name: "preview",
  definition: { kind: "remote", listenPort: 8080, destHost: "127.0.0.1", destPort: 3000 },
  listenAddress: "127.0.0.1:8080",
  expiresAt: "2026-09-02T11:30:00.000Z",
};

const primary: HostStatus = {
  name: "staging",
  profile: {
    host: "10.0.0.1",
    port: 22,
    user: "deploy",
    privateKeyPath: "/home/deploy/.ssh/id_ed25519_pi_staging",
  },
  state: "up",
  address: "10.0.0.1",
  latencyMs: 12.4,
};

const backup: HostStatus = {
  name: "backup",
  profile: {
    host: "nas.local",
    port: 2222,
    user: "admin",
    password: "super-secret",
    strictHostKey: false,
  },
  state: "timeout",
};

describe("what the indicator shows", () => {
  it("shows where a local tunnel listens and where it goes", () => {
    const [line] = renderTunnelLines([local]).map(stripAnsi);
    assert.match(line, /staging\/db/);
    assert.match(line, /127\.0\.0\.1:5432 → db\.internal:5432/);
  });

  it("points the arrow the other way for a remote tunnel", () => {
    const [line] = renderTunnelLines([remote]).map(stripAnsi);
    assert.match(line, /127\.0\.0\.1:8080 ← 127\.0\.0\.1:3000/);
  });

  it("mentions a time limit when there is one", () => {
    assert.match(renderTunnelLines([remote])[0], /until 11:30Z/);
    assert.ok(!renderTunnelLines([local])[0].includes("until"));
  });

  it("renders one line per tunnel, and none for none", () => {
    assert.strictEqual(renderTunnelLines([local, remote]).length, 2);
    assert.deepStrictEqual(renderTunnelLines([]), []);
  });

  it("names the single tunnel in the footer, and counts several", () => {
    assert.match(renderTunnelStatus([local]), /SSH tunnel db on 127\.0\.0\.1:5432/);
    assert.strictEqual(renderTunnelStatus([local, remote]), "2 SSH tunnels open");
  });

  it("says nothing in the footer when nothing is open", () => {
    assert.strictEqual(renderTunnelStatus([]), "");
  });
});

describe("what the host overview shows", () => {
  it("shows the count, active profile and check time", () => {
    const [header] = renderHostLines([primary, backup], "staging", "10:20:30").map(stripAnsi);
    assert.strictEqual(header, "SSH  ● 1/2 up  active staging  updated 10:20:30");
  });

  it("marks only the active profile and shows the endpoint", () => {
    const [active, other] = [primary, backup].map((host) => (
      stripAnsi(renderHostLines([host], "staging", "10:20:30")[2])
    ));
    assert.match(active, /^● ▸ staging  deploy@10\.0\.0\.1:22  up 12 ms  key$/);
    assert.match(other, /^○   backup  admin@nas\.local:2222  timeout  password  hostkey off$/);
  });

  it("shows the resolved address when it differs from the host name", () => {
    const resolved: HostStatus = { ...backup, address: "192.168.1.9", state: "up", latencyMs: 2 };
    const line = stripAnsi(renderHostLines([resolved], null, "10:20:30")[2]);
    assert.match(line, /admin@nas\.local:2222 \(192\.168\.1\.9\)/);
  });

  it("renders every terminal state without pretending a failure is online", () => {
    const states = ["timeout", "refused", "dns-error", "unreachable", "invalid", "error"] as const;
    const labels = states.map((state) => {
      const status: HostStatus = { ...backup, state, latencyMs: undefined, detail: "ECONNRESET" };
      return stripAnsi(renderHostLines([status], null, "10:20:30")[2]);
    });
    assert.match(labels[0], /timeout/);
    assert.match(labels[1], /refused/);
    assert.match(labels[2], /dns failed/);
    assert.match(labels[3], /unreachable/);
    assert.match(labels[4], /invalid config/);
    assert.match(labels[5], /error ECONNRESET/);
  });

  it("never prints a password or a private key path", () => {
    const output = [
      ...renderHostLines([primary, backup], "staging", "10:20:30"),
      ...renderSshLines({ hosts: [primary, backup], activeProfile: "staging", tunnels: [local] }),
    ].join("\n");
    assert.ok(!output.includes("super-secret"));
    assert.ok(!output.includes("id_ed25519_pi_staging"));
    assert.ok(!output.includes("/home/deploy"));
  });

  it("says checking while the first probe is running", () => {
    const checking: HostStatus = { ...primary, state: "checking", latencyMs: undefined };
    const lines = renderHostLines([checking], "staging").map(stripAnsi);
    assert.match(lines[0], /SSH  ● checking\.\.\.  active staging/);
    assert.match(lines[2], /checking/);
  });

  it("colors successful and failed hosts differently", () => {
    const lines = renderHostLines([primary, backup], "staging", "10:20:30");
    assert.match(lines[2], /\u001b\[32m/);
    assert.match(lines[3], /\u001b\[31m/);
    assert.doesNotMatch(lines.map(stripAnsi).join("\n"), /\u001b\[/);
  });

  it("shows threads, RAM and CPU/memory use under a reachable host", () => {
    const measured: HostStatus = {
      ...primary,
      resourceState: "ready",
      resources: {
        cpuThreads: 8,
        cpuPercent: 23,
        memoryTotalBytes: 16 * 1024 ** 3,
        memoryUsedBytes: 6.56 * 1024 ** 3,
        memoryUsedPercent: 41,
      },
    };
    const line = stripAnsi(renderHostLines([measured], "staging", "10:20:30")[3]);
    assert.strictEqual(line, "    8 threads · 16 GiB RAM · CPU 23% · MEM 41%");
  });

  it("labels a failed resource sample without hiding reachability", () => {
    const failed: HostStatus = {
      ...primary,
      resourceState: "error",
      resourceError: "auth",
    };
    const lines = renderHostLines([failed], "staging", "10:20:30").map(stripAnsi);
    assert.match(lines[2], /up 12 ms/);
    assert.strictEqual(lines[3], "    metrics unavailable: auth");
  });

  it("marks high CPU and memory use in red", () => {
    const busy: HostStatus = {
      ...primary,
      resourceState: "ready",
      resources: {
        cpuThreads: 8,
        cpuPercent: 95,
        memoryTotalBytes: 16 * 1024 ** 3,
        memoryUsedBytes: 15 * 1024 ** 3,
        memoryUsedPercent: 92,
      },
    };
    const line = renderHostLines([busy], "staging", "10:20:30")[3];
    assert.match(line, /\u001b\[31mCPU 95%\u001b\[0m/);
    assert.match(line, /\u001b\[31mMEM 92%\u001b\[0m/);
  });

  it("shows nothing when no host is configured", () => {
    assert.deepStrictEqual(renderHostLines([], null, "10:20:30"), []);
  });
});

describe("hosts and tunnels share one panel", () => {
  it("separates the two sections with a blank line", () => {
    const lines = renderSshLines({
      hosts: [primary],
      activeProfile: "staging",
      tunnels: [local],
      checkedAt: "10:20:30",
    });
    assert.ok(lines.includes(""));
    assert.ok(lines.some((line) => line.includes("deploy@10.0.0.1:22")));
    assert.ok(lines.some((line) => stripAnsi(line).includes("staging/db")));
    assert.ok(lines.some((line) => stripAnsi(line).startsWith("Tunnels")));
  });

  it("summarizes hosts, failures and tunnels", () => {
    assert.strictEqual(
      renderSshStatus({ hosts: [primary, backup], activeProfile: "staging", tunnels: [local] }),
      "2 SSH hosts | 1 unreachable | 1 tunnel",
    );
    assert.strictEqual(renderSshStatus({ hosts: [], activeProfile: null, tunnels: [] }), "");
  });
});

describe("drawing on whatever pi offers", () => {
  const snapshot = {
    hosts: [primary],
    activeProfile: "staging",
    tunnels: [local],
    checkedAt: "10:20:30",
  };

  it("uses both surfaces when both exist", () => {
    const calls: string[] = [];
    const show = createSshIndicator({
      hasUI: true,
      ui: {
        setWidget: (id, lines) => calls.push(`widget:${id}:${lines.length}`),
        setStatus: (id, text) => calls.push(`status:${id}:${text}`),
      },
    });

    show(snapshot);
    assert.deepStrictEqual(calls, [
      "widget:pi-ssh:7",
      "status:pi-ssh:1 SSH host | 1 tunnel",
    ]);
  });

  it("does not redraw unchanged content", () => {
    const calls: string[] = [];
    const show = createSshIndicator({
      ui: {
        setWidget: (_id, lines) => calls.push(`widget:${lines.length}`),
        setStatus: (_id, text) => calls.push(`status:${text}`),
      },
    });
    show(snapshot);
    show(snapshot);
    assert.deepStrictEqual(calls, [
      "widget:7",
      "status:1 SSH host | 1 tunnel",
    ]);
  });

  it("clears both when nothing is configured or open", () => {
    const calls: Array<{ lines?: string[]; text?: string }> = [];
    const show = createSshIndicator({
      ui: {
        setWidget: (_id, lines) => calls.push({ lines }),
        setStatus: (_id, text) => calls.push({ text }),
      },
    });

    show({ hosts: [], activeProfile: null, tunnels: [] });
    assert.deepStrictEqual(calls[0].lines, []);
    assert.strictEqual(calls[1].text, "");
  });

  it("copes with a pi that has only one of the two", () => {
    let seen = "";
    const onlyStatus = createSshIndicator({ ui: { setStatus: (_id, text) => (seen = text) } });
    onlyStatus(snapshot);
    assert.strictEqual(seen, "1 SSH host | 1 tunnel");

    let lines: string[] = [];
    const onlyWidget = createSshIndicator({ ui: { setWidget: (_id, l) => (lines = l) } });
    onlyWidget(snapshot);
    assert.strictEqual(lines.length, 7);
  });

  it("does nothing at all when there is no interface", () => {
    assert.doesNotThrow(() => createSshIndicator(undefined)(snapshot));
    assert.doesNotThrow(() => createSshIndicator({})(snapshot));
    assert.doesNotThrow(() => createSshIndicator({ hasUI: false, ui: {} })(snapshot));
  });

  it("survives an interface that throws", () => {
    const show = createSshIndicator({
      ui: {
        setWidget: () => {
          throw new Error("terminal went away");
        },
      },
    });
    assert.doesNotThrow(() => show(snapshot));
  });
});

describe("the indicator follows real tunnels", () => {
  let server: TestServer = null;
  let workspace: string;

  beforeEach(() => {
    _clearListeners();
  });

  after(async () => {
    await stopAllTunnels();
    _clearListeners();
    server?.stop();
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("is told when a tunnel opens and when it closes", async (t) => {
    server = await startTestServer();
    if (!server) return t.skip("no sshd on this machine");
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ssh-ui-"));

    const seen: number[] = [];
    onTunnelsChanged((tunnels) => seen.push(tunnels.length));

    const profile: SshProfile = {
      host: "127.0.0.1",
      port: server.port,
      user: server.user,
      privateKeyPath: server.clientKeyPath,
      knownHostsFile: path.join(workspace, "known_hosts"),
      strictHostKey: false,
    };

    await startTunnel({
      profileName: "ui",
      profile,
      name: "watched",
      definition: { kind: "local", listenPort: 0, destHost: "127.0.0.1", destPort: server.port },
    });
    await stopTunnel("ui", "watched");

    assert.deepStrictEqual(seen, [1, 0], "expected one notification on open and one on close");
  });
});
