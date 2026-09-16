import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { buildConfig } from "../src/config/config.ts";
import { Orchestrator } from "../src/orchestrator/orchestrator.ts";
import { Logger, MemorySink } from "../src/observability/logger.ts";
import {
  definition,
  fakeRegistry,
  fakeSessions,
  FakeTracker,
  makeIssue,
  sleep,
  waitFor,
} from "./helpers.ts";
import type { AppServerSessionOptions } from "../src/agent/app_server.ts";
import type { TurnBehavior } from "./helpers.ts";

interface Harness {
  tracker: FakeTracker;
  orchestrator: Orchestrator;
  sink: MemorySink;
  sessions: ReturnType<typeof fakeSessions>["sessions"];
  root: string;
  shutdown: () => Promise<void>;
}

async function harness(
  overrides: Record<string, unknown> = {},
  behavior?: (options: AppServerSessionOptions, turn: number) => TurnBehavior,
  startupError?: (options: AppServerSessionOptions) => Error | null,
): Promise<Harness> {
  const root = await Deno.makeTempDir();
  const tracker = new FakeTracker();
  const sink = new MemorySink();
  const logger = new Logger([sink], {}, "debug");
  const config = buildConfig(
    definition({
      tracker: {
        kind: "fake",
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Done"],
        ...(overrides.tracker as object ?? {}),
      },
      polling: { interval_ms: 60 },
      workspace: { root },
      agent: { max_concurrent_agents: 3, max_turns: 3, ...(overrides.agent as object ?? {}) },
      codex: { stall_timeout_ms: 0, ...(overrides.codex as object ?? {}) },
      hooks: overrides.hooks ?? {},
    }, root),
    () => undefined,
  );
  const sessions = fakeSessions(behavior, startupError);
  const orchestrator = new Orchestrator(
    definition(config as unknown as Record<string, unknown>, root),
    config,
    {
      logger,
      env: () => undefined,
      parentEnv: { PATH: "/bin", FAKE_TOKEN: "secret" },
      startSession: sessions.factory,
      trackerRegistry: fakeRegistry(tracker),
    },
  );
  return {
    tracker,
    orchestrator,
    sink,
    sessions: sessions.sessions,
    root,
    shutdown: async () => {
      await orchestrator.stop();
      await sleep(30);
    },
  };
}

Deno.test("dispatches eligible issues in priority/created order and skips ineligible ones", async () => {
  const h = await harness({ agent: { max_concurrent_agents: 10 } }, () => "hang");
  h.tracker.set(makeIssue({ id: "late", priority: 2, created_at: "2026-01-02T00:00:00Z" }));
  h.tracker.set(makeIssue({ id: "early", priority: 2, created_at: "2026-01-01T00:00:00Z" }));
  h.tracker.set(makeIssue({ id: "p1", priority: 1, created_at: "2026-01-03T00:00:00Z" }));
  h.tracker.set(makeIssue({ id: "nopri", priority: null }));
  h.tracker.set(makeIssue({ id: "nodispatch", dispatchable: false }));
  h.tracker.set(makeIssue({ id: "done", state: "Done" }));
  h.tracker.set(makeIssue({ id: "other", state: "Backlog" }));
  await h.orchestrator.start();
  await waitFor(() => h.sessions.length === 4, 3000, "4 sessions");
  await sleep(50);
  assertEquals(h.sessions.length, 4);
  // Dispatch order is the insertion order of the running map; session creation may interleave.
  const order = h.orchestrator.snapshot().running.map((r) => r.issue_identifier);
  assertEquals(order, ["T-p1", "T-early", "T-late", "T-nopri"]);
  // Secret env is stripped from the child environment.
  assertEquals(h.sessions[0].options.env["FAKE_TOKEN"], undefined);
  assertEquals(h.sessions[0].options.env["PATH"], "/bin");
  assert(h.sessions.some((s) => s.options.cwd === join(h.root, "T-p1")));
  const snap = h.orchestrator.snapshot();
  assertEquals(snap.counts.running, 4);
  await h.shutdown();
});

Deno.test("required labels are case-insensitive and blank labels match nothing", async () => {
  const h = await harness({ tracker: { required_labels: [" Symphony "] } }, () => "hang");
  h.tracker.set(makeIssue({ id: "a", labels: ["symphony"] }));
  h.tracker.set(makeIssue({ id: "b", labels: ["other"] }));
  await h.orchestrator.start();
  await waitFor(() => h.sessions.length === 1);
  await sleep(100);
  assertEquals(h.sessions.length, 1);
  assertEquals(h.sessions[0].options.title.startsWith("T-a"), true);
  await h.shutdown();

  const h2 = await harness({ tracker: { required_labels: [""] } }, () => "hang");
  h2.tracker.set(makeIssue({ id: "a" }));
  await h2.orchestrator.start();
  await sleep(150);
  assertEquals(h2.sessions.length, 0);
  await h2.shutdown();
});

Deno.test("global and per-state concurrency limits are enforced", async () => {
  const h = await harness(
    { agent: { max_concurrent_agents: 3, max_concurrent_agents_by_state: { "in progress": 1 } } },
    () => "hang",
  );
  h.tracker.set(makeIssue({ id: "1", state: "In Progress", priority: 1 }));
  h.tracker.set(makeIssue({ id: "2", state: "In Progress", priority: 1 }));
  h.tracker.set(makeIssue({ id: "3", state: "Todo", priority: 2 }));
  h.tracker.set(makeIssue({ id: "4", state: "Todo", priority: 2 }));
  h.tracker.set(makeIssue({ id: "5", state: "Todo", priority: 2 }));
  await h.orchestrator.start();
  await waitFor(() => h.sessions.length === 3);
  await sleep(150);
  const ids = h.sessions.map((s) => s.options.title.split(":")[0]).sort();
  assertEquals(ids, ["T-1", "T-3", "T-4"]);
  await h.shutdown();
});

Deno.test("worker runs continuation turns while active, then exits and re-checks via continuation retry", async () => {
  const h = await harness({ agent: { max_turns: 3 } });
  h.tracker.set(makeIssue({ id: "1" }));
  await h.orchestrator.start();
  await waitFor(() => h.sessions.length === 1 && h.sessions[0].turns.length === 3, 3000, "3 turns");
  await waitFor(() => h.sessions[0].stopped);
  assert(h.sessions[0].turns[0].startsWith("Work on T-1"));
  assert(h.sessions[0].turns[1].includes("Continue working on T-1"));
  const snap = h.orchestrator.snapshot();
  assertEquals(snap.counts.retrying, 1);
  assertEquals(snap.retrying[0].attempt, 1);
  assertEquals(snap.retrying[0].error, null);
  assertEquals(snap.codex_totals.total_tokens, 330);
  // The tick must not dispatch while the continuation claim exists.
  await sleep(150);
  assertEquals(h.sessions.length, 1);
  // Continuation retry (~1s) re-dispatches with attempt=1 because the issue is still active.
  await waitFor(() => h.sessions.length === 2, 2500, "continuation dispatch");
  assert(h.sessions[1].turns.length >= 1);
  await h.shutdown();
});

Deno.test("worker stops early when the issue leaves the active set after a turn", async () => {
  const h = await harness({ agent: { max_turns: 5 } }, (_o, turn) => {
    if (turn === 1) h.tracker.set(makeIssue({ id: "1", state: "Human Review" }));
    return "complete";
  });
  h.tracker.set(makeIssue({ id: "1" }));
  await h.orchestrator.start();
  await waitFor(() => h.sessions.length === 1 && h.sessions[0].stopped);
  assertEquals(h.sessions[0].turns.length, 1);
  // Continuation retry finds a non-active issue and releases the claim.
  await waitFor(() => h.orchestrator.snapshot().counts.retrying === 0, 2500, "claim release");
  await sleep(150);
  assertEquals(h.sessions.length, 1);
  await h.shutdown();
});

Deno.test("abnormal exit schedules exponential backoff retry with error", async () => {
  const h = await harness({}, () => "fail");
  h.tracker.set(makeIssue({ id: "1" }));
  await h.orchestrator.start();
  await waitFor(() => h.orchestrator.snapshot().counts.retrying === 1);
  const retry = h.orchestrator.snapshot().retrying[0];
  assertEquals(retry.attempt, 1);
  assert(
    retry.error?.includes("worker exited: agent turn error (turn_failed): boom"),
    retry.error ?? "",
  );
  const due = Date.parse(retry.due_at) - Date.now();
  assert(due > 9000 && due <= 10_050, `due in ${due}ms`);
  await h.shutdown();
});

Deno.test("startup failure of the agent session is a worker failure", async () => {
  const h = await harness({}, undefined, () => new Error("no codex"));
  h.tracker.set(makeIssue({ id: "1" }));
  await h.orchestrator.start();
  await waitFor(() => h.orchestrator.snapshot().counts.retrying === 1);
  assert(h.orchestrator.snapshot().retrying[0].error?.includes("agent session startup error"));
  await h.shutdown();
});

Deno.test("reconciliation stops terminal issues with cleanup and non-active without", async () => {
  const h = await harness({}, () => "hang");
  h.tracker.set(makeIssue({ id: "1" }));
  h.tracker.set(makeIssue({ id: "2" }));
  await h.orchestrator.start();
  await waitFor(() => h.sessions.length === 2);
  const ws1 = join(h.root, "T-1");
  const ws2 = join(h.root, "T-2");
  await Deno.stat(ws1);
  await Deno.stat(ws2);
  h.tracker.set(makeIssue({ id: "1", state: "Done" }));
  h.tracker.set(makeIssue({ id: "2", state: "Backlog" }));
  await waitFor(() => h.orchestrator.snapshot().counts.running === 0);
  await waitFor(() => h.sessions.every((s) => s.stopped));
  await assertRejects(() => Deno.stat(ws1), Deno.errors.NotFound);
  await Deno.stat(ws2);
  assertEquals(h.orchestrator.snapshot().counts.retrying, 0);
  // Issue 2 back to active is dispatched again (claim was released).
  h.tracker.set(makeIssue({ id: "2", state: "Todo" }));
  await waitFor(() => h.sessions.length === 3);
  await h.shutdown();
});

Deno.test("reconciliation terminates issues that vanished from scope and tolerates refresh failure", async () => {
  const h = await harness({}, () => "hang");
  h.tracker.set(makeIssue({ id: "1" }));
  await h.orchestrator.start();
  await waitFor(() => h.sessions.length === 1);
  h.tracker.failIds = new Error("api down");
  await sleep(200);
  assertEquals(h.orchestrator.snapshot().counts.running, 1);
  h.tracker.failIds = null;
  h.tracker.issues.delete("1");
  await waitFor(() => h.orchestrator.snapshot().counts.running === 0);
  await h.shutdown();
});

Deno.test("stall detection kills silent sessions and queues a retry", async () => {
  const h = await harness({ codex: { stall_timeout_ms: 100 } }, () => "hang");
  h.tracker.set(makeIssue({ id: "1" }));
  await h.orchestrator.start();
  await waitFor(() => h.sessions.length === 1);
  await waitFor(() => h.orchestrator.snapshot().counts.retrying === 1, 2000, "stall retry");
  assert(h.orchestrator.snapshot().retrying[0].error?.startsWith("stalled"));
  assert(h.sessions[0].stopped);
  await h.shutdown();
});

Deno.test("validation failure skips dispatch but keeps reconciliation and is operator-visible", async () => {
  const h = await harness({}, () => "hang");
  h.tracker.set(makeIssue({ id: "1" }));
  await h.orchestrator.start();
  await waitFor(() => h.sessions.length === 1);
  h.tracker.set(makeIssue({ id: "2" }));
  const broken = buildConfig(
    definition({
      tracker: { kind: "nope" },
      polling: { interval_ms: 60 },
      workspace: { root: h.root },
    }, h.root),
    () => undefined,
  );
  h.orchestrator.applyWorkflow(definition({}, h.root), broken);
  await sleep(200);
  assertEquals(h.sessions.length, 1);
  assert(h.orchestrator.snapshot().last_validation_error?.includes("unsupported tracker.kind"));
  assert(h.sink.lines.some((l) => l.includes("validation failed")));
  // Reconciliation still runs against the last effective tracker: terminal issue is stopped.
  h.tracker.set(makeIssue({ id: "1", state: "Done" }));
  await waitFor(() => h.orchestrator.snapshot().counts.running === 0);
  await h.shutdown();
});

Deno.test("startup validation failure rejects start", async () => {
  const h = await harness({ tracker: { kind: "missing" } });
  await assertRejects(() => h.orchestrator.start(), Error, "unsupported tracker.kind");
  await h.shutdown();
});

Deno.test("startup cleanup removes terminal workspaces and tolerates fetch failure", async () => {
  const h = await harness({}, () => "hang");
  await Deno.mkdir(join(h.root, "T-old"));
  h.tracker.set(makeIssue({ id: "old", state: "Done" }));
  await h.orchestrator.start();
  await assertRejects(() => Deno.stat(join(h.root, "T-old")), Deno.errors.NotFound);
  await h.shutdown();

  const h2 = await harness({}, () => "hang");
  h2.tracker.failStates = new Error("down");
  await h2.orchestrator.start();
  assert(h2.sink.lines.some((l) => l.includes("startup terminal cleanup skipped")));
  await h2.shutdown();
});

Deno.test("hooks run around attempts; before_run failure fails the attempt", async () => {
  const h = await harness({
    hooks: { before_run: "echo run >> hooks.log", after_run: "echo after >> hooks.log" },
  });
  h.tracker.set(makeIssue({ id: "1" }));
  await h.orchestrator.start();
  const logPath = join(h.root, "T-1", "hooks.log");
  const readLog = () => {
    try {
      return Deno.readTextFileSync(logPath);
    } catch {
      return "";
    }
  };
  await waitFor(() => readLog().includes("after"), 5000, "after_run hook");
  assertEquals(readLog(), "run\nafter\n");
  await h.shutdown();

  const h2 = await harness({ hooks: { before_run: "exit 2" } });
  h2.tracker.set(makeIssue({ id: "1" }));
  await h2.orchestrator.start();
  await waitFor(() => h2.orchestrator.snapshot().counts.retrying === 1);
  assert(h2.orchestrator.snapshot().retrying[0].error?.includes("before_run hook failed"));
  assertEquals(h2.sessions.length, 0);
  await h2.shutdown();
});

Deno.test("applyWorkflow changes concurrency for subsequent dispatch", async () => {
  const h = await harness({ agent: { max_concurrent_agents: 1 } }, () => "hang");
  h.tracker.set(makeIssue({ id: "1", priority: 1 }));
  h.tracker.set(makeIssue({ id: "2", priority: 2 }));
  await h.orchestrator.start();
  await waitFor(() => h.sessions.length === 1);
  await sleep(150);
  assertEquals(h.sessions.length, 1);
  const bigger = buildConfig(
    definition({
      tracker: { kind: "fake", active_states: ["Todo"], terminal_states: ["Done"] },
      polling: { interval_ms: 60 },
      workspace: { root: h.root },
      agent: { max_concurrent_agents: 2 },
      codex: { stall_timeout_ms: 0 },
    }, h.root),
    () => undefined,
  );
  h.orchestrator.applyWorkflow(definition({}, h.root, "New prompt {{ issue.id }}"), bigger);
  await waitFor(() => h.sessions.length === 2);
  assertEquals(h.sessions[1].turns[0], "New prompt 2");
  await h.shutdown();
});

Deno.test("snapshot exposes running rows with session ids, turn counts and tokens", async () => {
  const h = await harness({}, () => "hang");
  h.tracker.set(makeIssue({ id: "1", url: "https://x/1" }));
  await h.orchestrator.start();
  await waitFor(() => h.orchestrator.snapshot().running[0]?.session_id === "thread-x-turn-1");
  const row = h.orchestrator.snapshot().running[0];
  assertEquals(row.issue_identifier, "T-1");
  assertEquals(row.issue_url, "https://x/1");
  assertEquals(row.turn_count, 1);
  assertEquals(row.tokens, { input_tokens: 100, output_tokens: 10, total_tokens: 110 });
  assert((await h.orchestrator.issueDetails("T-1"))?.status === "running");
  assertEquals(await h.orchestrator.issueDetails("T-404"), null);
  await h.shutdown();
});
