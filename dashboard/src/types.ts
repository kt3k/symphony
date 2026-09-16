export interface Tokens {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface RunningRow {
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
  tokens: Tokens;
}

export interface RetryRow {
  issue_id: string;
  issue_identifier: string;
  issue_url: string | null;
  attempt: number;
  due_at: string;
  error: string | null;
}

export interface RateLimitWindow {
  usedPercent: number;
  resetsAt?: number | null;
  windowDurationMins?: number | null;
}

export interface Snapshot {
  generated_at: string;
  counts: { running: number; retrying: number };
  running: RunningRow[];
  retrying: RetryRow[];
  codex_totals: Tokens & { seconds_running: number };
  rate_limits: { primary?: RateLimitWindow | null; secondary?: RateLimitWindow | null; [key: string]: unknown } | null;
  last_validation_error: string | null;
  last_reload_error: string | null;
}
