# Seed architecture

Seed is a local-first generative TTRPG engine designed for experiments with proactive NPCs,
information boundaries, deterministic mechanics, and inspectable agent behavior.

## Design principles

1. **Content is data.** Worlds, campaigns, characters, scenes, quests, and events are validated
   JSON. Setting-specific facts do not belong in engine code.
2. **Mechanics are deterministic.** Models choose or narrate intent; rules compute checks, costs,
   combat, movement, inventory, and state transitions.
3. **The reducer is the writer.** Engine modules enqueue typed commands. The reducer validates each
   command, updates the world model, and emits replayable deltas.
4. **Autonomy is bounded.** Player actions outrank reactive and spontaneous NPC turns. Heartbeats,
   locks, cooldowns, grounding, and legality checks prevent autonomous actors from bypassing state.
5. **Knowledge is scoped.** Narrator and NPC packets are built from authoritative state, public and
   secret lore, disclosures, memories, and current presence.
6. **Behavior is inspectable.** LLM calls, turn plans, accepted beats, deltas, and outcomes are
   persisted for debugging and evaluation.
7. **Model access is pluggable.** OpenAI-compatible narrator, creative, utility, and embedding roles
   may point at different local or hosted endpoints.

## Request flow

```text
player text
   |
   v
TurnClassifier -> validated TurnPlan
   |
   v
GameEngine tick
   perceive -> resolve -> react -> narrate -> commit -> persist
                  |                       |
                  | commands              | model prose
                  v                       v
             deterministic rules     guarded narration
                  |                       |
                  +----------+------------+
                             v
                         event stream
                             |
                             v
                         CLI client
```

The same tick can include a player resolution and at most the bounded NPC activity allowed by the
Director. Commands do not mutate state when created; they become authoritative only during commit.

## Major layers

### Content — `src/content`

`schema.ts` is the runtime contract for worlds, campaigns, characters, events, NPC templates,
regions, items, quests, and authored mechanics. `loader.ts` validates a directory and returns a
`PlaySet`. Character rebinding and generic defeat tables also live here.

### Engine — `src/engine`

- `engine.ts` orchestrates startup, input submission, ticks, persistence, and event publication.
- `classify.ts` asks the utility role for a closed `TurnPlan` and applies validation/narrowing.
- `turn-plan.ts` owns the plan schema.
- `tick.ts` defines phase ordering and module context.
- `resolvers/` turns grounded plans into deterministic commands and narrative briefs.
- `grounded.ts` carries client-neutral grounded-action types shared by callers and the engine.

### Modules — `src/modules`

Modules participate in declared tick phases and communicate through the command queue. Current
modules cover autonomy, dialogue, narration, combat, scenes, events, travel, camp and room events,
NPC routines and memories, cases, captivity, errands, quest deadlines, status effects, upkeep, and
relationship decay.

### Rules — `src/rules`

Pure or nearly pure rules own dice, checks, combat math, social asks, party decisions, movement,
economy, items, magic, progression, captivity, consequences, continuity checks, regions, routines,
memory salience, visible state, and text matching. The bundled SRD data lives in `src/rules/srd`.

### World model — `src/world`

`WorldModel` is the in-memory source of truth. It contains the entity registry, locations, exits,
relationships, quest state, module slices, and clocks. `commands.ts` defines accepted writes;
`reducer.ts` applies them and emits deltas. `replay.ts` and the test suite enforce the invariant that
folding emitted deltas reconstructs the committed state.

Map, pathfinding, coordinate, region, enrichment, expansion, lodging, captivity, maintenance, and
query helpers live beside the model.

### State and events — `src/state`, `src/events`

`GameState` is the durable/public projection. SQLite is the default store and retains snapshots,
event logs, model calls, and turn traces. Typed game events feed the CLI and observability tools;
typed deltas form the replay record.

### Agents and knowledge — `src/agents`, `src/knowledge`, `src/memory`

The DM agent builds the narration brief and voices public prose. Significant NPCs receive scoped
packets containing persona, goals, allowed knowledge, relevant memories, present state, and recent
conversation. Their output is structured intent that must ground to a legal command or fall back to
speech/no-op.

Lore retrieval, disclosure ledgers, NPC history, summaries, and vector caching supply bounded
context without granting actors omniscience.

### LLM gateway — `src/llm`

All model access uses a single role-aware gateway interface. The OpenAI-compatible provider handles
chat completions, streaming, and embeddings. Logging, rescue/retry, refusal detection, normalization,
and the retained minor-safety guard are composed around the provider rather than embedded in game
rules.

### Clients and tooling — `src/cli`, `src/viewer`, `src/logging`

The CLI is the play surface. The Observatory is a separate read-only local server over the session
database. Logging code records requests, responses, latency, token usage, provider finish reasons,
turn correlation, and exportable traces.

## State transition contract

```text
intent -> resolver/module -> Command[] -> applyCommand -> Delta[] -> events/projection/store
```

- Resolvers and modules may read current and queued state.
- Only commands authorize mutation.
- Deltas describe what actually committed.
- Narration is checked against authorized commands and authoritative state.
- Persistence happens after commit, so a saved snapshot and its log head agree.

## NPC autonomy

The Director uses priority `player > reactive NPC > spontaneous NPC`, plus heartbeat timing,
reply-depth decay, per-actor locks, and scene ownership. NPC model output includes candidates and a
closed intended action. Grounding then checks targets, presence, paths, costs, legality, and command
shape before the reducer sees anything.

See [PROACTIVE-NPCS.md](PROACTIVE-NPCS.md) for the detailed arbitration model.

## Safety boundary

The public research tree retains the model-independent minor-safety guard. It evaluates player input
and player-visible generated prose, uses declared ages when available, and fails closed for ambiguous
minor-sexual output when its judge is required but unavailable. It is not a substitute for operator
policy, legal review, or model-side safeguards.

## Directory map

```text
src/
  agents/       DM, NPC, continuity-judge, and context construction
  cli/          terminal client
  config/       environment parsing and gateway composition
  content/      schemas, loaders, character binding, authored tables
  director/     arbitration and heartbeat primitives
  engine/       orchestrator, classifier, tick, resolvers, grounded protocol
  events/       public events, deltas, and bus
  knowledge/    scoped fact packets and temporal rendering
  llm/          gateway, provider, guard, rescue, normalization
  logging/      model-call and turn-trace capture/export
  memory/       disclosures, summaries, NPC history, vector retrieval/cache
  modules/      phase participants
  rules/        deterministic mechanics
  safety/       canonical minor predicates
  state/        projections and persistence
  viewer/       read-only Observatory
  world/        model, commands, reducer, replay, map, queries
  worldsmith/   seeded content reconciliation utilities
```
