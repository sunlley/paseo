import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WorkItemFileSchema, type WorkItem } from "../shared/work-items.js";

type Listener = (items: readonly WorkItem[]) => void;

/**
 * One JSON file, written atomically (temp file + rename). Mutations run one at a time so two
 * tool calls never lose each other's write. A file that fails to parse is left untouched and
 * every write fails until someone looks at it, instead of silently starting from empty.
 */
export class WorkItemStore {
  private items: readonly WorkItem[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly file: string) {}

  async list(): Promise<readonly WorkItem[]> {
    return this.load();
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  mutate(
    change: (items: readonly WorkItem[]) => readonly WorkItem[],
  ): Promise<readonly WorkItem[]> {
    const run = this.queue.then(async () => {
      const before = await this.load();
      const after = change(before);
      if (after === before) return before;
      await this.write(after);
      this.items = after;
      for (const listener of this.listeners) listener(after);
      return after;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<readonly WorkItem[]> {
    if (this.items) return this.items;
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.items = [];
      return this.items;
    }
    this.items = WorkItemFileSchema.parse(JSON.parse(text)).items;
    return this.items;
  }

  private async write(items: readonly WorkItem[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, items }, null, 2)}\n`, "utf8");
    await rename(temp, this.file);
  }
}
