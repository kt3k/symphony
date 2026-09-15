import { assert, assertEquals, assertMatch, assertNotEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  isInsideRoot,
  WorkspaceError,
  workspaceKey,
  WorkspaceManager,
} from "../src/workspace/manager.ts";
import { Logger, MemorySink } from "../src/observability/logger.ts";
import type { HooksConfig } from "../src/config/config.ts";

const noHooks: HooksConfig = {
  afterCreate: null,
  beforeRun: null,
  afterRun: null,
  beforeRemove: null,
  timeoutMs: 5000,
};

function manager(root: string, hooks: Partial<HooksConfig> = {}) {
  const sink = new MemorySink();
  const wm = new WorkspaceManager({
    root,
    hooks: { ...noHooks, ...hooks },
    logger: new Logger([sink]),
  });
  return { wm, sink };
}

Deno.test("workspaceKey keeps clean identifiers and hashes changed ones distinctly", async () => {
  assertEquals(await workspaceKey("ABC-123"), "ABC-123");
  const a = await workspaceKey("ABC/123");
  const b = await workspaceKey("ABC:123");
  assertMatch(a, /^ABC_123-[0-9a-f]{16}$/);
  assertNotEquals(a, b);
  assertEquals(a, await workspaceKey("ABC/123"));
});

Deno.test("isInsideRoot rejects escapes", () => {
  assert(isInsideRoot("/ws", "/ws/a"));
  assert(!isInsideRoot("/ws", "/ws"));
  assert(!isInsideRoot("/ws", "/ws/../etc"));
  assert(!isInsideRoot("/ws", "/wsx/a"));
});

Deno.test("createForIssue creates then reuses; after_create runs only once", async () => {
  const root = await Deno.makeTempDir();
  const { wm } = manager(root, { afterCreate: "echo created > marker" });
  const first = await wm.createForIssue("X-1");
  assertEquals(first.createdNow, true);
  assertEquals(first.path, join(root, "X-1"));
  assertEquals((await Deno.readTextFile(join(first.path, "marker"))).trim(), "created");
  await Deno.remove(join(first.path, "marker"));
  const second = await wm.createForIssue("X-1");
  assertEquals(second.createdNow, false);
  await assertRejects(() => Deno.stat(join(first.path, "marker")), Deno.errors.NotFound);
});

Deno.test("after_create failure aborts creation and removes the directory", async () => {
  const root = await Deno.makeTempDir();
  const { wm } = manager(root, { afterCreate: "exit 3" });
  await assertRejects(() => wm.createForIssue("X-2"), WorkspaceError, "code 3");
  await assertRejects(() => Deno.stat(join(root, "X-2")), Deno.errors.NotFound);
});

Deno.test("hook timeout is reported", async () => {
  const root = await Deno.makeTempDir();
  const { wm, sink } = manager(root, { beforeRun: "sleep 5", timeoutMs: 200 });
  const ws = await wm.createForIssue("X-3");
  const result = await wm.runHook("before_run", ws.path);
  assertEquals(result.ok, false);
  assertEquals(result.timedOut, true);
  assert(sink.lines.some((l) => l.includes("hook timed out")));
});

Deno.test("non-directory at workspace path fails safely", async () => {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(join(root, "X-4"), "file");
  const { wm } = manager(root);
  await assertRejects(() => wm.createForIssue("X-4"), WorkspaceError, "not a directory");
});

Deno.test("remove runs before_remove and deletes; missing workspace is a no-op", async () => {
  const root = await Deno.makeTempDir();
  const { wm, sink } = manager(root, { beforeRemove: "exit 1" });
  await wm.createForIssue("X-5");
  assertEquals(await wm.remove("X-5"), true);
  await assertRejects(() => Deno.stat(join(root, "X-5")), Deno.errors.NotFound);
  assert(sink.lines.some((l) => l.includes("hook failed")));
  assertEquals(await wm.remove("X-5"), false);
});
