import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  AgentError,
  type AgentEvent,
  AppServerSession,
  type AppServerSessionOptions,
} from "../src/agent/app_server.ts";
import { Logger, MemorySink } from "../src/observability/logger.ts";

const fakePath = fromFileUrl(new URL("./fixtures/fake_app_server.ts", import.meta.url));
const denoBin = Deno.execPath();

function options(overrides: Partial<AppServerSessionOptions> = {}) {
  const events: AgentEvent[] = [];
  const cwd = Deno.makeTempDirSync();
  const opts: AppServerSessionOptions = {
    command: `${JSON.stringify(denoBin)} run --allow-env --allow-read ${JSON.stringify(fakePath)}`,
    cwd,
    env: { PATH: Deno.env.get("PATH") ?? "", HOME: Deno.env.get("HOME") ?? "" },
    approvalPolicy: "on-request",
    threadSandbox: "workspace-write",
    turnSandboxPolicy: { type: "workspaceWrite", networkAccess: true },
    readTimeoutMs: 5000,
    turnTimeoutMs: 5000,
    title: "X-1: test",
    tools: [{
      name: "echo_tool",
      description: "echo",
      inputSchema: { type: "object" },
      mutates: false,
    }],
    executeTool: (name, args) => Promise.resolve({ success: true, output: { name, args } }),
    onEvent: (event) => events.push(event),
    logger: new Logger([new MemorySink()]),
    ...overrides,
  };
  return { opts, events, cwd };
}

Deno.test("session starts, runs turns, reports usage and rate limits", async () => {
  const { opts, events } = options();
  const session = await AppServerSession.start(opts);
  assertEquals(session.threadId, "thread-1");
  const first = await session.runTurn("do the work");
  assertEquals(first.turnId, "turn-1");
  const second = await session.runTurn("continue");
  assertEquals(second.turnId, "turn-2");
  await session.stop();

  const names = events.map((e) => e.event);
  assertEquals(names.filter((n) => n === "session_started").length, 1);
  assert(names.includes("turn_started"));
  assertEquals(names.filter((n) => n === "turn_completed").length, 2);
  const usage = events.filter((e) => e.event === "token_usage").map((e) => e.usage);
  assertEquals(usage[0], { input_tokens: 100, output_tokens: 50, total_tokens: 150 });
  assertEquals(usage[1], { input_tokens: 200, output_tokens: 100, total_tokens: 300 });
  assert(
    events.some((e) =>
      e.event === "rate_limits" &&
      (e.rate_limits as { primary: { usedPercent: number } }).primary.usedPercent === 12
    ),
  );
  const started = events.find((e) => e.event === "session_started")!;
  assertEquals(started.session_id, "thread-1-turn-1");
});

Deno.test("approvals are auto-accepted and dynamic tools execute host-side", async () => {
  const { opts, events } = options();
  const session = await AppServerSession.start(opts);
  await session.runTurn("APPROVAL TOOL:echo_tool");
  await session.stop();
  assert(events.some((e) => e.event === "approval_auto_approved"));
  assert(events.some((e) => e.event === "tool_call" && e.message === "echo_tool"));
  const messages = events.filter((e) => e.event === "notification").map((e) => e.message ?? "");
  assert(messages.some((m) => m.includes('approval="acceptForSession"')), messages.join("|"));
  assert(
    messages.some((m) => m.includes('"success":true') && m.includes("hello")),
    messages.join("|"),
  );
});

Deno.test("unsupported dynamic tools fail without stalling", async () => {
  const { opts, events } = options();
  const session = await AppServerSession.start(opts);
  await session.runTurn("TOOL:nope_tool");
  await session.stop();
  assert(events.some((e) => e.event === "unsupported_tool_call"));
  assert(events.some((e) => e.event === "turn_completed"));
});

Deno.test("user input requests fail the turn", async () => {
  const { opts, events } = options();
  const session = await AppServerSession.start(opts);
  const err = await assertRejects(() => session.runTurn("INPUT"), AgentError);
  assertEquals(err.code, "turn_input_required");
  await session.stop();
  assert(events.some((e) => e.event === "turn_input_required"));
});

Deno.test("failed turn maps to turn_failed with the error message", async () => {
  const { opts } = options();
  const session = await AppServerSession.start(opts);
  const err = await assertRejects(() => session.runTurn("FAIL"), AgentError);
  assertEquals(err.code, "turn_failed");
  assertEquals(err.message, "boom");
  await session.stop();
});

Deno.test("turn timeout fires on stream silence", async () => {
  const { opts } = options({ turnTimeoutMs: 300 });
  const session = await AppServerSession.start(opts);
  const err = await assertRejects(() => session.runTurn("HANG"), AgentError);
  assertEquals(err.code, "turn_timeout");
  await session.stop();
});

Deno.test("process exit during a turn maps to port_exit", async () => {
  const { opts } = options();
  const session = await AppServerSession.start(opts);
  const err = await assertRejects(() => session.runTurn("EXIT"), AgentError);
  assertEquals(err.code, "port_exit");
  await session.stop();
});

Deno.test("missing command maps to codex_not_found", async () => {
  const { opts } = options({ command: "definitely-not-a-real-binary-xyz app-server" });
  const err = await assertRejects(() => AppServerSession.start(opts), AgentError);
  assertEquals(err.code, "codex_not_found");
});

Deno.test("thread/start error surfaces as response_error and startup_failed", async () => {
  const { opts, events } = options();
  opts.env = { ...opts.env, FAKE_THREAD_START_ERROR: "1" };
  const err = await assertRejects(() => AppServerSession.start(opts), AgentError);
  assertEquals(err.code, "response_error");
  assert(events.some((e) => e.event === "startup_failed"));
});

Deno.test("read timeout during handshake maps to response_timeout", async () => {
  const { opts } = options({ command: "sleep 30", readTimeoutMs: 200 });
  const err = await assertRejects(() => AppServerSession.start(opts), AgentError);
  assertEquals(err.code, "response_timeout");
});
