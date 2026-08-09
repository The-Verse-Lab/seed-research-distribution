# Seed — contributor guide

Seed is a self-hostable generative TTRPG engine for research on proactive, agentic NPCs. It is
written in TypeScript and runs directly under Bun.

## Commands

```sh
bun run setup
bun run check
bun run dev                         # defaults to worlds/wakeward-isles
bun run dev worlds/<playset>
bun run viewer                      # read-only Observatory
bun run playtest:sweep              # live-model run; spends tokens
bun run playtest:triage
```

Do not run live-model playtests unless the task explicitly authorizes the spend.

## Architecture

- `src/world/` owns the world model, reducer, commands, replay, map, and expansion mechanics.
- `src/engine/` orchestrates classification and the deterministic tick pipeline.
- `src/modules/` contains events, dialogue, combat, autonomy, routines, memory, and projections.
- `src/agents/` builds grounded narrator and NPC packets; models propose and phrase outcomes.
- `src/content/` defines and validates authored `world.json` and `campaign.json` data.
- `src/research/` validates optional controlled-scenario overlays without changing normal playsets.
- `src/logging/` records model calls and inspectable per-turn traces.
- `worlds/wakeward-isles/` is the sole bundled campaign and CLI default.
- `tests/fixtures/worlds/` contains small neutral worlds for engine regression coverage.

Read `docs/ARCHITECTURE.md`, `docs/PROACTIVE-NPCS.md`, and `docs/OBSERVABILITY.md` for detail.

## Hard rules

- Mutable state has one writer: enqueue typed commands and let `src/world/reducer.ts` apply them.
- Mechanics are deterministic code. Models never directly change state or establish world truth.
- Product intent classification is model-based. Regex-like heuristics live only in the test DSL.
- NPC actions use the closed candidate list and exact IDs; illegal or stale acts fall back safely.
- Companion action, consent, coercion, combat, and minor-safety gates remain non-bypassable.
- Structured diagnostics record inputs, candidate IDs, reason codes, grounding, and outcomes. They do
  not record hidden chain-of-thought.
- World-specific behavior belongs in validated data, never an engine branch.
- Preserve user changes and secrets. Credentials stay in ignored `.env` files.
- Attribute repository file headers to Runkai Zhang.
- Keep `bun run typecheck` and `bun test` green. Run `graphify update .` after code changes.

## Content contract

`world.json` and `campaign.json` are the ordinary playable unit. An optional `research.json` is a
read-only overlay loaded through `src/research/scenario.ts`; instantiation clones the standard
playset before applying controlled setup, fact masks, and companion goals.

The bundled research campaign keeps travel and room-event rolls disabled, uses no procedural map
expansion, and requires no combat. New research content must retain those controls unless a task
explicitly changes the contract.

## Verification

For distribution-ready changes run, at minimum:

```sh
bun run check
bun run playtest/scripts/safety-matrix.ts
git diff --check
graphify update .
```

Also parse authored JSON and run documentation-link, orphan, and distribution-firewall checks when
content or packaging changes.
