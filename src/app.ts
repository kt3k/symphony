import { loadWorkflow, type WorkflowDefinition } from "./workflow/loader.ts";
import { WorkflowWatcher } from "./workflow/watcher.ts";
import { buildConfig, type ServiceConfig } from "./config/config.ts";
import { Orchestrator, type OrchestratorDeps } from "./orchestrator/orchestrator.ts";
import type { Logger } from "./observability/logger.ts";
import { denoEnv, type EnvLookup } from "./util/env.ts";
import { startAppServerSession } from "./agent/app_server.ts";
import type { AgentSessionFactory } from "./agent/app_server.ts";
import type { TrackerAdapterFactory } from "./tracker/types.ts";

export interface AppOptions {
  workflowPath: string;
  logger: Logger;
  env?: EnvLookup;
  parentEnv?: Record<string, string>;
  startSession?: AgentSessionFactory;
  trackerRegistry?: ReadonlyMap<string, TrackerAdapterFactory>;
  watchDebounceMs?: number;
}

export class App {
  readonly orchestrator: Orchestrator;
  readonly watcher: WorkflowWatcher;
  #logger: Logger;

  private constructor(orchestrator: Orchestrator, watcher: WorkflowWatcher, logger: Logger) {
    this.orchestrator = orchestrator;
    this.watcher = watcher;
    this.#logger = logger;
  }

  static async start(options: AppOptions): Promise<App> {
    const env = options.env ?? denoEnv;
    const definition = await loadWorkflow(options.workflowPath);
    const config = buildConfig(definition, env);

    const holder: { watcher: WorkflowWatcher | null } = { watcher: null };
    const deps: OrchestratorDeps = {
      logger: options.logger,
      env,
      parentEnv: options.parentEnv ?? Deno.env.toObject(),
      startSession: options.startSession ?? startAppServerSession,
      trackerRegistry: options.trackerRegistry,
      refreshWorkflow: () => holder.watcher?.reloadIfChanged() ?? Promise.resolve(),
    };
    const orchestrator = new Orchestrator(definition, config, deps);

    const watcher = new WorkflowWatcher({
      path: definition.path,
      currentSource: definition.source,
      logger: options.logger,
      debounceMs: options.watchDebounceMs,
      onReload: (next: WorkflowDefinition) => {
        const nextConfig: ServiceConfig = buildConfig(next, env);
        orchestrator.applyWorkflow(next, nextConfig);
      },
      onError: (error) => orchestrator.noteReloadError(error.message),
    });
    holder.watcher = watcher;

    await orchestrator.start();
    watcher.start();
    options.logger.info("symphony started", {
      workflow: definition.path,
      workspace_root: config.workspace.root,
      poll_interval_ms: config.polling.intervalMs,
    });
    return new App(orchestrator, watcher, options.logger);
  }

  async stop(): Promise<void> {
    this.watcher.stop();
    await this.orchestrator.stop();
    this.#logger.info("symphony stopped");
  }
}
