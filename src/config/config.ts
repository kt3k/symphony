import { isAbsolute, resolve } from "@std/path";
import type { WorkflowDefinition } from "../workflow/loader.ts";
import { type EnvLookup, resolveEnvValue } from "../util/env.ts";
import { normalizeState } from "../tracker/types.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface TrackerConfig {
  kind: string | null;
  provider: Record<string, unknown>;
  requiredLabels: string[];
  activeStates: string[] | null;
  terminalStates: string[] | null;
}

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Map<string, number>;
}

export interface CodexConfig {
  command: string;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface ServiceConfig {
  workflowPath: string;
  workflowDir: string;
  tracker: TrackerConfig;
  polling: { intervalMs: number };
  workspace: { root: string };
  hooks: HooksConfig;
  agent: AgentConfig;
  codex: CodexConfig;
}

export const DEFAULTS = {
  pollingIntervalMs: 30_000,
  hookTimeoutMs: 60_000,
  maxConcurrentAgents: 10,
  maxTurns: 20,
  maxRetryBackoffMs: 300_000,
  codexCommand: "codex app-server",
  turnTimeoutMs: 3_600_000,
  readTimeoutMs: 5_000,
  stallTimeoutMs: 300_000,
  /**
   * High-trust posture (documented in README): the app-server may ask, and Symphony auto-approves
   * every command/file-change request for the session. The sandbox defaults to workspace-write
   * with network access; escalations are requested and auto-approved.
   */
  approvalPolicy: "on-request",
  threadSandbox: "workspace-write",
  turnSandboxPolicy: { type: "workspaceWrite", networkAccess: true },
} as const;

type Raw = Record<string, unknown>;

function section(root: Raw, key: string): Raw {
  const value = root[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`\`${key}\` must be a map`);
  }
  return value as Raw;
}

function optionalString(raw: Raw, key: string, path: string): string | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ConfigError(`\`${path}\` must be a string`);
  return value;
}

function integer(
  raw: Raw,
  key: string,
  path: string,
  fallback: number,
  opts: { min?: number } = {},
) {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ConfigError(`\`${path}\` must be an integer`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new ConfigError(`\`${path}\` must be >= ${opts.min}`);
  }
  return value;
}

function stringList(raw: Raw, key: string, path: string): string[] | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ConfigError(`\`${path}\` must be a list of strings`);
  }
  return value as string[];
}

function expandHome(value: string, env: EnvLookup): string {
  if (value === "~" || value.startsWith("~/")) {
    const home = env("HOME") ?? env("USERPROFILE");
    if (!home) throw new ConfigError("cannot expand `~`: HOME is not set");
    return home + value.slice(1);
  }
  return value;
}

function defaultWorkspaceRoot(env: EnvLookup): string {
  const tmp = env("TMPDIR") ?? env("TMP") ?? env("TEMP") ?? "/tmp";
  return resolve(tmp, "symphony_workspaces");
}

function perStateLimits(raw: unknown): Map<string, number> {
  const map = new Map<string, number>();
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return map;
  }
  for (const [state, limit] of Object.entries(raw as Raw)) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) continue;
    const key = normalizeState(state);
    if (key === "") continue;
    map.set(key, limit);
  }
  return map;
}

export function buildConfig(def: WorkflowDefinition, env: EnvLookup): ServiceConfig {
  const root = def.config;
  const tracker = section(root, "tracker");
  const polling = section(root, "polling");
  const workspace = section(root, "workspace");
  const hooks = section(root, "hooks");
  const agent = section(root, "agent");
  const codex = section(root, "codex");

  const kind = optionalString(tracker, "kind", "tracker.kind");
  const provider = section(tracker, "provider");

  const requiredLabels = stringList(tracker, "required_labels", "tracker.required_labels") ?? [];

  let workspaceRoot: string;
  const rawRoot = workspace["root"];
  if (rawRoot === undefined || rawRoot === null) {
    workspaceRoot = defaultWorkspaceRoot(env);
  } else {
    const resolved = resolveEnvValue(rawRoot, env);
    if (typeof resolved !== "string" || resolved === "") {
      throw new ConfigError("`workspace.root` must resolve to a non-empty path string");
    }
    const expanded = expandHome(resolved, env);
    workspaceRoot = isAbsolute(expanded) ? resolve(expanded) : resolve(def.dir, expanded);
  }

  const command = optionalString(codex, "command", "codex.command") ?? DEFAULTS.codexCommand;

  return {
    workflowPath: def.path,
    workflowDir: def.dir,
    tracker: {
      kind: kind === null || kind.trim() === "" ? null : kind.trim(),
      provider,
      requiredLabels,
      activeStates: stringList(tracker, "active_states", "tracker.active_states"),
      terminalStates: stringList(tracker, "terminal_states", "tracker.terminal_states"),
    },
    polling: {
      intervalMs: integer(
        polling,
        "interval_ms",
        "polling.interval_ms",
        DEFAULTS.pollingIntervalMs,
        {
          min: 1,
        },
      ),
    },
    workspace: { root: workspaceRoot },
    hooks: {
      afterCreate: optionalString(hooks, "after_create", "hooks.after_create"),
      beforeRun: optionalString(hooks, "before_run", "hooks.before_run"),
      afterRun: optionalString(hooks, "after_run", "hooks.after_run"),
      beforeRemove: optionalString(hooks, "before_remove", "hooks.before_remove"),
      timeoutMs: integer(hooks, "timeout_ms", "hooks.timeout_ms", DEFAULTS.hookTimeoutMs, {
        min: 1,
      }),
    },
    agent: {
      maxConcurrentAgents: integer(
        agent,
        "max_concurrent_agents",
        "agent.max_concurrent_agents",
        DEFAULTS.maxConcurrentAgents,
        { min: 0 },
      ),
      maxTurns: integer(agent, "max_turns", "agent.max_turns", DEFAULTS.maxTurns, { min: 1 }),
      maxRetryBackoffMs: integer(
        agent,
        "max_retry_backoff_ms",
        "agent.max_retry_backoff_ms",
        DEFAULTS.maxRetryBackoffMs,
        { min: 0 },
      ),
      maxConcurrentAgentsByState: perStateLimits(agent["max_concurrent_agents_by_state"]),
    },
    codex: {
      command,
      approvalPolicy: codex["approval_policy"] ?? DEFAULTS.approvalPolicy,
      threadSandbox: codex["thread_sandbox"] ?? DEFAULTS.threadSandbox,
      turnSandboxPolicy: codex["turn_sandbox_policy"] ?? DEFAULTS.turnSandboxPolicy,
      turnTimeoutMs: integer(
        codex,
        "turn_timeout_ms",
        "codex.turn_timeout_ms",
        DEFAULTS.turnTimeoutMs,
        {
          min: 1,
        },
      ),
      readTimeoutMs: integer(
        codex,
        "read_timeout_ms",
        "codex.read_timeout_ms",
        DEFAULTS.readTimeoutMs,
        {
          min: 1,
        },
      ),
      stallTimeoutMs: integer(
        codex,
        "stall_timeout_ms",
        "codex.stall_timeout_ms",
        DEFAULTS.stallTimeoutMs,
      ),
    },
  };
}
