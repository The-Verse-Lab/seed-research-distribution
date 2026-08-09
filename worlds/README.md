# Worlds

This is where worlds and campaigns live — as **data**, not code. The engine is generic;
everything that makes a setting specific is authored here. This directory *is* the
"campaign infrastructure."

## Layout

Each play set is a directory with two standard files and may add a validated research overlay:

```
worlds/
└── <your-world>/
    ├── world.json       # the reusable setting
    ├── campaign.json    # a campaign played on top of that world
    └── research.json    # optional controlled-scenario manifest
```

A `world.json` may back several campaigns — copy a `campaign.json` pattern to start a new
story in the same setting.

## The contract

The shapes are defined and validated in
[`src/content/schema.ts`](../src/content/schema.ts). On load
([`src/content/loader.ts`](../src/content/loader.ts)) Seed:

1. Validates each file against its Zod schema (types + ranges).
2. Cross-checks references (the campaign's start location exists, companions are real
   NPCs, scenes point at real locations). Authoring mistakes fail loudly here.
3. When requested through `src/research/scenario.ts`, validates the optional research manifest
   against the ordinary playset before returning any scenario clone.

## Authoring your own world

1. Copy `wakeward-isles/` (or a test fixture under `tests/fixtures/worlds/`) to
   `worlds/<your-world>/`.
2. Rewrite `world.json` — `id`, `name`, `summary`, then fill `locations`, `npcs`,
   `monsters`, `items`, `spells`, `lore`, `factions`.
3. Rewrite `campaign.json` — point `worldId` at your world, define `characters`,
   `scenes`, `quests`, and the `startingState`.
4. Point the CLI at it: `bun src/cli/main.ts worlds/<your-world>` (path arg), or
   `SEED_WORLD_DIR=worlds/<your-world> bun run dev`. No path/env ⇒ the flagship
   `worlds/wakeward-isles`.

### Making an NPC proactive

The headline feature lives in each NPC's `autonomy` block:

```jsonc
"autonomy": {
  "isPartyMember": true,   // travels with the party → eligible for autonomous turns
  "level": "leader",       // passive | reactive | proactive | leader
  "canLead": true,         // leader proposals may act on tacit consent
  "heartbeatSeconds": 40,  // how often a quiet NPC reconsiders acting
  "replyDecayAlpha": 0.2   // how fast NPC-to-NPC chatter tapers
}
```

See [docs/PROACTIVE-NPCS.md](../docs/PROACTIVE-NPCS.md) for what each setting does.

> The test worlds under `tests/fixtures/worlds/` (Thistledown Vale, Black Concord, and
> the Emberford `example/`) exercise the schema and aren't shipped campaigns. Build your
> own world alongside `wakeward-isles/`; you never have to touch the engine.
