import { useEffect, useMemo, useState } from "react";
import { AppRegistry, AppState } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import { useAllDirectoryDemand } from "@/hooks/use-directory-demand";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHosts,
  type HostRuntimeSnapshot,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { refreshProviderSubagents, useProviderSubagentStore } from "@/subagents/provider-store";
import type { HostProfile } from "@/types/host-connection";
import {
  buildPadWidgetSnapshot,
  type PadWidgetHostInput,
  type PadWidgetSubagentInput,
} from "./pad-widget-snapshot";

interface PaseoWidgetModule {
  isPlaced(): Promise<boolean>;
  setSnapshot(json: string): void;
  startKeepAlive(): boolean;
  stopKeepAlive(): void;
  addListener(event: "onScreenOn", handler: () => void): { remove(): void };
}

const widgetModule = requireOptionalNativeModule<PaseoWidgetModule>("PaseoWidget");

// React Native pauses JS timers in the background unless a headless task runs. While widgets
// are placed the native side holds this never-ending task, so the daemon client keeps pinging
// and its socket lease stays alive (KeepAliveTask in modules/paseo-widget).
AppRegistry.registerHeadlessTask("PaseoWidgetKeepAlive", () => () => new Promise<void>(() => {}));

/** Session-store changes arrive per streamed token; the widgets need at most one redraw per window. */
const THROTTLE_MS = 2_000;
/** Resent even when nothing changed, so the widgets can tell a quiet fleet from a dead app. */
const HEARTBEAT_MS = 60_000;

function toHostInput(host: HostProfile, runtime: HostRuntimeSnapshot | null): PadWidgetHostInput {
  const online = isHostRuntimeConnected(runtime);
  const activeId = runtime?.activeConnectionId ?? null;
  const probe = activeId ? runtime?.probeByConnectionId.get(activeId) : undefined;
  return {
    serverId: host.serverId,
    label: host.label,
    online,
    connectionType: online ? (runtime?.activeConnection?.type ?? null) : null,
    latencyMs: online && probe?.status === "available" ? probe.latencyMs : null,
  };
}

function collectSubagents(): PadWidgetSubagentInput[] {
  const result: PadWidgetSubagentInput[] = [];
  for (const [key, descriptor] of useProviderSubagentStore.getState().descriptors) {
    result.push({
      // Keys are providerSubagentKey(serverId, parentAgentId, subagentId).
      serverId: key.slice(0, key.indexOf("\0")),
      parentAgentId: descriptor.parentAgentId,
      status: descriptor.status,
      createdAt: Date.parse(descriptor.createdAt),
    });
  }
  return result;
}

/**
 * Whether any Paseo widget sits on the home screen; rechecked whenever the app comes forward.
 * While one does, a foreground service keeps the process (and its daemon connection) alive,
 * because Xiaomi freezes background apps within seconds. Android only lets the app start that
 * service while it is in front, which is exactly when this check runs.
 */
function useWidgetPlaced(): boolean {
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    const module = widgetModule;
    if (!module) return;
    const check = () => {
      module.isPlaced().then(
        (isPlaced) => {
          if (isPlaced) module.startKeepAlive();
          else module.stopKeepAlive();
          setPlaced(isPlaced);
          return undefined;
        },
        () => setPlaced(false),
      );
    };
    check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => subscription.remove();
  }, []);
  return placed;
}

/**
 * Pushes agent state to the Android home-screen widgets. Nothing runs, and no host directory is
 * demanded, until a widget is placed: the fleet-wide directory costs every host a subscription.
 */
export function usePadWidgetSync(): void {
  const placed = useWidgetPlaced();
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  useAllDirectoryDemand({ serverIds, enabled: placed });

  useEffect(() => {
    const module = widgetModule;
    if (!placed || !module) return;
    const runtime = getHostRuntimeStore();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastKey = "";
    let lastSentAt = 0;
    // Provider subagents are only listed for parents someone opened; the widgets need every
    // visible parent's list once per connection. Updates after that arrive on the event feed,
    // and refreshProviderSubagents marks the parent tracked so a reconnect resyncs it.
    const listed = new Set<string>();
    const listSubagents = () => {
      const sessions = useSessionStore.getState().sessions;
      for (const host of hosts) {
        const snapshot = runtime.getSnapshot(host.serverId);
        const client = snapshot?.client;
        if (!client || !isHostRuntimeConnected(snapshot)) continue;
        for (const agent of sessions[host.serverId]?.agents.values() ?? []) {
          if (agent.background || agent.archivedAt) continue;
          const key = `${host.serverId}:${snapshot.clientGeneration}:${agent.id}`;
          if (listed.has(key)) continue;
          listed.add(key);
          refreshProviderSubagents(client, host.serverId, agent.id).catch(() => undefined);
        }
      }
    };

    const send = () => {
      timer = null;
      const sessions = useSessionStore.getState().sessions;
      const snapshot = buildPadWidgetSnapshot({
        now: Date.now(),
        hosts: hosts.map((host) => toHostInput(host, runtime.getSnapshot(host.serverId))),
        agentsByServer: Object.fromEntries(
          Object.entries(sessions).map(([serverId, session]) => [serverId, session.agents]),
        ),
        subagents: collectSubagents(),
      });
      const key = JSON.stringify({ ...snapshot, updatedAt: 0 });
      if (key === lastKey && snapshot.updatedAt - lastSentAt < HEARTBEAT_MS) return;
      lastKey = key;
      lastSentAt = snapshot.updatedAt;
      module.setSnapshot(JSON.stringify(snapshot));
    };
    const schedule = () => {
      listSubagents();
      timer ??= setTimeout(send, THROTTLE_MS);
    };

    const unsubscribeSessions = useSessionStore.subscribe(schedule);
    const unsubscribeRuntime = runtime.subscribeAll(schedule);
    const unsubscribeSubagents = useProviderSubagentStore.subscribe(schedule);
    // The socket drops while the screen is off; reconnect the moment it comes back on instead
    // of waiting out the grown backoff, so the widgets are current when they are visible.
    const screenOn = module.addListener("onScreenOn", () => {
      runtime.ensureConnectedAll({ verify: true });
      schedule();
    });
    const heartbeat = setInterval(send, HEARTBEAT_MS);
    listSubagents();
    send();
    return () => {
      unsubscribeSessions();
      unsubscribeRuntime();
      unsubscribeSubagents();
      screenOn.remove();
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
    };
  }, [placed, hosts]);
}
