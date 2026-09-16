# Symphony (Deno)

A Deno/TypeScript implementation of the [Symphony Service Specification](./SPEC.md): a long-running
daemon that polls an issue tracker, creates an isolated workspace per issue, and drives a Codex
app-server session for that issue inside the workspace.

- Tracker adapter: **GitHub Issues** (`tracker.kind: github`)
- Coding agent: **Codex app-server** (tested against `@openai/codex` 0.154.0)
- Trust posture: **high-trust** (see
  [Approval, sandbox and user input](#approval-sandbox-and-user-input))

## Requirements

- Deno 2.x (also builds the dashboard; Node is not needed)
- `codex` on `PATH` (or set `codex.command`), logged in / configured for the host
- A GitHub token with `issues:write` on the target repository (exposed as `GITHUB_TOKEN`,
  `GH_TOKEN`, or referenced from `tracker.provider.token` as `$VAR_NAME`)

## Running

```sh
deno task start                      # uses ./WORKFLOW.md
deno task start path/to/WORKFLOW.md  # explicit workflow path
deno task start --log-level debug
deno task start --port 8080          # dashboard + JSON API on http://127.0.0.1:8080
```

Exit codes: `0` on normal shutdown (SIGINT/SIGTERM), `1` when startup fails (missing/invalid
`WORKFLOW.md`, unsupported tracker, rejected provider config), `2` on bad CLI arguments.

Development:

```sh
deno task test    # unit + integration tests (uses a fake app-server, no network)
deno task check   # fmt --check, lint, type check
```

## WORKFLOW.md

See [`WORKFLOW.example.md`](./WORKFLOW.example.md). The file is YAML front matter plus a Markdown
prompt template rendered with strict Liquid (`issue` and `attempt` variables; unknown variables and
filters fail the attempt). Changes to the file are detected and re-applied without a restart; an
invalid edit is logged and the last known good configuration stays in effect.

Core keys and defaults follow SPEC §6.4 exactly. Implementation-defined defaults:

| Key                         | Default                                         |
| --------------------------- | ----------------------------------------------- |
| `workspace.root`            | `$TMPDIR/symphony_workspaces`                   |
| `codex.approval_policy`     | `on-request`                                    |
| `codex.thread_sandbox`      | `workspace-write`                               |
| `codex.turn_sandbox_policy` | `{ type: workspaceWrite, networkAccess: true }` |

`codex.*` policy values are passed through to the app-server untouched; consult
`codex app-server generate-json-schema` for the accepted values of your Codex version.

## GitHub adapter profile (SPEC §11.2)

| Item                                          | Value                                                                                                                                                                                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracker.kind`                                | `github`                                                                                                                                                                                                                                           |
| Scope                                         | One repository: `provider.owner` + `provider.repo`, or `provider.repository: owner/repo`                                                                                                                                                           |
| Auth                                          | `provider.token` (literal or `$VAR`), else `GITHUB_TOKEN`, else `GH_TOKEN`. Empty → `missing_tracker_secret`                                                                                                                                       |
| Other provider keys                           | `api_url` (default `https://api.github.com`), `state_label_prefix` (`status:`), `priority_label_prefix` (`priority:`), `assignee`, `per_page` (100), `timeout_ms` (30000)                                                                          |
| Default states                                | `active_states: [open]`, `terminal_states: [closed]` — override them when you use status labels                                                                                                                                                    |
| `id`                                          | Issue number as a string (opaque to the orchestrator)                                                                                                                                                                                              |
| `identifier`                                  | `<repo>-<number>` (e.g. `widgets-42`); names the workspace directory                                                                                                                                                                               |
| `native_ref`                                  | `{ owner, repo, number, node_id, html_url, is_pull_request }`                                                                                                                                                                                      |
| `state`                                       | `closed` when the issue is closed; otherwise the text after the first `status:` label (provider spelling kept); otherwise `open`                                                                                                                   |
| `priority`                                    | Integer from `priority:<n>` label, or `P<n>` label; else `null`                                                                                                                                                                                    |
| `labels`                                      | Trimmed, lowercased, deduplicated                                                                                                                                                                                                                  |
| `blocked_by`                                  | Always `[]` (GitHub issue dependencies are not queried)                                                                                                                                                                                            |
| `dispatchable`                                | `true` unless the item is a pull request, is locked, or `provider.assignee` is set and does not match                                                                                                                                              |
| Pagination                                    | `per_page` + `Link: rel="next"`; `sort=created&direction=asc`; pull requests are dropped                                                                                                                                                           |
| Malformed records                             | State-list reads log and skip them; ID refresh fails with `tracker_response`                                                                                                                                                                       |
| Missing on ID refresh                         | 404/410 (and pull requests) are omitted                                                                                                                                                                                                            |
| Error mapping                                 | fetch failure → `tracker_request`; 429 or 403 with `x-ratelimit-remaining: 0`/`retry-after` → `tracker_rate_limited` (with `retryAfterMs`); other non-2xx → `tracker_status`; non-JSON → `tracker_response`; runaway paging → `tracker_pagination` |
| Secret env names removed from the agent child | `GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`                                                                                                                                                                       |

### Provider-native agent tools

Advertised as Codex dynamic tools and executed **in the Symphony process** with the configured
token; the agent never sees the token. All tools are scoped to the issue the session is working on.

| Tool                         | Mutates | Input                                          |
| ---------------------------- | ------- | ---------------------------------------------- |
| `github_issue_get`           | no      | `{}`                                           |
| `github_issue_list_comments` | no      | `{}`                                           |
| `github_issue_comment`       | yes     | `{ body: string }`                             |
| `github_issue_add_labels`    | yes     | `{ labels: string[] }`                         |
| `github_issue_remove_label`  | yes     | `{ label: string }`                            |
| `github_issue_set_state`     | yes     | `{ state: "open" \| "closed", state_reason? }` |

Results are `{ success, output }`; failures carry `{ error: { category, message } }` using the
adapter error categories above. Unknown tool names return `success: false` without stalling the
session. Tool declarations are sent in `thread/start` as `dynamicTools` with the `experimentalApi`
capability; a Codex version that ignores the field simply runs without them.

## Approval, sandbox and user input

This implementation targets **trusted environments**. It does not add sandboxing beyond what Codex
and the OS provide.

- `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `execCommandApproval`,
  `applyPatchApproval` → auto-approved for the session (`acceptForSession` /
  `approved_for_session`).
- `item/permissions/requestApproval` → the requested permissions are granted.
- `item/tool/requestUserInput` → the run fails with `turn_input_required`; the turn is interrupted
  and the orchestrator retries with backoff. Symphony never waits for a human.
- Unsupported dynamic tools and unknown server requests → structured failure, session continues.
- MCP elicitations and other interactive server requests → rejected with a JSON-RPC error.

Hardening options (SPEC §15.5): tighten `codex.approval_policy` / `codex.thread_sandbox` /
`codex.turn_sandbox_policy`, restrict dispatch with `required_labels` and `provider.assignee`, run
the daemon as a dedicated user with a dedicated `workspace.root`, and keep tokens out of
`WORKFLOW.md` by using `$VAR` references.

## Workspaces and hooks

- Workspace path: `<workspace.root>/<workspace_key>`; the key is the identifier with characters
  outside `[A-Za-z0-9._-]` replaced by `_` plus a 64-bit SHA-256 suffix when anything was replaced.
- Workspaces are reused across runs and deleted only when the issue reaches a terminal state
  (startup sweep, reconciliation, or a retry refresh that observes the transition).
- Hooks run as `bash -lc <script>` in the workspace with the host environment (including tracker
  secrets, so `after_create` can clone). Failure semantics per SPEC §9.4. An existing non-directory
  at the workspace path is a hard failure. If `after_create` fails the new directory is removed.
- No built-in VCS logic: clone/sync in `after_create` / `before_run`.

## Orchestration notes

- Single in-memory authority (no database). Restart recovery = startup terminal cleanup + fresh
  polling.
- After a clean worker exit a 1s continuation retry re-checks the issue; failures back off
  `min(10s * 2^(attempt-1), agent.max_retry_backoff_ms)`.
- Within one worker the agent runs up to `agent.max_turns` turns on the same thread; later turns
  send continuation guidance only.
- Stall detection compares the last agent event against `codex.stall_timeout_ms`; `<= 0` disables
  it.
- `codex.turn_timeout_ms` is a silence timeout reset by every app-server message, not a total cap.

## Observability

Structured `key=value` logs on stderr with `issue_id`, `issue_identifier` and `session_id`
(`<thread_id>-<turn_id>`). `Orchestrator.snapshot()` returns the SPEC §13.3 runtime snapshot
(running rows with turn counts and tokens, retry queue, aggregate totals, latest rate limits, last
validation/reload errors).

### HTTP dashboard and JSON API (SPEC §13.7)

Enabled by `server.port` in `WORKFLOW.md` or the CLI `--port` flag (the flag wins). Binds
`127.0.0.1` unless `server.host` says otherwise; `port: 0` picks an ephemeral port. Changing
`server.*` requires a restart. The server is read-only apart from `/api/v1/refresh` and is never
needed for correctness.

| Route                      | Response                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`                    | HTML dashboard: tiles, running sessions, retry queue, rate limits, errors; auto-refreshes every 5s                                         |
| `GET /api/v1/state`        | The runtime snapshot (`counts`, `running[]`, `retrying[]`, `codex_totals`, `rate_limits`, `last_validation_error`, `last_reload_error`)    |
| `GET /api/v1/<identifier>` | Per-issue debug view (`status`, `workspace.path`, `attempts`, `running`/`retry` row, `last_error`); `404 issue_not_found` when not tracked |
| `POST /api/v1/refresh`     | `202 { queued, coalesced, requested_at, operations }` — runs a poll + reconcile now                                                        |

Errors use `{ "error": { "code", "message" } }`; wrong methods answer `405` with an `Allow` header.

The dashboard lives in [`dashboard/`](./dashboard) (Vite, React, Tailwind v4, shadcn/ui components
under `src/components/ui`). It is built with Deno's npm compatibility — no Node or npm anywhere in the
repo; `dashboard/deno.json` pins the npm dependencies and `dashboard/deno.lock` locks them. The built
output in `dashboard/dist` is committed so the daemon needs no build step at runtime; CI rebuilds it
and fails if the committed files are stale. After changing the UI:

```sh
deno task build:dashboard   # tsc + vite build -> dashboard/dist
deno task dev:dashboard     # vite dev server; proxies /api to http://127.0.0.1:8080
```

Without a build, `GET /` answers `503 dashboard_not_built` while the JSON API keeps working.

## Layout

```
main.ts                     CLI
src/app.ts                  workflow load -> config -> orchestrator -> watcher
src/workflow/               WORKFLOW.md loader + file watcher
src/config/                 typed config, defaults, $VAR / ~ resolution
src/tracker/                Issue model, adapter contract, GitHub adapter
src/workspace/              workspace keys, directories, hooks, safety invariants
src/prompt/                 strict Liquid rendering, continuation guidance
src/agent/                  Codex app-server client (JSON-RPC over stdio) + worker attempt loop
src/orchestrator/           poll tick, dispatch, retries, reconciliation, snapshot
src/observability/          logger, HTTP server (JSON API + static dashboard)
dashboard/                  React/Tailwind/shadcn dashboard; dist/ is committed
tests/                      Core Conformance tests (fake tracker + fake app-server)
```
