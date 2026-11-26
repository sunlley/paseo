import type {
  PluginButton,
  PluginButtonRegistration,
  PluginClientContext,
  PluginText,
} from "@getpaseo/plugin/client";
import type { WorkItem } from "./shared/work-items.js";
import { watchWorkItems } from "./shared/work-items.js";
import { messages } from "./client/messages.js";
import { sessionItem, WorkItemsPanel } from "./client/panel.js";
import { isDesktopApp } from "./client/web.js";

const PILL_LABELS = {
  none: messages.message("pill.none"),
  todo: messages.message("pill.todo"),
  in_progress: messages.message("pill.in_progress"),
  needs_review: messages.message("pill.needs_review"),
  blocked: messages.message("pill.blocked"),
  done: messages.message("pill.done"),
};

function pillPresentation(item: WorkItem | null): Pick<PluginButton<PluginText>, "icon" | "label"> {
  if (!item) return { icon: "ListPlus", label: PILL_LABELS.none };
  return { icon: item.kind === "bug" ? "Bug" : "ListChecks", label: PILL_LABELS[item.status] };
}

// One pill per session, next to Tasks and Subagents. It follows the session it sits on, so
// switching session or workspace switches what it shows with no extra state.
export default function contribute(client: PluginClientContext) {
  if (!isDesktopApp()) return () => {};

  const pills = new Map<string, PluginButtonRegistration<PluginText>>();
  let items: readonly WorkItem[] = [];
  let stopped = false;
  const lifetime = new AbortController();

  const refresh = (agentId: string) => {
    pills.get(agentId)?.update(pillPresentation(sessionItem(items, agentId)));
  };

  const register = (agent: {
    id: string;
    workspaceId?: string | null;
    background?: boolean;
    archivedAt?: string | null;
  }) => {
    if (stopped) return;
    pills.get(agent.id)?.remove();
    pills.delete(agent.id);
    if (!agent.workspaceId || agent.background || agent.archivedAt) return;
    pills.set(
      agent.id,
      client.addComposerPill({
        id: "work-items",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: messages.message("title"),
          ...pillPresentation(sessionItem(items, agent.id)),
          behavior: { kind: "popover", Content: WorkItemsPanel },
        },
      }),
    );
  };

  const remove = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };

  const watch = client.subscribe(watchWorkItems, {}, (event) => {
    items = event.items;
    for (const agentId of pills.keys()) refresh(agentId);
  });

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const pill of pills.values()) pill.remove();
          pills.clear();
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          if (message.payload.kind === "remove") remove(message.payload.agentId);
          else register(message.payload.agent);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("Work items: agent observation failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    watch();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
