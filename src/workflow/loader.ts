import { parse as parseYaml } from "@std/yaml";
import { dirname, resolve } from "@std/path";

export type WorkflowErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map";

export class WorkflowError extends Error {
  constructor(readonly code: WorkflowErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowError";
  }
}

export interface WorkflowDefinition {
  path: string;
  dir: string;
  source: string;
  config: Record<string, unknown>;
  promptTemplate: string;
}

const FENCE = /^---\s*$/;

export function parseWorkflow(
  source: string,
): Pick<WorkflowDefinition, "config" | "promptTemplate"> {
  const lines = source.split(/\r?\n/);
  if (lines.length === 0 || !FENCE.test(lines[0])) {
    return { config: {}, promptTemplate: source.trim() };
  }
  const end = lines.findIndex((line, index) => index > 0 && FENCE.test(line));
  if (end === -1) {
    throw new WorkflowError("workflow_parse_error", "front matter is not terminated by `---`");
  }
  const yamlText = lines.slice(1, end).join("\n");
  const promptTemplate = lines.slice(end + 1).join("\n").trim();

  let parsed: unknown;
  try {
    parsed = yamlText.trim() === "" ? {} : parseYaml(yamlText);
  } catch (err) {
    throw new WorkflowError(
      "workflow_parse_error",
      `invalid YAML front matter: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowError(
      "workflow_front_matter_not_a_map",
      "front matter must decode to a map/object",
    );
  }
  return { config: parsed as Record<string, unknown>, promptTemplate };
}

export async function loadWorkflow(path: string): Promise<WorkflowDefinition> {
  const absolute = resolve(path);
  let source: string;
  try {
    source = await Deno.readTextFile(absolute);
  } catch (err) {
    throw new WorkflowError(
      "missing_workflow_file",
      `cannot read workflow file ${absolute}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const { config, promptTemplate } = parseWorkflow(source);
  return { path: absolute, dir: dirname(absolute), source, config, promptTemplate };
}
