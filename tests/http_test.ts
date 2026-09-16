import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { App } from "../src/app.ts";
import { parseArgs } from "../main.ts";
import { Logger, MemorySink } from "../src/observability/logger.ts";
import { fakeRegistry, fakeSessions, FakeTracker, makeIssue, sleep, waitFor } from "./helpers.ts";

async function startApp(serverSection: string, port?: number) {
  const dir = await Deno.makeTempDir();
  const workflowPath = join(dir, "WORKFLOW.md");
  await Deno.writeTextFile(
    workflowPath,
    `---\ntracker:\n  kind: fake\n  active_states: [Todo]\n  terminal_states: [Done]\npolling:\n  interval_ms: 60\nworkspace:\n  root: ./ws\ncodex:\n  stall_timeout_ms: 0\n${serverSection}---\nWork {{ issue.identifier }}\n`,
  );
  const tracker = new FakeTracker();
  tracker.set(makeIssue({ id: "1", url: "https://x/1" }));
  const sessions = fakeSessions(() => "hang");
  const app = await App.start({
    workflowPath,
    logger: new Logger([new MemorySink()]),
    env: () => undefined,
    parentEnv: {},
    startSession: sessions.factory,
    trackerRegistry: fakeRegistry(tracker),
    port,
  });
  return {
    app,
    dir,
    stop: async () => {
      await app.stop();
      await sleep(30);
    },
  };
}

Deno.test("parseArgs accepts --port", () => {
  assertEquals(parseArgs(["--port", "8080"]).port, 8080);
  assertEquals(parseArgs(["--port=0"]).port, 0);
  assertEquals(parseArgs([]).port, undefined);
  let threw = false;
  try {
    parseArgs(["--port", "abc"]);
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("no server without server.port or --port", async () => {
  const { app, stop } = await startApp("");
  assertEquals(app.httpServer, null);
  await stop();
});

Deno.test("dashboard and JSON API serve orchestrator state", async () => {
  const { app, dir, stop } = await startApp("server:\n  port: 0\n");
  try {
    assert(app.httpServer !== null);
    const base = app.httpServer!.url;
    assert(base.startsWith("http://127.0.0.1:"));
    await waitFor(() => app.orchestrator.snapshot().counts.running === 1);

    const state = await (await fetch(`${base}/api/v1/state`)).json();
    assertEquals(state.counts, { running: 1, retrying: 0 });
    assertEquals(state.running[0].issue_identifier, "T-1");
    assertEquals(state.running[0].issue_url, "https://x/1");
    assert(typeof state.codex_totals.seconds_running === "number");

    const htmlResponse = await fetch(`${base}/`);
    assertEquals(htmlResponse.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await htmlResponse.text();
    assert(html.includes("<title>Symphony</title>"));
    assert(html.includes('<script src="/app.js">'));
    assert(html.includes('<link rel="stylesheet" href="/index.css" />'));
    const js = await fetch(`${base}/app.js`);
    assertEquals(js.status, 200);
    assertEquals(js.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert((await js.text()).includes("/api/v1/state"));
    const css = await fetch(`${base}/index.css`);
    assertEquals(css.status, 200);
    assertEquals(css.headers.get("content-type"), "text/css; charset=utf-8");
    assert((await css.text()).includes(".card"));
    const traversal = await fetch(`${base}/dist/..%2Fdeno.json`);
    assertEquals(traversal.status, 404);
    await traversal.body?.cancel();

    const details = await (await fetch(`${base}/api/v1/T-1`)).json();
    assertEquals(details.status, "running");
    assertEquals(details.workspace.path, join(dir, "ws", "T-1"));
    assertEquals(details.running.session_id, "thread-x-turn-1");

    const missing = await fetch(`${base}/api/v1/T-404`);
    assertEquals(missing.status, 404);
    assertEquals((await missing.json()).error.code, "issue_not_found");

    const refresh = await fetch(`${base}/api/v1/refresh`, { method: "POST" });
    assertEquals(refresh.status, 202);
    const body = await refresh.json();
    assertEquals(body.queued, true);
    assertEquals(body.operations, ["poll", "reconcile"]);

    const wrongMethod = await fetch(`${base}/api/v1/refresh`);
    assertEquals(wrongMethod.status, 405);
    assertEquals(wrongMethod.headers.get("allow"), "POST");
    await wrongMethod.body?.cancel();

    const postState = await fetch(`${base}/api/v1/state`, { method: "POST" });
    assertEquals(postState.status, 405);
    await postState.body?.cancel();

    const unknown = await fetch(`${base}/nope`);
    assertEquals(unknown.status, 404);
    assertEquals((await unknown.json()).error.code, "not_found");
  } finally {
    await stop();
  }
});

Deno.test("missing dashboard build answers 503 for its files but keeps the API", async () => {
  const { HttpServer } = await import("../src/observability/http.ts");
  const { app, stop } = await startApp("");
  const server = HttpServer.start({
    port: 0,
    orchestrator: app.orchestrator,
    logger: new Logger([new MemorySink()]),
    dashboardDir: await Deno.makeTempDir(),
  });
  try {
    const root = await fetch(`${server.url}/`);
    assertEquals(root.status, 503);
    assertEquals((await root.json()).error.code, "dashboard_not_built");
    const css = await fetch(`${server.url}/index.css`);
    assertEquals(css.status, 503);
    await css.body?.cancel();
    const state = await fetch(`${server.url}/api/v1/state`);
    assertEquals(state.status, 200);
    await state.body?.cancel();
  } finally {
    await server.stop();
    await stop();
  }
});

Deno.test("--port overrides server.port", async () => {
  const { app, stop } = await startApp("server:\n  port: 1\n", 0);
  try {
    assert(app.httpServer !== null);
    assert(app.httpServer!.port > 1);
  } finally {
    await stop();
  }
});
