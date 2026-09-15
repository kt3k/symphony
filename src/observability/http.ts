import type { Orchestrator } from "../orchestrator/orchestrator.ts";
import type { Logger } from "./logger.ts";
import { nowIso } from "../util/time.ts";

export interface HttpServerOptions {
  port: number;
  hostname?: string;
  orchestrator: Orchestrator;
  logger: Logger;
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

  private constructor(options: HttpServerOptions) {
    this.#orchestrator = options.orchestrator;
    this.#logger = options.logger;
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
        return new Response(renderDashboard(), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
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
}

function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Symphony</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 1.5rem; max-width: 1200px; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; display: flex; align-items: baseline; gap: 1rem; }
  h1 small { font-weight: normal; opacity: .7; font-size: .8rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
  .tiles { display: flex; flex-wrap: wrap; gap: .75rem; }
  .tile { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 6px; padding: .6rem .9rem; min-width: 8rem; }
  .tile b { display: block; font-size: 1.3rem; }
  .tile span { font-size: .75rem; opacity: .7; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); vertical-align: top; }
  th { opacity: .7; font-weight: 600; }
  td.msg { max-width: 28rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .error { color: #c62828; }
  .empty { opacity: .6; font-style: italic; }
  button { font: inherit; padding: .3rem .7rem; }
  pre { font-size: .75rem; overflow: auto; }
  .muted { opacity: .6; }
</style>
</head>
<body>
<h1>Symphony <small id="generated"></small> <button id="refresh">Poll now</button></h1>
<div class="tiles" id="tiles"></div>
<div id="errors"></div>
<h2>Running</h2>
<div id="running"></div>
<h2>Retry queue</h2>
<div id="retrying"></div>
<h2>Rate limits</h2>
<pre id="rate"></pre>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ago = (iso) => { if (!iso) return "-"; const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? Math.round(s) + "s ago" : s < 3600 ? Math.round(s / 60) + "m ago" : (s / 3600).toFixed(1) + "h ago"; };
const until = (iso) => { const s = (Date.parse(iso) - Date.now()) / 1000; return s <= 0 ? "now" : s < 60 ? "in " + Math.round(s) + "s" : "in " + Math.round(s / 60) + "m"; };
const link = (r) => r.issue_url ? '<a href="' + esc(r.issue_url) + '">' + esc(r.issue_identifier) + '</a>' : esc(r.issue_identifier);
const table = (rows, cols) => rows.length === 0 ? '<p class="empty">none</p>' :
  '<table><thead><tr>' + cols.map((c) => '<th>' + c[0] + '</th>').join('') + '</tr></thead><tbody>' +
  rows.map((r) => '<tr>' + cols.map((c) => '<td class="' + (c[2] || '') + '">' + c[1](r) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
function render(s) {
  document.getElementById("generated").textContent = "snapshot " + ago(s.generated_at);
  const t = s.codex_totals;
  document.getElementById("tiles").innerHTML = [
    ["Running", s.counts.running], ["Retrying", s.counts.retrying],
    ["Input tokens", t.input_tokens.toLocaleString()], ["Output tokens", t.output_tokens.toLocaleString()],
    ["Total tokens", t.total_tokens.toLocaleString()], ["Agent hours", (t.seconds_running / 3600).toFixed(2)],
  ].map(([k, v]) => '<div class="tile"><b>' + esc(v) + '</b><span>' + k + '</span></div>').join('');
  const errs = [];
  if (s.last_validation_error) errs.push("validation: " + s.last_validation_error);
  if (s.last_reload_error) errs.push("reload: " + s.last_reload_error);
  document.getElementById("errors").innerHTML = errs.map((e) => '<p class="error">' + esc(e) + '</p>').join('');
  document.getElementById("running").innerHTML = table(s.running, [
    ["Issue", link], ["State", (r) => esc(r.state)], ["Session", (r) => '<span class="muted">' + esc(r.session_id) + '</span>'],
    ["Turns", (r) => r.turn_count], ["Started", (r) => ago(r.started_at)], ["Last event", (r) => esc(r.last_event) + ' <span class="muted">' + ago(r.last_event_at) + '</span>'],
    ["Message", (r) => esc(r.last_message), "msg"], ["Tokens", (r) => r.tokens.total_tokens.toLocaleString()],
  ]);
  document.getElementById("retrying").innerHTML = table(s.retrying, [
    ["Issue", link], ["Attempt", (r) => r.attempt], ["Due", (r) => until(r.due_at)], ["Reason", (r) => esc(r.error), "msg"],
  ]);
  document.getElementById("rate").textContent = s.rate_limits ? JSON.stringify(s.rate_limits, null, 2) : "no rate-limit data yet";
}
async function load() {
  try { render(await (await fetch("/api/v1/state")).json()); }
  catch (e) { document.getElementById("errors").innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
}
document.getElementById("refresh").onclick = async () => { await fetch("/api/v1/refresh", { method: "POST" }); setTimeout(load, 500); };
load();
setInterval(load, 5000);
</script>
</body>
</html>
`;
}
