export const WORK_ITEM_TOOLS = ["create_work_item", "update_work_item", "list_work_items"] as const;

/**
 * The work-item tools only touch this plugin's own file, so asking the user to approve every
 * status change just interrupts them. Providers prefix MCP tools (`mcp__paseo__…`), so match the
 * bare name or a `__`-separated suffix, never a substring.
 */
export function isWorkItemToolRequest(request: { kind: string; name: string }): boolean {
  if (request.kind !== "tool") return false;
  return WORK_ITEM_TOOLS.some(
    (tool) => request.name === tool || request.name.endsWith(`__${tool}`),
  );
}
