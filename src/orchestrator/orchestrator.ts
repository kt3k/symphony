import type { ServiceConfig } from "../config/config.ts";
import type { WorkflowDefinition } from "../workflow/loader.ts";
import {
  compareForDispatch,
  type Issue,
  issueRoutable,
  normalizeState,
  type TrackerAdapterFactory,
} from "../tracker/types.ts";
import { WorkspaceManager } from "../workspace/manager.ts";
import type { AgentEvent, AgentSessionFactory, UsageTotals } from "../agent/app_server.ts";
import { runAgentAttempt, WorkerError } from "../agent/runner.ts";
import type { Logger } from "../observability/logger.ts";
import type { EnvLookup } from "../util/env.ts";
import { monoMs, nowIso } from "../util/time.ts";
import { type EffectiveTracker, validateDispatchConfig } from "./validate.ts";

export const CONTINUATION_DELAY_MS = 1000;
export const RETRY_BASE_DELAY_MS = 10_000;

interface TokenCounters {
  input: number;
  output: number;
  total: number;
}

interface RunningEntry {
  issue: Issue;
  identifier: string;
  controller: AbortController;
  sessionId: string | null;
  pid: number | null;
  lastEvent: string | null;
  lastEventAt: string | null;
  lastEventMono: number | null;
  lastMessage: string | null;
  tokens: TokenCounters;
  lastReported: TokenCounters;
  retryAttempt: number | null;
  startedAt: string;
  startedMono: number;
  turnCount: number;
  lastError: string | null;
}

interface RetryEntry {
  issueId: string;
  identifier: string;
  url: string | null;
  attempt: number;
  dueAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  error: string | null;
}

export interface Snapshot {
  generated_at: string;
  counts: { running: number; retrying: number };
  running: Array<{
    issue_id: string;
    issue_identifier: string;
    issue_url: string | null;
    state: string;
    session_id: string | null;
    turn_count: number;
    last_event: string | null;
    last_message: string | null;
    started_at: string;
    last_event_at: string | null;
    tokens: UsageTotals;
  }>;
  retrying: Array<{
    issue_id: string;
    issue_identifier: string;
    issue_url: string | null;
    attempt: number;
    due_at: string;
    error: string | null;
  }>;
  codex_totals: UsageTotals & { seconds_running: number };
  rate_limits: unknown;
  last_validation_error: string | null;
  last_reload_error: string | null;
}

export interface OrchestratorDeps {
  logger: Logger;
  env: EnvLookup;
  parentEnv: Record<string, string>;
  startSession: AgentSessionFactory;
  trackerRegistry?: ReadonlyMap<string, TrackerAdapterFactory>;
  onStateChange?: () => void;
  refreshWorkflow?: () => Promise<void>;
}

export class Orchestrator {
  #config: ServiceConfig;
  #promptTemplate: string;
  #deps: OrchestratorDeps;
  #log: Logger;
  #workspaces: WorkspaceManager;
  #tracker: EffectiveTracker | null = null;
  /** Last successfully validated tracker; reconciliation keeps using it while validation fails. */
  #lastGoodTracker: EffectiveTracker | null = null;
  #lastValidationError: string | null = null;
  #lastReloadError: string | null = null;

  #pollIntervalMs: number;
  #maxConcurrentAgents: number;
  #running = new Map<string, RunningEntry>();
  #claimed = new Set<string>();
  #retryAttempts = new Map<string, RetryEntry>();
  #completed = new Set<string>();
  #codexTotals: TokenCounters = { input: 0, output: 0, total: 0 };
  #endedSeconds = 0;
  #rateLimits: unknown = null;

  #tickTimer: ReturnType<typeof setTimeout> | null = null;
  #lastTickEndMono: number | null = null;
  #ticking = false;
  #refreshRequested = false;
  #stopped = false;

  constructor(definition: WorkflowDefinition, config: ServiceConfig, deps: OrchestratorDeps) {
    this.#config = config;
    this.#promptTemplate = definition.promptTemplate;
    this.#deps = deps;
    this.#log = deps.logger;
    this.#pollIntervalMs = config.polling.intervalMs;
    this.#maxConcurrentAgents = config.agent.maxConcurrentAgents;
    this.#workspaces = new WorkspaceManager({
      root: config.workspace.root,
      hooks: config.hooks,
      logger: deps.logger,
    });
  }

  get config(): ServiceConfig {
    return this.#config;
  }

  get workspaces(): WorkspaceManager {
    return this.#workspaces;
  }

  async start(): Promise<void> {
    const validation = this.#validate();
    if (!validation.ok) {
      this.#log.error("startup validation failed", { error: validation.error });
      throw new Error(`startup validation failed: ${validation.error}`);
    }
    await this.#startupTerminalCleanup();
    this.#scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#tickTimer !== null) clearTimeout(this.#tickTimer);
    this.#tickTimer = null;
    for (const entry of this.#retryAttempts.values()) clearTimeout(entry.timer);
    this.#retryAttempts.clear();
    const stops: Promise<void>[] = [];
    for (const id of [...this.#running.keys()]) {
      stops.push(this.#terminateRunningIssue(id, false, "shutdown"));
    }
    await Promise.all(stops);
    this.#claimed.clear();
  }

  applyWorkflow(definition: WorkflowDefinition, config: ServiceConfig): void {
    if (JSON.stringify(config.server) !== JSON.stringify(this.#config.server)) {
      this.#log.warn(
        "server.port/host changed; restart required for the HTTP server to pick it up",
      );
    }
    this.#config = config;
    this.#promptTemplate = definition.promptTemplate;
    this.#maxConcurrentAgents = config.agent.maxConcurrentAgents;
    const intervalChanged = this.#pollIntervalMs !== config.polling.intervalMs;
    this.#pollIntervalMs = config.polling.intervalMs;
    this.#workspaces.updateConfig(config.workspace.root, config.hooks);
    this.#tracker = null; // rebuilt by the next validation
    this.#lastReloadError = null;
    this.#log.info("workflow re-applied", {
      poll_interval_ms: this.#pollIntervalMs,
      max_concurrent_agents: this.#maxConcurrentAgents,
      workspace_root: config.workspace.root,
    });
    if (intervalChanged && this.#tickTimer !== null && !this.#ticking) {
      // Re-arm relative to the last tick so the new cadence applies immediately.
      const base = this.#lastTickEndMono ?? monoMs();
      this.#scheduleTick(Math.max(0, base + this.#pollIntervalMs - monoMs()));
    }
  }

  noteReloadError(message: string): void {
    this.#lastReloadError = message;
    this.#log.error("workflow reload failed; keeping last known good configuration", {
      error: message,
    });
  }

  requestRefresh(): { queued: boolean; coalesced: boolean } {
    if (this.#stopped) return { queued: false, coalesced: false };
    if (this.#ticking) {
      const coalesced = this.#refreshRequested;
      this.#refreshRequested = true;
      return { queued: true, coalesced };
    }
    this.#scheduleTick(0);
    return { queued: true, coalesced: false };
  }

  snapshot(): Snapshot {
    const now = monoMs();
    let activeSeconds = 0;
    const running = [];
    for (const [id, entry] of this.#running) {
      activeSeconds += (now - entry.startedMono) / 1000;
      running.push({
        issue_id: id,
        issue_identifier: entry.identifier,
        issue_url: entry.issue.url,
        state: entry.issue.state,
        session_id: entry.sessionId,
        turn_count: entry.turnCount,
        last_event: entry.lastEvent,
        last_message: entry.lastMessage,
        started_at: entry.startedAt,
        last_event_at: entry.lastEventAt,
        tokens: {
          input_tokens: entry.tokens.input,
          output_tokens: entry.tokens.output,
          total_tokens: entry.tokens.total,
        },
      });
    }
    const retrying = [];
    for (const entry of this.#retryAttempts.values()) {
      retrying.push({
        issue_id: entry.issueId,
        issue_identifier: entry.identifier,
        issue_url: entry.url,
        attempt: entry.attempt,
        due_at: new Date(Date.now() + Math.max(entry.dueAtMs - now, 0)).toISOString(),
        error: entry.error,
      });
    }
    return {
      generated_at: nowIso(),
      counts: { running: running.length, retrying: retrying.length },
      running,
      retrying,
      codex_totals: {
        input_tokens: this.#codexTotals.input,
        output_tokens: this.#codexTotals.output,
        total_tokens: this.#codexTotals.total,
        seconds_running: this.#endedSeconds + activeSeconds,
      },
      rate_limits: this.#rateLimits,
      last_validation_error: this.#lastValidationError,
      last_reload_error: this.#lastReloadError,
    };
  }

  async issueDetails(identifier: string): Promise<Record<string, unknown> | null> {
    const workspacePath = async () => {
      try {
        return (await this.#workspaces.pathFor(identifier)).path;
      } catch {
        return null;
      }
    };
    for (const [id, entry] of this.#running) {
      if (entry.identifier === identifier) {
        const row = this.snapshot().running.find((r) => r.issue_id === id) ?? null;
        return {
          issue_identifier: identifier,
          issue_id: id,
          status: "running",
          workspace: { path: await workspacePath() },
          attempts: { current_retry_attempt: entry.retryAttempt },
          running: row,
          retry: null,
          last_error: entry.lastError,
        };
      }
    }
    for (const entry of this.#retryAttempts.values()) {
      if (entry.identifier === identifier) {
        const row = this.snapshot().retrying.find((r) => r.issue_id === entry.issueId) ?? null;
        return {
          issue_identifier: identifier,
          issue_id: entry.issueId,
          status: "retrying",
          workspace: { path: await workspacePath() },
          attempts: { current_retry_attempt: entry.attempt },
          running: null,
          retry: row,
          last_error: entry.error,
        };
      }
    }
    return null;
  }

  #scheduleTick(delayMs: number): void {
    if (this.#stopped) return;
    if (this.#tickTimer !== null) clearTimeout(this.#tickTimer);
    this.#tickTimer = setTimeout(() => {
      this.#tickTimer = null;
      this.#tick().catch((err) =>
        this.#log.error("tick crashed", { error: (err as Error).message })
      );
    }, delayMs);
  }

  async #tick(): Promise<void> {
    if (this.#ticking || this.#stopped) return;
    this.#ticking = true;
    try {
      await this.#reconcileRunningIssues();
      await this.#deps.refreshWorkflow?.().catch((err) =>
        this.#log.warn("workflow refresh check failed", { error: (err as Error).message })
      );

      const validation = this.#validate();
      if (!validation.ok) {
        this.#log.error("dispatch skipped: validation failed", { error: validation.error });
        return;
      }
      const tracker = validation.tracker;

      let issues: Issue[];
      try {
        issues = await tracker.adapter.fetchIssuesByStates(tracker.activeStates);
      } catch (err) {
        this.#log.error("candidate fetch failed; skipping dispatch this tick", {
          error: (err as Error).message,
        });
        return;
      }

      for (const issue of [...issues].sort(compareForDispatch)) {
        if (this.#availableSlots() <= 0) break;
        if (this.#shouldDispatch(issue, tracker)) this.#dispatch(issue, null, tracker);
      }
    } finally {
      this.#ticking = false;
      this.#lastTickEndMono = monoMs();
      this.#notify();
      const immediate = this.#refreshRequested;
      this.#refreshRequested = false;
      this.#scheduleTick(immediate ? 0 : this.#pollIntervalMs);
    }
  }

  #validate() {
    const result = validateDispatchConfig(this.#config, this.#deps.env, this.#deps.trackerRegistry);
    if (result.ok) {
      this.#tracker = result.tracker;
      this.#lastGoodTracker = result.tracker;
      this.#lastValidationError = null;
    } else {
      this.#tracker = null;
      this.#lastValidationError = result.error;
    }
    return result;
  }

  #notify(): void {
    try {
      this.#deps.onStateChange?.();
    } catch (err) {
      this.#log.warn("state change observer failed", { error: (err as Error).message });
    }
  }

  #availableSlots(): number {
    return Math.max(this.#maxConcurrentAgents - this.#running.size, 0);
  }

  #hasRequiredFields(issue: Issue): boolean {
    return [issue.id, issue.identifier, issue.title, issue.state].every(
      (value) => typeof value === "string" && value !== "",
    );
  }

  #stateIsActive(state: string, tracker: EffectiveTracker): boolean {
    const normalized = normalizeState(state);
    return tracker.activeStates.some((s) => normalizeState(s) === normalized) &&
      !tracker.terminalStates.some((s) => normalizeState(s) === normalized);
  }

  #stateIsTerminal(state: string, tracker: EffectiveTracker): boolean {
    const normalized = normalizeState(state);
    return tracker.terminalStates.some((s) => normalizeState(s) === normalized);
  }

  #perStateSlotAvailable(state: string): boolean {
    const key = normalizeState(state);
    const limit = this.#config.agent.maxConcurrentAgentsByState.get(key);
    if (limit === undefined) return true;
    let count = 0;
    for (const entry of this.#running.values()) {
      if (normalizeState(entry.issue.state) === key) count += 1;
    }
    return count < limit;
  }

  #shouldDispatch(issue: Issue, tracker: EffectiveTracker): boolean {
    return this.#hasRequiredFields(issue) &&
      this.#stateIsActive(issue.state, tracker) &&
      issueRoutable(issue, this.#config.tracker.requiredLabels) &&
      !this.#running.has(issue.id) &&
      !this.#claimed.has(issue.id) &&
      this.#availableSlots() > 0 &&
      this.#perStateSlotAvailable(issue.state);
  }

  #retryDispatchAllowed(issue: Issue, tracker: EffectiveTracker): boolean {
    return this.#hasRequiredFields(issue) &&
      this.#stateIsActive(issue.state, tracker) &&
      issueRoutable(issue, this.#config.tracker.requiredLabels) &&
      !this.#running.has(issue.id) &&
      this.#perStateSlotAvailable(issue.state);
  }

  #dispatch(issue: Issue, attempt: number | null, tracker: EffectiveTracker): void {
    const existingRetry = this.#retryAttempts.get(issue.id);
    if (existingRetry) {
      clearTimeout(existingRetry.timer);
      this.#retryAttempts.delete(issue.id);
    }
    const controller = new AbortController();
    const entry: RunningEntry = {
      issue,
      identifier: issue.identifier,
      controller,
      sessionId: null,
      pid: null,
      lastEvent: null,
      lastEventAt: null,
      lastEventMono: null,
      lastMessage: null,
      tokens: { input: 0, output: 0, total: 0 },
      lastReported: { input: 0, output: 0, total: 0 },
      retryAttempt: attempt,
      startedAt: nowIso(),
      startedMono: monoMs(),
      turnCount: 0,
      lastError: null,
    };
    this.#running.set(issue.id, entry);
    this.#claimed.add(issue.id);

    const log = this.#log.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    log.info("dispatching worker", { attempt, state: issue.state });

    // Snapshot config + adapter for the whole attempt (§10.5).
    const config = this.#config;
    runAgentAttempt(issue, attempt, {
      config,
      promptTemplate: this.#promptTemplate,
      tracker: tracker.adapter,
      activeStates: tracker.activeStates,
      workspaces: this.#workspaces,
      startSession: this.#deps.startSession,
      parentEnv: this.#deps.parentEnv,
      logger: this.#log,
      onEvent: (event) => this.#onAgentEvent(issue.id, entry, event),
      signal: controller.signal,
    }).then(
      () => this.#onWorkerExit(issue.id, entry, null),
      (err: unknown) => this.#onWorkerExit(issue.id, entry, err),
    );
  }

  #onAgentEvent(issueId: string, entry: RunningEntry, event: AgentEvent): void {
    if (this.#running.get(issueId) !== entry) return;
    entry.lastEvent = event.event;
    entry.lastEventAt = event.timestamp;
    entry.lastEventMono = monoMs();
    if (event.codex_app_server_pid !== null) entry.pid = event.codex_app_server_pid;
    if (event.message !== undefined && event.message !== "") entry.lastMessage = event.message;
    if (event.session_id) entry.sessionId = event.session_id;
    if (event.event === "session_started" || event.event === "turn_started") entry.turnCount += 1;
    if (event.usage) this.#applyUsage(entry, event.usage);
    if (event.rate_limits !== undefined) this.#rateLimits = event.rate_limits;
    if (
      event.event === "turn_failed" || event.event === "turn_ended_with_error" ||
      event.event === "startup_failed"
    ) {
      entry.lastError = event.message ?? event.event;
    }
    const log = this.#log.child({
      issue_id: issueId,
      issue_identifier: entry.identifier,
      session_id: entry.sessionId,
    });
    if (
      event.event === "notification" || event.event === "token_usage" ||
      event.event === "rate_limits"
    ) {
      log.debug("agent event", {
        event: event.event,
        method: event.method,
        message: event.message,
      });
    } else {
      log.info("agent event", { event: event.event, message: event.message });
    }
  }

  #applyUsage(entry: RunningEntry, usage: UsageTotals): void {
    const reset = usage.total_tokens < entry.lastReported.total;
    const delta = reset
      ? { input: usage.input_tokens, output: usage.output_tokens, total: usage.total_tokens }
      : {
        input: usage.input_tokens - entry.lastReported.input,
        output: usage.output_tokens - entry.lastReported.output,
        total: usage.total_tokens - entry.lastReported.total,
      };
    entry.tokens.input += delta.input;
    entry.tokens.output += delta.output;
    entry.tokens.total += delta.total;
    this.#codexTotals.input += delta.input;
    this.#codexTotals.output += delta.output;
    this.#codexTotals.total += delta.total;
    entry.lastReported = {
      input: usage.input_tokens,
      output: usage.output_tokens,
      total: usage.total_tokens,
    };
  }

  #onWorkerExit(issueId: string, entry: RunningEntry, error: unknown): void {
    if (this.#running.get(issueId) !== entry) return; // already terminated by the orchestrator
    this.#running.delete(issueId);
    this.#endedSeconds += (monoMs() - entry.startedMono) / 1000;
    const log = this.#log.child({
      issue_id: issueId,
      issue_identifier: entry.identifier,
      session_id: entry.sessionId,
    });

    if (error === null) {
      this.#completed.add(issueId);
      log.info("worker completed; scheduling continuation check");
      this.#scheduleRetry(issueId, 1, {
        identifier: entry.identifier,
        url: entry.issue.url,
        continuation: true,
      });
    } else if (error instanceof WorkerError && error.reason === "cancelled") {
      log.info("worker cancelled");
      this.#claimed.delete(issueId);
    } else {
      const message = (error as Error).message ?? String(error);
      const attempt = (entry.retryAttempt ?? 0) + 1;
      log.warn("worker failed; retrying", { attempt, error: message });
      this.#scheduleRetry(issueId, attempt, {
        identifier: entry.identifier,
        url: entry.issue.url,
        error: `worker exited: ${message}`,
      });
    }
    this.#notify();
  }

  #scheduleRetry(
    issueId: string,
    attempt: number,
    options: {
      identifier: string;
      url?: string | null;
      error?: string | null;
      continuation?: boolean;
    },
  ): void {
    if (this.#stopped) return;
    const existing = this.#retryAttempts.get(issueId);
    if (existing) clearTimeout(existing.timer);
    const delay = options.continuation
      ? CONTINUATION_DELAY_MS
      : Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), this.#config.agent.maxRetryBackoffMs);
    const timer = setTimeout(() => {
      this.#onRetryTimer(issueId).catch((err) =>
        this.#log.error("retry handler crashed", {
          issue_id: issueId,
          error: (err as Error).message,
        })
      );
    }, delay);
    this.#retryAttempts.set(issueId, {
      issueId,
      identifier: options.identifier,
      url: options.url ?? null,
      attempt,
      dueAtMs: monoMs() + delay,
      timer,
      error: options.error ?? null,
    });
    this.#claimed.add(issueId);
  }

  async #onRetryTimer(issueId: string): Promise<void> {
    const retry = this.#retryAttempts.get(issueId);
    if (!retry || this.#stopped) return;
    this.#retryAttempts.delete(issueId);
    const log = this.#log.child({ issue_id: issueId, issue_identifier: retry.identifier });

    const validation = this.#validate();
    if (!validation.ok) {
      this.#scheduleRetry(issueId, retry.attempt + 1, {
        identifier: retry.identifier,
        url: retry.url,
        error: validation.error,
      });
      return;
    }
    const tracker = validation.tracker;

    let refreshed: Issue[];
    try {
      refreshed = await tracker.adapter.fetchIssuesByIds([issueId]);
    } catch (err) {
      log.warn("retry refresh failed", { error: (err as Error).message });
      this.#scheduleRetry(issueId, retry.attempt + 1, {
        identifier: retry.identifier,
        url: retry.url,
        error: "retry refresh failed",
      });
      return;
    }
    const issue = refreshed.find((candidate) => candidate.id === issueId);
    if (!issue) {
      log.info("issue no longer visible; releasing claim");
      this.#claimed.delete(issueId);
      this.#notify();
      return;
    }
    if (this.#stateIsTerminal(issue.state, tracker)) {
      log.info("issue is terminal; cleaning workspace and releasing claim", { state: issue.state });
      await this.#cleanupWorkspace(issue.identifier);
      this.#claimed.delete(issueId);
      this.#notify();
      return;
    }
    if (!this.#retryDispatchAllowed(issue, tracker)) {
      log.info("issue no longer dispatchable; releasing claim", { state: issue.state });
      this.#claimed.delete(issueId);
      this.#notify();
      return;
    }
    if (this.#availableSlots() <= 0) {
      this.#scheduleRetry(issueId, retry.attempt + 1, {
        identifier: issue.identifier,
        url: issue.url,
        error: "no available orchestrator slots",
      });
      this.#notify();
      return;
    }
    this.#dispatch(issue, retry.attempt, tracker);
    this.#notify();
  }

  async #reconcileRunningIssues(): Promise<void> {
    await this.#reconcileStalledRuns();
    if (this.#running.size === 0) return;
    let tracker = this.#tracker;
    if (tracker === null) {
      const validation = this.#validate();
      tracker = validation.ok ? validation.tracker : this.#lastGoodTracker;
    }
    if (tracker === null) return;

    const runningIds = [...this.#running.keys()];
    let refreshed: Issue[];
    try {
      refreshed = await tracker.adapter.fetchIssuesByIds(runningIds);
    } catch (err) {
      this.#log.debug("state refresh failed; keeping workers running", {
        error: (err as Error).message,
      });
      return;
    }
    const seen = new Set<string>();
    for (const issue of refreshed) {
      seen.add(issue.id);
      const entry = this.#running.get(issue.id);
      if (!entry) continue;
      if (this.#stateIsTerminal(issue.state, tracker)) {
        await this.#terminateRunningIssue(
          issue.id,
          true,
          `issue reached terminal state ${issue.state}`,
        );
      } else if (
        this.#stateIsActive(issue.state, tracker) &&
        issueRoutable(issue, this.#config.tracker.requiredLabels)
      ) {
        entry.issue = issue;
      } else {
        await this.#terminateRunningIssue(
          issue.id,
          false,
          `issue no longer active/routable (state ${issue.state})`,
        );
      }
    }
    for (const id of runningIds) {
      if (!seen.has(id) && this.#running.has(id)) {
        await this.#terminateRunningIssue(id, false, "issue no longer visible in tracker scope");
      }
    }
  }

  async #reconcileStalledRuns(): Promise<void> {
    const stallTimeout = this.#config.codex.stallTimeoutMs;
    if (stallTimeout <= 0) return;
    const now = monoMs();
    for (const [id, entry] of [...this.#running]) {
      const elapsed = now - (entry.lastEventMono ?? entry.startedMono);
      if (elapsed > stallTimeout) {
        const attempt = (entry.retryAttempt ?? 0) + 1;
        await this.#terminateRunningIssue(id, false, `stalled for ${Math.round(elapsed)}ms`);
        this.#scheduleRetry(id, attempt, {
          identifier: entry.identifier,
          url: entry.issue.url,
          error: `stalled: no agent activity for ${Math.round(elapsed)}ms`,
        });
      }
    }
  }

  async #terminateRunningIssue(
    issueId: string,
    cleanupWorkspace: boolean,
    reason: string,
  ): Promise<void> {
    const entry = this.#running.get(issueId);
    if (!entry) return;
    this.#running.delete(issueId);
    this.#claimed.delete(issueId);
    this.#endedSeconds += (monoMs() - entry.startedMono) / 1000;
    this.#log.child({
      issue_id: issueId,
      issue_identifier: entry.identifier,
      session_id: entry.sessionId,
    })
      .info("terminating worker", { reason, cleanup_workspace: cleanupWorkspace });
    entry.controller.abort(new WorkerError("cancelled", reason));
    if (cleanupWorkspace) await this.#cleanupWorkspace(entry.identifier);
    this.#notify();
  }

  async #cleanupWorkspace(identifier: string): Promise<void> {
    try {
      const removed = await this.#workspaces.remove(identifier);
      if (removed) this.#log.info("workspace removed", { issue_identifier: identifier });
    } catch (err) {
      this.#log.warn("workspace cleanup failed", {
        issue_identifier: identifier,
        error: (err as Error).message,
      });
    }
  }

  async #startupTerminalCleanup(): Promise<void> {
    const tracker = this.#tracker;
    if (!tracker || tracker.terminalStates.length === 0) return;
    let terminal: Issue[];
    try {
      terminal = await tracker.adapter.fetchIssuesByStates(tracker.terminalStates);
    } catch (err) {
      this.#log.warn("startup terminal cleanup skipped: fetch failed", {
        error: (err as Error).message,
      });
      return;
    }
    for (const issue of terminal) await this.#cleanupWorkspace(issue.identifier);
  }
}
