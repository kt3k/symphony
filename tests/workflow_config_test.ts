import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { loadWorkflow, parseWorkflow, WorkflowError } from "../src/workflow/loader.ts";
import { buildConfig, ConfigError, DEFAULTS } from "../src/config/config.ts";
import type { WorkflowDefinition } from "../src/workflow/loader.ts";

function def(config: Record<string, unknown>, dir = "/wf"): WorkflowDefinition {
  return { path: join(dir, "WORKFLOW.md"), dir, source: "", config, promptTemplate: "" };
}

const env = (vars: Record<string, string>) => (name: string) => vars[name];

Deno.test("parseWorkflow splits front matter and trims body", () => {
  const out = parseWorkflow("---\npolling:\n  interval_ms: 5\n---\n\nHello {{ issue.id }}\n\n");
  assertEquals(out.config, { polling: { interval_ms: 5 } });
  assertEquals(out.promptTemplate, "Hello {{ issue.id }}");
});

Deno.test("parseWorkflow without front matter uses whole file as body", () => {
  const out = parseWorkflow("Just a prompt\n");
  assertEquals(out.config, {});
  assertEquals(out.promptTemplate, "Just a prompt");
});

Deno.test("parseWorkflow rejects non-map front matter and bad YAML", () => {
  const err = assertThrows(() => parseWorkflow("---\n- a\n- b\n---\nbody"), WorkflowError);
  assertEquals(err.code, "workflow_front_matter_not_a_map");
  const err2 = assertThrows(() => parseWorkflow("---\nfoo: [unclosed\n---\nbody"), WorkflowError);
  assertEquals(err2.code, "workflow_parse_error");
  const err3 = assertThrows(() => parseWorkflow("---\nfoo: 1\nbody"), WorkflowError);
  assertEquals(err3.code, "workflow_parse_error");
});

Deno.test("loadWorkflow reports missing file with typed error", async () => {
  const err = await assertRejects(() => loadWorkflow("/nonexistent/WORKFLOW.md"), WorkflowError);
  assertEquals(err.code, "missing_workflow_file");
});

Deno.test("buildConfig applies defaults", () => {
  const cfg = buildConfig(def({}), env({ TMPDIR: "/tmp" }));
  assertEquals(cfg.polling.intervalMs, DEFAULTS.pollingIntervalMs);
  assertEquals(cfg.hooks.timeoutMs, DEFAULTS.hookTimeoutMs);
  assertEquals(cfg.agent.maxConcurrentAgents, DEFAULTS.maxConcurrentAgents);
  assertEquals(cfg.agent.maxTurns, DEFAULTS.maxTurns);
  assertEquals(cfg.agent.maxRetryBackoffMs, DEFAULTS.maxRetryBackoffMs);
  assertEquals(cfg.codex.command, "codex app-server");
  assertEquals(cfg.codex.turnTimeoutMs, 3_600_000);
  assertEquals(cfg.codex.readTimeoutMs, 5_000);
  assertEquals(cfg.codex.stallTimeoutMs, 300_000);
  assertEquals(cfg.workspace.root, "/tmp/symphony_workspaces");
  assertEquals(cfg.tracker.kind, null);
  assertEquals(cfg.tracker.requiredLabels, []);
  assertEquals(cfg.tracker.activeStates, null);
});

Deno.test("buildConfig resolves relative workspace.root against WORKFLOW.md dir", () => {
  const cfg = buildConfig(def({ workspace: { root: "./ws" } }, "/repo"), env({}));
  assertEquals(cfg.workspace.root, "/repo/ws");
});

Deno.test("buildConfig resolves $VAR and ~ for workspace.root", () => {
  const a = buildConfig(def({ workspace: { root: "$WS" } }), env({ WS: "/data/ws" }));
  assertEquals(a.workspace.root, "/data/ws");
  const b = buildConfig(def({ workspace: { root: "~/ws" } }), env({ HOME: "/home/me" }));
  assertEquals(b.workspace.root, "/home/me/ws");
  assertThrows(() => buildConfig(def({ workspace: { root: "$MISSING" } }), env({})), ConfigError);
});

Deno.test("buildConfig keeps codex.command as a shell string and preserves provider keys", () => {
  const cfg = buildConfig(
    def({
      tracker: {
        kind: "github",
        provider: { owner: "a", repo: "b", token: "$T", extra: { x: 1 } },
      },
      codex: { command: "npx codex app-server --foo" },
    }),
    env({}),
  );
  assertEquals(cfg.codex.command, "npx codex app-server --foo");
  assertEquals(cfg.tracker.provider, { owner: "a", repo: "b", token: "$T", extra: { x: 1 } });
});

Deno.test("buildConfig normalizes per-state concurrency map and ignores invalid entries", () => {
  const cfg = buildConfig(
    def({
      agent: { max_concurrent_agents_by_state: { " In Progress ": 2, Todo: 0, Bad: "x", Neg: -1 } },
    }),
    env({}),
  );
  assertEquals([...cfg.agent.maxConcurrentAgentsByState.entries()], [["in progress", 2]]);
});

Deno.test("buildConfig rejects invalid values", () => {
  assertThrows(() => buildConfig(def({ hooks: { timeout_ms: "soon" } }), env({})), ConfigError);
  assertThrows(() => buildConfig(def({ hooks: { timeout_ms: 0 } }), env({})), ConfigError);
  assertThrows(() => buildConfig(def({ agent: { max_turns: 0 } }), env({})), ConfigError);
  assertThrows(() => buildConfig(def({ polling: { interval_ms: 1.5 } }), env({})), ConfigError);
  assertThrows(() => buildConfig(def({ tracker: "github" }), env({})), ConfigError);
  assertThrows(() => buildConfig(def({ tracker: { required_labels: "x" } }), env({})), ConfigError);
});

Deno.test("buildConfig ignores unknown keys", () => {
  const cfg = buildConfig(def({ server: { port: 8080 }, whatever: 1 }), env({}));
  assert(cfg);
});
