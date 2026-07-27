import { NextResponse, type NextRequest } from "next/server";

import {
  readCachedAnalysis,
  writeCachedAnalysis,
  type AnalysisCacheKey,
} from "@/app/server/analysisCache";

/**
 * Server-side proxy to the Hivemind RunPod serverless endpoint.
 *
 * This exists for one reason: RunPod requires an API key, and the browser must
 * never see it. `NEXT_PUBLIC_ENGINE_ENDPOINT` is compiled into the client
 * bundle, so the key cannot travel that way.
 *
 * The path is `/api/engine/run` rather than `/api/engine` so that pointing
 * `NEXT_PUBLIC_ENGINE_ENDPOINT` at `/api/engine` makes `engineClient.ts`'s
 * existing `${endpoint}/run` land here unchanged. The dev server exposes the
 * same `/run` path, so the client works against either with only an env change.
 *
 * The response shape mirrors RunPod's `{ output: ... }` envelope, which is what
 * `analyzePosition` already unwraps.
 */

const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;

/**
 * A cold worker pays a container pull and a TensorRT plan load before it can
 * answer, so the first request after scale-to-zero is far slower than a warm
 * one. This bounds how long we are willing to wait for the whole thing.
 *
 * Hosts cap function duration independently (Vercel in particular), and the
 * lower of the two wins -- if the platform kills the function first the client
 * sees a network error rather than the timeout message below.
 */
export const maxDuration = 300;

const TOTAL_DEADLINE_MS = 240_000;

/**
 * Polling starts fast and backs off.
 *
 * Submitting with `/run` instead of `/runsync` means even a warm search, which
 * settles in under three seconds, is discovered by a poll rather than returned
 * directly -- so a flat one-second interval would add up to a second to every
 * request. Starting at 150ms keeps that overhead small where it is felt, and
 * backing off to a second keeps a cold start (minutes) from being thousands of
 * requests.
 */
const FIRST_POLL_MS = 150;
const MAX_POLL_MS = 1_000;
const POLL_BACKOFF = 1.5;

/**
 * A game review fires dozens of requests over several minutes, spaced far
 * enough apart that RunPod's edge (Cloudflare) closes the idle keep-alive
 * sockets between them. undici then picks one of those already-closed sockets
 * out of its pool for the next request and surfaces `UND_ERR_SOCKET` ("other
 * side closed") -- a connection that never carried the request, not an engine
 * failure. It does not retry that itself, so a single blip out of dozens failed
 * a whole review with a 504. These bound a short retry that absorbs it.
 */
const MAX_FETCH_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 250;

/**
 * Search budgets are clamped here, not just in the client.
 *
 * This route is unauthenticated and every call spends GPU time on your RunPod
 * account. Without a ceiling, a handcrafted request asking for 50M nodes is a
 * way to run up your bill from a browser console. The handler enforces its own
 * caps too; this is the outer one that keeps abusive jobs from being dispatched
 * at all.
 */
/*
 * 4M, not 5M, because 5M cannot finish. At the measured worst case of 7,221 nps
 * the endpoint's 600s `executionTimeoutMs` tops out near 4.33M nodes, and a
 * `nodes` search that hits that timeout is the worst outcome available: it
 * returns nothing and still bills the full 600s. The cap belongs below the
 * ceiling rather than 15% above it.
 */
const MAX_NODES = 4_000_000;
const MAX_MOVETIME_MS = 30_000;
const MAX_MULTIPV = 20;

type RunPodStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

interface RunPodJob {
  id?: string;
  status?: RunPodStatus;
  output?: unknown;
  error?: unknown;
}

function clampInteger(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  if (rounded <= 0) return null;
  return Math.min(rounded, max);
}

/**
 * Rebuilds the handler input from scratch rather than forwarding the client's
 * object.
 *
 * Passing the body through would let a caller set fields the handler accepts
 * but the UI never sends. Listing them explicitly means the proxy's contract is
 * visible here, and adding a field to the engine is a deliberate edit.
 */
function buildEngineInput(raw: Record<string, unknown>): Record<string, unknown> | { error: string } {
  const fen = raw.fen;
  if (typeof fen !== "string" || !fen.includes("|")) {
    return { error: "expected a two-board fen of the form 'fenA|fenB'" };
  }

  const analysisBoard = raw.analysisBoard === 2 ? 2 : 1;
  const mode = raw.mode === "sit" ? "sit" : "go";
  const team = raw.team === "black" ? "black" : "white";

  const input: Record<string, unknown> = {
    action: "move",
    fen,
    analysisBoard,
    mode,
    team,
    multipv: clampInteger(raw.multipv, MAX_MULTIPV) ?? 1,
  };

  // nodes and movetime are alternative budgets; the handler prefers nodes when
  // both are present, so only one is forwarded.
  const nodes = clampInteger(raw.nodes, MAX_NODES);
  if (nodes !== null) {
    input.nodes = nodes;
  } else {
    const movetime = clampInteger(raw.movetime, MAX_MOVETIME_MS);
    if (movetime !== null) input.movetime = movetime;
  }

  return input;
}

function authHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${RUNPOD_API_KEY}`,
  };
}

/** A sleep that gives up as soon as the request is abandoned. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Whether a thrown fetch error is a transient connection drop worth retrying.
 *
 * Scoped deliberately narrow. The one we have actually observed is undici
 * reusing a keep-alive socket that RunPod's edge already closed, which throws a
 * `TypeError: fetch failed` whose `cause` carries `code: 'UND_ERR_SOCKET'` and
 * the message "other side closed"; the reset/timeout codes are the same class of
 * connection-level failure and cost nothing to include. What is excluded
 * matters as much: an `AbortError` is a real cancellation (the user left, or our
 * deadline fired), and an HTTP error status is never thrown here at all -- the
 * callers read `response.ok` themselves. Neither should be papered over.
 */
function isTransientConnectionError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return false;
  const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
  const code = cause?.code;
  if (
    code === "UND_ERR_SOCKET" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return true;
  }
  const message = `${err instanceof Error ? err.message : ""} ${cause?.message ?? ""}`;
  return /other side closed/i.test(message);
}

/**
 * `fetch` with a bounded retry for the transient connection drops above.
 *
 * A returned `Response` is handed straight back untouched -- including a 4xx/5xx
 * status, which is not a transport failure and is the callers' to interpret.
 * Only a thrown `isTransientConnectionError` is retried, and only while the
 * request is neither aborted nor past its deadline, so a retry can never outlive
 * the wait the rest of the route already bounds. `sleep` rejects on abort, so a
 * client leaving mid-backoff surfaces as the same `AbortError` a live fetch
 * would have.
 *
 * Retrying the `/run` POST is safe against double-billing precisely because the
 * error we retry is pre-send: undici throws "other side closed" when it writes
 * to a socket the peer has already closed, so no job was ever submitted. A reset
 * that lands after the request reached RunPod is the rare exception; the cost of
 * being wrong there is at most one extra job, itself capped by `MAX_NODES`.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  deadline: number,
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fetch(url, { ...init, signal });
    } catch (err) {
      if (
        attempt >= MAX_FETCH_ATTEMPTS ||
        signal.aborted ||
        Date.now() >= deadline ||
        !isTransientConnectionError(err)
      ) {
        throw err;
      }
      console.warn(
        `fetch ${url}: attempt ${attempt} hit a transient connection error, retrying`,
        err,
      );
      await sleep(RETRY_BACKOFF_MS * attempt, signal);
    }
  }
}

/**
 * Tells RunPod to stop a job we are no longer waiting for.
 *
 * Without this the search runs to completion and is billed in full: a bestmove
 * was once observed arriving 25 seconds after the client had gone. The worker
 * stops as soon as it is asked -- the handler is async and drops out of its
 * search loop on cancellation -- but nothing asks unless we do, because an HTTP
 * disconnect is invisible to RunPod.
 *
 * Deliberately does not take the request's AbortSignal. By the time this is
 * called that signal is usually already aborted, and passing it would cancel
 * the cancellation -- the one request that has to outlive the client.
 *
 * Best-effort by design: the job may have finished a moment ago, and failing to
 * cancel is never worth turning into a client-visible error.
 */
async function cancelJob(jobId: string): Promise<void> {
  try {
    const response = await fetch(
      `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/cancel/${jobId}`,
      { method: "POST", headers: authHeaders() },
    );
    if (!response.ok) {
      console.error(`cancel job ${jobId}: RunPod returned HTTP ${response.status}`);
    }
  } catch (err) {
    console.error(`cancel job ${jobId} failed`, err);
  }
}

/**
 * Polls a job to completion.
 *
 * Jobs are submitted with `/run`, which returns an id immediately, rather than
 * `/runsync`, which returns one only once it answers. That difference is the
 * whole reason cancellation can work at all: a client that disconnects during a
 * `/runsync` call leaves us holding no id, and therefore nothing to cancel.
 */
async function pollUntilSettled(
  jobId: string,
  deadline: number,
  signal: AbortSignal,
): Promise<RunPodJob> {
  const statusUrl = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/status/${jobId}`;
  let wait = FIRST_POLL_MS;

  while (Date.now() < deadline) {
    await sleep(wait, signal);
    wait = Math.min(Math.round(wait * POLL_BACKOFF), MAX_POLL_MS);

    const response = await fetchWithRetry(statusUrl, { headers: authHeaders() }, signal, deadline);
    if (!response.ok) {
      throw new Error(`RunPod status returned HTTP ${response.status}`);
    }

    const job = (await response.json()) as RunPodJob;
    if (job.status && job.status !== "IN_QUEUE" && job.status !== "IN_PROGRESS") {
      return job;
    }
  }

  throw new Error("timed out waiting for the engine");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!RUNPOD_ENDPOINT_ID || !RUNPOD_API_KEY) {
    console.error("POST /api/engine/run: RUNPOD_ENDPOINT_ID or RUNPOD_API_KEY is unset");
    return NextResponse.json(
      { error: "the analysis engine is not configured" },
      { status: 503 },
    );
  }

  const body: unknown = await request.json().catch(() => null);
  const rawInput = (body as { input?: unknown } | null)?.input;
  if (!rawInput || typeof rawInput !== "object") {
    return NextResponse.json({ error: "expected an 'input' object" }, { status: 400 });
  }

  const built = buildEngineInput(rawInput as Record<string, unknown>);
  if ("error" in built && typeof built.error === "string") {
    return NextResponse.json({ error: built.error }, { status: 400 });
  }

  /**
   * Only `nodes` searches are cacheable.
   *
   * A `movetime` search fixes the clock and lets the work vary, so its result
   * is not an answer to a repeatable question -- two runs of the same request
   * did different amounts of searching, and neither is the one a later caller
   * asked for. `nodes` fixes the work, which is what makes "at least this deep"
   * a meaningful thing to store and compare.
   */
  // `built` is a union with the error shape, and the guard above cannot narrow
  // it -- a Record<string, unknown> may legitimately carry an "error" key too.
  // Every field below was written by buildEngineInput, so the assertion is
  // describing that function's output rather than trusting the request.
  const input = built as Record<string, unknown>;

  const cacheKey: AnalysisCacheKey | null =
    typeof input.nodes === "number"
      ? {
          fen: input.fen as string,
          analysisBoard: input.analysisBoard as number,
          team: input.team as string,
          mode: input.mode as string,
          nodes: input.nodes,
          multipv: input.multipv as number,
        }
      : null;

  if (cacheKey) {
    const cached = readCachedAnalysis(cacheKey);
    if (cached) {
      // Same envelope as a live result: the client unwraps `output` and cannot
      // tell the difference, which is the point -- a re-viewed report shows the
      // numbers it showed the first time.
      return NextResponse.json({ output: cached });
    }
  }

  const deadline = Date.now() + TOTAL_DEADLINE_MS;

  // Held outside the try so the catch can cancel a job that is still running.
  let jobId: string | undefined;

  try {
    const response = await fetchWithRetry(
      `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/run`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ input: built }),
      },
      request.signal,
      deadline,
    );

    if (!response.ok) {
      // The upstream body can carry the key in an error echo, so it is logged
      // rather than returned.
      console.error(
        `POST /api/engine/run: RunPod returned HTTP ${response.status}`,
        await response.text().catch(() => ""),
      );
      return NextResponse.json({ error: "the analysis engine is unavailable" }, { status: 502 });
    }

    let job = (await response.json()) as RunPodJob;
    jobId = job.id;

    if (job.status === "IN_QUEUE" || job.status === "IN_PROGRESS") {
      if (!jobId) {
        return NextResponse.json({ error: "the engine returned no job id" }, { status: 502 });
      }
      job = await pollUntilSettled(jobId, deadline, request.signal);
    }

    if (job.status !== "COMPLETED") {
      console.error(`POST /api/engine/run: job ${job.id} ended ${job.status}`, job.error);
      const message =
        job.status === "TIMED_OUT"
          ? "the search exceeded its time limit"
          : "the analysis engine failed";
      return NextResponse.json({ error: message }, { status: 502 });
    }

    // Handler-level errors travel inside a COMPLETED job's output; the client
    // checks `output.error`, so this passes through untouched.
    //
    // Stored after the status check and before returning. `writeCachedAnalysis`
    // rejects outputs carrying an `error`, so a handler-level failure is not
    // made permanent for that position.
    if (cacheKey) writeCachedAnalysis(cacheKey, job.output);

    return NextResponse.json({ output: job.output });
  } catch (err) {
    // Every path here abandons a job that may still be searching, and a search
    // nobody is waiting for is billed exactly like one that is. Stop it.
    //
    // This covers the client going away *and* our own deadline expiring: in the
    // latter case the job is still running on RunPod's side, and leaving it
    // alone would spend the full remaining search budget on a result that has
    // nowhere to go.
    if (jobId) await cancelJob(jobId);

    if (err instanceof DOMException && err.name === "AbortError") {
      // The user navigated or changed position.
      return NextResponse.json({ error: "cancelled" }, { status: 499 });
    }
    console.error("POST /api/engine/run failed", err);
    const message =
      err instanceof Error && err.message.startsWith("timed out")
        ? "the engine did not respond in time -- a cold worker can take a few minutes"
        : "could not reach the analysis engine";
    return NextResponse.json({ error: message }, { status: 504 });
  }
}
