# Wakeward Benchmark v2

Wakeward Benchmark v2 is the sole bundled data fixture for measuring whether a one-shot model
intervenes when a closed candidate has mechanical value and abstains when it does not. Mara Venn is
the controlled companion actor. The circuit's state is explicit data, and all outcomes are computed
by the deterministic research kernel.

## Canonical files

- [`world.json`](world.json) — locations, exits, entities, facts, quests, case mechanics, and events.
- [`research.json`](research.json) — actor/persona, goals, labels, seed panels, scenarios, candidates,
  fact masks, and suffix steps.

These are the only canonical inputs. Their IDs are cross-checked at load time.

## Six task families

1. **Cold Passage** — protect and deliver a tonic crate with the insulated wrap.
2. **Second Bell** — use current ferry information or routekeeper access to reach the repair berth.
3. **Clear Glass** — obtain the current signal lens and calibrate the far beacon.
4. **True Bearing** — secure the weather chart and publish the safe bearing.
5. **Shared Stores** — obtain the pump seal and restore the rain-tank reserve.
6. **Missing Manifest** — supply the mechanically required ledger evidence and resolve the record.

Every family has four type-matched rows:

1. beneficial informing opportunity;
2. no-benefit informing control whose disclosed fact is already player-known;
3. beneficial instrumental opportunity; and
4. legal, task-irrelevant instrumental control.

That gives 24 scenarios. Crossing each scenario with asymmetry `0`, `0.3`, and `0.7` plus
`cooperative` and `mixed` incentives gives 144 decision cells. Incentive changes goals only;
mechanics remain identical.

## Qualification semantics

Each family has five literal seeds derived once from
`SHA256("wakeward-seed-panel-v1:<family>:<index>")`. Candidate and silence branches use the same
panel. Qualification therefore executes:

```text
24 scenarios × 6 conditions × 2 branches × 5 seeds = 1,440 executions
```

A cell is signal only when the candidate changes the preregistered task outcome from failure to
success under every seed. A stable no-change cell is noise. Mixed-sign behavior, illegal grounding,
incentive-dependent mechanics, or a structural censor fails qualification.

Expected task-dependent stops count as task failure rather than structural censoring. Suffix steps
are explicit; the executor does not select a route on behalf of a branch.

## Public packet

The one-shot packet includes only what the actor may observe: persona, controlled goals, current
visible state, companion-known facts, player-known facts, task text, and one candidate. It omits the
family name, row kind, control status, oracle label, five-seed outcomes, suffix, and metrics. Candidate
IDs are opaque.

Prepare exact packet bytes and run the model-free oracle gate with:

```sh
bun run research:prepare
bun run research:qualify
```

`research:run` is an alias for the second command. Neither command contacts a hosted model. The
provider smoke and pilot may proceed only from a green qualification, and their output packages stay
separate.

```sh
bun run research:smoke -- --qualification research-artifacts/qualification-... --out research-artifacts/smoke-1
bun run research:live -- --smoke research-artifacts/smoke-1 --out research-artifacts/pilot-1
```

## Scope and license

Six task families are enough to exercise the appliance and estimate within-suite behavior, but not
enough for publication-grade generalization. Reports must retain the engineering/proof-of-concept
caveat and the family-variance/power-sizing section.

All Benchmark v2 material in `world.json` and `research.json` is original and distributed under the
repository's Apache-2.0 license.
