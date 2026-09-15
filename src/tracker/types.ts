/**
 * Issue tracker integration contract (SPEC §4.1.1, §11).
 *
 * Issue field names intentionally mirror the specification (snake_case) so the same object can be
 * handed to the prompt template without a conversion step (§12.2).
 */

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  /** Opaque stable dispatch identity within the tracker scope. */
  id: string;
  /** Non-secret provider identifiers for provider-native tools; opaque to the orchestrator. */
  native_ref: Record<string, unknown> | null;
  /** Human-readable key, unique within the tracker scope (names workspaces). */
  identifier: string;
  title: string;
  description: string | null;
  /** Lower is higher priority; `1..4` sort before everything else. */
  priority: number | null;
  /** Provider-native state name with provider spelling preserved. */
  state: string;
  branch_name: string | null;
  url: string | null;
  assignee_id: string | null;
  /** Trimmed, lowercased, deduplicated. */
  labels: string[];
  blocked_by: BlockerRef[];
  /** Adapter-derived provider-specific eligibility. */
  dispatchable: boolean;
  /** RFC 3339 instants or null. */
  created_at: string | null;
  updated_at: string | null;
}

export type TrackerErrorCategory =
  | "unsupported_tracker_kind"
  | "invalid_tracker_config"
  | "missing_tracker_secret"
  | "tracker_request"
  | "tracker_status"
  | "tracker_response"
  | "tracker_pagination"
  | "tracker_rate_limited";

export class TrackerError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly status: number | null;

  constructor(
    readonly category: TrackerErrorCategory,
    message: string,
    options: {
      retryable?: boolean;
      retryAfterMs?: number | null;
      status?: number | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "TrackerError";
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.status = options.status ?? null;
  }
}

/** Provider-native agent tool advertised to the coding agent (§10.5). */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  inputSchema: Record<string, unknown>;
  /** Documented mutation capability, surfaced in logs and docs. */
  mutates: boolean;
}

export interface ToolResult {
  success: boolean;
  /** JSON-safe structured output (or error detail when `success` is false). */
  output: unknown;
}

export interface ToolContext {
  issue: Issue;
}

export interface TrackerAdapter {
  readonly kind: string;
  /** §11.1 (1). Empty input MUST return `[]` without a provider request. */
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  /** §11.1 (2). Empty input MUST return `[]` without a provider request. */
  fetchIssuesByIds(issueIds: string[]): Promise<Issue[]>;
  /** OPTIONAL provider-native tools (§10.5). Return `[]` when none are shipped. */
  agentToolSpecs(): ToolSpec[];
  /** Environment names stripped from the coding-agent child environment (§15.3). */
  secretEnvironmentNames(): string[];
  executeAgentTool(name: string, args: unknown, context: ToolContext): Promise<ToolResult>;
}

/** Effective tracker settings handed to an adapter factory (§11.2). */
export interface TrackerSettings {
  provider: Record<string, unknown>;
  activeStates: string[];
  terminalStates: string[];
  requiredLabels: string[];
}

export interface TrackerAdapterFactory {
  readonly kind: string;
  /** Adapter-profile defaults applied when WORKFLOW.md omits the state lists (§5.3.1). */
  readonly defaultActiveStates: string[] | null;
  readonly defaultTerminalStates: string[] | null;
  /** Validates the provider config and builds an adapter; throws `TrackerError`. */
  create(settings: TrackerSettings, env: (name: string) => string | undefined): TrackerAdapter;
}

/** Scheduler comparison form of a state name (§4.2). */
export function normalizeState(state: string): string {
  return state.trim().toLowerCase();
}

/** §11.3: trimmed, lowercased, blanks dropped, duplicates removed. */
export function normalizeLabels(labels: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of labels) {
    const label = raw.trim().toLowerCase();
    if (label === "" || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/** Parses a provider timestamp into RFC 3339 or null when unusable. */
export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/** True when the issue has every configured required label (§5.3.1). */
export function hasRequiredLabels(issue: Issue, requiredLabels: string[]): boolean {
  for (const raw of requiredLabels) {
    const wanted = raw.trim().toLowerCase();
    // A blank configured label matches no issue.
    if (wanted === "") return false;
    if (!issue.labels.includes(wanted)) return false;
  }
  return true;
}

/** §8.2: adapter `dispatchable` plus required labels; state/claims/slots are checked elsewhere. */
export function issueRoutable(issue: Issue, requiredLabels: string[]): boolean {
  return issue.dispatchable && hasRequiredLabels(issue, requiredLabels);
}

/** §8.2 sorting: priority 1..4 first, then oldest `created_at`, then identifier. */
export function compareForDispatch(a: Issue, b: Issue): number {
  const pa = priorityBucket(a.priority);
  const pb = priorityBucket(b.priority);
  if (pa !== pb) return pa - pb;
  const ca = a.created_at === null ? Number.POSITIVE_INFINITY : Date.parse(a.created_at);
  const cb = b.created_at === null ? Number.POSITIVE_INFINITY : Date.parse(b.created_at);
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
}

function priorityBucket(priority: number | null): number {
  if (priority !== null && Number.isInteger(priority) && priority >= 1 && priority <= 4) {
    return priority;
  }
  return 5;
}
