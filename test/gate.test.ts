import { afterAll, beforeAll, expect, test } from "bun:test";
import ext, { nextHot, readConfig, readTemps, shouldGate, temperatureOf } from "../index";

// A fake sparkDash: bearer-protected, temperatures settable per test.
const TOKEN = "test-token-not-real";
let temps: Record<string, number> = {};
let server: ReturnType<typeof Bun.serve>;
let url = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`)
        return Response.json({ error: "Authentication required" }, { status: 401 });
      const u = new URL(req.url);
      if (u.pathname === "/api/sparks") return Response.json({ sparks: Object.keys(temps).map(id => ({ id })) });
      const m = /^\/api\/sparks\/([^/]+)\/metrics$/.exec(u.pathname);
      if (m && m[1] in temps) return Response.json({ id: m[1], online: true, metrics: { gpu: { temperature: temps[m[1]] } } });
      return Response.json({ error: "Spark not found" }, { status: 404 });
    },
  });
  url = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));

const cfg = (extra: Record<string, string> = {}) =>
  readConfig({ SPARKDASH_URL: url, SPARKDASH_TOKEN: TOKEN, OMP_THERMAL_GATE_POLL_MS: "1000", ...extra });

test("hysteresis", () => {
  const c = { highC: 80, resumeC: 75 };
  expect(nextHot(false, 79, c)).toBe(false);
  expect(nextHot(false, 80, c)).toBe(true);
  expect(nextHot(true, 77, c)).toBe(true);
  expect(nextHot(true, 75, c)).toBe(false);
  expect(nextHot(true, undefined, c)).toBe(false);
});

test("temperature parsing", () => {
  expect(temperatureOf({ online: true, metrics: { gpu: { temperature: 61 } } })).toBe(61);
  expect(temperatureOf({ gpu: { temperature: 70 } })).toBe(70);
  expect(temperatureOf({ online: false, metrics: { gpu: { temperature: 61 } } })).toBeUndefined();
  expect(temperatureOf({ metrics: { gpu: { temperature: 0 } } })).toBeUndefined();
});

test("provider matching", () => {
  expect(shouldGate("sparks", cfg())).toBe(true);
  expect(shouldGate("anthropic", cfg())).toBe(false);
  expect(shouldGate("sparks", cfg({ OMP_THERMAL_GATE_DISABLED: "1" }))).toBe(false);
});

test("reads max temp over all units", async () => {
  temps = { spark1: 62, spark2: 84, spark3: 58 };
  const r = await readTemps(cfg());
  expect(r.maxC).toBe(84);
  expect(r.hottest).toBe("spark2");
});

test("401 fails open with a clear error", async () => {
  temps = { spark1: 90 };
  const r = await readTemps(cfg({ SPARKDASH_TOKEN: "wrong" }));
  expect(r.maxC).toBeUndefined();
  expect(r.error).toContain("401");
});

test("missing URL fails open", async () => {
  const r = await readTemps(readConfig({}));
  expect(r.error).toContain("SPARKDASH_URL");
});

// Drive the real extension through a fake omp host.
function load(env: Record<string, string>) {
  Object.assign(process.env, env);
  const handlers: Array<(e: any, ctx: any) => Promise<unknown>> = [];
  const status: Array<string | undefined> = [];
  const notes: string[] = [];
  let aborted = false;
  ext({ setLabel() {}, on: (ev: string, h: any) => ev === "before_provider_request" && handlers.push(h) } as any);
  const ctx = {
    model: { provider: "sparks" },
    ui: { setStatus: (_k: string, t?: string) => status.push(t), notify: (m: string) => notes.push(m) },
    abort: () => (aborted = true),
  };
  const run = async (provider = "sparks") => {
    ctx.model.provider = provider;
    for (const h of handlers) await h({ type: "before_provider_request", payload: {} }, ctx);
  };
  return { run, handlers, status, notes, aborted: () => aborted };
}

test("cool cluster: passes straight through", async () => {
  temps = { spark1: 60 };
  const h = load({ SPARKDASH_URL: url, SPARKDASH_TOKEN: TOKEN, OMP_THERMAL_GATE_MAX_WAIT_MS: "60000" });
  expect(h.handlers.length).toBe(4); // ceil(60000/25000)+1
  const t0 = Date.now();
  await h.run();
  expect(Date.now() - t0).toBeLessThan(1000);
});

test("hot cluster: waits until <= resume, then sends", async () => {
  temps = { spark1: 85 };
  const h = load({ SPARKDASH_URL: url, SPARKDASH_TOKEN: TOKEN, OMP_THERMAL_GATE_POLL_MS: "1000", OMP_THERMAL_GATE_MAX_WAIT_MS: "60000", OMP_THERMAL_GATE_CACHE_MS: "0" });
  setTimeout(() => (temps = { spark1: 78 }), 1200); // below high, above resume: keep waiting
  setTimeout(() => (temps = { spark1: 74 }), 2600);
  const t0 = Date.now();
  await h.run();
  const took = Date.now() - t0;
  expect(took).toBeGreaterThanOrEqual(2500);
  expect(took).toBeLessThan(6000);
  expect(h.status.some(s => s?.includes("spark1 85°C"))).toBe(true);
  expect(h.status.at(-1)).toBeUndefined();
});

test("non-gated provider is never held", async () => {
  temps = { spark1: 95 };
  const h = load({ SPARKDASH_URL: url, SPARKDASH_TOKEN: TOKEN, OMP_THERMAL_GATE_CACHE_MS: "0" });
  const t0 = Date.now();
  await h.run("anthropic");
  expect(Date.now() - t0).toBeLessThan(500);
});

test("max wait: proceeds (or aborts) when it never cools", async () => {
  temps = { spark1: 95 };
  const h = load({ SPARKDASH_URL: url, SPARKDASH_TOKEN: TOKEN, OMP_THERMAL_GATE_POLL_MS: "1000", OMP_THERMAL_GATE_MAX_WAIT_MS: "2000", OMP_THERMAL_GATE_ON_TIMEOUT: "abort", OMP_THERMAL_GATE_CACHE_MS: "0" });
  await h.run();
  expect(h.aborted()).toBe(true);
  expect(h.notes.some(n => n.includes("aborting"))).toBe(true);
}, 10_000);
