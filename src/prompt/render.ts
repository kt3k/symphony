import { Liquid } from "liquidjs";
import type { Issue } from "../tracker/types.ts";

export type PromptErrorCode = "template_parse_error" | "template_render_error";

export class PromptError extends Error {
  constructor(readonly code: PromptErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PromptError";
  }
}

export const DEFAULT_PROMPT = "You are working on an issue from the configured tracker.";

const engine = new Liquid({ strictVariables: true, strictFilters: true });

export async function renderPrompt(
  template: string,
  issue: Issue,
  attempt: number | null,
): Promise<string> {
  const body = template.trim() === "" ? DEFAULT_PROMPT : template;
  let parsed;
  try {
    parsed = engine.parse(body);
  } catch (err) {
    // liquidjs reports unknown filters while parsing; the spec files those under render errors.
    const message = (err as Error).message;
    const code = /undefined filter/i.test(message)
      ? "template_render_error"
      : "template_parse_error";
    throw new PromptError(code, message, { cause: err });
  }
  try {
    // Strip the prototype so liquidjs sees a plain object with the spec's snake_case keys.
    const scope = { issue: structuredClone(issue), attempt };
    return await engine.render(parsed, scope);
  } catch (err) {
    throw new PromptError("template_render_error", (err as Error).message, { cause: err });
  }
}

// Deliberately does not repeat the task prompt already present in the thread history.
export function continuationPrompt(issue: Issue, turnNumber: number, maxTurns: number): string {
  return [
    `Continue working on ${issue.identifier} (${issue.title}).`,
    `The issue is still in state "${issue.state}" after your previous turn.`,
    `This is turn ${turnNumber} of at most ${maxTurns} in this session.`,
    "Review what you already did in this workspace, finish any remaining work, and move the",
    "issue to its handoff state with the available tools when it is complete. If nothing is left to",
    "do, say so briefly and stop.",
  ].join("\n");
}
