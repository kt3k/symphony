export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  native_ref: Record<string, unknown> | null;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  assignee_id: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  dispatchable: boolean;
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

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutates: boolean;
}

export interface ToolResult {
  success: boolean;
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
  agentToolSpecs(): ToolSpec[];
  secretEnvironmentNames(): string[];
  executeAgentTool(name: string, args: unknown, context: ToolContext): Promise<ToolResult>;
}

export interface TrackerSettings {
  provider: Record<string, unknown>;
  activeStates: string[];
  terminalStates: string[];
  requiredLabels: string[];
}

export interface TrackerAdapterFactory {
  readonly kind: string;
  readonly defaultActiveStates: string[] | null;
  readonly defaultTerminalStates: string[] | null;
  create(settings: TrackerSettings, env: (name: string) => string | undefined): TrackerAdapter;
}

export function normalizeState(state: string): string {
  return state.trim().toLowerCase();
}

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

export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

export function hasRequiredLabels(issue: Issue, requiredLabels: string[]): boolean {
  for (const raw of requiredLabels) {
    const wanted = raw.trim().toLowerCase();
    // A blank configured label matches no issue.
    if (wanted === "") return false;
    if (!issue.labels.includes(wanted)) return false;
  }
  return true;
}

export function issueRoutable(issue: Issue, requiredLabels: string[]): boolean {
  return issue.dispatchable && hasRequiredLabels(issue, requiredLabels);
}

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
