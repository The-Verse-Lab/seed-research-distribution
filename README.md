# Seed

Seed is a self-hostable generative TTRPG engine for research on proactive, agentic NPCs.
It combines deterministic mechanics with model-authored narration, local persistence, and
inspectable per-turn traces.

## Current surface

- **CLI play:** free-text actions are classified into typed plans and resolved by deterministic
  rules before narration.
- **Bounded NPC autonomy:** companions can react, act, join, leave, betray, and lead without
  bypassing arbitration or reducer checks.
- **Data-authored campaigns:** worlds and campaigns are validated JSON rather than engine code.
- **Replayable state:** commands produce typed deltas, SQLite snapshots, event logs, and turn traces.
- **Grounded narration:** context packets, continuity checks, and knowledge boundaries constrain
  model prose to authoritative state.
- **Minor-safety guard:** player-visible generation passes through the retained non-bypassable
  guard in `src/llm`.

The browser play client and image-generation stack are intentionally absent from this research
tree. The read-only Observatory remains available for inspecting sessions.

## Quickstart

Requires [Bun](https://bun.sh) 1.3 or newer and reachable OpenAI-compatible narrator, utility,
and embedding endpoints.

```sh
bun run setup
cp .env.example .env
bun run check
bun run dev worlds/wakeward-isles
```

Use `/help` in the CLI for commands. Address an NPC by name to speak with them.

Inspect the session database with:

```sh
bun run viewer
```

The Observatory listens on `http://localhost:4505` by default and exposes transcripts, model calls,
state, and per-turn traces.

## Repository status

This clean-history distribution is the public research surface of Seed. **The Wakeward Isles** is
the only bundled playset and the CLI default. Its optional, validated `research.json` defines
controlled companion-information, action, and no-op scenarios without changing the standard
campaign loader. The general counterfactual sweep and signal-detection analysis remain future work;
see [RESEARCH.md](RESEARCH.md) for the exact implementation boundary.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Proactive NPCs](docs/PROACTIVE-NPCS.md)
- [Observability](docs/OBSERVABILITY.md)
- [Playtesting](docs/PLAYTESTING.md)
- [Prose-to-code invariants](docs/PROSE-TO-CODE.md)
- [The Wakeward Isles](worlds/wakeward-isles/README.md)

## Project layout

```text
src/            engine, rules, agents, modules, state, memory, and CLI
tests/          deterministic unit, integration, replay, and firewall coverage
worlds/         authored world/campaign data
playtest/       CLI scripts and live-run tooling
docs/           architecture, operations, and research notes
```

Seed is licensed under Apache-2.0; bundled SRD material carries its own notices beside the data.
