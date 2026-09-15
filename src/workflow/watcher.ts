import { basename, dirname } from "@std/path";
import { loadWorkflow, type WorkflowDefinition } from "./loader.ts";
import type { Logger } from "../observability/logger.ts";

export interface WorkflowWatcherOptions {
  path: string;
  currentSource: string;
  onReload: (definition: WorkflowDefinition) => void | Promise<void>;
  onError: (error: Error) => void;
  logger: Logger;
  debounceMs?: number;
}

export class WorkflowWatcher {
  #options: WorkflowWatcherOptions;
  #watcher: Deno.FsWatcher | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #source: string;
  #reloading: Promise<void> | null = null;
  #stopped = false;

  constructor(options: WorkflowWatcherOptions) {
    this.#options = options;
    this.#source = options.currentSource;
  }

  start(): void {
    const dir = dirname(this.#options.path);
    const file = basename(this.#options.path);
    try {
      // Watch the directory: editors typically replace the file by rename.
      this.#watcher = Deno.watchFs(dir, { recursive: false });
    } catch (err) {
      this.#options.logger.warn("workflow watch unavailable; relying on per-tick reload checks", {
        error: (err as Error).message,
      });
      return;
    }
    this.#consume(this.#watcher, file).catch((err) => {
      if (!this.#stopped) {
        this.#options.logger.warn("workflow watcher stopped", { error: (err as Error).message });
      }
    });
  }

  async #consume(watcher: Deno.FsWatcher, file: string): Promise<void> {
    for await (const event of watcher) {
      if (this.#stopped) break;
      if (!event.paths.some((p) => basename(p) === file)) continue;
      if (this.#timer !== null) clearTimeout(this.#timer);
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.reloadIfChanged().catch(() => {});
      }, this.#options.debounceMs ?? 250);
    }
  }

  reloadIfChanged(): Promise<void> {
    if (this.#reloading) return this.#reloading;
    this.#reloading = this.#reload().finally(() => {
      this.#reloading = null;
    });
    return this.#reloading;
  }

  async #reload(): Promise<void> {
    if (this.#stopped) return;
    let definition: WorkflowDefinition;
    try {
      definition = await loadWorkflow(this.#options.path);
    } catch (err) {
      this.#options.onError(err as Error);
      return;
    }
    if (definition.source === this.#source) return;
    try {
      await this.#options.onReload(definition);
      this.#source = definition.source;
      this.#options.logger.info("workflow reloaded", { path: definition.path });
    } catch (err) {
      this.#options.onError(err as Error);
    }
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    try {
      this.#watcher?.close();
    } catch {
      // already closed
    }
    this.#watcher = null;
  }
}
