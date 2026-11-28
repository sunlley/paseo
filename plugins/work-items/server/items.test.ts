import { describe, expect, it } from "vitest";
import type { WorkItem } from "../shared/work-items.js";
import {
  applyPullRequest,
  applyTodos,
  createWorkItem,
  currentItemFor,
  pruneWorkItems,
  updateWorkItem,
} from "./items.js";

const T0 = "2026-11-24T10:00:00.000Z";
const T1 = "2026-11-24T10:05:00.000Z";

function item(input: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: input.id,
    kind: "feature",
    status: "in_progress",
    agentId: "agent-1",
    workspaceId: "ws-1",
    note: null,
    progress: null,
    currentStep: null,
    pr: null,
    createdAt: T0,
    updatedAt: T0,
    completedAt: null,
    ...input,
  };
}

describe("createWorkItem", () => {
  it("records the calling agent and workspace and starts in progress", () => {
    const items = createWorkItem([], {
      id: "w1",
      now: T0,
      title: "Desktop work items pill",
      kind: "feature",
      agentId: "agent-1",
      workspaceId: "ws-1",
    });
    expect(items).toEqual([
      item({ id: "w1", title: "Desktop work items pill", createdAt: T0, updatedAt: T0 }),
    ]);
  });
});

describe("updateWorkItem", () => {
  it("changes status and note, and stamps completion when done", () => {
    const items = updateWorkItem(
      [item({ id: "w1" })],
      "w1",
      { status: "done", note: "merged" },
      T1,
    );
    expect(items[0]).toEqual(
      item({ id: "w1", status: "done", note: "merged", updatedAt: T1, completedAt: T1 }),
    );
  });

  it("clears the completion stamp when a done item is reopened", () => {
    const items = updateWorkItem(
      [item({ id: "w1", status: "done", completedAt: T0 })],
      "w1",
      { status: "blocked" },
      T1,
    );
    expect(items[0]).toMatchObject({ status: "blocked", completedAt: null, updatedAt: T1 });
  });

  it("throws for an unknown id", () => {
    expect(() => updateWorkItem([], "missing", { status: "done" }, T1)).toThrow(
      "No work item with id missing",
    );
  });
});

describe("currentItemFor", () => {
  it("picks the agent's most recently updated open item", () => {
    const items = [
      item({ id: "old", updatedAt: T0 }),
      item({ id: "new", updatedAt: T1 }),
      item({ id: "done", status: "done", updatedAt: "2026-11-24T11:00:00.000Z" }),
      item({ id: "other", agentId: "agent-2", updatedAt: "2026-11-24T12:00:00.000Z" }),
    ];
    expect(currentItemFor(items, "agent-1")?.id).toBe("new");
    expect(currentItemFor(items, "agent-3")).toBeNull();
  });
});

describe("applyTodos", () => {
  it("mirrors the agent's todo list onto its current item", () => {
    const items = applyTodos(
      [item({ id: "w1" })],
      "agent-1",
      [
        { text: "Read docs", completed: true },
        {
          text: "Write store",
          completed: false,
          status: "in_progress",
          activeForm: "Writing store",
        },
        { text: "Ship", completed: false },
      ],
      T1,
    );
    expect(items[0]).toMatchObject({
      progress: { done: 1, total: 3 },
      currentStep: "Writing store",
      updatedAt: T1,
    });
  });

  it("returns the same array when nothing changed, so no write happens", () => {
    const before = [item({ id: "w1", progress: { done: 1, total: 1 }, currentStep: null })];
    expect(applyTodos(before, "agent-1", [{ text: "Done", completed: true }], T1)).toBe(before);
    expect(applyTodos(before, "agent-2", [{ text: "x", completed: false }], T1)).toBe(before);
  });
});

describe("applyPullRequest", () => {
  const open = { url: "https://github.com/o/r/pull/7", number: 7, isMerged: false };

  it("attaches the workspace's open PR to its active items", () => {
    const items = applyPullRequest(
      [
        item({ id: "w1" }),
        item({ id: "w2", status: "done" }),
        item({ id: "w3", workspaceId: "ws-2" }),
      ],
      "ws-1",
      open,
      T1,
    );
    expect(items.map((entry) => [entry.id, entry.pr?.number ?? null])).toEqual([
      ["w1", 7],
      ["w2", null],
      ["w3", null],
    ]);
  });

  it("completes items whose PR merged", () => {
    const items = applyPullRequest(
      [item({ id: "w1", status: "needs_review", pr: { url: open.url, number: 7, merged: false } })],
      "ws-1",
      { ...open, isMerged: true },
      T1,
    );
    expect(items[0]).toMatchObject({
      status: "done",
      completedAt: T1,
      pr: { url: open.url, number: 7, merged: true },
    });
  });
});

describe("pruneWorkItems", () => {
  it("drops items done more than 30 days ago and keeps everything else", () => {
    const now = "2026-12-30T00:00:00.000Z";
    const items = [
      item({ id: "old-done", status: "done", completedAt: "2026-11-01T00:00:00.000Z" }),
      item({ id: "recent-done", status: "done", completedAt: "2026-12-20T00:00:00.000Z" }),
      item({ id: "old-open", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(pruneWorkItems(items, now).map((entry) => entry.id)).toEqual([
      "recent-done",
      "old-open",
    ]);
  });
});
