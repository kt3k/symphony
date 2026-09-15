import { App } from "./src/app.ts";
import { Logger, type LogLevel, StderrSink } from "./src/observability/logger.ts";
import { SYMPHONY_VERSION } from "./src/agent/app_server.ts";

const USAGE = `symphony ${SYMPHONY_VERSION}

Usage: symphony [path-to-WORKFLOW.md] [options]

Options:
  --port <n>                           Serve the dashboard and JSON API on 127.0.0.1:<n>
                                       (overrides server.port in WORKFLOW.md; 0 = ephemeral)
  --log-level <debug|info|warn|error>  Minimum log level (default: info)
  -h, --help                           Show this help
  -V, --version                        Print the version
`;

export interface CliArgs {
  workflowPath: string;
  logLevel: LogLevel;
  port: number | undefined;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    workflowPath: "WORKFLOW.md",
    logLevel: "info",
    port: undefined,
    help: false,
    version: false,
  };
  const parsePort = (value: string | undefined) => {
    if (value === undefined || !/^\d+$/.test(value) || Number(value) > 65535) {
      throw new Error(`invalid --port ${JSON.stringify(value)}`);
    }
    return Number(value);
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "-V" || arg === "--version") out.version = true;
    else if (arg === "--port") out.port = parsePort(argv[++i]);
    else if (arg.startsWith("--port=")) out.port = parsePort(arg.slice("--port=".length));
    else if (arg === "--log-level") {
      const level = argv[++i];
      if (!["debug", "info", "warn", "error"].includes(level ?? "")) {
        throw new Error(`invalid --log-level ${JSON.stringify(level)}`);
      }
      out.logLevel = level as LogLevel;
    } else if (arg.startsWith("--log-level=")) {
      const level = arg.slice("--log-level=".length);
      if (!["debug", "info", "warn", "error"].includes(level)) {
        throw new Error(`invalid --log-level ${JSON.stringify(level)}`);
      }
      out.logLevel = level as LogLevel;
    } else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error("expected at most one workflow path");
  if (positional.length === 1) out.workflowPath = positional[0];
  return out;
}

export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`error: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.version) {
    console.log(SYMPHONY_VERSION);
    return 0;
  }

  const logger = new Logger([new StderrSink()], {}, args.logLevel);
  let app: App;
  try {
    app = await App.start({ workflowPath: args.workflowPath, logger, port: args.port });
  } catch (err) {
    logger.error("startup failed", { error: (err as Error).message });
    return 1;
  }

  return await new Promise<number>((resolve) => {
    let stopping = false;
    const shutdown = (signal: string) => {
      if (stopping) return;
      stopping = true;
      logger.info("shutdown requested", { signal });
      app.stop().then(() => resolve(0), (err) => {
        logger.error("shutdown failed", { error: (err as Error).message });
        resolve(1);
      });
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      try {
        Deno.addSignalListener(signal, () => shutdown(signal));
      } catch {
        // unsupported on this platform
      }
    }
  });
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
