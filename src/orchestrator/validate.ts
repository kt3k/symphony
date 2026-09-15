/**
 * Dispatch preflight validation (SPEC §6.3).
 */
import type { ServiceConfig } from "../config/config.ts";
import type { TrackerAdapter, TrackerAdapterFactory } from "../tracker/types.ts";
import { findTrackerFactory } from "../tracker/registry.ts";
import type { EnvLookup } from "../util/env.ts";

export interface EffectiveTracker {
  adapter: TrackerAdapter;
  activeStates: string[];
  terminalStates: string[];
}

export type ValidationResult =
  | { ok: true; tracker: EffectiveTracker }
  | { ok: false; error: string };

export function validateDispatchConfig(
  config: ServiceConfig,
  env: EnvLookup,
  registry?: ReadonlyMap<string, TrackerAdapterFactory>,
): ValidationResult {
  if (config.codex.command.trim() === "") {
    return { ok: false, error: "codex.command must be a non-empty shell command" };
  }
  if (config.tracker.kind === null) {
    return { ok: false, error: "tracker.kind is required" };
  }
  const factory = findTrackerFactory(config.tracker.kind, registry);
  if (!factory) {
    return { ok: false, error: `unsupported tracker.kind ${JSON.stringify(config.tracker.kind)}` };
  }
  const activeStates = config.tracker.activeStates ?? factory.defaultActiveStates;
  const terminalStates = config.tracker.terminalStates ?? factory.defaultTerminalStates;
  if (activeStates === null || activeStates.length === 0) {
    return { ok: false, error: "tracker.active_states is required for this tracker" };
  }
  if (terminalStates === null) {
    return { ok: false, error: "tracker.terminal_states is required for this tracker" };
  }
  try {
    const adapter = factory.create(
      {
        provider: config.tracker.provider,
        activeStates,
        terminalStates,
        requiredLabels: config.tracker.requiredLabels,
      },
      env,
    );
    return { ok: true, tracker: { adapter, activeStates, terminalStates } };
  } catch (err) {
    return { ok: false, error: `tracker.provider rejected: ${(err as Error).message}` };
  }
}
