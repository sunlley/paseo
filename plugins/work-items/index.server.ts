import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  defineAgentTool,
  type PluginHookContext,
  type PluginServerContext,
} from "@getpaseo/plugin/server";
import { z } from "zod";
import { WorkItemKindSchema, WorkItemStatusSchema, watchWorkItems } from "./shared/work-items.js";
import {
  applyPullRequest,
  applyTodos,
  createWorkItem,
  currentItemFor,
  pruneWorkItems,
  updateWorkItem,
  type TodoEntry,
} from "./server/items.js";
import { isWorkItemToolRequest } from "./server/permissions.js";
import { WorkItemStore } from "./server/store.js";

// Built-ins run inside the daemon process, which always has PASEO_HOME set by its launcher.
const DATA_FILE = join(
  process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
  "plugin-data",
  "work-items.json",
);

const INSTRUCTIONS = [
  "Paseo work items: before you start implementing a new feature or fixing a bug, call",
  "create_work_item with a short title and kind (feature or bug). Keep it current with",
  "update_work_item: needs_review when you are done and waiting for the user (for example a PR",
  "is open), blocked with a one-line note when you are stuck, done when it is finished. Your",
  "todo list is mirrored as its progress automatically. Do not create work items for questions,",
  "research or chores.",
].join(" ");

// Built-ins may import only the plugin SDK and zod, so take the API type from the hook context.
type PaseoApi = PluginHookContext["paseo"];

function now(): string {
  return new Date().toISOString();
}

export default function contribute(server: PluginServerContext) {
  const store = new WorkItemStore(DATA_FILE);
  const timelines = new Map<string, () => void>();
  let workspaces: (() => void) | null = null;

  // An agent's todo list only matters while it has an open work item. Watching starts lazily,
  // because the plugin only receives a PaseoApi inside hooks, tools and handlers.
  function watchTimeline(paseo: PaseoApi, agentId: string): void {
    if (timelines.has(agentId)) return;
    const stop = paseo.agents.ref(agentId).timeline.subscribe((message) => {
      if (!("event" in message) || message.event.type !== "timeline") return;
      const item = message.event.item;
      if (item.type !== "todo") return;
      void store
        .mutate((items) => applyTodos(items, agentId, item.items as TodoEntry[], now()))
        .catch(() => undefined);
    });
    timelines.set(agentId, stop);
  }

  function watchWorkspaces(paseo: PaseoApi): void {
    if (workspaces) return;
    workspaces = () => {};
    void paseo.workspaces
      .list({ subscribe: {} })
      .then(({ entries, subscription }) => {
        const apply = (workspace: (typeof entries)[number]) => {
          const pr = workspace.githubRuntime?.pullRequest;
          if (!pr) return;
          void store
            .mutate((items) => applyPullRequest(items, workspace.id, pr, now()))
            .catch(() => undefined);
        };
        for (const workspace of entries) apply(workspace);
        const off = subscription.subscribe({
          snapshot: ({ entries: next }) => next.forEach(apply),
          update: (message) => {
            if (message.type === "workspace_update" && message.payload.kind === "upsert") {
              apply(message.payload.workspace);
            }
          },
        });
        workspaces = () => {
          off();
          void subscription.release?.();
        };
        return undefined;
      })
      .catch(() => {
        workspaces = null;
      });
  }

  async function watchFor(paseo: PaseoApi, agentId: string): Promise<void> {
    watchWorkspaces(paseo);
    if (currentItemFor(await store.list(), agentId)) watchTimeline(paseo, agentId);
  }

  // Stop following agents that no longer have anything open.
  const stopIdleTimelines = store.onChange((items) => {
    for (const [agentId, stop] of timelines) {
      if (!currentItemFor(items, agentId)) {
        stop();
        timelines.delete(agentId);
      }
    }
  });

  const createTool = defineAgentTool({
    name: "create_work_item",
    description:
      "Create a Paseo work item for the feature or bug fix you are about to work on. It appears above the user's composer and tracks your progress.",
    input: z.object({
      title: z.string().trim().min(1).max(120).describe("Short title, in the user's language"),
      kind: WorkItemKindSchema.describe("feature or bug"),
    }),
    async execute({ title, kind }, { agent, paseo }) {
      const id = randomUUID();
      const stamp = now();
      await store.mutate((items) =>
        createWorkItem(pruneWorkItems(items, stamp), {
          id,
          now: stamp,
          title,
          kind,
          agentId: agent.id,
          workspaceId: agent.workspaceId,
        }),
      );
      watchWorkspaces(paseo);
      watchTimeline(paseo, agent.id);
      return { text: `Created work item ${id}: ${title}`, structuredContent: { id } };
    },
  });

  const updateTool = defineAgentTool({
    name: "update_work_item",
    description:
      "Update a Paseo work item. Omit id to update your current open item. Use needs_review when waiting for the user, blocked (with a note) when stuck, done when finished.",
    input: z.object({
      id: z.string().optional().describe("Work item id; defaults to your current open item"),
      status: WorkItemStatusSchema.optional(),
      note: z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe("One line: blocker or what to check"),
      title: z.string().trim().min(1).max(120).optional(),
    }),
    async execute({ id, status, note, title }, { agent }) {
      const items = await store.list();
      const target = id ?? currentItemFor(items, agent.id)?.id;
      if (!target) return { text: "You have no open work item to update.", isError: true };
      await store.mutate((current) =>
        updateWorkItem(current, target, { status, note, title }, now()),
      );
      return { text: `Updated work item ${target}.`, structuredContent: { id: target } };
    },
  });

  const listTool = defineAgentTool({
    name: "list_work_items",
    description: "List Paseo work items in your workspace, or only your own.",
    input: z.object({ scope: z.enum(["workspace", "agent"]).default("workspace") }),
    async execute({ scope }, { agent }) {
      const items = (await store.list()).filter((entry) =>
        scope === "agent" ? entry.agentId === agent.id : entry.workspaceId === agent.workspaceId,
      );
      return { text: JSON.stringify(items, null, 2), structuredContent: { items } };
    },
  });

  const removeOpenHook = server.addHook("agent.open.before", async ({ request }, { paseo }) => {
    if (request.background || request.purpose !== "interactive") return;
    void watchFor(paseo, request.agentId).catch(() => undefined);
    return {
      ...request,
      tools: [...request.tools, createTool, updateTool, listTool],
      appendSystemPrompt: [...(request.appendSystemPrompt ?? []), INSTRUCTIONS],
    };
  });

  const removePermissionHook = server.addHook(
    "agent.permission.before",
    async ({ agent, request }, { paseo }) => {
      if (!isWorkItemToolRequest(request)) return;
      await paseo.agents.ref(agent.id).respondToPermission({
        requestId: request.id,
        response: { behavior: "allow" },
      });
    },
  );

  server.handle(watchWorkItems, async (_input, { push, signal }) => {
    await push({ items: [...(await store.list())] });
    const off = store.onChange((items) => {
      void push({ items: [...items] });
    });
    signal.addEventListener("abort", off, { once: true });
  });

  return () => {
    removeOpenHook();
    removePermissionHook();
    stopIdleTimelines();
    for (const stop of timelines.values()) stop();
    timelines.clear();
    workspaces?.();
  };
}
