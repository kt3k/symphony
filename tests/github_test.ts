import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { GitHubAdapter, normalizeGitHubIssue, parseGitHubProvider } from "../src/tracker/github.ts";
import { TrackerError } from "../src/tracker/types.ts";

const env = (vars: Record<string, string>) => (name: string) => vars[name];

function cfg(overrides: Record<string, unknown> = {}) {
  return parseGitHubProvider(
    { owner: "acme", repo: "widgets", token: "tok", ...overrides },
    env({}),
  );
}

function payload(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    node_id: `N${number}`,
    title: `Issue ${number}`,
    body: "body",
    state: "open",
    html_url: `https://github.com/acme/widgets/issues/${number}`,
    labels: [{ name: "Bug" }, { name: "status: Ready" }, { name: "priority:2" }],
    assignees: [{ login: "Bot" }],
    assignee: { login: "Bot" },
    locked: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function fakeFetch(routes: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (input: string, init: RequestInit) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: input,
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      headers: init.headers as Record<string, string>,
    };
    calls.push(call);
    return Promise.resolve(routes(call));
  };
  return { fetch, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

Deno.test("provider config: repository shorthand, token fallbacks, validation", () => {
  const a = parseGitHubProvider({ repository: "acme/widgets" }, env({ GITHUB_TOKEN: "t1" }));
  assertEquals([a.owner, a.repo, a.token], ["acme", "widgets", "t1"]);
  const b = parseGitHubProvider(
    { owner: "a", repo: "b", token: "$MY_TOKEN" },
    env({ MY_TOKEN: "t2" }),
  );
  assertEquals(b.token, "t2");
  const missing = assertThrows(
    () => parseGitHubProvider({ owner: "a", repo: "b", token: "$MY_TOKEN" }, env({ MY_TOKEN: "" })),
    TrackerError,
  );
  assertEquals(missing.category, "missing_tracker_secret");
  const noRepo = assertThrows(() => parseGitHubProvider({ token: "t" }, env({})), TrackerError);
  assertEquals(noRepo.category, "invalid_tracker_config");
  assertThrows(
    () => parseGitHubProvider({ owner: "a", repo: "b", token: "t", per_page: 500 }, env({})),
    TrackerError,
  );
  assertEquals(
    cfg({ api_url: "https://ghe.example/api/v3/" }).apiUrl,
    "https://ghe.example/api/v3",
  );
});

Deno.test("normalizeGitHubIssue maps fields, state labels, priority and dispatchable", () => {
  const issue = normalizeGitHubIssue(payload(7), cfg());
  assertEquals(issue.id, "7");
  assertEquals(issue.identifier, "widgets-7");
  assertEquals(issue.state, "Ready");
  assertEquals(issue.priority, 2);
  assertEquals(issue.labels, ["bug", "status: ready", "priority:2"]);
  assertEquals(issue.assignee_id, "Bot");
  assertEquals(issue.dispatchable, true);
  assertEquals(issue.created_at, "2026-01-01T00:00:00.000Z");
  assertEquals(issue.native_ref?.number, 7);

  const closed = normalizeGitHubIssue(payload(8, { state: "closed" }), cfg());
  assertEquals(closed.state, "closed");
  const plain = normalizeGitHubIssue(
    payload(9, { labels: [{ name: "P1" }], created_at: "garbage" }),
    cfg(),
  );
  assertEquals(plain.state, "open");
  assertEquals(plain.priority, 1);
  assertEquals(plain.created_at, null);
  const pr = normalizeGitHubIssue(payload(10, { pull_request: { url: "x" } }), cfg());
  assertEquals(pr.dispatchable, false);
  const unassigned = normalizeGitHubIssue(
    payload(11, { assignees: [], assignee: null }),
    cfg({ assignee: "bot" }),
  );
  assertEquals(unassigned.dispatchable, false);
  const assigned = normalizeGitHubIssue(payload(12), cfg({ assignee: "bot" }));
  assertEquals(assigned.dispatchable, true);
  assertThrows(() => normalizeGitHubIssue(payload(13, { title: "" }), cfg()));
  assertThrows(() => normalizeGitHubIssue({ number: "x" }, cfg()));
});

Deno.test("fetchIssuesByStates paginates, filters PRs/states and picks the GitHub state param", async () => {
  const base = "https://api.github.com/repos/acme/widgets/issues";
  const { fetch, calls } = fakeFetch((call) => {
    if (call.url.includes("page=2")) {
      return json([payload(3, { labels: [] }), payload(4, { state: "closed" })]);
    }
    return json([payload(1), payload(2, { pull_request: {} }), {
      number: 99,
      title: "",
      state: "open",
    }], {
      headers: { link: `<${base}?state=all&per_page=100&page=2>; rel="next"` },
    });
  });
  const malformed: string[] = [];
  const adapter = new GitHubAdapter(cfg(), { fetch, onMalformed: (m) => malformed.push(m) });

  const ready = await adapter.fetchIssuesByStates(["ready", "closed"]);
  assertEquals(ready.map((i) => i.id), ["1", "4"]);
  assertEquals(calls.length, 2);
  assert(calls[0].url.startsWith(`${base}?state=all`));
  assertEquals(calls[0].headers["authorization"], "Bearer tok");
  assertEquals(malformed.length, 1);

  calls.length = 0;
  await adapter.fetchIssuesByStates(["Ready"]);
  assert(calls[0].url.includes("state=open"));
  calls.length = 0;
  await adapter.fetchIssuesByStates(["CLOSED"]);
  assert(calls[0].url.includes("state=closed"));
  calls.length = 0;
  assertEquals(await adapter.fetchIssuesByStates([]), []);
  assertEquals(calls.length, 0);
});

Deno.test("fetchIssuesByIds omits missing issues, fails on malformed, skips provider calls for empty input", async () => {
  const { fetch, calls } = fakeFetch((call) => {
    if (call.url.endsWith("/issues/1")) return json(payload(1));
    if (call.url.endsWith("/issues/2")) return new Response("nope", { status: 404 });
    if (call.url.endsWith("/issues/3")) return json({ number: 3, state: "open" });
    return new Response("?", { status: 500 });
  });
  const adapter = new GitHubAdapter(cfg(), { fetch });
  assertEquals(await adapter.fetchIssuesByIds([]), []);
  assertEquals(calls.length, 0);
  const found = await adapter.fetchIssuesByIds(["1", "2", "abc", "1"]);
  assertEquals(found.map((i) => i.id), ["1"]);
  assertEquals(calls.length, 2);
  const err = await assertRejects(() => adapter.fetchIssuesByIds(["3"]), TrackerError);
  assertEquals(err.category, "tracker_response");
});

Deno.test("transport errors map to portable categories", async () => {
  const rateLimited = new GitHubAdapter(cfg(), {
    fetch: () =>
      Promise.resolve(
        new Response("slow down", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "retry-after": "7" },
        }),
      ),
  });
  const rl = await assertRejects(() => rateLimited.fetchIssuesByStates(["open"]), TrackerError);
  assertEquals(rl.category, "tracker_rate_limited");
  assertEquals(rl.retryAfterMs, 7000);

  const unauthorized = new GitHubAdapter(cfg(), {
    fetch: () => Promise.resolve(new Response("bad", { status: 401 })),
  });
  const st = await assertRejects(() => unauthorized.fetchIssuesByStates(["open"]), TrackerError);
  assertEquals(st.category, "tracker_status");

  const network = new GitHubAdapter(cfg(), {
    fetch: () => Promise.reject(new Error("ECONNRESET")),
  });
  const rq = await assertRejects(() => network.fetchIssuesByStates(["open"]), TrackerError);
  assertEquals(rq.category, "tracker_request");

  const garbage = new GitHubAdapter(cfg(), {
    fetch: () => Promise.resolve(new Response("<html>", { status: 200 })),
  });
  const rs = await assertRejects(() => garbage.fetchIssuesByStates(["open"]), TrackerError);
  assertEquals(rs.category, "tracker_response");
});

Deno.test("agent tools execute against the context issue and report failures structurally", async () => {
  const { fetch, calls } = fakeFetch((call) => {
    if (call.method === "POST" && call.url.endsWith("/issues/5/comments")) {
      return json({ id: 77, html_url: "https://github.com/c/77" });
    }
    if (call.method === "POST" && call.url.endsWith("/issues/5/labels")) {
      return json([{ name: "status: review" }]);
    }
    if (call.method === "PATCH" && call.url.endsWith("/issues/5")) {
      return json(payload(5, { state: "closed" }));
    }
    if (call.method === "DELETE") return new Response(null, { status: 404 });
    if (call.method === "GET" && call.url.endsWith("/issues/5")) return json(payload(5));
    return new Response("bad", { status: 500 });
  });
  const adapter = new GitHubAdapter(cfg(), { fetch });
  const issue = normalizeGitHubIssue(payload(5), cfg());
  const specs = adapter.agentToolSpecs();
  assert(specs.some((s) => s.name === "github_issue_comment" && s.mutates));

  const comment = await adapter.executeAgentTool("github_issue_comment", { body: "hi" }, { issue });
  assertEquals(comment, { success: true, output: { id: 77, url: "https://github.com/c/77" } });
  assertEquals(calls[0].body, { body: "hi" });

  const labels = await adapter.executeAgentTool("github_issue_add_labels", {
    labels: ["status: review"],
  }, { issue });
  assertEquals(labels, { success: true, output: { labels: ["status: review"] } });

  const removed = await adapter.executeAgentTool("github_issue_remove_label", { label: "x" }, {
    issue,
  });
  assertEquals(removed, { success: true, output: { removed: false } });

  const closed = await adapter.executeAgentTool("github_issue_set_state", { state: "closed" }, {
    issue,
  });
  assertEquals(closed.success, true);

  const got = await adapter.executeAgentTool("github_issue_get", {}, { issue });
  assertEquals((got.output as { number: number }).number, 5);

  const bad = await adapter.executeAgentTool("github_issue_comment", { body: "" }, { issue });
  assertEquals(bad.success, false);
  const unknown = await adapter.executeAgentTool("nope", {}, { issue });
  assertEquals(unknown.success, false);
  const failing = await adapter.executeAgentTool("github_issue_list_comments", {}, { issue });
  assertEquals(failing.success, false);
  assertEquals(
    (failing.output as { error: { category: string } }).error.category,
    "tracker_status",
  );
});
