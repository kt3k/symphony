import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { App } from "../src/app.ts";
import { parseArgs } from "../main.ts";
import { Logger, MemorySink } from "../src/observability/logger.ts";
import { fakeRegistry, fakeSessions, FakeTracker, makeIssue, sleep, waitFor } from "./helpers.ts";

Deno.test("parseArgs: positional path, default, options and errors", () => {
  assertEquals(parseArgs([]).workflowPath, "WORKFLOW.md");
  assertEquals(parseArgs(["./x/WORKFLOW.md"]).workflowPath, "./x/WORKFLOW.md");
  assertEquals(parseArgs(["--log-level", "debug"]).logLevel, "debug");
  assertEquals(parseArgs(["--log-level=warn"]).logLevel, "warn");
  assert(parseArgs(["--help"]).help);
  assert(parseArgs(["-V"]).version);
  assertThrows(() => parseArgs(["a", "b"]));
  assertThrows(() => parseArgs(["--bogus"]));
  assertThrows(() => parseArgs(["--log-level", "loud"]));
});

Deno.test("CLI exits nonzero on missing workflow and prints help", async () => {
  const main = new URL("../main.ts", import.meta.url).pathname;
  const missing = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", main, "/nonexistent/WORKFLOW.md"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(missing.code, 1);
  assert(
    new TextDecoder().decode(missing.stderr).includes("missing_workflow_file") ||
      new TextDecoder().decode(missing.stderr).includes("cannot read workflow file"),
  );

  const help = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", main, "--help"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(help.code, 0);
  assert(new TextDecoder().decode(help.stdout).includes("Usage: symphony"));
});

Deno.test("App starts, reloads WORKFLOW.md on change and keeps last known good on invalid reload", async () => {
  const dir = await Deno.makeTempDir();
  const root = join(dir, "ws");
  const workflowPath = join(dir, "WORKFLOW.md");
  const workflow = (prompt: string, extra = "") =>
    `---\ntracker:\n  kind: fake\n  active_states: [Todo]\n  terminal_states: [Done]\npolling:\n  interval_ms: 60\nworkspace:\n  root: ./ws\nagent:\n  max_concurrent_agents: 1\n  max_turns: 1\ncodex:\n  stall_timeout_ms: 0\n${extra}---\n${prompt}\n`;
  await Deno.writeTextFile(workflowPath, workflow("First {{ issue.identifier }}"));

  const tracker = new FakeTracker();
  tracker.set(makeIssue({ id: "1" }));
  const sessions = fakeSessions(() => "hang");
  const sink = new MemorySink();
  const app = await App.start({
    workflowPath,
    logger: new Logger([sink]),
    env: () => undefined,
    parentEnv: {},
    startSession: sessions.factory,
    trackerRegistry: fakeRegistry(tracker),
    watchDebounceMs: 50,
  });
  try {
    await waitFor(() => sessions.sessions.length === 1);
    assertEquals(sessions.sessions[0].turns[0], "First T-1");
    assertEquals(app.orchestrator.config.workspace.root, root);

    // Valid change: prompt + concurrency are re-applied without restart.
    tracker.set(makeIssue({ id: "2" }));
    await Deno.writeTextFile(
      workflowPath,
      workflow("Second {{ issue.identifier }}").replace(
        "max_concurrent_agents: 1",
        "max_concurrent_agents: 2",
      ),
    );
    await waitFor(() => sessions.sessions.length === 2, 4000, "reload dispatch");
    assertEquals(sessions.sessions[1].turns[0], "Second T-2");
    assert(sink.lines.some((l) => l.includes("workflow reloaded")));

    // Invalid change: error is visible, previous config stays effective.
    await Deno.writeTextFile(workflowPath, "---\n- not\n- a map\n---\nbody\n");
    await waitFor(
      () => app.orchestrator.snapshot().last_reload_error !== null,
      4000,
      "reload error",
    );
    assert(app.orchestrator.snapshot().last_reload_error?.includes("front matter"));
    assertEquals(app.orchestrator.config.agent.maxConcurrentAgents, 2);
    assertEquals(app.orchestrator.snapshot().counts.running, 2);
  } finally {
    await app.stop();
    await sleep(30);
  }
});

Deno.test("App.start fails on invalid config", async () => {
  const dir = await Deno.makeTempDir();
  const workflowPath = join(dir, "WORKFLOW.md");
  await Deno.writeTextFile(workflowPath, "---\ntracker:\n  kind: nope\n---\nbody\n");
  await assertRejects(
    () =>
      App.start({
        workflowPath,
        logger: new Logger([new MemorySink()]),
        env: () => undefined,
        parentEnv: {},
      }),
    Error,
    "unsupported tracker.kind",
  );
});
