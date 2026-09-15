---
tracker:
  kind: github
  provider:
    repository: your-org/your-repo
    token: $GITHUB_TOKEN
    # state_label_prefix: "status:"     # label that carries the workflow state (default)
    # assignee: symphony-bot            # only dispatch issues assigned to this login
  required_labels: [symphony]
  active_states: ["ready", "in progress"]
  terminal_states: ["closed", "done"]

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces

hooks:
  after_create: |
    git clone "https://github.com/your-org/your-repo.git" .
  before_run: |
    git fetch origin && git checkout -B "symphony/{{ issue.identifier }}" origin/main 2>/dev/null || true
  timeout_ms: 120000

agent:
  max_concurrent_agents: 3
  max_turns: 10
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    "in progress": 2

# server:
#   port: 8080          # dashboard + JSON API on 127.0.0.1 (or run with --port)

codex:
  command: codex app-server
  approval_policy: on-request
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: true
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
---

You are working on GitHub issue **{{ issue.identifier }}**: {{ issue.title }}

{% if attempt %}This is continuation/retry attempt {{ attempt }}. Check the workspace for prior
progress before starting over.{% endif %}

## Issue

{{ issue.description }}

Labels: {% for label in issue.labels %}`{{ label }}` {% endfor %} URL: {{ issue.url }}

## What to do

1. Read the repository and understand the request.
2. Implement the change on a branch named `symphony/{{ issue.identifier }}`, with tests.
3. Run the project's tests and linters.
4. Push the branch and open a pull request.
5. Use `github_issue_comment` to summarize what you did and link the PR.
6. Use `github_issue_add_labels` with `status: review` and `github_issue_remove_label` for the
   current status label to hand the issue off for human review. Do not close the issue yourself.

If you are blocked, comment on the issue explaining why and add the label `status: blocked`.
