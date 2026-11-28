import type { WorkItem, WorkItemKind, WorkItemStatus } from "../shared/work-items.js";

// Pure list transforms. Each returns the same array when nothing changed, so callers can skip
// the write and the broadcast.

const DONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface TodoEntry {
  text: string;
  completed: boolean;
  status?: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface WorkspacePullRequest {
  url: string;
  number?: number;
  isMerged: boolean;
}

export function createWorkItem(
  items: readonly WorkItem[],
  input: {
    id: string;
    now: string;
    title: string;
    kind: WorkItemKind;
    agentId: string | null;
    workspaceId: string | null;
  },
): WorkItem[] {
  return [
    ...items,
    {
      id: input.id,
      title: input.title,
      kind: input.kind,
      status: "in_progress",
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      note: null,
      progress: null,
      currentStep: null,
      pr: null,
      createdAt: input.now,
      updatedAt: input.now,
      completedAt: null,
    },
  ];
}

export function updateWorkItem(
  items: readonly WorkItem[],
  id: string,
  patch: { status?: WorkItemStatus; note?: string | null; title?: string },
  now: string,
): WorkItem[] {
  if (!items.some((entry) => entry.id === id)) throw new Error(`No work item with id ${id}`);
  return items.map((entry) => {
    if (entry.id !== id) return entry;
    const status = patch.status ?? entry.status;
    return {
      ...entry,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.note === undefined ? {} : { note: patch.note }),
      status,
      updatedAt: now,
      completedAt: status === "done" ? (entry.completedAt ?? now) : null,
    };
  });
}

export function currentItemFor(items: readonly WorkItem[], agentId: string): WorkItem | null {
  let current: WorkItem | null = null;
  for (const entry of items) {
    if (entry.agentId !== agentId || entry.status === "done") continue;
    if (!current || entry.updatedAt > current.updatedAt) current = entry;
  }
  return current;
}

export function applyTodos(
  items: readonly WorkItem[],
  agentId: string,
  todos: readonly TodoEntry[],
  now: string,
): readonly WorkItem[] {
  const current = currentItemFor(items, agentId);
  if (!current) return items;
  const progress = { done: todos.filter((todo) => todo.completed).length, total: todos.length };
  const active = todos.find((todo) => todo.status === "in_progress" && !todo.completed);
  const currentStep = active ? (active.activeForm ?? active.text) : null;
  if (
    current.progress?.done === progress.done &&
    current.progress.total === progress.total &&
    current.currentStep === currentStep
  ) {
    return items;
  }
  return items.map((entry) =>
    entry.id === current.id ? { ...entry, progress, currentStep, updatedAt: now } : entry,
  );
}

export function applyPullRequest(
  items: readonly WorkItem[],
  workspaceId: string,
  pr: WorkspacePullRequest,
  now: string,
): readonly WorkItem[] {
  let changed = false;
  const next = items.map((entry) => {
    if (entry.workspaceId !== workspaceId || entry.status === "done") return entry;
    if (entry.pr && entry.pr.url !== pr.url) return entry;
    if (pr.isMerged) {
      if (!entry.pr) return entry;
      changed = true;
      return {
        ...entry,
        status: "done" as const,
        pr: { ...entry.pr, merged: true },
        updatedAt: now,
        completedAt: now,
      };
    }
    if (entry.pr) return entry;
    changed = true;
    return {
      ...entry,
      pr: { url: pr.url, number: pr.number ?? null, merged: false },
      updatedAt: now,
    };
  });
  return changed ? next : items;
}

export function pruneWorkItems(items: readonly WorkItem[], now: string): readonly WorkItem[] {
  const cutoff = Date.parse(now) - DONE_RETENTION_MS;
  const kept = items.filter(
    (entry) =>
      entry.status !== "done" || !entry.completedAt || Date.parse(entry.completedAt) >= cutoff,
  );
  return kept.length === items.length ? items : kept;
}
