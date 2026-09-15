import type {
  Issue,
  ToolContext,
  ToolResult,
  ToolSpec,
  TrackerAdapter,
  TrackerAdapterFactory,
  TrackerSettings,
} from "../src/tracker/types.ts";
import type {
  AgentEvent,
  AgentSession,
  AgentSessionFactory,
  AppServerSessionOptions,
} from "../src/agent/app_server.ts";
import { AgentError } from "../src/agent/app_server.ts";
import type { WorkflowDefinition } from "../src/workflow/loader.ts";
import { join } from "@std/path";

export function makeIssue(overrides: Partial<Issue> & { id: string }): Issue {
  return {
    native_ref: null,
    identifier: `T-${overrides.id}`,
    title: `Issue ${overrides.id}`,
    description: null,
    priority: null,
    state: "Todo",
    branch_name: null,
    url: null,
    assignee_id: null,
    labels: [],
    blocked_by: [],
    dispatchable: true,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

export class FakeTracker implements TrackerAdapter {
  readonly kind = "fake";
  issues = new Map<string, Issue>();
  calls: string[] = [];
  failStates: Error | null = null;
  failIds: Error | null = null;
  tools: ToolSpec[] = [];
  toolCalls: Array<{ name: string; args: unknown; issue: Issue }> = [];

  set(issue: Issue): void {
    this.issues.set(issue.id, issue);
  }

  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    this.calls.push(`states:${stateNames.join(",")}`);
    if (stateNames.length === 0) return Promise.resolve([]);
    if (this.failStates) return Promise.reject(this.failStates);
    const wanted = new Set(stateNames.map((s) => s.trim().toLowerCase()));
    return Promise.resolve(
      [...this.issues.values()].filter((i) => wanted.has(i.state.trim().toLowerCase())),
    );
  }

  fetchIssuesByIds(issueIds: string[]): Promise<Issue[]> {
    this.calls.push(`ids:${issueIds.join(",")}`);
    if (issueIds.length === 0) return Promise.resolve([]);
    if (this.failIds) return Promise.reject(this.failIds);
    return Promise.resolve(
      issueIds.map((id) => this.issues.get(id)).filter((i): i is Issue => i !== undefined),
    );
  }

  agentToolSpecs(): ToolSpec[] {
    return this.tools;
  }

  secretEnvironmentNames(): string[] {
    return ["FAKE_TOKEN"];
  }

  executeAgentTool(name: string, args: unknown, context: ToolContext): Promise<ToolResult> {
    this.toolCalls.push({ name, args, issue: context.issue });
    return Promise.resolve({ success: true, output: { name } });
  }
}

export function fakeRegistry(tracker: FakeTracker): Map<string, TrackerAdapterFactory> {
  const factory: TrackerAdapterFactory = {
    kind: "fake",
    defaultActiveStates: null,
    defaultTerminalStates: null,
    create(_settings: TrackerSettings) {
      return tracker;
    },
  };
  return new Map([["fake", factory]]);
}

export type TurnBehavior = "complete" | "fail" | "hang" | "input_required";

export interface FakeSessionRecord {
  options: AppServerSessionOptions;
  turns: string[];
  stopped: boolean;
}

/** In-process stand-in for the app-server client. */
export function fakeSessions(
  behavior: (options: AppServerSessionOptions, turnNumber: number) => TurnBehavior = () =>
    "complete",
  startupError: (options: AppServerSessionOptions) => Error | null = () => null,
) {
  const sessions: FakeSessionRecord[] = [];
  const factory: AgentSessionFactory = (options) => {
    const error = startupError(options);
    if (error) return Promise.reject(error);
    const record: FakeSessionRecord = { options, turns: [], stopped: false };
    sessions.push(record);
    let turnNumber = 0;
    let pendingReject: ((err: Error) => void) | null = null;
    const emit = (event: Omit<AgentEvent, "timestamp" | "codex_app_server_pid">) =>
      options.onEvent({
        ...event,
        timestamp: new Date().toISOString(),
        codex_app_server_pid: 4242,
      });
    const session: AgentSession = {
      threadId: "thread-x",
      pid: 4242,
      async runTurn(text: string) {
        turnNumber += 1;
        record.turns.push(text);
        const turnId = `turn-${turnNumber}`;
        emit({
          event: turnNumber === 1 ? "session_started" : "turn_started",
          session_id: `thread-x-${turnId}`,
          thread_id: "thread-x",
          turn_id: turnId,
        });
        emit({
          event: "token_usage",
          usage: {
            input_tokens: 100 * turnNumber,
            output_tokens: 10 * turnNumber,
            total_tokens: 110 * turnNumber,
          },
        });
        const mode = behavior(options, turnNumber);
        await new Promise((r) => setTimeout(r, 10));
        switch (mode) {
          case "complete":
            emit({ event: "turn_completed", turn_id: turnId });
            return { turnId };
          case "fail":
            emit({ event: "turn_failed", turn_id: turnId, message: "boom" });
            throw new AgentError("turn_failed", "boom");
          case "input_required":
            emit({ event: "turn_input_required", turn_id: turnId });
            throw new AgentError("turn_input_required", "agent requested user input");
          case "hang":
            return new Promise<{ turnId: string }>((_, reject) => {
              pendingReject = reject;
            });
        }
      },
      stop() {
        record.stopped = true;
        if (pendingReject) {
          pendingReject(new AgentError("port_exit", "stopped"));
          pendingReject = null;
        }
        return Promise.resolve();
      },
    };
    return Promise.resolve(session);
  };
  return { factory, sessions };
}

export function definition(
  config: Record<string, unknown>,
  dir: string,
  promptTemplate = "Work on {{ issue.identifier }}",
): WorkflowDefinition {
  return {
    path: join(dir, "WORKFLOW.md"),
    dir,
    source: JSON.stringify(config),
    config,
    promptTemplate,
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `predicate` holds or the timeout elapses. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}
