# omp-thermal-gate

An [omp](https://github.com/can1357/oh-my-pi) extension with two gates for a
shared GPU cluster:

- **Thermal gate**: holds requests to a hot GPU cluster until it cools down.
- **Busy gate**: refuses new subagents on cluster models while
  [Machinist](#busy-gate-machinist) is already running several jobs there.
  Cloud subagents are unaffected.

The thermal gate is built for a cluster of NVIDIA DGX Sparks
monitored by [sparkDash](https://github.com/MiaAI-Lab/sparkDash), but any
sparkDash fleet works.

Before every provider request to a gated provider (default `sparks`), the gate
reads each unit's GPU temperature from sparkDash
(`GET /api/sparks/:id/metrics` → `metrics.gpu.temperature`). If the hottest unit
is **at or above 80 °C**, the request waits and polls until the hottest unit is
**at or below 75 °C**, then goes out. The 5 °C gap is hysteresis so the gate
does not flap at the threshold. While it waits, the omp status line shows
`🌡 spark1 83°C — holding until ≤75°C (40s)`.

It is client-side only. Nothing on the cluster or the inference server changes.

## Install

```sh
git clone https://github.com/danieljohnmorris/omp-thermal-gate
cd omp-thermal-gate
./install.sh        # copies index.ts to ~/.omp/agent/extensions/thermal-gate/
```

omp auto-discovers extensions in `~/.omp/agent/extensions/`. Restart omp after
installing.

## Enable: set the environment

The gate is configured **only through environment variables**. The sparkDash
token is a secret: keep it in your shell environment (or a secrets manager that
exports it). **Never put the token in this repo, in a committed `.env`, or in
omp's config files.** `.env*` is git-ignored here for that reason.

```sh
# e.g. in ~/.zshenv, or exported by your secrets manager
export SPARKDASH_URL="http://spark2.<your-tailnet>.ts.net:5555"
export SPARKDASH_TOKEN="…"      # sparkDash's SPARKDASH_TOKEN, from the host running sparkDash
```

Without `SPARKDASH_URL` the gate stays off. With a wrong or missing token,
sparkDash answers 401 and the gate fails open: requests go through and omp
shows `🌡 gate off: sparkDash 401 (check SPARKDASH_TOKEN)`.

| Variable | Default | Meaning |
|---|---|---|
| `SPARKDASH_URL` | — (required) | sparkDash base URL |
| `SPARKDASH_TOKEN` | — | sparkDash bearer token. Env only. |
| `OMP_THERMAL_GATE_HIGH_C` | `80` | start holding at or above this |
| `OMP_THERMAL_GATE_RESUME_C` | `75` | release at or below this |
| `OMP_THERMAL_GATE_PROVIDERS` | `sparks` | comma list of omp provider names to gate |
| `OMP_THERMAL_GATE_SPARK_IDS` | every unit | comma list of sparkDash unit ids to watch |
| `OMP_THERMAL_GATE_POLL_MS` | `5000` | poll interval while holding |
| `OMP_THERMAL_GATE_MAX_WAIT_MS` | `600000` | longest one request is held (10 min) |
| `OMP_THERMAL_GATE_ON_TIMEOUT` | `proceed` | `proceed` or `abort` when the max wait runs out |
| `OMP_THERMAL_GATE_CACHE_MS` | `3000` | reuse a reading this long when cool |
| `OMP_THERMAL_GATE_DISABLED` | — | `1` turns the gate off |

Everything except `MAX_WAIT_MS` is read on every request, so changes apply
without a restart. `MAX_WAIT_MS` sizes the handler chain at load time.

## How it works

- Hooks omp's `before_provider_request` event, so it runs before **every** model
  call, including each step of a tool loop, not just before each user prompt.
- omp gives each extension handler 30 s. To hold longer, the gate registers a
  chain of handlers that each wait up to 25 s; omp runs them in order for the
  same request. Once the cluster is cool the rest of the chain returns
  immediately. When cool, a request costs one cached sparkDash read.
- Unknown temperatures (sparkDash down, unit offline, failed collection) count
  as cool: the gate never blocks on data it does not have.
- Pressing Esc during a hold does not cut the current 25 s slice short.

## Busy gate (Machinist)

Machinist (OhMyMachinist) runs its own coding jobs on the same Sparks. When it
is busy, omp sessions should not pile more Sparks work on top by fanning out
subagents.

Before omp spawns a subagent (task tool or eval `agent()`), the gate reads
Machinist's status (`GET $MACHINIST_URL/api/v1/status`, read-only, no
credentials) and counts jobs whose `state` is `"running"`. If the count is
**at or above `OMP_BUSY_GATE_MAX_RUNNING` (default 3)** and the subagent's model
is on a gated provider (default `sparks`), the spawn is refused. The task tool
returns the reason to the agent ("Machinist has 4 jobs running (limit 3), so new
subagents on Sparks models are paused…"), so it can do the work itself, use a
cloud model, or retry later. The status line shows `⚙ Machinist has 4 jobs
running (limit 3): no new Sparks subagents`.

- Uses omp's `before_subagent_spawn` hook (omp ≥ 18.8), which can block a spawn
  or replace its model. The first entry of the spawn's model patterns decides
  (`sparks/GLM-5.3-Flash-EXL3-bg:auto` → `sparks`); a spawn with no patterns
  inherits the parent session's model.
- Only **new** subagents are affected. The main session's own requests and
  subagents that are already running carry on (the thermal gate still applies
  to them).
- Single threshold, no hysteresis: each spawn is checked on its own, so there
  is nothing to flap. Readings are cached for 3 s.
- Set `OMP_BUSY_GATE_FALLBACK_MODEL` (e.g. a cloud model) to reroute refused
  spawns to that model instead of refusing them.
- If Machinist cannot be reached the gate fails open: the spawn goes ahead.
- Machinist's own workers run omp with `--no-extensions`, so they never gate
  themselves.

| Variable | Default | Meaning |
|---|---|---|
| `MACHINIST_URL` | `http://100.70.205.115:7331` | Machinist base URL |
| `OMP_BUSY_GATE_MAX_RUNNING` | `3` | refuse gated spawns at or above this many running jobs |
| `OMP_BUSY_GATE_PROVIDERS` | `OMP_THERMAL_GATE_PROVIDERS`, else `sparks` | providers whose subagents are gated |
| `OMP_BUSY_GATE_FALLBACK_MODEL` | — | reroute refused spawns to this model instead of refusing |
| `OMP_BUSY_GATE_CACHE_MS` | `3000` | reuse a Machinist reading this long |
| `OMP_BUSY_GATE_DISABLED` | — | `1` turns the busy gate off |

All are read on every spawn; no restart needed to change them.

## Test

```sh
bun test
```

The tests run against a fake sparkDash and a fake Machinist; no real token is needed.

## License

MIT
