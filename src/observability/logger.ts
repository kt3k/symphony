export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface LogSink {
  write(line: string): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class StderrSink implements LogSink {
  #encoder = new TextEncoder();
  write(line: string): void {
    Deno.stderr.writeSync(this.#encoder.encode(line + "\n"));
  }
}

export class MemorySink implements LogSink {
  lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Error) return formatValue(value.message);
  if (typeof value === "string") {
    const needsQuote = value === "" || /[\s"=]/.test(value);
    return needsQuote ? JSON.stringify(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

export class Logger {
  #sinks: LogSink[];
  #bound: LogFields;
  #minLevel: number;

  constructor(
    sinks: LogSink[] = [new StderrSink()],
    bound: LogFields = {},
    level: LogLevel = "info",
  ) {
    this.#sinks = sinks;
    this.#bound = bound;
    this.#minLevel = LEVEL_ORDER[level];
  }

  child(fields: LogFields): Logger {
    const child = new Logger(this.#sinks, { ...this.#bound, ...fields });
    child.#minLevel = this.#minLevel;
    return child;
  }

  debug(message: string, fields?: LogFields): void {
    this.#log("debug", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.#log("info", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.#log("warn", message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.#log("error", message, fields);
  }

  #log(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.#minLevel) return;
    const all = { ...this.#bound, ...(fields ?? {}) };
    const parts = [new Date().toISOString(), level.toUpperCase(), message];
    for (const [key, value] of Object.entries(all)) {
      if (value === undefined) continue;
      parts.push(`${key}=${formatValue(value)}`);
    }
    const line = parts.join(" ");
    let delivered = false;
    for (const sink of this.#sinks) {
      try {
        sink.write(line);
        delivered = true;
      } catch {
        // A failing sink must not take the orchestrator down (§13.2).
      }
    }
    if (!delivered && this.#sinks.length > 0) {
      try {
        console.error(line);
      } catch {
        // nothing left to do
      }
    }
  }
}

export function truncate(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `...(${text.length - max} more chars)`;
}
