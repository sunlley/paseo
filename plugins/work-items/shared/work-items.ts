import { defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const WorkItemKindSchema = z.enum(["feature", "bug"]);
export const WorkItemStatusSchema = z.enum([
  "todo",
  "in_progress",
  "needs_review",
  "blocked",
  "done",
]);

export const WorkItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: WorkItemKindSchema,
  status: WorkItemStatusSchema,
  /** The agent (session) that created it; the composer pill of that agent shows it. */
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  /** A blocker, or what the user should check, in one line. */
  note: z.string().nullable(),
  /** Mirrors the creating agent's todo list (the "Tasks" pill), so agents never maintain it. */
  progress: z.object({ done: z.number().int(), total: z.number().int() }).nullable(),
  currentStep: z.string().nullable(),
  pr: z.object({ url: z.string(), number: z.number().nullable(), merged: z.boolean() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});

export type WorkItem = z.infer<typeof WorkItemSchema>;
export type WorkItemKind = z.infer<typeof WorkItemKindSchema>;
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

export const WorkItemFileSchema = z.object({
  version: z.literal(1),
  items: z.array(WorkItemSchema),
});

/** Every change pushes the whole list; it stays small because done items are pruned. */
export const watchWorkItems = defineSubscription({
  name: "work-items.watch",
  input: z.object({}),
  event: z.object({ items: z.array(WorkItemSchema) }),
});
