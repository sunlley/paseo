import { describe, expect, it } from "vitest";
import { isWorkItemToolRequest } from "./permissions.js";

describe("isWorkItemToolRequest", () => {
  it("matches the plugin's tools by bare and provider-prefixed name", () => {
    expect(isWorkItemToolRequest({ kind: "tool", name: "create_work_item" })).toBe(true);
    expect(isWorkItemToolRequest({ kind: "tool", name: "mcp__paseo__update_work_item" })).toBe(
      true,
    );
    expect(isWorkItemToolRequest({ kind: "tool", name: "mcp__paseo__list_work_items" })).toBe(true);
  });

  it("leaves every other request to the user", () => {
    expect(isWorkItemToolRequest({ kind: "tool", name: "Bash" })).toBe(false);
    expect(isWorkItemToolRequest({ kind: "tool", name: "mcp__paseo__create_agent" })).toBe(false);
    expect(isWorkItemToolRequest({ kind: "tool", name: "recreate_work_item" })).toBe(false);
    expect(isWorkItemToolRequest({ kind: "question", name: "create_work_item" })).toBe(false);
  });
});
