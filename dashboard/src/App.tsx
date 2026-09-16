import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  Coins,
  ExternalLink,
  Gauge,
  RefreshCw,
  RotateCw,
  XCircle,
} from "lucide-react";

import type { RateLimitWindow, RetryRow, RunningRow, Snapshot } from "@/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const POLL_MS = 5000;

function ago(iso: string | null, now: number): string {
  if (!iso) return "–";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
}

function until(iso: string, now: number): string {
  const s = (Date.parse(iso) - now) / 1000;
  if (s <= 0) return "now";
  if (s < 60) return `in ${Math.round(s)}s`;
  return `in ${Math.round(s / 60)}m`;
}

function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${Math.floor(seconds % 60)}s`;
}

const fmt = (n: number) => n.toLocaleString();

function IssueLink({ row }: { row: { issue_identifier: string; issue_url: string | null } }) {
  if (!row.issue_url) return <span className="font-medium">{row.issue_identifier}</span>;
  return (
    <a
      href={row.issue_url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
    >
      {row.issue_identifier}
      <ExternalLink className="size-3 text-muted-foreground" />
    </a>
  );
}

function EventBadge({ event }: { event: string | null }) {
  if (!event) return <span className="text-muted-foreground">–</span>;
  if (event === "turn_completed" || event === "session_started") {
    return (
      <Badge variant="outline" className="border-status-good/40 text-foreground">
        <CheckCircle2 className="text-status-good" />
        {event}
      </Badge>
    );
  }
  if (event === "turn_failed" || event === "turn_ended_with_error" || event === "startup_failed" || event === "turn_input_required") {
    return (
      <Badge variant="outline" className="border-status-critical/40 text-foreground">
        <XCircle className="text-status-critical" />
        {event}
      </Badge>
    );
  }
  return <Badge variant="outline">{event}</Badge>;
}

function StatTile({ label, value, hint, icon }: { label: string; value: string; hint?: string; icon: React.ReactNode }) {
  return (
    <Card className="gap-2 py-5">
      <CardHeader className="pb-0">
        <CardDescription className="flex items-center gap-2">
          {icon}
          {label}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
        {hint && <div className="text-muted-foreground mt-1 text-xs">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function RunningTable({ rows, now }: { rows: RunningRow[]; now: number }) {
  if (rows.length === 0) {
    return <p className="text-muted-foreground px-6 pb-2 text-sm">No agent sessions are running.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Issue</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Session</TableHead>
          <TableHead className="text-right">Turns</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Last event</TableHead>
          <TableHead>Message</TableHead>
          <TableHead className="text-right">Tokens</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.issue_id}>
            <TableCell>
              <IssueLink row={r} />
            </TableCell>
            <TableCell>
              <Badge variant="secondary">{r.state}</Badge>
            </TableCell>
            <TableCell className="text-muted-foreground font-mono text-xs">{r.session_id ?? "starting…"}</TableCell>
            <TableCell className="text-right tabular-nums">{r.turn_count}</TableCell>
            <TableCell className="text-muted-foreground">{ago(r.started_at, now)}</TableCell>
            <TableCell>
              <div className="flex items-center gap-2">
                <EventBadge event={r.last_event} />
                <span className="text-muted-foreground text-xs">{ago(r.last_event_at, now)}</span>
              </div>
            </TableCell>
            <TableCell className="max-w-[24rem] truncate text-muted-foreground" title={r.last_message ?? ""}>
              {r.last_message ?? "–"}
            </TableCell>
            <TableCell className="text-right tabular-nums">{fmt(r.tokens.total_tokens)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RetryTable({ rows, now }: { rows: RetryRow[]; now: number }) {
  if (rows.length === 0) {
    return <p className="text-muted-foreground px-6 pb-2 text-sm">The retry queue is empty.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Issue</TableHead>
          <TableHead className="text-right">Attempt</TableHead>
          <TableHead>Due</TableHead>
          <TableHead>Reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.issue_id}>
            <TableCell>
              <IssueLink row={r} />
            </TableCell>
            <TableCell className="text-right tabular-nums">{r.attempt}</TableCell>
            <TableCell className="tabular-nums">{until(r.due_at, now)}</TableCell>
            <TableCell className="max-w-[36rem] truncate" title={r.error ?? ""}>
              {r.error ? (
                <span className="inline-flex items-center gap-1.5">
                  <AlertCircle className="size-3.5 shrink-0 text-status-critical" />
                  <span className="truncate">{r.error}</span>
                </span>
              ) : (
                <Badge variant="outline">
                  <RotateCw />
                  continuation check
                </Badge>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RateLimitMeter({ label, window }: { label: string; window: RateLimitWindow }) {
  const used = Math.min(100, Math.max(0, window.usedPercent));
  const resets = window.resetsAt ? new Date(window.resetsAt * 1000).toLocaleString() : null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium capitalize">{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {used}% used{window.windowDurationMins ? ` · ${window.windowDurationMins}m window` : ""}
        </span>
      </div>
      <Progress value={used} aria-label={`${label} rate limit ${used}% used`} />
      {resets && <div className="text-muted-foreground text-xs">resets {resets}</div>}
    </div>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [polling, setPolling] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/state", { cache: "no-store" });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      setSnapshot(await response.json());
      setFetchError(null);
    } catch (err) {
      setFetchError((err as Error).message);
    } finally {
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(timer);
      clearInterval(clock);
    };
  }, [load]);

  const pollNow = async () => {
    setPolling(true);
    try {
      await fetch("/api/v1/refresh", { method: "POST" });
      await new Promise((r) => setTimeout(r, 600));
      await load();
    } finally {
      setPolling(false);
    }
  };

  const totals = snapshot?.codex_totals;
  const rate = snapshot?.rate_limits;
  const windows = rate
    ? (["primary", "secondary"] as const).filter((k) => rate[k] && typeof rate[k]?.usedPercent === "number")
    : [];

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Symphony</h1>
          <p className="text-muted-foreground text-sm">
            {snapshot ? `Snapshot ${ago(snapshot.generated_at, now)} · refreshes every ${POLL_MS / 1000}s` : "Connecting…"}
          </p>
        </div>
        <Button onClick={pollNow} disabled={polling} variant="outline">
          <RefreshCw className={polling ? "animate-spin" : ""} />
          Poll tracker now
        </Button>
      </header>

      {fetchError && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Cannot reach the Symphony API</AlertTitle>
          <AlertDescription>{fetchError}</AlertDescription>
        </Alert>
      )}
      {snapshot?.last_validation_error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Dispatch paused: configuration validation failed</AlertTitle>
          <AlertDescription>{snapshot.last_validation_error}</AlertDescription>
        </Alert>
      )}
      {snapshot?.last_reload_error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>WORKFLOW.md reload failed; last known good configuration is in effect</AlertTitle>
          <AlertDescription>{snapshot.last_reload_error}</AlertDescription>
        </Alert>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Running" value={String(snapshot?.counts.running ?? 0)} icon={<Activity className="size-4" />} hint="agent sessions" />
        <StatTile label="Retrying" value={String(snapshot?.counts.retrying ?? 0)} icon={<RotateCw className="size-4" />} hint="waiting in the retry queue" />
        <StatTile
          label="Tokens"
          value={totals ? fmt(totals.total_tokens) : "0"}
          icon={<Coins className="size-4" />}
          hint={totals ? `${fmt(totals.input_tokens)} in · ${fmt(totals.output_tokens)} out` : undefined}
        />
        <StatTile
          label="Agent time"
          value={totals ? duration(totals.seconds_running) : "0m 0s"}
          icon={<Clock className="size-4" />}
          hint="cumulative, including active sessions"
        />
      </section>

      <Card className="pb-2">
        <CardHeader>
          <CardTitle>Running sessions</CardTitle>
          <CardDescription>One Codex app-server per issue, inside its own workspace.</CardDescription>
          <CardAction>
            <Badge variant="secondary">{snapshot?.counts.running ?? 0}</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="px-2">
          <RunningTable rows={snapshot?.running ?? []} now={now} />
        </CardContent>
      </Card>

      <Card className="pb-2">
        <CardHeader>
          <CardTitle>Retry queue</CardTitle>
          <CardDescription>Continuation checks after clean exits, exponential backoff after failures.</CardDescription>
          <CardAction>
            <Badge variant="secondary">{snapshot?.counts.retrying ?? 0}</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="px-2">
          <RetryTable rows={snapshot?.retrying ?? []} now={now} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="size-4" />
            Codex rate limits
          </CardTitle>
          <CardDescription>Latest account/rateLimits/updated payload seen from any session.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {windows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No rate-limit data yet.</p>
          ) : (
            windows.map((k) => <RateLimitMeter key={k} label={k} window={rate![k] as RateLimitWindow} />)
          )}
        </CardContent>
      </Card>

      <footer className="text-muted-foreground flex flex-wrap gap-4 text-xs">
        <a className="hover:underline" href="/api/v1/state">/api/v1/state</a>
        <span>POST /api/v1/refresh</span>
        <span>GET /api/v1/&lt;issue_identifier&gt;</span>
      </footer>
    </div>
  );
}
