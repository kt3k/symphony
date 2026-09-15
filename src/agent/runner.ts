/**
 * Worker attempt: workspace + prompt + app-server session with the in-process turn loop
 * (SPEC §10.7, §16.5).
 */
import type { ServiceConfig } from "../config/config.ts";
import type { Issue, TrackerAdapter } from "../tracker/types.ts";
import { issueRoutable, normalizeState } from "../tracker/types.ts";
import type { WorkspaceManager } from "../workspace/manager.ts";
import { continuationPrompt, renderPrompt } from "../prompt/render.ts";
import type { AgentEvent, AgentSession, AgentSessionFactory } from "./app_server.ts";
import { AgentError } from "./app_server.ts";
import type { Logger } from "../observability/logger.ts";
import { nowIso } from "../util/time.ts";

export type WorkerFailure =
  | "workspace"
  | "before_run_hook"
  | "agent_startup"
  | "prompt"
  | "agent_turn"
  | "issue_refresh"
  | "cancelled";

export class WorkerError extends Error {
  constructor(readonly reason: WorkerFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerError";
  }
}

export interface WorkerContext {
  /** Config snapshot bound to this attempt (§10.5: one session, one snapshot). */
  config: ServiceConfig;
  promptTemplate: string;
  tracker: TrackerAdapter;
  activeStates: string[];
  workspaces: WorkspaceManager;
  startSession: AgentSessionFactory;
  /** Parent environment; tracker secrets are stripped before launch. */
  parentEnv: Record<string, string>;
  logger: Logger;
  onEvent: (event: AgentEvent) => void;
  signal: AbortSignal;
}

function childEnvironment(
  parent: Record<string, string>,
  secretNames: string[],
): Record<string, string> {
  const env = { ...parent };
  for (const name of secretNames) delete env[name];
  return env;
}

export async function runAgentAttempt(
  issue: Issue,
  attempt: number | null,
  ctx: WorkerContext,
): Promise<void> {
  const log = ctx.logger.child({ issue_id: issue.id, issue_identifier: issue.identifier });
  const throwIfCancelled = () => {
    if (ctx.signal.aborted) throw new WorkerError("cancelled", "attempt cancelled by orchestrator");
  };

  throwIfCancelled();
  let workspace;
  try {
    workspace = await ctx.workspaces.createForIssue(issue.identifier);
  } catch (err) {
    throw new WorkerError("workspace", `workspace error: ${(err as Error).message}`, {
      cause: err,
    });
  }
  log.info("workspace ready", { path: workspace.path, created: workspace.createdNow });
  throwIfCancelled();

  const beforeRun = await ctx.workspaces.runHook("before_run", workspace.path);
  if (!beforeRun.ok) {
    throw new WorkerError(
      "before_run_hook",
      beforeRun.timedOut ? "before_run hook timed out" : "before_run hook failed",
    );
  }
  throwIfCancelled();

  const activeStates = new Set(ctx.activeStates.map(normalizeState));
  let currentIssue = issue;
  let session: AgentSession;
  try {
    session = await ctx.startSession({
      command: ctx.config.codex.command,
      cwd: workspace.path,
      env: childEnvironment(ctx.parentEnv, ctx.tracker.secretEnvironmentNames()),
      approvalPolicy: ctx.config.codex.approvalPolicy,
      threadSandbox: ctx.config.codex.threadSandbox,
      turnSandboxPolicy: ctx.config.codex.turnSandboxPolicy,
      readTimeoutMs: ctx.config.codex.readTimeoutMs,
      turnTimeoutMs: ctx.config.codex.turnTimeoutMs,
      title: `${issue.identifier}: ${issue.title}`,
      tools: ctx.tracker.agentToolSpecs(),
      executeTool: (name, args) =>
        ctx.tracker.executeAgentTool(name, args, { issue: currentIssue }),
      onEvent: ctx.onEvent,
      logger: log,
    });
  } catch (err) {
    await ctx.workspaces.runHook("after_run", workspace.path);
    throw new WorkerError(
      "agent_startup",
      `agent session startup error: ${(err as Error).message}`,
      {
        cause: err,
      },
    );
  }

  const finish = async () => {
    await session.stop();
    await ctx.workspaces.runHook("after_run", workspace.path);
  };
  const onAbort = () => {
    session.stop().catch(() => {});
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const maxTurns = ctx.config.agent.maxTurns;
    let turnNumber = 1;
    while (true) {
      throwIfCancelled();
      let prompt: string;
      try {
        prompt = turnNumber === 1
          ? await renderPrompt(ctx.promptTemplate, currentIssue, attempt)
          : continuationPrompt(currentIssue, turnNumber, maxTurns);
      } catch (err) {
        throw new WorkerError("prompt", `prompt error: ${(err as Error).message}`, { cause: err });
      }

      ctx.onEvent({
        event: "turn_loop",
        timestamp: nowIso(),
        codex_app_server_pid: session.pid,
        message: `turn ${turnNumber}/${maxTurns}`,
      });
      try {
        await session.runTurn(prompt);
      } catch (err) {
        if (ctx.signal.aborted) {
          throw new WorkerError("cancelled", "attempt cancelled by orchestrator");
        }
        const code = err instanceof AgentError ? err.code : "unknown";
        throw new WorkerError(
          "agent_turn",
          `agent turn error (${code}): ${(err as Error).message}`,
          {
            cause: err,
          },
        );
      }
      throwIfCancelled();

      let refreshed: Issue[];
      try {
        refreshed = await ctx.tracker.fetchIssuesByIds([issue.id]);
      } catch (err) {
        throw new WorkerError(
          "issue_refresh",
          `issue state refresh error: ${(err as Error).message}`,
          {
            cause: err,
          },
        );
      }
      const next = refreshed.find((candidate) => candidate.id === issue.id);
      if (!next) {
        log.info("issue no longer visible; ending worker");
        break;
      }
      currentIssue = next;
      if (
        !activeStates.has(normalizeState(next.state)) ||
        !issueRoutable(next, ctx.config.tracker.requiredLabels)
      ) {
        log.info("issue left active/routable set; ending worker", { state: next.state });
        break;
      }
      if (turnNumber >= maxTurns) {
        log.info("max turns reached; ending worker", { max_turns: maxTurns });
        break;
      }
      turnNumber += 1;
    }
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    await finish();
  }
}
