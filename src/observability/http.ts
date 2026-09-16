import { extname, fromFileUrl, join } from "@std/path";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import type { Logger } from "./logger.ts";
import { nowIso } from "../util/time.ts";

export const DASHBOARD_DIST = fromFileUrl(new URL("../../dashboard/dist/", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

export interface HttpServerOptions {
  port: number;
  hostname?: string;
  orchestrator: Orchestrator;
  logger: Logger;
  /** Directory holding the built dashboard (index.html + assets/). */
  dashboardDir?: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function methodNotAllowed(allowed: string[]): Response {
  const response = error(405, "method_not_allowed", `allowed: ${allowed.join(", ")}`);
  response.headers.set("allow", allowed.join(", "));
  return response;
}

export class HttpServer {
  readonly #server: Deno.HttpServer<Deno.NetAddr>;
  readonly #orchestrator: Orchestrator;
  readonly #logger: Logger;
  readonly #dashboardDir: string;

  private constructor(options: HttpServerOptions) {
    this.#orchestrator = options.orchestrator;
    this.#logger = options.logger;
    this.#dashboardDir = options.dashboardDir ?? DASHBOARD_DIST;
    this.#server = Deno.serve(
      { port: options.port, hostname: options.hostname ?? "127.0.0.1", onListen: () => {} },
      (request) => this.#handle(request),
    );
  }

  static start(options: HttpServerOptions): HttpServer {
    const server = new HttpServer(options);
    options.logger.info("http server listening", { url: server.url });
    return server;
  }

  get port(): number {
    return this.#server.addr.port;
  }

  get url(): string {
    return `http://${this.#server.addr.hostname}:${this.#server.addr.port}`;
  }

  async stop(): Promise<void> {
    await this.#server.shutdown();
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/") {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        return await this.#staticFile("index.html", "no-store");
      }
      const assetMatch = /^\/assets\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
      if (assetMatch) {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        return await this.#staticFile(
          join("assets", assetMatch[1]),
          "public, max-age=31536000, immutable",
        );
      }
      if (url.pathname === "/api/v1/state") {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        return json(this.#orchestrator.snapshot());
      }
      if (url.pathname === "/api/v1/refresh") {
        if (request.method !== "POST") return methodNotAllowed(["POST"]);
        const result = this.#orchestrator.requestRefresh();
        return json({ ...result, requested_at: nowIso(), operations: ["poll", "reconcile"] }, 202);
      }
      const issueMatch = /^\/api\/v1\/([^/]+)$/.exec(url.pathname);
      if (issueMatch) {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        const identifier = decodeURIComponent(issueMatch[1]);
        const details = await this.#orchestrator.issueDetails(identifier);
        if (details === null) {
          return error(404, "issue_not_found", `issue ${identifier} is not tracked in memory`);
        }
        return json(details);
      }
      return error(404, "not_found", `no route for ${url.pathname}`);
    } catch (err) {
      this.#logger.error("http request failed", {
        path: url.pathname,
        error: (err as Error).message,
      });
      return error(500, "internal_error", (err as Error).message);
    }
  }

  async #staticFile(relative: string, cacheControl: string): Promise<Response> {
    let body: Uint8Array<ArrayBuffer>;
    try {
      body = await Deno.readFile(join(this.#dashboardDir, relative));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        if (relative === "index.html") {
          return error(
            503,
            "dashboard_not_built",
            `dashboard assets are missing from ${this.#dashboardDir}; run \`npm run build\` in dashboard/`,
          );
        }
        return error(404, "not_found", `no asset ${relative}`);
      }
      throw err;
    }
    return new Response(body, {
      headers: {
        "content-type": CONTENT_TYPES[extname(relative)] ?? "application/octet-stream",
        "cache-control": cacheControl,
      },
    });
  }
}
