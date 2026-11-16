/**
 * Keeping configured hosts and running tunnels visible.
 *
 * A tunnel outlives the tool call that opened it, so a listing that has
 * scrolled out of view is not enough: an open forward the user has forgotten
 * about is a port on their machine reaching into someone else's network. The
 * same surface also shows the configured hosts and their TCP reachability, so
 * the user can see what the extension will connect to without running a tool.
 *
 * Pi offers two surfaces that survive scrolling -- a widget above the editor
 * and a status line in the footer -- and this uses whichever exists.
 *
 * Everything here is defensive. Extensions also run in rpc, json and print
 * modes where there is no interface at all, and an older pi may have neither
 * method; none of that is a reason for a transfer to fail.
 */

import { styled } from "./ansi.ts";
import type { HostStatus } from "./host-status.ts";
import { displayValue, renderHostLines } from "./host-status.ts";
import type { RunningTunnel } from "./types.ts";

const SURFACE_ID = "pi-ssh";

/** The subset of pi's UI this module touches, all of it optional. */
export interface UiSurface {
  setWidget?: (id: string, lines: string[]) => void;
  setStatus?: (id: string, text: string) => void;
}

export interface UiContext {
  hasUI?: boolean;
  ui?: UiSurface;
}

interface TunnelRow {
  readonly identity: string;
  readonly route: string;
  readonly meta: string;
}

interface TunnelWidths {
  readonly identity: number;
  readonly route: number;
}

function tunnelRows(tunnels: ReadonlyArray<RunningTunnel>): TunnelRow[] {
  return tunnels.map((tunnel) => {
    const arrow = tunnel.definition.kind === "local" ? "→" : "←";
    const dest = `${displayValue(tunnel.definition.destHost)}:${tunnel.definition.destPort}`;
    const details: string[] = [];
    if (tunnel.connections > 0) {
      details.push(`${tunnel.connections} ${tunnel.connections === 1 ? "conn" : "conns"}`);
    }
    if (tunnel.expiresAt) details.push(`until ${tunnel.expiresAt.slice(11, 16)}Z`);
    return {
      identity: `${displayValue(tunnel.profile)}/${displayValue(tunnel.name)}`,
      route: `${displayValue(tunnel.listenAddress)} ${arrow} ${dest}`,
      meta: details.join(" · "),
    };
  });
}

function tunnelWidths(rows: ReadonlyArray<TunnelRow>): TunnelWidths {
  return {
    identity: Math.max(...rows.map((row) => row.identity.length)),
    route: Math.max(...rows.map((row) => row.route.length)),
  };
}

function plainTunnelRow(row: TunnelRow, widths: TunnelWidths): string {
  return [
    "●",
    row.identity.padEnd(widths.identity),
    row.route.padEnd(widths.route),
    row.meta,
  ].join("  ").trimEnd();
}

function styledTunnelRow(row: TunnelRow, widths: TunnelWidths): string {
  const identity = `${styled(row.identity, "bold")}${" ".repeat(widths.identity - row.identity.length)}`;
  return [
    styled("●", "bold", "green"),
    identity,
    row.route.padEnd(widths.route),
    row.meta ? styled(row.meta, "dim") : "",
  ].join("  ").trimEnd();
}

/** One styled line per tunnel, for the widget above the editor. */
export function renderTunnelLines(tunnels: ReadonlyArray<RunningTunnel>): string[] {
  const rows = tunnelRows(tunnels);
  if (rows.length === 0) return [];
  const widths = tunnelWidths(rows);
  return rows.map((row) => styledTunnelRow(row, widths));
}

function renderTunnelSection(tunnels: ReadonlyArray<RunningTunnel>): string[] {
  const rows = tunnelRows(tunnels);
  if (rows.length === 0) return [];
  const widths = tunnelWidths(rows);
  const headerPlain = `Tunnels  ● ${rows.length} open`;
  const plainRows = rows.map((row) => plainTunnelRow(row, widths));
  const ruleWidth = Math.min(100, Math.max(headerPlain.length, ...plainRows.map((line) => line.length)));
  const header = [
    styled("Tunnels", "bold"),
    `${styled("●", "bold", "green")} ${styled(`${rows.length} open`, "green")}`,
  ].join("  ");
  return [
    header,
    styled("─".repeat(ruleWidth), "dim"),
    ...rows.map((row) => styledTunnelRow(row, widths)),
  ];
}

/** A single line for the footer, where there is only room for a count. */
export function renderTunnelStatus(tunnels: ReadonlyArray<RunningTunnel>): string {
  if (tunnels.length === 0) return "";
  if (tunnels.length === 1) {
    const [only] = tunnels;
    return `SSH tunnel ${only.name} on ${only.listenAddress}`;
  }
  return `${tunnels.length} SSH tunnels open`;
}

export interface SshUiSnapshot {
  readonly hosts: ReadonlyArray<HostStatus>;
  readonly activeProfile: string | null;
  readonly tunnels: ReadonlyArray<RunningTunnel>;
  readonly checkedAt?: string;
}

function sameLines(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

/** Hosts and tunnels share one expandable widget. */
export function renderSshLines(snapshot: SshUiSnapshot): string[] {
  const hostLines = renderHostLines(snapshot.hosts, snapshot.activeProfile, snapshot.checkedAt);
  const tunnelLines = renderTunnelSection(snapshot.tunnels);
  if (hostLines.length === 0) return tunnelLines;
  if (tunnelLines.length === 0) return hostLines;
  return [...hostLines, "", ...tunnelLines];
}

/** A compact footer summary for the same surface. */
export function renderSshStatus(snapshot: SshUiSnapshot): string {
  const parts: string[] = [];
  if (snapshot.hosts.length > 0) {
    const noun = snapshot.hosts.length === 1 ? "host" : "hosts";
    parts.push(`${snapshot.hosts.length} SSH ${noun}`);
    const unreachable = snapshot.hosts.filter((host) => (
      host.state !== "up" && host.state !== "checking"
    )).length;
    if (unreachable > 0) parts.push(`${unreachable} unreachable`);
  }
  if (snapshot.tunnels.length > 0) {
    const noun = snapshot.tunnels.length === 1 ? "tunnel" : "tunnels";
    parts.push(`${snapshot.tunnels.length} ${noun}`);
  }
  return parts.join(" | ");
}

/**
 * Build the function that pushes hosts and tunnels onto the interface.
 * Returns a no-op when there is nothing to draw on, so callers need no
 * special case.
 */
export function createSshIndicator(ctx: UiContext | undefined): (snapshot: SshUiSnapshot) => void {
  const ui = ctx?.ui;
  if (!ui || ctx?.hasUI === false) {
    return () => {};
  }

  let lastLines: string[] | null = null;
  let lastStatus: string | null = null;

  return (snapshot) => {
    const lines = renderSshLines(snapshot);
    const status = renderSshStatus(snapshot);
    try {
      if (typeof ui.setWidget === "function" && (lastLines === null || !sameLines(lastLines, lines))) {
        // An empty array clears the widget when nothing is configured or open.
        ui.setWidget(SURFACE_ID, lines);
        lastLines = lines;
      }
      if (typeof ui.setStatus === "function" && status !== lastStatus) {
        ui.setStatus(SURFACE_ID, status);
        lastStatus = status;
      }
    } catch {
      // Whatever the interface does with this, it must not break SSH.
    }
  };
}
