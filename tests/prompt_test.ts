import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  continuationPrompt,
  DEFAULT_PROMPT,
  PromptError,
  renderPrompt,
} from "../src/prompt/render.ts";
import type { Issue } from "../src/tracker/types.ts";

export const sampleIssue: Issue = {
  id: "1",
  native_ref: { number: 1 },
  identifier: "repo-1",
  title: "Fix it",
  description: "desc",
  priority: 2,
  state: "open",
  branch_name: null,
  url: "https://example/1",
  assignee_id: null,
  labels: ["bug", "symphony"],
  blocked_by: [{ id: "2", identifier: "repo-2", state: "open" }],
  dispatchable: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: null,
};

Deno.test("renderPrompt renders issue fields, nested lists and attempt", async () => {
  const out = await renderPrompt(
    "{{ issue.identifier }}: {{ issue.title }} [{% for l in issue.labels %}{{ l }} {% endfor %}] " +
      "blocked={{ issue.blocked_by[0].identifier }} attempt={{ attempt }}",
    sampleIssue,
    3,
  );
  assertEquals(out, "repo-1: Fix it [bug symphony ] blocked=repo-2 attempt=3");
});

Deno.test("renderPrompt fails on unknown variables and filters", async () => {
  const e1 = await assertRejects(() => renderPrompt("{{ nope }}", sampleIssue, null), PromptError);
  assertEquals(e1.code, "template_render_error");
  const e2 = await assertRejects(
    () => renderPrompt("{{ issue.title | nofilter }}", sampleIssue, null),
    PromptError,
  );
  assertEquals(e2.code, "template_render_error");
  const e3 = await assertRejects(() => renderPrompt("{% if %}", sampleIssue, null), PromptError);
  assertEquals(e3.code, "template_parse_error");
});

Deno.test("renderPrompt falls back to the default prompt for an empty body", async () => {
  assertEquals(await renderPrompt("   ", sampleIssue, null), DEFAULT_PROMPT);
});

Deno.test("continuationPrompt does not repeat the task and mentions turn budget", () => {
  const text = continuationPrompt(sampleIssue, 2, 20);
  assertStringIncludes(text, "repo-1");
  assertStringIncludes(text, "turn 2 of at most 20");
});
