import { afterAll, beforeAll, expect, test } from "bun:test";
import ext, { countRunning, providerOf, readBusyConfig, readMachinist, spawnTargetsGated } from "../index";

// A fake Machinist: /api/v1/status with a settable job list.
let states: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let url = "";
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/api/v1/status")
        return Response.json({ jobs: states.map((state, i) => ({ id: i, state })), csrf_token: "ignored" });
      return new Response("nope", { status: 404 });
    },
  });
  url = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));

test("config defaults", () => {
  const c = readBusyConfig({});
  expect(c.url).toBe("http://100.70.205.115:7331");
  expect(c.maxRunning).toBe(3);
  expect(c.providers).toEqual(["sparks"]);
});

test("counting and provider parsing", () => {
  expect(countRunning({ jobs: [{ state: "running" }, { state: "succeeded" }, { state: "running" }] })).toBe(2);
  expect(countRunning({})).toBeUndefined();
  expect(providerOf("sparks/GLM-5.3-Flash-EXL3-bg:auto")).toBe("sparks");
  expect(providerOf("gpt-6")).toBeUndefined();
  const c = { providers: ["sparks"] };
  expect(spawnTargetsGated(["sparks/GLM:auto", "openai/x"], "openai", c)).toBe(true);
  expect(spawnTargetsGated(["openai-codex/gpt-6-astra:high"], "sparks", c)).toBe(false);
  expect(spawnTargetsGated([], "sparks", c)).toBe(true); // inherits parent model
});

test("reads running jobs; unreachable is an error", async () => {
  states = ["running", "running", "succeeded"];
  expect((await readMachinist(readBusyConfig({ MACHINIST_URL: url }))).running).toBe(2);
  expect((await readMachinist(readBusyConfig({ MACHINIST_URL: "http://127.0.0.1:1" }))).error).toContain("unreachable");
});

function load(env: Record<string, string>) {
  for (const k of Object.keys(process.env)) if (k.startsWith("OMP_BUSY_GATE_")) delete process.env[k];
  Object.assign(process.env, env);
  let spawn: ((e: any, ctx: any) => Promise<any>) | undefined;
  ext({ setLabel() {}, on: (ev: string, h: any) => { if (ev === "before_subagent_spawn") spawn = h; } } as any);
  const ctx = { model: { provider: "openai-codex" }, ui: { setStatus() {}, notify() {} } };
  return (patterns: string[]) => spawn!({ type: "before_subagent_spawn", agent: "task", invocationKind: "task", patterns }, ctx);
}

test("blocks Sparks spawns at >= 3 running, allows cloud", async () => {
  const spawn = load({ MACHINIST_URL: url, OMP_BUSY_GATE_CACHE_MS: "0" });
  states = ["running", "running", "succeeded"];
  expect(await spawn(["sparks/GLM:auto"])).toBeUndefined();
  states = ["running", "running", "running"];
  const r = await spawn(["sparks/GLM:auto"]);
  expect(r.block).toBe(true);
  expect(r.reason).toContain("3 jobs running");
  expect(await spawn(["openai-codex/gpt-6-astra:high"])).toBeUndefined();
});

test("fallback model reroutes instead of refusing", async () => {
  const spawn = load({ MACHINIST_URL: url, OMP_BUSY_GATE_CACHE_MS: "0", OMP_BUSY_GATE_FALLBACK_MODEL: "openai-codex/gpt-6-astra" });
  states = ["running", "running", "running", "running"];
  const r = await spawn(["sparks/GLM:auto"]);
  expect(r.block).toBeUndefined();
  expect(r.model).toBe("openai-codex/gpt-6-astra");
});

test("Machinist down fails open", async () => {
  const spawn = load({ MACHINIST_URL: "http://127.0.0.1:1", OMP_BUSY_GATE_CACHE_MS: "0" });
  expect(await spawn(["sparks/GLM:auto"])).toBeUndefined();
});
