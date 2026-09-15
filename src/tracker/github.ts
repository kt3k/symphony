import {
  type Issue,
  normalizeLabels,
  normalizeState,
  normalizeTimestamp,
  type ToolContext,
  type ToolResult,
  type ToolSpec,
  type TrackerAdapter,
  type TrackerAdapterFactory,
  TrackerError,
  type TrackerSettings,
} from "./types.ts";
import { type EnvLookup, resolveEnvValue } from "../util/env.ts";

export const GITHUB_SECRET_ENV_NAMES = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

export interface GitHubProviderConfig {
  owner: string;
  repo: string;
  token: string;
  apiUrl: string;
  stateLabelPrefix: string;
  priorityLabelPrefix: string;
  assignee: string | null;
  perPage: number;
  timeoutMs: number;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const DEFAULT_API_URL = "https://api.github.com";

function providerString(raw: Record<string, unknown>, key: string, env: EnvLookup): string | null {
  const value = resolveEnvValue(raw[key], env);
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new TrackerError("invalid_tracker_config", `tracker.provider.${key} must be a string`);
  }
  return value;
}

export function parseGitHubProvider(
  raw: Record<string, unknown>,
  env: EnvLookup,
): GitHubProviderConfig {
  let owner = providerString(raw, "owner", env);
  let repo = providerString(raw, "repo", env);
  const repository = providerString(raw, "repository", env);
  if (repository !== null) {
    const parts = repository.split("/");
    if (parts.length !== 2 || parts.some((p) => p.trim() === "")) {
      throw new TrackerError(
        "invalid_tracker_config",
        "tracker.provider.repository must be `owner/repo`",
      );
    }
    owner ??= parts[0];
    repo ??= parts[1];
  }
  if (!owner || !repo) {
    throw new TrackerError(
      "invalid_tracker_config",
      "tracker.provider requires `owner` and `repo` (or `repository: owner/repo`)",
    );
  }

  let token: string | undefined;
  if (raw["token"] !== undefined && raw["token"] !== null) {
    const resolved = resolveEnvValue(raw["token"], env);
    if (resolved !== undefined && typeof resolved !== "string") {
      throw new TrackerError("invalid_tracker_config", "tracker.provider.token must be a string");
    }
    token = resolved as string | undefined;
  } else {
    for (const name of ["GITHUB_TOKEN", "GH_TOKEN"]) {
      const value = env(name);
      if (value !== undefined && value !== "") {
        token = value;
        break;
      }
    }
  }
  if (token === undefined || token === "") {
    throw new TrackerError(
      "missing_tracker_secret",
      "GitHub token is missing: set tracker.provider.token (e.g. `$GITHUB_TOKEN`) or GITHUB_TOKEN/GH_TOKEN",
    );
  }

  const perPageRaw = raw["per_page"] ?? 100;
  if (
    typeof perPageRaw !== "number" || !Number.isInteger(perPageRaw) || perPageRaw < 1 ||
    perPageRaw > 100
  ) {
    throw new TrackerError(
      "invalid_tracker_config",
      "tracker.provider.per_page must be an integer 1..100",
    );
  }
  const timeoutRaw = raw["timeout_ms"] ?? 30_000;
  if (typeof timeoutRaw !== "number" || !Number.isInteger(timeoutRaw) || timeoutRaw < 1) {
    throw new TrackerError(
      "invalid_tracker_config",
      "tracker.provider.timeout_ms must be a positive integer",
    );
  }
  const apiUrl = (providerString(raw, "api_url", env) ?? DEFAULT_API_URL).replace(/\/+$/, "");

  return {
    owner,
    repo,
    token,
    apiUrl,
    stateLabelPrefix: providerString(raw, "state_label_prefix", env) ?? "status:",
    priorityLabelPrefix: providerString(raw, "priority_label_prefix", env) ?? "priority:",
    assignee: providerString(raw, "assignee", env),
    perPage: perPageRaw,
    timeoutMs: timeoutRaw,
  };
}

interface GitHubLabel {
  name?: unknown;
}
interface GitHubUser {
  login?: unknown;
}
interface GitHubIssuePayload {
  number?: unknown;
  node_id?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  state_reason?: unknown;
  html_url?: unknown;
  labels?: unknown;
  assignee?: unknown;
  assignees?: unknown;
  locked?: unknown;
  pull_request?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

export class MalformedIssueError extends Error {}

function rawLabelNames(payload: GitHubIssuePayload): string[] {
  if (!Array.isArray(payload.labels)) return [];
  const names: string[] = [];
  for (const label of payload.labels) {
    if (typeof label === "string") names.push(label);
    else if (
      label && typeof label === "object" && typeof (label as GitHubLabel).name === "string"
    ) {
      names.push((label as GitHubLabel).name as string);
    }
  }
  return names;
}

function labelValue(names: string[], prefix: string): string | null {
  const wanted = prefix.toLowerCase();
  for (const name of names) {
    if (name.toLowerCase().startsWith(wanted)) {
      const value = name.slice(prefix.length).trim();
      if (value !== "") return value;
    }
  }
  return null;
}

export function normalizeGitHubIssue(payload: unknown, cfg: GitHubProviderConfig): Issue {
  if (!payload || typeof payload !== "object") {
    throw new MalformedIssueError("issue payload is not an object");
  }
  const p = payload as GitHubIssuePayload;
  if (typeof p.number !== "number" || !Number.isInteger(p.number)) {
    throw new MalformedIssueError("issue number missing");
  }
  if (typeof p.title !== "string" || p.title.trim() === "") {
    throw new MalformedIssueError(`issue #${p.number} has no title`);
  }
  if (p.state !== "open" && p.state !== "closed") {
    throw new MalformedIssueError(
      `issue #${p.number} has unknown state ${JSON.stringify(p.state)}`,
    );
  }
  const names = rawLabelNames(p);
  const state = p.state === "closed"
    ? "closed"
    : (labelValue(names, cfg.stateLabelPrefix) ?? "open");

  let priority: number | null = null;
  const priorityText = labelValue(names, cfg.priorityLabelPrefix);
  if (priorityText !== null && /^\d+$/.test(priorityText)) {
    priority = Number.parseInt(priorityText, 10);
  }
  if (priority === null) {
    const short = names.find((n) => /^p[0-9]$/i.test(n.trim()));
    if (short) priority = Number.parseInt(short.trim().slice(1), 10);
  }

  const assignees = Array.isArray(p.assignees)
    ? p.assignees
      .map((u) => (u && typeof u === "object" ? (u as GitHubUser).login : undefined))
      .filter((l): l is string => typeof l === "string")
    : [];
  const assignee = p.assignee && typeof p.assignee === "object" &&
      typeof (p.assignee as GitHubUser).login === "string"
    ? (p.assignee as GitHubUser).login as string
    : (assignees[0] ?? null);

  const isPullRequest = p.pull_request !== undefined && p.pull_request !== null;
  const assigneeOk = cfg.assignee === null ||
    assignees.some((l) => l.toLowerCase() === cfg.assignee!.toLowerCase()) ||
    (assignee !== null && assignee.toLowerCase() === cfg.assignee.toLowerCase());
  const dispatchable = !isPullRequest && p.locked !== true && assigneeOk;

  return {
    id: String(p.number),
    native_ref: {
      owner: cfg.owner,
      repo: cfg.repo,
      number: p.number,
      node_id: typeof p.node_id === "string" ? p.node_id : null,
      html_url: typeof p.html_url === "string" ? p.html_url : null,
      is_pull_request: isPullRequest,
    },
    identifier: `${cfg.repo}-${p.number}`,
    title: p.title,
    description: typeof p.body === "string" ? p.body : null,
    priority,
    state,
    branch_name: null,
    url: typeof p.html_url === "string" ? p.html_url : null,
    assignee_id: assignee,
    labels: normalizeLabels(names),
    blocked_by: [],
    dispatchable,
    created_at: normalizeTimestamp(p.created_at),
    updated_at: normalizeTimestamp(p.updated_at),
  };
}

function parseLinkNext(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) return match[1];
  }
  return null;
}

export interface GitHubAdapterOptions {
  fetch?: FetchLike;
  onMalformed?: (message: string) => void;
}

export class GitHubAdapter implements TrackerAdapter {
  readonly kind = "github";
  readonly config: GitHubProviderConfig;
  #fetch: FetchLike;
  #onMalformed: (message: string) => void;

  constructor(config: GitHubProviderConfig, options: GitHubAdapterOptions = {}) {
    this.config = config;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#onMalformed = options.onMalformed ?? (() => {});
  }

  get issuesUrl(): string {
    return `${this.config.apiUrl}/repos/${this.config.owner}/${this.config.repo}/issues`;
  }

  secretEnvironmentNames(): string[] {
    return [...GITHUB_SECRET_ENV_NAMES];
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];
    const wanted = new Set(stateNames.map(normalizeState));
    const hasClosed = wanted.has("closed");
    const onlyClosed = hasClosed && wanted.size === 1;
    const ghState = onlyClosed ? "closed" : hasClosed ? "all" : "open";

    const out: Issue[] = [];
    let url: string | null =
      `${this.issuesUrl}?state=${ghState}&per_page=${this.config.perPage}&sort=created&direction=asc`;
    let pages = 0;
    while (url !== null) {
      pages += 1;
      if (pages > 1000) {
        throw new TrackerError(
          "tracker_pagination",
          "pagination did not terminate after 1000 pages",
        );
      }
      const response = await this.#request("GET", url);
      const body = await this.#json(response);
      if (!Array.isArray(body)) {
        throw new TrackerError("tracker_response", "issue list response is not an array");
      }
      for (const raw of body) {
        if (raw && typeof raw === "object" && (raw as GitHubIssuePayload).pull_request) continue;
        let issue: Issue;
        try {
          issue = normalizeGitHubIssue(raw, this.config);
        } catch (err) {
          // A state-list call MAY omit a malformed record but SHOULD log it (§11.1).
          this.#onMalformed((err as Error).message);
          continue;
        }
        if (wanted.has(normalizeState(issue.state))) out.push(issue);
      }
      url = parseLinkNext(response.headers.get("link"));
    }
    return out;
  }

  async fetchIssuesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];
    const unique = [...new Set(issueIds)];
    const results = await Promise.all(unique.map((id) => this.#fetchOne(id)));
    return results.filter((issue): issue is Issue => issue !== null);
  }

  async #fetchOne(id: string): Promise<Issue | null> {
    if (!/^\d+$/.test(id)) return null; // never a visible GitHub issue number
    const response = await this.#request("GET", `${this.issuesUrl}/${id}`, { allowMissing: true });
    if (response.status === 404 || response.status === 410) return null;
    const body = await this.#json(response);
    if (body && typeof body === "object" && (body as GitHubIssuePayload).pull_request) return null;
    try {
      return normalizeGitHubIssue(body, this.config);
    } catch (err) {
      // An ID refresh MUST fail rather than silently omit a malformed requested record (§11.1).
      throw new TrackerError("tracker_response", `issue ${id}: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }

  agentToolSpecs(): ToolSpec[] {
    return [
      {
        name: "github_issue_get",
        description: "Read the current issue (title, body, state, labels, assignees) from GitHub.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        mutates: false,
      },
      {
        name: "github_issue_list_comments",
        description: "List comments on the current issue, oldest first.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        mutates: false,
      },
      {
        name: "github_issue_comment",
        description: "Post a comment on the current issue.",
        inputSchema: {
          type: "object",
          properties: { body: { type: "string", description: "Markdown comment body" } },
          required: ["body"],
          additionalProperties: false,
        },
        mutates: true,
      },
      {
        name: "github_issue_add_labels",
        description:
          "Add labels to the current issue (for example a `status:` label to hand it off).",
        inputSchema: {
          type: "object",
          properties: { labels: { type: "array", items: { type: "string" }, minItems: 1 } },
          required: ["labels"],
          additionalProperties: false,
        },
        mutates: true,
      },
      {
        name: "github_issue_remove_label",
        description: "Remove one label from the current issue.",
        inputSchema: {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
          additionalProperties: false,
        },
        mutates: true,
      },
      {
        name: "github_issue_set_state",
        description: "Open or close the current issue.",
        inputSchema: {
          type: "object",
          properties: {
            state: { type: "string", enum: ["open", "closed"] },
            state_reason: { type: "string", enum: ["completed", "not_planned", "reopened"] },
          },
          required: ["state"],
          additionalProperties: false,
        },
        mutates: true,
      },
    ];
  }

  async executeAgentTool(name: string, args: unknown, context: ToolContext): Promise<ToolResult> {
    const ref = context.issue.native_ref;
    const number = ref && typeof ref["number"] === "number"
      ? ref["number"]
      : Number.parseInt(context.issue.id, 10);
    if (!Number.isInteger(number)) {
      return { success: false, output: { error: "issue has no GitHub number" } };
    }
    const base = `${this.issuesUrl}/${number}`;
    const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "github_issue_get": {
          const body = await this.#json(await this.#request("GET", base));
          return { success: true, output: pickIssueFields(body) };
        }
        case "github_issue_list_comments": {
          const body = await this.#json(
            await this.#request("GET", `${base}/comments?per_page=100`),
          );
          const comments = Array.isArray(body)
            ? body.map((c) => {
              const comment = c as Record<string, unknown>;
              const user = comment["user"] as Record<string, unknown> | null | undefined;
              return {
                id: comment["id"],
                author: user?.["login"] ?? null,
                created_at: comment["created_at"],
                body: comment["body"],
              };
            })
            : [];
          return { success: true, output: { comments } };
        }
        case "github_issue_comment": {
          if (typeof input["body"] !== "string" || input["body"].trim() === "") {
            return { success: false, output: { error: "`body` must be a non-empty string" } };
          }
          const body = await this.#json(
            await this.#request("POST", `${base}/comments`, { body: { body: input["body"] } }),
          );
          const comment = body as Record<string, unknown>;
          return { success: true, output: { id: comment["id"], url: comment["html_url"] } };
        }
        case "github_issue_add_labels": {
          const labels = input["labels"];
          if (
            !Array.isArray(labels) || labels.length === 0 ||
            labels.some((l) => typeof l !== "string")
          ) {
            return {
              success: false,
              output: { error: "`labels` must be a non-empty list of strings" },
            };
          }
          const body = await this.#json(
            await this.#request("POST", `${base}/labels`, { body: { labels } }),
          );
          return { success: true, output: { labels: rawLabelNames({ labels: body }) } };
        }
        case "github_issue_remove_label": {
          if (typeof input["label"] !== "string" || input["label"].trim() === "") {
            return { success: false, output: { error: "`label` must be a non-empty string" } };
          }
          const response = await this.#request(
            "DELETE",
            `${base}/labels/${encodeURIComponent(input["label"])}`,
            { allowMissing: true },
          );
          if (response.status === 404) return { success: true, output: { removed: false } };
          await response.body?.cancel();
          return { success: true, output: { removed: true } };
        }
        case "github_issue_set_state": {
          if (input["state"] !== "open" && input["state"] !== "closed") {
            return { success: false, output: { error: "`state` must be `open` or `closed`" } };
          }
          const patch: Record<string, unknown> = { state: input["state"] };
          if (typeof input["state_reason"] === "string") {
            patch["state_reason"] = input["state_reason"];
          }
          const body = await this.#json(await this.#request("PATCH", base, { body: patch }));
          return { success: true, output: pickIssueFields(body) };
        }
        default:
          return { success: false, output: { error: `unsupported tool: ${name}` } };
      }
    } catch (err) {
      const error = err instanceof TrackerError
        ? { category: err.category, message: err.message }
        : { category: "tracker_request", message: (err as Error).message };
      return { success: false, output: { error } };
    }
  }

  async #request(
    method: string,
    url: string,
    options: { body?: unknown; allowMissing?: boolean } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${this.config.token}`,
      "user-agent": "symphony",
      "x-github-api-version": "2022-11-28",
    };
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (err) {
      throw new TrackerError(
        "tracker_request",
        `GitHub request failed: ${(err as Error).message}`,
        {
          retryable: true,
          cause: err,
        },
      );
    }
    if (response.ok) return response;
    if (options.allowMissing && (response.status === 404 || response.status === 410)) {
      await response.body?.cancel();
      return response;
    }
    const text = await response.text().catch(() => "");
    const remaining = response.headers.get("x-ratelimit-remaining");
    const retryAfter = response.headers.get("retry-after");
    if (
      response.status === 429 ||
      (response.status === 403 && (remaining === "0" || retryAfter !== null))
    ) {
      throw new TrackerError(
        "tracker_rate_limited",
        `GitHub rate limit reached (${response.status})`,
        {
          retryable: true,
          status: response.status,
          retryAfterMs: retryAfter !== null && /^\d+$/.test(retryAfter)
            ? Number(retryAfter) * 1000
            : null,
        },
      );
    }
    throw new TrackerError(
      "tracker_status",
      `GitHub responded ${response.status} for ${method} ${url}: ${text.slice(0, 200)}`,
      { retryable: response.status >= 500, status: response.status },
    );
  }

  async #json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (err) {
      throw new TrackerError(
        "tracker_response",
        `GitHub response is not JSON: ${(err as Error).message}`,
        {
          cause: err,
        },
      );
    }
  }
}

function pickIssueFields(body: unknown): Record<string, unknown> {
  const p = (body && typeof body === "object" ? body : {}) as GitHubIssuePayload;
  return {
    number: p.number,
    title: p.title,
    body: p.body ?? null,
    state: p.state,
    state_reason: p.state_reason ?? null,
    labels: rawLabelNames(p),
    assignees: Array.isArray(p.assignees)
      ? p.assignees.map((u) => (u as GitHubUser)?.login).filter((l) => typeof l === "string")
      : [],
    url: p.html_url ?? null,
  };
}

export const githubFactory: TrackerAdapterFactory = {
  kind: "github",
  defaultActiveStates: ["open"],
  defaultTerminalStates: ["closed"],
  create(settings: TrackerSettings, env: EnvLookup): TrackerAdapter {
    return new GitHubAdapter(parseGitHubProvider(settings.provider, env));
  },
};
