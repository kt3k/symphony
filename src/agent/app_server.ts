/**
 * Codex app-server client (SPEC §10). Speaks newline-delimited JSON-RPC over the subprocess stdio
 * of `bash -lc <codex.command>` started in the per-issue workspace.
 *
 * Trust posture (high-trust, documented in README): every approval request from the app-server is
 * auto-accepted for the session, user-input requests fail the turn, and dynamic tool calls are
 * routed to the tracker adapter host-side.
 */
import { TextLineStream } from "@std/streams";
import type { ToolResult, ToolSpec } from "../tracker/types.ts";
import type { Logger } from "../observability/logger.ts";
import { truncate } from "../observability/logger.ts";
import { nowIso, withTimeout } from "../util/time.ts";

export const SYMPHONY_VERSION = "0.1.0";
const MAX_LINE_BYTES = 10 * 1024 * 1024;

export type AgentErrorCode =
  | "codex_not_found"
  | "invalid_workspace_cwd"
  | "response_timeout"
  | "turn_timeout"
  | "port_exit"
  | "response_error"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_input_required";

export class AgentError extends Error {
  constructor(readonly code: AgentErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentError";
  }
}

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/** Runtime event emitted upstream to the orchestrator (§10.4). */
export interface AgentEvent {
  event: string;
  timestamp: string;
  codex_app_server_pid: number | null;
  /** Absolute thread totals when the event carries them (§13.5). */
  usage?: UsageTotals | null;
  rate_limits?: unknown;
  message?: string;
  thread_id?: string;
  turn_id?: string;
  session_id?: string;
  method?: string;
}

export interface AppServerSessionOptions {
  command: string;
  cwd: string;
  /** Full child environment (already stripped of tracker secrets). */
  env: Record<string, string>;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  readTimeoutMs: number;
  turnTimeoutMs: number;
  /** `<issue.identifier>: <issue.title>` (§10.2). */
  title: string;
  tools: ToolSpec[];
  executeTool: (name: string, args: unknown) => Promise<ToolResult>;
  onEvent: (event: AgentEvent) => void;
  logger: Logger;
  shell?: string[];
}

export interface TurnOutcome {
  turnId: string;
}

export interface AgentSession {
  readonly threadId: string;
  readonly pid: number | null;
  runTurn(text: string): Promise<TurnOutcome>;
  stop(): Promise<void>;
}

export type AgentSessionFactory = (options: AppServerSessionOptions) => Promise<AgentSession>;

type JsonObject = Record<string, unknown>;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface TurnRecord {
  status: string;
  errorMessage: string | null;
}

interface TurnWaiter {
  resolve: (record: TurnRecord) => void;
  reject: (error: Error) => void;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Extracts absolute thread totals from a `thread/tokenUsage/updated` payload (§13.5). */
export function usageFromTokenUsage(params: unknown): UsageTotals | null {
  if (!isObject(params)) return null;
  const tokenUsage = params["tokenUsage"];
  if (!isObject(tokenUsage)) return null;
  const total = isObject(tokenUsage["total"]) ? tokenUsage["total"] : null;
  if (total === null) return null;
  return {
    input_tokens: asNumber(total["inputTokens"] ?? total["input_tokens"]),
    output_tokens: asNumber(total["outputTokens"] ?? total["output_tokens"]),
    total_tokens: asNumber(total["totalTokens"] ?? total["total_tokens"]),
  };
}

export class AppServerSession implements AgentSession {
  readonly #options: AppServerSessionOptions;
  readonly #log: Logger;
  #child!: Deno.ChildProcess;
  #writer!: WritableStreamDefaultWriter<Uint8Array>;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #turnWaiters = new Map<string, TurnWaiter>();
  #completedTurns = new Map<string, TurnRecord>();
  #exitStatus: Deno.CommandStatus | null = null;
  #exitPromise!: Promise<void>;
  #threadId = "";
  #turnTimer: ReturnType<typeof setTimeout> | null = null;
  #activeTurn: { id: string | null; reject: (error: Error) => void } | null = null;
  #lastErrorMessage: string | null = null;
  #inputRequired = false;
  #firstTurn = true;
  #stopped = false;

  private constructor(options: AppServerSessionOptions) {
    this.#options = options;
    this.#log = options.logger;
  }

  get threadId(): string {
    return this.#threadId;
  }

  get pid(): number | null {
    return this.#child?.pid ?? null;
  }

  static async start(options: AppServerSessionOptions): Promise<AppServerSession> {
    const session = new AppServerSession(options);
    await session.#launch();
    try {
      await session.#handshake();
    } catch (err) {
      session.#emit({ event: "startup_failed", message: (err as Error).message });
      await session.stop();
      throw err;
    }
    return session;
  }

  async #launch(): Promise<void> {
    const { cwd, command, env } = this.#options;
    try {
      const stat = await Deno.stat(cwd);
      if (!stat.isDirectory) throw new Error("not a directory");
    } catch (err) {
      throw new AgentError(
        "invalid_workspace_cwd",
        `workspace cwd ${cwd} is unusable: ${(err as Error).message}`,
      );
    }
    const [shell, ...shellArgs] = this.#options.shell ?? ["bash", "-lc"];
    try {
      this.#child = new Deno.Command(shell, {
        args: [...shellArgs, command],
        cwd,
        env,
        clearEnv: true,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (err) {
      throw new AgentError("port_exit", `failed to spawn app-server: ${(err as Error).message}`, {
        cause: err,
      });
    }
    this.#writer = this.#child.stdin.getWriter();
    this.#exitPromise = this.#child.status.then((status) => {
      this.#exitStatus = status;
      this.#onExit(status);
    });
    this.#readStdout();
    this.#readStderr();
  }

  async #handshake(): Promise<void> {
    await this.#request("initialize", {
      clientInfo: { name: "symphony", title: "Symphony", version: SYMPHONY_VERSION },
      capabilities: { experimentalApi: true },
    });
    await this.#notify("initialized", {});
    const threadParams: JsonObject = {
      cwd: this.#options.cwd,
      approvalPolicy: this.#options.approvalPolicy,
      sandbox: this.#options.threadSandbox,
    };
    if (this.#options.tools.length > 0) {
      threadParams["dynamicTools"] = this.#options.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    }
    const started = await this.#request("thread/start", threadParams);
    const thread = isObject(started) && isObject(started["thread"]) ? started["thread"] : null;
    const threadId = thread ? asString(thread["id"]) : null;
    if (threadId === null) {
      throw new AgentError("response_error", "thread/start response did not include a thread id");
    }
    this.#threadId = threadId;
    try {
      await this.#request("thread/name/set", { threadId, name: this.#options.title });
    } catch (err) {
      this.#log.debug("thread/name/set not applied", { error: (err as Error).message });
    }
  }

  async runTurn(text: string): Promise<TurnOutcome> {
    if (this.#exitStatus !== null || this.#stopped) {
      throw new AgentError("port_exit", "app-server is not running");
    }
    if (this.#activeTurn !== null) {
      throw new AgentError("response_error", "a turn is already active");
    }

    const record = await new Promise<TurnRecord>((resolve, reject) => {
      this.#activeTurn = { id: null, reject };
      this.#lastErrorMessage = null;
      this.#inputRequired = false;
      this.#armTurnTimer();

      this.#request("turn/start", {
        threadId: this.#threadId,
        input: [{ type: "text", text }],
        cwd: this.#options.cwd,
        approvalPolicy: this.#options.approvalPolicy,
        sandboxPolicy: this.#options.turnSandboxPolicy,
      }).then((result) => {
        const turn = isObject(result) && isObject(result["turn"]) ? result["turn"] : null;
        const turnId = turn ? asString(turn["id"]) : null;
        if (turnId === null) {
          reject(new AgentError("response_error", "turn/start response did not include a turn id"));
          return;
        }
        if (this.#activeTurn) this.#activeTurn.id = turnId;
        const sessionId = `${this.#threadId}-${turnId}`;
        this.#emit({
          event: this.#firstTurn ? "session_started" : "turn_started",
          thread_id: this.#threadId,
          turn_id: turnId,
          session_id: sessionId,
        });
        this.#firstTurn = false;
        const done = this.#completedTurns.get(turnId);
        if (done) {
          this.#completedTurns.delete(turnId);
          resolve(done);
          return;
        }
        this.#turnWaiters.set(turnId, { resolve, reject });
      }, reject);
    }).finally(() => {
      this.#clearTurnTimer();
      const turnId = this.#activeTurn?.id;
      if (turnId) this.#turnWaiters.delete(turnId);
      this.#activeTurn = null;
    });

    const turnId = record === undefined ? "" : (this.#lastTurnId ?? "");
    switch (record.status) {
      case "completed":
        this.#emit({ event: "turn_completed", turn_id: turnId, thread_id: this.#threadId });
        return { turnId };
      case "failed": {
        const message = record.errorMessage ?? this.#lastErrorMessage ?? "turn failed";
        this.#emit({ event: "turn_failed", turn_id: turnId, message });
        throw new AgentError("turn_failed", message);
      }
      case "interrupted":
        this.#emit({ event: "turn_cancelled", turn_id: turnId });
        throw new AgentError("turn_cancelled", "turn was interrupted");
      default:
        throw new AgentError("response_error", `unexpected turn status ${record.status}`);
    }
  }

  #lastTurnId: string | null = null;

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#clearTurnTimer();
    try {
      await this.#writer.close();
    } catch {
      // stdin already closed
    }
    if (this.#exitStatus === null) {
      try {
        this.#child.kill("SIGTERM");
      } catch {
        // already gone
      }
      const graceful = new Promise<void>((resolve) => setTimeout(resolve, 2000));
      await Promise.race([this.#exitPromise, graceful]);
      if (this.#exitStatus === null) {
        try {
          this.#child.kill("SIGKILL");
        } catch {
          // already gone
        }
        await this.#exitPromise.catch(() => {});
      }
    }
  }

  // ---- transport ---------------------------------------------------------------------------

  async #send(message: JsonObject): Promise<void> {
    const line = JSON.stringify(message) + "\n";
    try {
      await this.#writer.write(new TextEncoder().encode(line));
    } catch (err) {
      throw this.#exitError(`cannot write to app-server: ${(err as Error).message}`);
    }
  }

  #notify(method: string, params: JsonObject): Promise<void> {
    return this.#send({ method, params });
  }

  #request(method: string, params: JsonObject): Promise<unknown> {
    const id = this.#nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    const sent = this.#send({ id, method, params }).catch((err) => {
      this.#pending.delete(id);
      throw err;
    });
    return sent.then(() =>
      withTimeout(
        promise,
        this.#options.readTimeoutMs,
        () => {
          this.#pending.delete(id);
          return new AgentError(
            "response_timeout",
            `${method} timed out after ${this.#options.readTimeoutMs}ms`,
          );
        },
      )
    );
  }

  #exitError(message: string): AgentError {
    const code = this.#exitStatus?.code;
    if (code === 127) {
      return new AgentError("codex_not_found", `app-server command not found (exit 127)`);
    }
    return new AgentError("port_exit", code === undefined ? message : `${message} (exit ${code})`);
  }

  #onExit(status: Deno.CommandStatus): void {
    this.#log.debug("app-server exited", { code: status.code, signal: status.signal });
    const error = this.#exitError(`app-server exited with code ${status.code}`);
    for (const [, pending] of this.#pending) pending.reject(error);
    this.#pending.clear();
    for (const [, waiter] of this.#turnWaiters) waiter.reject(error);
    this.#turnWaiters.clear();
    this.#activeTurn?.reject(error);
  }

  async #readStdout(): Promise<void> {
    try {
      const lines = this.#child.stdout
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TextLineStream());
      for await (const line of lines) {
        if (line.trim() === "") continue;
        if (line.length > MAX_LINE_BYTES) {
          this.#emit({ event: "malformed", message: `line exceeds ${MAX_LINE_BYTES} bytes` });
          continue;
        }
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          this.#emit({ event: "malformed", message: truncate(line, 200) });
          continue;
        }
        this.#armTurnTimer();
        this.#dispatch(message);
      }
    } catch (err) {
      this.#log.debug("app-server stdout closed", { error: (err as Error).message });
    }
  }

  async #readStderr(): Promise<void> {
    try {
      const lines = this.#child.stderr
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TextLineStream());
      for await (const line of lines) {
        if (line.trim() !== "") this.#log.debug("app-server stderr", { line: truncate(line, 500) });
      }
    } catch {
      // stream closed
    }
  }

  #dispatch(message: unknown): void {
    if (!isObject(message)) {
      this.#emit({ event: "malformed", message: "non-object JSON message" });
      return;
    }
    const method = asString(message["method"]);
    const hasId = message["id"] !== undefined && message["id"] !== null;
    if (hasId && method !== null) {
      this.#handleServerRequest(message["id"] as string | number, method, message["params"]);
    } else if (hasId) {
      this.#handleResponse(message);
    } else if (method !== null) {
      this.#handleNotification(method, message["params"]);
    } else {
      this.#emit({ event: "other_message", message: truncate(JSON.stringify(message), 200) });
    }
  }

  #handleResponse(message: JsonObject): void {
    const id = message["id"];
    const pending = typeof id === "number" ? this.#pending.get(id) : undefined;
    if (!pending) {
      this.#emit({ event: "other_message", message: `response for unknown request ${String(id)}` });
      return;
    }
    this.#pending.delete(id as number);
    if (message["error"] !== undefined && message["error"] !== null) {
      const error = message["error"];
      const text = isObject(error)
        ? asString(error["message"]) ?? JSON.stringify(error)
        : String(error);
      pending.reject(new AgentError("response_error", text));
    } else {
      pending.resolve(message["result"]);
    }
  }

  #handleNotification(method: string, params: unknown): void {
    const p = isObject(params) ? params : {};
    switch (method) {
      case "thread/tokenUsage/updated": {
        const usage = usageFromTokenUsage(p);
        this.#emit({
          event: "token_usage",
          method,
          usage,
          turn_id: asString(p["turnId"]) ?? undefined,
        });
        return;
      }
      case "account/rateLimits/updated":
        this.#emit({ event: "rate_limits", method, rate_limits: p["rateLimits"] ?? null });
        return;
      case "turn/completed": {
        const turn = isObject(p["turn"]) ? p["turn"] : {};
        const turnId = asString(turn["id"]);
        const status = asString(turn["status"]) ?? "completed";
        const error = isObject(turn["error"]) ? asString(turn["error"]["message"]) : null;
        if (turnId === null) return;
        const record: TurnRecord = { status, errorMessage: error };
        this.#lastTurnId = turnId;
        const waiter = this.#turnWaiters.get(turnId);
        if (waiter) {
          this.#turnWaiters.delete(turnId);
          waiter.resolve(record);
        } else {
          this.#completedTurns.set(turnId, record);
        }
        return;
      }
      case "error": {
        const error = isObject(p["error"]) ? p["error"] : {};
        const text = asString(error["message"]) ?? "unknown error";
        if (p["willRetry"] !== true) this.#lastErrorMessage = text;
        this.#emit({
          event: "turn_ended_with_error",
          method,
          message: text,
          turn_id: asString(p["turnId"]) ?? undefined,
        });
        return;
      }
      case "item/completed": {
        const item = isObject(p["item"]) ? p["item"] : {};
        const type = asString(item["type"]);
        const text = type === "agentMessage" ? asString(item["text"]) : null;
        this.#emit({
          event: "notification",
          method,
          message: text !== null ? truncate(text, 300) : `${type ?? "item"} completed`,
        });
        return;
      }
      default:
        if (method.endsWith("/delta") || method.endsWith("/outputDelta")) {
          // High-volume streaming payloads still count as activity but stay out of the logs.
          this.#emit({ event: "notification", method });
          return;
        }
        this.#emit({ event: "notification", method, message: method });
    }
  }

  #handleServerRequest(id: string | number, method: string, params: unknown): void {
    const p = isObject(params) ? params : {};
    const respond = (result: JsonObject) => this.#send({ id, result }).catch(() => {});
    const fail = (code: number, message: string) =>
      this.#send({ id, error: { code, message } }).catch(() => {});

    switch (method) {
      case "item/commandExecution/requestApproval":
        this.#emit({
          event: "approval_auto_approved",
          method,
          message: truncate(asString(p["command"]) ?? "", 200),
        });
        respond({ decision: "acceptForSession" });
        return;
      case "item/fileChange/requestApproval":
        this.#emit({
          event: "approval_auto_approved",
          method,
          message: asString(p["reason"]) ?? "file change",
        });
        respond({ decision: "acceptForSession" });
        return;
      case "execCommandApproval":
      case "applyPatchApproval":
        this.#emit({ event: "approval_auto_approved", method });
        respond({ decision: "approved_for_session" });
        return;
      case "item/permissions/requestApproval": {
        const requested = isObject(p["permissions"]) ? p["permissions"] : {};
        const granted: JsonObject = {};
        for (const [key, value] of Object.entries(requested)) {
          if (value !== null && value !== undefined) granted[key] = value;
        }
        this.#emit({
          event: "approval_auto_approved",
          method,
          message: asString(p["reason"]) ?? "permissions",
        });
        respond({ permissions: granted });
        return;
      }
      case "item/tool/call": {
        const tool = asString(p["tool"]) ?? "";
        const known = this.#options.tools.some((spec) => spec.name === tool);
        if (!known) {
          this.#emit({ event: "unsupported_tool_call", method, message: tool });
          respond({
            success: false,
            contentItems: [{ type: "inputText", text: `unsupported tool: ${tool}` }],
          });
          return;
        }
        this.#emit({ event: "tool_call", method, message: tool });
        this.#options.executeTool(tool, p["arguments"]).then(
          (result) =>
            respond({
              success: result.success,
              contentItems: [{ type: "inputText", text: JSON.stringify(result.output ?? null) }],
            }),
          (err) =>
            respond({
              success: false,
              contentItems: [{
                type: "inputText",
                text: `tool ${tool} failed: ${(err as Error).message}`,
              }],
            }),
        );
        return;
      }
      case "item/tool/requestUserInput": {
        this.#emit({ event: "turn_input_required", method });
        this.#inputRequired = true;
        fail(-32001, "Symphony runs unattended; user input is not available");
        const error = new AgentError("turn_input_required", "agent requested user input");
        this.#activeTurn?.reject(error);
        const turnId = this.#activeTurn?.id;
        if (turnId) {
          this.#notify("turn/interrupt", { threadId: this.#threadId, turnId }).catch(() => {});
        }
        return;
      }
      default:
        this.#emit({
          event: "other_message",
          method,
          message: `unsupported server request ${method}`,
        });
        fail(-32601, `method ${method} is not supported by Symphony`);
    }
  }

  // ---- timers & events ---------------------------------------------------------------------

  #armTurnTimer(): void {
    if (this.#activeTurn === null) return;
    this.#clearTurnTimer();
    this.#turnTimer = setTimeout(() => {
      const error = new AgentError(
        "turn_timeout",
        `no app-server output for ${this.#options.turnTimeoutMs}ms during turn`,
      );
      this.#activeTurn?.reject(error);
    }, this.#options.turnTimeoutMs);
  }

  #clearTurnTimer(): void {
    if (this.#turnTimer !== null) {
      clearTimeout(this.#turnTimer);
      this.#turnTimer = null;
    }
  }

  #emit(event: Omit<AgentEvent, "timestamp" | "codex_app_server_pid">): void {
    try {
      this.#options.onEvent({ ...event, timestamp: nowIso(), codex_app_server_pid: this.pid });
    } catch (err) {
      this.#log.warn("event handler failed", { error: (err as Error).message });
    }
  }
}

export const startAppServerSession: AgentSessionFactory = (options) =>
  AppServerSession.start(options);
