/**
 * Workspace manager (SPEC §4.2, §9).
 */
import { join, resolve, SEPARATOR } from "@std/path";
import type { HooksConfig } from "../config/config.ts";
import type { Logger } from "../observability/logger.ts";
import { truncate } from "../observability/logger.ts";

export type HookName = "after_create" | "before_run" | "after_run" | "before_remove";

export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export interface HookResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  output: string;
}

export class WorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

const ALLOWED = /^[A-Za-z0-9._-]+$/;

/** §4.2 / §9.5 invariant 3: sanitized identifier plus a 64-bit hash suffix when sanitizing changed it. */
export async function workspaceKey(identifier: string): Promise<string> {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  if (sanitized === identifier && sanitized !== "") return sanitized;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identifier));
  const hex = Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${sanitized === "" ? "issue" : sanitized}-${hex}`;
}

/** §9.5 invariant 2: `path` must be a descendant of `root` (both absolute, normalized). */
export function isInsideRoot(root: string, path: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  const prefix = normalizedRoot.endsWith(SEPARATOR) ? normalizedRoot : normalizedRoot + SEPARATOR;
  return normalizedPath.startsWith(prefix);
}

export interface WorkspaceManagerOptions {
  root: string;
  hooks: HooksConfig;
  logger: Logger;
  /** Shell used for hooks; defaults to `bash -lc` (§9.4). */
  shell?: string[];
}

export class WorkspaceManager {
  #root: string;
  #hooks: HooksConfig;
  #logger: Logger;
  #shell: string[];

  constructor(options: WorkspaceManagerOptions) {
    this.#root = resolve(options.root);
    this.#hooks = options.hooks;
    this.#logger = options.logger;
    this.#shell = options.shell ?? ["bash", "-lc"];
  }

  get root(): string {
    return this.#root;
  }

  /** Re-applies reloaded `workspace`/`hooks` config for future operations (§6.2). */
  updateConfig(root: string, hooks: HooksConfig): void {
    this.#root = resolve(root);
    this.#hooks = hooks;
  }

  async pathFor(identifier: string): Promise<{ path: string; workspaceKey: string }> {
    const key = await workspaceKey(identifier);
    if (!ALLOWED.test(key)) {
      throw new WorkspaceError(
        `workspace key ${JSON.stringify(key)} contains disallowed characters`,
      );
    }
    const path = join(this.#root, key);
    if (!isInsideRoot(this.#root, path)) {
      throw new WorkspaceError(`workspace path ${path} escapes workspace root ${this.#root}`);
    }
    return { path, workspaceKey: key };
  }

  /** §9.2: create or reuse the per-issue directory; run `after_create` only on creation. */
  async createForIssue(identifier: string): Promise<Workspace> {
    const { path, workspaceKey } = await this.pathFor(identifier);
    let createdNow = false;
    try {
      const stat = await Deno.stat(path);
      if (!stat.isDirectory) {
        // Policy: an existing non-directory at the workspace location is a hard failure.
        throw new WorkspaceError(`workspace path ${path} exists and is not a directory`);
      }
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      if (!(err instanceof Deno.errors.NotFound)) {
        throw new WorkspaceError(`cannot stat workspace ${path}: ${(err as Error).message}`, {
          cause: err,
        });
      }
      try {
        await Deno.mkdir(path, { recursive: true });
      } catch (mkErr) {
        throw new WorkspaceError(`cannot create workspace ${path}: ${(mkErr as Error).message}`, {
          cause: mkErr,
        });
      }
      createdNow = true;
    }

    if (createdNow && this.#hooks.afterCreate !== null) {
      const result = await this.runHook("after_create", path);
      if (!result.ok) {
        // Failure aborts workspace creation; remove the partially prepared directory (§9.3).
        await Deno.remove(path, { recursive: true }).catch(() => {});
        throw new WorkspaceError(
          `after_create hook ${result.timedOut ? "timed out" : `failed with code ${result.code}`}`,
        );
      }
    }
    return { path, workspaceKey, createdNow };
  }

  /** Removes the workspace for a terminal issue, running `before_remove` best-effort (§9.4). */
  async remove(identifier: string): Promise<boolean> {
    const { path } = await this.pathFor(identifier);
    let exists = false;
    try {
      exists = (await Deno.stat(path)).isDirectory;
    } catch {
      exists = false;
    }
    if (!exists) return false;
    if (this.#hooks.beforeRemove !== null) {
      await this.runHook("before_remove", path);
    }
    await Deno.remove(path, { recursive: true });
    return true;
  }

  /** Runs one configured hook in the workspace; returns `ok: true` when the hook is unset. */
  async runHook(name: HookName, cwd: string): Promise<HookResult> {
    const script = this.#scriptFor(name);
    if (script === null) return { ok: true, code: 0, timedOut: false, output: "" };
    const log = this.#logger.child({ hook: name, cwd });
    log.info("hook started");
    const [cmd, ...args] = this.#shell;
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(cmd, {
        args: [...args, script],
        cwd,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (err) {
      log.error("hook failed to spawn", { error: (err as Error).message });
      return { ok: false, code: null, timedOut: false, output: (err as Error).message };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, this.#hooks.timeoutMs);
    const output = await child.output();
    clearTimeout(timer);
    const text = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
    const ok = output.success && !timedOut;
    if (ok) {
      log.info("hook completed", { code: output.code });
    } else {
      log.warn(timedOut ? "hook timed out" : "hook failed", {
        code: output.code,
        timeout_ms: this.#hooks.timeoutMs,
        output: truncate(text.trim(), 1000),
      });
    }
    return { ok, code: output.code, timedOut, output: text };
  }

  #scriptFor(name: HookName): string | null {
    switch (name) {
      case "after_create":
        return this.#hooks.afterCreate;
      case "before_run":
        return this.#hooks.beforeRun;
      case "after_run":
        return this.#hooks.afterRun;
      case "before_remove":
        return this.#hooks.beforeRemove;
    }
  }
}
