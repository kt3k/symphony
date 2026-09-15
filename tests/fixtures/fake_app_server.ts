/**
 * Minimal stand-in for `codex app-server` used by tests. Reads newline-delimited JSON-RPC from
 * stdin and reacts to markers in the turn prompt text:
 *   APPROVAL  -> asks for a command approval before completing
 *   TOOL:name -> issues a dynamic tool call and echoes the response in an item/completed event
 *   INPUT     -> requests user input
 *   FAIL      -> completes the turn with status failed
 *   HANG      -> never completes the turn (and stays silent)
 *   EXIT      -> exits the process mid-turn
 */
import { TextLineStream } from "jsr:@std/streams@^1.0.9";

const encoder = new TextEncoder();
let turnCounter = 0;
const pendingRequests = new Map<number, (message: Record<string, unknown>) => void>();
let serverRequestId = 1000;

function send(message: unknown) {
  Deno.stdout.writeSync(encoder.encode(JSON.stringify(message) + "\n"));
}

function serverRequest(method: string, params: unknown): Promise<Record<string, unknown>> {
  const id = serverRequestId++;
  send({ id, method, params });
  return new Promise((resolve) => pendingRequests.set(id, resolve));
}

async function runTurn(threadId: string, turnId: string, text: string) {
  send({
    method: "turn/started",
    params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } },
  });
  send({
    method: "item/started",
    params: { threadId, turnId, item: { type: "agentMessage", id: "m1" } },
  });
  send({
    method: "thread/tokenUsage/updated",
    params: {
      threadId,
      turnId,
      tokenUsage: {
        last: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
        },
        total: {
          inputTokens: 100 * turnCounter,
          outputTokens: 50 * turnCounter,
          totalTokens: 150 * turnCounter,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
        },
      },
    },
  });
  if (text.includes("HANG")) return;
  if (text.includes("EXIT")) Deno.exit(3);
  if (text.includes("APPROVAL")) {
    const response = await serverRequest("item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId: "c1",
      command: "rm -rf build",
      startedAtMs: Date.now(),
    });
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: {
          type: "agentMessage",
          id: "m2",
          text: `approval=${
            JSON.stringify((response.result as Record<string, unknown>)?.decision)
          }`,
        },
      },
    });
  }
  const tool = /TOOL:([a-z_]+)/.exec(text);
  if (tool) {
    const response = await serverRequest("item/tool/call", {
      threadId,
      turnId,
      callId: "call1",
      tool: tool[1],
      arguments: { body: "hello" },
    });
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { type: "agentMessage", id: "m3", text: `tool=${JSON.stringify(response.result)}` },
      },
    });
  }
  if (text.includes("INPUT")) {
    await serverRequest("item/tool/requestUserInput", {
      threadId,
      turnId,
      itemId: "q1",
      isBlocking: true,
      questions: [{ id: "q", header: "Q", question: "Which?" }],
    });
    // Symphony interrupts; report the turn as interrupted.
    send({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "interrupted", items: [] } },
    });
    return;
  }
  send({
    method: "account/rateLimits/updated",
    params: { rateLimits: { primary: { usedPercent: 12 } } },
  });
  if (text.includes("FAIL")) {
    send({
      method: "error",
      params: { threadId, turnId, willRetry: false, error: { message: "boom" } },
    });
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: { id: turnId, status: "failed", items: [], error: { message: "boom" } },
      },
    });
    return;
  }
  send({
    method: "item/completed",
    params: { threadId, turnId, item: { type: "agentMessage", id: "m9", text: "done" } },
  });
  send({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status: "completed", items: [] } },
  });
}

const lines = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).pipeThrough(
  new TextLineStream(),
);
for await (const line of lines) {
  if (line.trim() === "") continue;
  const message = JSON.parse(line) as Record<string, unknown>;
  const method = message.method as string | undefined;
  const id = message.id as number | undefined;
  if (id !== undefined && method === undefined) {
    const waiter = pendingRequests.get(id);
    if (waiter) {
      pendingRequests.delete(id);
      waiter(message);
    }
    continue;
  }
  const params = (message.params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "initialize":
      send({ id, result: { userAgent: "fake" } });
      break;
    case "initialized":
      break;
    case "thread/start": {
      if (Deno.env.get("FAKE_THREAD_START_ERROR")) {
        send({ id, error: { code: -1, message: "thread start rejected" } });
        break;
      }
      const cwd = params.cwd as string;
      send({
        id,
        result: { thread: { id: "thread-1", cwd }, dynamicTools: params.dynamicTools ?? null },
      });
      break;
    }
    case "thread/name/set":
      send({ id, result: {} });
      break;
    case "turn/start": {
      turnCounter += 1;
      const turnId = `turn-${turnCounter}`;
      const input = params.input as Array<{ text?: string }>;
      const text = input?.[0]?.text ?? "";
      send({ id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      runTurn(params.threadId as string, turnId, text);
      break;
    }
    case "turn/interrupt":
      break;
    default:
      if (id !== undefined) {
        send({ id, error: { code: -32601, message: `unknown method ${method}` } });
      }
  }
}
