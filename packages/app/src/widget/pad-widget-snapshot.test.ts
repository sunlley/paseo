import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { buildPadWidgetSnapshot, type PadWidgetHostInput } from "./pad-widget-snapshot";

const NOW = Date.parse("2026-11-17T06:00:00.000Z");

function agent(input: Partial<Agent> & { id: string }): Agent {
  return {
    serverId: "mac",
    provider: "claude",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    title: input.id,
    cwd: "/Users/me/paseo",
    model: null,
    background: false,
    archivedAt: null,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    pendingPermissions: [],
    lastActivityAt: new Date(NOW - 60_000),
    ...input,
  } as Agent;
}

const MAC: PadWidgetHostInput = {
  serverId: "mac",
  label: "MacBook Pro",
  online: true,
  connectionType: "directTcp",
  latencyMs: 18,
};

function build(agents: Agent[], hosts: PadWidgetHostInput[] = [MAC]) {
  return buildPadWidgetSnapshot({
    now: NOW,
    hosts,
    agentsByServer: { mac: new Map(agents.map((entry) => [entry.id, entry])) },
  });
}

describe("buildPadWidgetSnapshot", () => {
  it("lists agents that need the user first, hides background, archived and seen-idle agents", () => {
    const snapshot = build([
      agent({ id: "running", status: "running" }),
      agent({ id: "idle-seen" }),
      agent({ id: "hidden", status: "running", background: true }),
      agent({ id: "archived", status: "running", archivedAt: new Date(NOW) }),
      agent({ id: "failed", status: "error", requiresAttention: true, attentionReason: "error" }),
      agent({
        id: "waiting",
        status: "running",
        pendingPermissions: [
          { id: "p", provider: "claude", name: "Bash", kind: "tool" },
        ] as Agent["pendingPermissions"],
      }),
      agent({ id: "finished", requiresAttention: true, attentionReason: "finished" }),
    ]);

    expect(snapshot.agents.map((entry) => [entry.id, entry.bucket])).toEqual([
      ["waiting", "needs_input"],
      ["failed", "failed"],
      ["finished", "attention"],
      ["running", "running"],
    ]);
    expect(snapshot.counts).toEqual({ needsInput: 1, failed: 1, running: 1, finished: 1 });
    expect(snapshot.totalAgents).toBe(5);
  });

  it("describes what a waiting agent asks for and why a failed agent stopped", () => {
    const snapshot = build([
      agent({
        id: "waiting",
        status: "running",
        attentionTimestamp: new Date(NOW - 120_000),
        pendingPermissions: [
          {
            id: "p",
            provider: "claude",
            name: "Bash",
            kind: "tool",
            title: "Run typecheck",
            description: "Check types before committing",
            detail: { type: "shell", command: "npm run typecheck", cwd: "/Users/me/paseo/app" },
          },
        ] as Agent["pendingPermissions"],
      }),
      agent({
        id: "failed",
        status: "error",
        requiresAttention: true,
        attentionReason: "error",
        attentionTimestamp: new Date(NOW - 1_200_000),
        lastError: "Gradle build failed",
      }),
    ]);

    expect(
      snapshot.agents.map(({ id, request, error, attentionAt }) => ({
        id,
        request,
        error,
        attentionAt,
      })),
    ).toEqual([
      {
        id: "waiting",
        request: {
          tool: "Bash",
          title: "Run typecheck",
          command: "npm run typecheck",
          cwd: "/Users/me/paseo/app",
          description: "Check types before committing",
        },
        error: null,
        attentionAt: NOW - 120_000,
      },
      {
        id: "failed",
        request: null,
        error: "Gradle build failed",
        attentionAt: NOW - 1_200_000,
      },
    ]);
  });

  it("carries turn timing and usage, and totals usage across visible agents", () => {
    const snapshot = build([
      agent({
        id: "running",
        status: "running",
        model: "opus",
        thinkingOptionId: "high",
        turn: { phase: "open", turnId: "t", startedAt: new Date(NOW - 768_000) } as Agent["turn"],
        lastUsage: {
          inputTokens: 184_000,
          outputTokens: 12_000,
          totalCostUsd: 1.2,
          contextWindowMaxTokens: 200_000,
          contextWindowUsedTokens: 124_000,
        },
      }),
      agent({
        id: "idle-seen",
        lastUsage: { inputTokens: 1_000, outputTokens: 500, totalCostUsd: 0.3 },
      }),
      agent({ id: "no-usage", status: "running" }),
    ]);

    expect(
      snapshot.agents.map(({ id, turnStartedAt, usage, thinking }) => ({
        id,
        turnStartedAt,
        usage,
        thinking,
      })),
    ).toEqual([
      {
        id: "running",
        turnStartedAt: NOW - 768_000,
        usage: { contextPercent: 62, inputTokens: 184_000, outputTokens: 12_000, costUsd: 1.2 },
        thinking: "high",
      },
      { id: "no-usage", turnStartedAt: null, usage: null, thinking: null },
    ]);
    expect(snapshot.usage).toEqual({ tokens: 197_500, costUsd: 1.5 });
  });

  it("reports every saved host with its route, and ignores agents of removed hosts", () => {
    const snapshot = buildPadWidgetSnapshot({
      now: NOW,
      hosts: [
        MAC,
        {
          serverId: "nas",
          label: "Home Server",
          online: false,
          connectionType: null,
          latencyMs: null,
        },
      ],
      agentsByServer: {
        mac: new Map([["a", agent({ id: "a", status: "running" })]]),
        gone: new Map([["b", agent({ id: "b", serverId: "gone", status: "running" })]]),
      },
    });

    expect(snapshot.hosts).toEqual([
      {
        serverId: "mac",
        label: "MacBook Pro",
        online: true,
        connection: "directTcp",
        latencyMs: 18,
      },
      { serverId: "nas", label: "Home Server", online: false, connection: null, latencyMs: null },
    ]);
    expect(snapshot.agents.map((entry) => [entry.id, entry.hostLabel])).toEqual([
      ["a", "MacBook Pro"],
    ]);
    expect(snapshot.totalAgents).toBe(1);
  });

  it("counts an idle agent whose provider subagents are still running as running", () => {
    const snapshot = buildPadWidgetSnapshot({
      now: NOW,
      hosts: [MAC],
      agentsByServer: {
        mac: new Map([
          ["console", agent({ id: "console" })],
          ["quiet", agent({ id: "quiet" })],
        ]),
      },
      subagents: [
        { serverId: "mac", parentAgentId: "console", status: "running", createdAt: NOW - 300_000 },
        { serverId: "mac", parentAgentId: "console", status: "running", createdAt: NOW - 120_000 },
        { serverId: "mac", parentAgentId: "console", status: "failed", createdAt: NOW - 900_000 },
        { serverId: "mac", parentAgentId: "quiet", status: "completed", createdAt: NOW - 900_000 },
      ],
    });

    expect(
      snapshot.agents.map(({ id, bucket, turnStartedAt, subagents }) => ({
        id,
        bucket,
        turnStartedAt,
        subagents,
      })),
    ).toEqual([
      {
        id: "console",
        bucket: "running",
        turnStartedAt: NOW - 300_000,
        subagents: { running: 2, failed: 1 },
      },
    ]);
    expect(snapshot.counts).toEqual({ needsInput: 0, failed: 0, running: 1, finished: 0 });
  });
});
