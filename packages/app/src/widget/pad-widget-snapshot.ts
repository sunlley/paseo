import type { ActiveConnection } from "@/runtime/host-runtime";
import type { Agent } from "@/stores/session-store";
import {
  deriveSidebarStateBucket,
  STATUS_BUCKET_ORDER,
  type SidebarStateBucket,
} from "@/utils/sidebar-agent-state";

/**
 * What the Android home-screen widgets render. The widgets only display state, so this is a
 * plain JSON projection of the agent directory; the Kotlin side owns every layout decision.
 * Bump `v` when a field changes meaning so an old widget build can ignore a newer payload.
 */
export interface PadWidgetSnapshot {
  v: 1;
  updatedAt: number;
  counts: { needsInput: number; failed: number; running: number; finished: number };
  /** Visible agents, including idle ones the user has already seen. */
  totalAgents: number;
  /**
   * Sum of each visible agent's last reported turn usage. Providers report per turn, not per
   * day, so this is "recent", never "today"; agents that report no cost contribute nothing.
   */
  usage: { tokens: number; costUsd: number };
  hosts: PadWidgetHost[];
  /** Most urgent first; at most MAX_WIDGET_AGENTS. */
  agents: PadWidgetAgent[];
}

export type PadWidgetBucket = Exclude<SidebarStateBucket, "done">;

export interface PadWidgetAgent {
  serverId: string;
  id: string;
  bucket: PadWidgetBucket;
  title: string;
  provider: string;
  model: string | null;
  hostLabel: string;
  workspace: string;
  /** When the agent started waiting on the user, failed, or finished (epoch ms). */
  attentionAt: number | null;
  /** The first pending permission, for agents waiting on the user. */
  request: PadWidgetRequest | null;
  error: string | null;
  turnStartedAt: number | null;
  thinking: string | null;
  usage: PadWidgetUsage | null;
  /** Provider-owned children (Claude Task subagents and the like); they run on after the parent's turn ends. */
  subagents: { running: number; failed: number };
}

export interface PadWidgetUsage {
  contextPercent: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface PadWidgetRequest {
  tool: string;
  title: string | null;
  command: string | null;
  cwd: string | null;
  description: string | null;
}

export interface PadWidgetHost {
  serverId: string;
  label: string;
  online: boolean;
  connection: ActiveConnection["type"] | null;
  latencyMs: number | null;
}

export interface PadWidgetHostInput {
  serverId: string;
  label: string;
  online: boolean;
  connectionType: ActiveConnection["type"] | null;
  latencyMs: number | null;
}

export interface PadWidgetSubagentInput {
  serverId: string;
  parentAgentId: string;
  status: "running" | "completed" | "failed" | "canceled";
  createdAt: number;
}

export interface PadWidgetSource {
  now: number;
  hosts: readonly PadWidgetHostInput[];
  agentsByServer: Record<string, ReadonlyMap<string, Agent> | undefined>;
  /** Provider subagents the app knows of; they live outside the agent directory. */
  subagents?: readonly PadWidgetSubagentInput[];
}

interface SubagentTally {
  running: number;
  failed: number;
  firstRunningAt: number | null;
}

function tallySubagents(subagents: readonly PadWidgetSubagentInput[]): Map<string, SubagentTally> {
  const tallies = new Map<string, SubagentTally>();
  for (const subagent of subagents) {
    const key = `${subagent.serverId}\0${subagent.parentAgentId}`;
    const tally = tallies.get(key) ?? { running: 0, failed: 0, firstRunningAt: null };
    if (subagent.status === "running") {
      tally.running += 1;
      tally.firstRunningAt = Math.min(
        tally.firstRunningAt ?? subagent.createdAt,
        subagent.createdAt,
      );
    } else if (subagent.status === "failed") {
      tally.failed += 1;
    }
    tallies.set(key, tally);
  }
  return tallies;
}

export const MAX_WIDGET_AGENTS = 6;

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

function describeRequest(agent: Agent): PadWidgetRequest | null {
  const permission = agent.pendingPermissions[0];
  if (!permission) return null;
  const shell = permission.detail?.type === "shell" ? permission.detail : null;
  const inputCommand = permission.input?.command;
  return {
    tool: permission.name,
    title: permission.title ?? null,
    command: shell?.command ?? (typeof inputCommand === "string" ? inputCommand : null),
    cwd: shell?.cwd ?? null,
    description: permission.description ?? null,
  };
}

function describeUsage(agent: Agent): PadWidgetUsage | null {
  const usage = agent.lastUsage;
  if (!usage) return null;
  const max = usage.contextWindowMaxTokens;
  const used = usage.contextWindowUsedTokens;
  return {
    contextPercent: max && used !== undefined ? Math.round((used / max) * 100) : null,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    costUsd: usage.totalCostUsd ?? null,
  };
}

export function buildPadWidgetSnapshot(source: PadWidgetSource): PadWidgetSnapshot {
  const hostLabels = new Map(source.hosts.map((host) => [host.serverId, host.label]));
  const counts = { needsInput: 0, failed: 0, running: 0, finished: 0 };
  let totalAgents = 0;
  const usage = { tokens: 0, costUsd: 0 };
  const listed: Array<{ agent: Agent; bucket: PadWidgetBucket; subagents: SubagentTally }> = [];
  const tallies = tallySubagents(source.subagents ?? []);
  const noSubagents: SubagentTally = { running: 0, failed: 0, firstRunningAt: null };

  for (const [serverId, agents] of Object.entries(source.agentsByServer)) {
    if (!agents || !hostLabels.has(serverId)) continue;
    for (const agent of agents.values()) {
      if (agent.background || agent.archivedAt) continue;
      totalAgents += 1;
      usage.tokens += (agent.lastUsage?.inputTokens ?? 0) + (agent.lastUsage?.outputTokens ?? 0);
      usage.costUsd += agent.lastUsage?.totalCostUsd ?? 0;
      const subagents = tallies.get(`${serverId}\0${agent.id}`) ?? noSubagents;
      const bucket = widgetBucket(agent, subagents);
      if (bucket === "done") continue;
      if (bucket === "needs_input") counts.needsInput += 1;
      else if (bucket === "failed") counts.failed += 1;
      else if (bucket === "running") counts.running += 1;
      else counts.finished += 1;
      listed.push({ agent, bucket, subagents });
    }
  }

  listed.sort(
    (left, right) =>
      STATUS_BUCKET_ORDER.indexOf(left.bucket) - STATUS_BUCKET_ORDER.indexOf(right.bucket) ||
      right.agent.lastActivityAt.getTime() - left.agent.lastActivityAt.getTime(),
  );

  return {
    v: 1,
    updatedAt: source.now,
    counts,
    totalAgents,
    usage,
    hosts: source.hosts.map((host) => ({
      serverId: host.serverId,
      label: host.label,
      online: host.online,
      connection: host.connectionType,
      latencyMs: host.latencyMs,
    })),
    agents: listed.slice(0, MAX_WIDGET_AGENTS).map((entry) => toWidgetAgent(entry, hostLabels)),
  };
}

function widgetBucket(agent: Agent, subagents: SubagentTally): SidebarStateBucket {
  const own = deriveSidebarStateBucket({
    status: agent.status,
    pendingPermissionCount: agent.pendingPermissions.length,
    requiresAttention: agent.requiresAttention,
    attentionReason: agent.attentionReason,
    backgroundWork: agent.backgroundWork,
  });
  // A parent whose turn ended is still working while its subagents run. Waiting on the user
  // or a failure stays first: those are what the user has to act on.
  return subagents.running > 0 && (own === "done" || own === "attention") ? "running" : own;
}

function toWidgetAgent(
  { agent, bucket, subagents }: { agent: Agent; bucket: PadWidgetBucket; subagents: SubagentTally },
  hostLabels: ReadonlyMap<string, string>,
): PadWidgetAgent {
  return {
    serverId: agent.serverId,
    id: agent.id,
    bucket,
    title: agent.title ?? basename(agent.cwd),
    provider: agent.provider,
    model: agent.model,
    hostLabel: hostLabels.get(agent.serverId) ?? agent.serverId,
    workspace: basename(agent.cwd),
    attentionAt: agent.attentionTimestamp?.getTime() ?? null,
    request: bucket === "needs_input" ? describeRequest(agent) : null,
    error: bucket === "failed" ? (agent.lastError ?? null) : null,
    turnStartedAt:
      agent.turn.phase === "open"
        ? (agent.turn.startedAt?.getTime() ?? null)
        : subagents.firstRunningAt,
    thinking: agent.thinkingOptionId ?? null,
    usage: describeUsage(agent),
    subagents: { running: subagents.running, failed: subagents.failed },
  };
}
