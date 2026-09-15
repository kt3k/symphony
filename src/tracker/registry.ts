import type { TrackerAdapterFactory } from "./types.ts";
import { githubFactory } from "./github.ts";

/** Supported `tracker.kind` values (§6.3). */
export const trackerFactories: ReadonlyMap<string, TrackerAdapterFactory> = new Map(
  [githubFactory].map((factory) => [factory.kind, factory]),
);

export function findTrackerFactory(
  kind: string,
  registry: ReadonlyMap<string, TrackerAdapterFactory> = trackerFactories,
): TrackerAdapterFactory | undefined {
  return registry.get(kind.trim().toLowerCase());
}
