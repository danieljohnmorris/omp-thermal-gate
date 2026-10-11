/**
 * omp-thermal-gate
 *
 * Two gates for omp on a shared DGX Spark cluster:
 *  - thermal gate: holds omp's requests to a hot GPU cluster until it cools down;
 *  - busy gate: refuses new Sparks-model subagents while Machinist is busy (see below).
 *
 * Before every provider request to a gated provider (default: `sparks`), the
 * extension asks sparkDash for each unit's GPU temperature
 * (`GET /api/sparks/:id/metrics` -> `metrics.gpu.temperature`). If the hottest
 * unit is at or above HIGH (default 80 C) the request waits, polling, until the
 * hottest unit is at or below RESUME (default 75 C). The gap between the two is
 * hysteresis, so the gate does not flap at the threshold.
 *
 * Client-side only: nothing on the cluster changes. If sparkDash cannot be
 * reached, or answers without a temperature, the gate fails open (the request
 * goes through) and says so on the status line.
 *
 * Why the handler is registered many times: omp gives every extension handler a
 * 30 s budget, then carries on without it. One handler can therefore hold a
 * request for under 30 s. To wait longer, the gate registers a chain of handlers
 * that each wait up to SLICE_MS; omp runs them in order for the same request, so
 * together they cover MAX_WAIT_MS. Once the cluster is cool (or the gate gives
 * up) the rest of the chain returns immediately.
 *
 * Configuration is read from the environment on every request. The sparkDash
 * token is only ever read from the environment (SPARKDASH_TOKEN); never put it
 * in this file or in git.
 *
 *   SPARKDASH_URL                    sparkDash base URL, e.g. http://spark2.<tailnet>.ts.net:5555 (required)
 *   SPARKDASH_TOKEN                  sparkDash bearer token (required on a tokened sparkDash)
 *   OMP_THERMAL_GATE_HIGH_C          start waiting at or above this (default 80)
 *   OMP_THERMAL_GATE_RESUME_C        resume at or below this (default 75)
 *   OMP_THERMAL_GATE_PROVIDERS       comma list of omp provider names to gate (default "sparks")
 *   OMP_THERMAL_GATE_SPARK_IDS       comma list of sparkDash unit ids (default: every online unit)
 *   OMP_THERMAL_GATE_POLL_MS         poll interval while waiting (default 5000)
 *   OMP_THERMAL_GATE_MAX_WAIT_MS     longest a single request is held (default 600000 = 10 min)
 *   OMP_THERMAL_GATE_ON_TIMEOUT      "proceed" (default) or "abort" once MAX_WAIT_MS is spent
 *   OMP_THERMAL_GATE_CACHE_MS        reuse a reading this long when cool (default 3000)
 *   OMP_THERMAL_GATE_DISABLED        truthy => gate does nothing
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** Per-handler wait budget, safely under omp's 30 s extension-handler cap. */
export const SLICE_MS = 25_000;
/** Hard ceiling on the handler chain, whatever MAX_WAIT_MS says (1 hour). */
const MAX_CHAIN = Math.ceil(3_600_000 / SLICE_MS);
const FETCH_TIMEOUT_MS = 4_000;
const STATUS_KEY = "thermal-gate";

export interface GateConfig {
  url: string;
  token: string;
  highC: number;
  resumeC: number;
  providers: string[];
  sparkIds: string[];
  pollMs: number;
  maxWaitMs: number;
  onTimeout: "proceed" | "abort";
  cacheMs: number;
  disabled: boolean;
}

const num = (raw: string | undefined, def: number): number => {
  if (raw == null || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
};
const list = (raw: string | undefined, def: string[]): string[] => {
  if (raw == null || raw.trim() === "") return def;
  return raw.split(",").map(s => s.trim()).filter(Boolean);
};
const truthy = (raw: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes((raw ?? "").trim().toLowerCase());

export function readConfig(env: Record<string, string | undefined> = process.env): GateConfig {
  const highC = num(env.OMP_THERMAL_GATE_HIGH_C, 80);
  let resumeC = num(env.OMP_THERMAL_GATE_RESUME_C, 75);
  if (resumeC > highC) resumeC = highC;
  return {
    url: (env.SPARKDASH_URL ?? "").trim().replace(/\/+$/, ""),
    token: (env.SPARKDASH_TOKEN ?? "").trim(),
    highC,
    resumeC,
    providers: list(env.OMP_THERMAL_GATE_PROVIDERS, ["sparks"]),
    sparkIds: list(env.OMP_THERMAL_GATE_SPARK_IDS, []),
    pollMs: Math.max(1000, num(env.OMP_THERMAL_GATE_POLL_MS, 5000)),
    maxWaitMs: num(env.OMP_THERMAL_GATE_MAX_WAIT_MS, 600_000),
    onTimeout: (env.OMP_THERMAL_GATE_ON_TIMEOUT ?? "").trim().toLowerCase() === "abort" ? "abort" : "proceed",
    cacheMs: num(env.OMP_THERMAL_GATE_CACHE_MS, 3000),
    disabled: truthy(env.OMP_THERMAL_GATE_DISABLED),
  };
}

export interface Reading {
  /** Hottest GPU across the units read, or undefined if none reported one. */
  maxC?: number;
  /** Unit that holds maxC. */
  hottest?: string;
  /** Per-unit temperatures that were read. */
  temps: Record<string, number>;
  /** Set when sparkDash could not be read at all. */
  error?: string;
}

/** Temperature from a sparkDash metrics snapshot, or undefined if it has none. */
export function temperatureOf(snapshot: any): number | undefined {
  if (!snapshot || snapshot.online === false) return undefined;
  const gpu = snapshot.metrics?.gpu ?? snapshot.gpu;
  const t = gpu?.temperature;
  // sparkDash reports 0 for a failed collection; no GB10 idles at 0 C.
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : undefined;
}

export function summarise(temps: Record<string, number>): Reading {
  let maxC: number | undefined;
  let hottest: string | undefined;
  for (const [id, t] of Object.entries(temps)) {
    if (maxC === undefined || t > maxC) {
      maxC = t;
      hottest = id;
    }
  }
  return { maxC, hottest, temps };
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export async function readTemps(cfg: GateConfig, fetchImpl: FetchLike = fetch as any): Promise<Reading> {
  if (!cfg.url) return { temps: {}, error: "SPARKDASH_URL not set" };
  const headers: Record<string, string> = { accept: "application/json" };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  const get = async (path: string): Promise<any> => {
    const res = await fetchImpl(`${cfg.url}${path}`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(res.status === 401 ? "sparkDash 401 (check SPARKDASH_TOKEN)" : `sparkDash HTTP ${res.status}`);
    return res.json();
  };
  try {
    let ids = cfg.sparkIds;
    if (ids.length === 0) {
      const body = await get("/api/sparks");
      ids = (body?.sparks ?? []).map((s: any) => s?.id).filter((id: unknown) => typeof id === "string");
    }
    const temps: Record<string, number> = {};
    const results = await Promise.allSettled(ids.map(id => get(`/api/sparks/${encodeURIComponent(id)}/metrics`)));
    let firstError: string | undefined;
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        const t = temperatureOf(r.value);
        if (t !== undefined) temps[ids[i]] = t;
      } else {
        firstError ??= r.reason instanceof Error ? r.reason.message : String(r.reason);
      }
    });
    const reading = summarise(temps);
    if (reading.maxC === undefined) reading.error = firstError ?? "no GPU temperature reported";
    return reading;
  } catch (err) {
    return { temps: {}, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Hysteresis: a cool cluster turns hot at >= highC; a hot one turns cool at <= resumeC.
 * An unknown temperature counts as cool: the gate fails open rather than hold
 * requests on a reading it does not have.
 */
export function nextHot(wasHot: boolean, maxC: number | undefined, cfg: Pick<GateConfig, "highC" | "resumeC">): boolean {
  if (maxC === undefined) return false;
  return wasHot ? maxC > cfg.resumeC : maxC >= cfg.highC;
}

export function shouldGate(provider: string | undefined, cfg: GateConfig): boolean {
  return !cfg.disabled && !!provider && cfg.providers.includes(provider);
}

// ---------------------------------------------------------------------------
// Busy gate: no new Sparks subagents while Machinist is busy.
//
// Machinist (OhMyMachinist) runs its own coding jobs on the same Sparks. When
// it has OMP_BUSY_GATE_MAX_RUNNING or more jobs in state "running", this gate
// refuses to spawn new subagents whose model resolves to a gated provider
// (default `sparks`). Subagents on cloud models still spawn. Requests from the
// main session and from subagents that are already running are not touched.
//
// It hooks omp's `before_subagent_spawn` event (task tool and eval `agent()`),
// which fires in the parent session before the child is created and can
// return { block, reason }. The reason reaches the model as the task tool's
// error, so the agent can do the work itself, pick a cloud model, or retry.
//
//   MACHINIST_URL                 Machinist base URL (default http://100.70.205.115:7331)
//   OMP_BUSY_GATE_MAX_RUNNING     refuse Sparks spawns at or above this many running jobs (default 3)
//   OMP_BUSY_GATE_PROVIDERS       providers whose subagents are gated (default: OMP_THERMAL_GATE_PROVIDERS, else "sparks")
//   OMP_BUSY_GATE_FALLBACK_MODEL  optional model pattern to reroute a refused spawn to (e.g. a cloud model) instead of refusing
//   OMP_BUSY_GATE_CACHE_MS        reuse a Machinist reading this long (default 3000)
//   OMP_BUSY_GATE_DISABLED        truthy => busy gate does nothing
// ---------------------------------------------------------------------------

export const DEFAULT_MACHINIST_URL = "http://100.70.205.115:7331";

export interface BusyConfig {
  url: string;
  maxRunning: number;
  providers: string[];
  fallbackModel: string;
  cacheMs: number;
  disabled: boolean;
}

export function readBusyConfig(env: Record<string, string | undefined> = process.env): BusyConfig {
  return {
    url: ((env.MACHINIST_URL ?? "").trim() || DEFAULT_MACHINIST_URL).replace(/\/+$/, ""),
    maxRunning: Math.max(1, Math.floor(num(env.OMP_BUSY_GATE_MAX_RUNNING, 3))),
    providers: list(env.OMP_BUSY_GATE_PROVIDERS, list(env.OMP_THERMAL_GATE_PROVIDERS, ["sparks"])),
    fallbackModel: (env.OMP_BUSY_GATE_FALLBACK_MODEL ?? "").trim(),
    cacheMs: num(env.OMP_BUSY_GATE_CACHE_MS, 3000),
    disabled: truthy(env.OMP_BUSY_GATE_DISABLED),
  };
}

export interface BusyReading {
  running?: number;
  error?: string;
}

/** Count Machinist jobs in state "running" from a /api/v1/status body. */
export function countRunning(body: any): number | undefined {
  const jobs = body?.jobs;
  if (!Array.isArray(jobs)) return undefined;
  return jobs.filter((j: any) => j?.state === "running").length;
}

/** Read-only: GET /api/v1/status. Never sends credentials; ignores csrf_token. */
export async function readMachinist(cfg: BusyConfig, fetchImpl: FetchLike = fetch as any): Promise<BusyReading> {
  try {
    const res = await fetchImpl(`${cfg.url}/api/v1/status`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `Machinist HTTP ${res.status}` };
    const running = countRunning(await res.json());
    return running === undefined ? { error: "Machinist status has no jobs list" } : { running };
  } catch (err) {
    return { error: `Machinist unreachable (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** Provider of a model pattern such as "sparks/GLM-5.3-Flash-EXL3-bg:auto". */
export function providerOf(pattern: string | undefined): string | undefined {
  const p = (pattern ?? "").trim();
  const slash = p.indexOf("/");
  return slash > 0 ? p.slice(0, slash) : undefined;
}

/**
 * Whether a spawn would land on a gated provider. omp tries `patterns` in
 * order, so the first one decides. With no patterns the child inherits the
 * parent session's model.
 */
export function spawnTargetsGated(patterns: string[] | undefined, parentProvider: string | undefined, cfg: Pick<BusyConfig, "providers">): boolean {
  const first = patterns?.find(p => p.trim() !== "");
  const provider = first !== undefined ? providerOf(first) : parentProvider;
  return !!provider && cfg.providers.includes(provider);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface Gate {
  startedAt: number;
  done: boolean;
}

export default function (pi: ExtensionAPI) {
  pi.setLabel("Thermal gate");

  let hot = false;
  let cache: { at: number; reading: Reading } | undefined;
  let lastError: string | undefined;
  let gate: Gate | undefined;

  const read = async (cfg: GateConfig, fresh: boolean): Promise<Reading> => {
    if (!fresh && cache && Date.now() - cache.at < cfg.cacheMs) return cache.reading;
    const reading = await readTemps(cfg);
    cache = { at: Date.now(), reading };
    return reading;
  };

  const fmt = (r: Reading) => (r.maxC === undefined ? "?" : `${r.hottest} ${Math.round(r.maxC)}°C`);

  const slice = async (index: number, ctx: any): Promise<undefined> => {
    const cfg = readConfig();
    const provider = ctx?.model?.provider as string | undefined;
    if (!shouldGate(provider, cfg)) return undefined;

    // The first handler in the chain opens a gate for this request; the rest join it.
    if (index === 0) gate = { startedAt: Date.now(), done: false };
    const g = gate;
    if (!g || g.done) return undefined;
    if (index * SLICE_MS >= cfg.maxWaitMs) {
      // This slice is beyond the configured wait: only the timeout decision is left.
      return finish(g, cfg, ctx, true);
    }

    const sliceEnd = Date.now() + SLICE_MS;
    let first = index === 0;
    for (;;) {
      const reading = await read(cfg, !first);
      first = false;
      if (reading.error) {
        if (reading.error !== lastError) {
          lastError = reading.error;
          ctx.ui?.notify?.(`Thermal gate: ${reading.error}; not gating`, "warning");
        }
        ctx.ui?.setStatus?.(STATUS_KEY, `🌡 gate off: ${reading.error}`);
        hot = false;
        g.done = true;
        return undefined;
      }
      lastError = undefined;
      hot = nextHot(hot, reading.maxC, cfg);
      if (!hot) {
        ctx.ui?.setStatus?.(STATUS_KEY, undefined);
        g.done = true;
        return undefined;
      }
      const waited = Math.round((Date.now() - g.startedAt) / 1000);
      ctx.ui?.setStatus?.(STATUS_KEY, `🌡 ${fmt(reading)} — holding until ≤${cfg.resumeC}°C (${waited}s)`);
      if (Date.now() - g.startedAt >= cfg.maxWaitMs) return finish(g, cfg, ctx, true);
      const remaining = sliceEnd - Date.now();
      if (remaining <= cfg.pollMs) return undefined; // hand over to the next slice
      await sleep(cfg.pollMs);
    }
  };

  const finish = (g: Gate, cfg: GateConfig, ctx: any, timedOut: boolean): undefined => {
    g.done = true;
    if (!timedOut) return undefined;
    const mins = Math.round(cfg.maxWaitMs / 60_000);
    if (cfg.onTimeout === "abort") {
      ctx.ui?.setStatus?.(STATUS_KEY, undefined);
      ctx.ui?.notify?.(`Thermal gate: still hot after ${mins} min; aborting`, "error");
      ctx.abort?.();
    } else {
      ctx.ui?.setStatus?.(STATUS_KEY, undefined);
      ctx.ui?.notify?.(`Thermal gate: still hot after ${mins} min; sending anyway`, "warning");
    }
    return undefined;
  };

  // ---- busy gate: refuse new Sparks subagents while Machinist is busy ----
  let busyCache: { at: number; reading: BusyReading } | undefined;
  let busyLastError: string | undefined;
  const BUSY_STATUS_KEY = "busy-gate";

  pi.on("before_subagent_spawn", async (event: any, ctx: any) => {
    const cfg = readBusyConfig();
    if (cfg.disabled) return undefined;
    if (!spawnTargetsGated(event?.patterns, ctx?.model?.provider, cfg)) return undefined;

    let reading = busyCache && Date.now() - busyCache.at < cfg.cacheMs ? busyCache.reading : undefined;
    if (!reading) {
      reading = await readMachinist(cfg);
      busyCache = { at: Date.now(), reading };
    }
    if (reading.error) {
      // Fail open: Machinist down must never stop omp from spawning.
      if (reading.error !== busyLastError) {
        busyLastError = reading.error;
        ctx.ui?.notify?.(`Busy gate: ${reading.error}; not gating subagents`, "warning");
      }
      ctx.ui?.setStatus?.(BUSY_STATUS_KEY, undefined);
      return undefined;
    }
    busyLastError = undefined;
    const running = reading.running ?? 0;
    if (running < cfg.maxRunning) {
      ctx.ui?.setStatus?.(BUSY_STATUS_KEY, undefined);
      return undefined;
    }

    const why = `Machinist has ${running} jobs running (limit ${cfg.maxRunning})`;
    ctx.ui?.setStatus?.(BUSY_STATUS_KEY, `⚙ ${why}: no new Sparks subagents`);
    if (cfg.fallbackModel) {
      ctx.ui?.notify?.(`Busy gate: ${why}; ${event?.agent ?? "subagent"} → ${cfg.fallbackModel}`, "info");
      return { model: cfg.fallbackModel, note: `busy gate: ${why}` };
    }
    ctx.ui?.notify?.(`Busy gate: ${why}; refused Sparks subagent ${event?.agent ?? ""}`.trim(), "warning");
    return {
      block: true,
      reason:
        `Busy gate: ${why}, so new subagents on Sparks models are paused. ` +
        `Do this work in the current session, spawn it on a cloud model instead, or try again later.`,
    };
  });

  // The chain is sized at load time from MAX_WAIT_MS (+1 slice for the timeout decision).
  const chain = Math.min(MAX_CHAIN, Math.ceil(readConfig().maxWaitMs / SLICE_MS) + 1);
  for (let i = 0; i < chain; i++) {
    const index = i;
    pi.on("before_provider_request", (_event, ctx) => slice(index, ctx));
  }
}
