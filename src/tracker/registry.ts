import type { TrackerAdapterFactory } from "./types.ts";
import { githubFactory } from "./github.ts";

export const trackerFactories: ReadonlyMap<string, TrackerAdapterFactory> = new Map(
  [githubFactory].map((factory) => [factory.kind, factory]),
);

export function findTrackerFactory(
  kind: string,
  registry: ReadonlyMap<string, TrackerAdapterFactory> = trackerFactories,
): TrackerAdapterFactory | undefined {
  return registry.get(kind.trim().toLowerCase());
}
