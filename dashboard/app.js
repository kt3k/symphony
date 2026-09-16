// Symphony dashboard: polls /api/v1/state and renders it with Basecoat (shadcn-style) markup.
const POLL_MS = 5000;

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n ?? 0).toLocaleString();

const svg = (paths, cls = "size-4") =>
  `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const icons = {
  activity: svg('<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>'),
  rotate: svg('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'),
  coins: svg('<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>'),
  clock: svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  check: svg('<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>', "size-3 text-status-good"),
  x: svg('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>', "size-3 text-status-critical"),
  alert: svg('<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>'),
  alertSm: svg('<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>', "size-3.5 shrink-0 text-status-critical"),
  external: svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>', "size-3 text-muted-foreground"),
  rotateSm: svg('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>', "size-3"),
};

function ago(iso, now) {
  if (!iso) return "–";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
}

function until(iso, now) {
  const s = (Date.parse(iso) - now) / 1000;
  if (s <= 0) return "now";
  if (s < 60) return `in ${Math.round(s)}s`;
  return `in ${Math.round(s / 60)}m`;
}

function duration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${Math.floor(seconds % 60)}s`;
}

const issueLink = (row) =>
  row.issue_url
    ? `<a class="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline" href="${esc(row.issue_url)}" target="_blank" rel="noreferrer">${esc(row.issue_identifier)}${icons.external}</a>`
    : `<span class="font-medium">${esc(row.issue_identifier)}</span>`;

const GOOD_EVENTS = new Set(["turn_completed", "session_started"]);
const BAD_EVENTS = new Set(["turn_failed", "turn_ended_with_error", "startup_failed", "turn_input_required"]);

function eventBadge(event) {
  if (!event) return '<span class="text-muted-foreground">–</span>';
  if (GOOD_EVENTS.has(event)) {
    return `<span class="badge border-status-good/40" data-variant="outline">${icons.check}${esc(event)}</span>`;
  }
  if (BAD_EVENTS.has(event)) {
    return `<span class="badge border-status-critical/40" data-variant="outline">${icons.x}${esc(event)}</span>`;
  }
  return `<span class="badge" data-variant="outline">${esc(event)}</span>`;
}

const tile = (label, value, hint, icon) => `
  <section class="card gap-2 py-5">
    <header>
      <p class="flex items-center gap-2">${icon}${label}</p>
    </header>
    <section>
      <div class="text-3xl font-semibold tabular-nums tracking-tight">${esc(value)}</div>
      ${hint ? `<div class="text-muted-foreground mt-1 text-xs">${esc(hint)}</div>` : ""}
    </section>
  </section>`;

const table = (head, rows) => `
  <div class="table-container">
    <table class="table">
      <thead><tr>${head}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;

function renderRunning(rows, now) {
  if (rows.length === 0) return '<p class="text-muted-foreground px-4 pb-2 text-sm">No agent sessions are running.</p>';
  return table(
    "<th>Issue</th><th>State</th><th>Session</th><th class=\"text-end\">Turns</th><th>Started</th><th>Last event</th><th>Message</th><th class=\"text-end\">Tokens</th>",
    rows.map((r) => `
      <tr>
        <td>${issueLink(r)}</td>
        <td><span class="badge" data-variant="secondary">${esc(r.state)}</span></td>
        <td class="text-muted-foreground font-mono text-xs">${esc(r.session_id ?? "starting…")}</td>
        <td class="text-end tabular-nums">${r.turn_count}</td>
        <td class="text-muted-foreground">${ago(r.started_at, now)}</td>
        <td><span class="flex items-center gap-2">${eventBadge(r.last_event)}<span class="text-muted-foreground text-xs">${ago(r.last_event_at, now)}</span></span></td>
        <td class="text-muted-foreground max-w-[24rem] truncate" title="${esc(r.last_message)}">${esc(r.last_message ?? "–")}</td>
        <td class="text-end tabular-nums">${fmt(r.tokens.total_tokens)}</td>
      </tr>`).join(""),
  );
}

function renderRetrying(rows, now) {
  if (rows.length === 0) return '<p class="text-muted-foreground px-4 pb-2 text-sm">The retry queue is empty.</p>';
  return table(
    "<th>Issue</th><th class=\"text-end\">Attempt</th><th>Due</th><th>Reason</th>",
    rows.map((r) => `
      <tr>
        <td>${issueLink(r)}</td>
        <td class="text-end tabular-nums">${r.attempt}</td>
        <td class="tabular-nums">${until(r.due_at, now)}</td>
        <td class="max-w-[36rem] truncate" title="${esc(r.error)}">${
          r.error
            ? `<span class="inline-flex items-center gap-1.5">${icons.alertSm}<span class="truncate">${esc(r.error)}</span></span>`
            : `<span class="badge" data-variant="outline">${icons.rotateSm}continuation check</span>`
        }</td>
      </tr>`).join(""),
  );
}

function renderRate(rate) {
  const windows = rate ? ["primary", "secondary"].filter((k) => rate[k] && typeof rate[k].usedPercent === "number") : [];
  if (windows.length === 0) return '<p class="text-muted-foreground text-sm">No rate-limit data yet.</p>';
  return windows.map((k) => {
    const w = rate[k];
    const used = Math.min(100, Math.max(0, w.usedPercent));
    const resets = w.resetsAt ? new Date(w.resetsAt * 1000).toLocaleString() : null;
    return `
      <div class="space-y-1.5">
        <div class="flex items-center justify-between text-sm">
          <span class="font-medium capitalize">${k}</span>
          <span class="text-muted-foreground tabular-nums">${used}% used${w.windowDurationMins ? ` · ${w.windowDurationMins}m window` : ""}</span>
        </div>
        <div class="progress" role="progressbar" aria-label="${k} rate limit ${used}% used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}">
          <span style="width: ${used}%"></span>
        </div>
        ${resets ? `<div class="text-muted-foreground text-xs">resets ${esc(resets)}</div>` : ""}
      </div>`;
  }).join("");
}

const alertBox = (title, body) => `
  <div class="alert" data-variant="destructive">
    ${icons.alert}
    <h2>${esc(title)}</h2>
    <section>${esc(body)}</section>
  </div>`;

let snapshot = null;
let fetchError = null;

function render() {
  const now = Date.now();
  $("subtitle").textContent = snapshot
    ? `Snapshot ${ago(snapshot.generated_at, now)} · refreshes every ${POLL_MS / 1000}s`
    : "Connecting…";

  const alerts = [];
  if (fetchError) alerts.push(alertBox("Cannot reach the Symphony API", fetchError));
  if (snapshot?.last_validation_error) {
    alerts.push(alertBox("Dispatch paused: configuration validation failed", snapshot.last_validation_error));
  }
  if (snapshot?.last_reload_error) {
    alerts.push(alertBox("WORKFLOW.md reload failed; last known good configuration is in effect", snapshot.last_reload_error));
  }
  $("alerts").innerHTML = alerts.join("");

  const t = snapshot?.codex_totals;
  $("tiles").innerHTML = [
    tile("Running", String(snapshot?.counts.running ?? 0), "agent sessions", icons.activity),
    tile("Retrying", String(snapshot?.counts.retrying ?? 0), "waiting in the retry queue", icons.rotate),
    tile("Tokens", t ? fmt(t.total_tokens) : "0", t ? `${fmt(t.input_tokens)} in · ${fmt(t.output_tokens)} out` : "", icons.coins),
    tile("Agent time", t ? duration(t.seconds_running) : "0m 0s", "cumulative, including active sessions", icons.clock),
  ].join("");

  $("running-count").textContent = String(snapshot?.counts.running ?? 0);
  $("retrying-count").textContent = String(snapshot?.counts.retrying ?? 0);
  $("running").innerHTML = renderRunning(snapshot?.running ?? [], now);
  $("retrying").innerHTML = renderRetrying(snapshot?.retrying ?? [], now);
  $("rate").innerHTML = renderRate(snapshot?.rate_limits);
}

async function load() {
  try {
    const response = await fetch("/api/v1/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    snapshot = await response.json();
    fetchError = null;
  } catch (err) {
    fetchError = err.message;
  }
  render();
}

$("poll").addEventListener("click", async () => {
  const button = $("poll");
  button.disabled = true;
  $("poll-icon").classList.add("animate-spin");
  try {
    await fetch("/api/v1/refresh", { method: "POST" });
    await new Promise((r) => setTimeout(r, 600));
    await load();
  } finally {
    $("poll-icon").classList.remove("animate-spin");
    button.disabled = false;
  }
});

load();
setInterval(load, POLL_MS);
setInterval(render, 1000);
