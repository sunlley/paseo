import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkItem } from "./items.js";
import { WorkItemStore } from "./store.js";

const NOW = "2026-11-24T10:00:00.000Z";
let dir: string;
const ids = (items: readonly { id: string }[]) => items.map((entry) => entry.id);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "work-items-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function add(id: string) {
  return (items: Parameters<typeof createWorkItem>[0]) =>
    createWorkItem(items, { id, now: NOW, title: id, kind: "bug", agentId: "a", workspaceId: "w" });
}

describe("WorkItemStore", () => {
  it("persists mutations and reloads them", async () => {
    const file = join(dir, "work-items.json");
    const store = new WorkItemStore(file);
    await store.mutate(add("w1"));
    const reopened = new WorkItemStore(file);
    expect((await reopened.list()).map((entry) => entry.id)).toEqual(["w1"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      version: 1,
      items: [{ id: "w1" }],
    });
  });

  it("serializes concurrent mutations and notifies listeners once per change", async () => {
    const store = new WorkItemStore(join(dir, "work-items.json"));
    const seen: string[][] = [];
    store.onChange((items) => seen.push(ids(items)));
    await Promise.all([store.mutate(add("w1")), store.mutate(add("w2"))]);
    await store.mutate((items) => items);
    expect(seen).toEqual([["w1"], ["w1", "w2"]]);
  });

  it("starts empty from a missing file and refuses to overwrite an unreadable one", async () => {
    expect(await new WorkItemStore(join(dir, "missing.json")).list()).toEqual([]);
    const broken = join(dir, "broken.json");
    await writeFile(broken, "{not json");
    await expect(new WorkItemStore(broken).mutate(add("w1"))).rejects.toThrow();
    expect(await readFile(broken, "utf8")).toBe("{not json");
  });
});
