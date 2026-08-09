# Thistledown Vale — test world

A cozy-but-uncanny medieval **fantasy-life** setting: magic is the quiet work of daily
craft (hearth-charms, hedge-witchery, ward-signs), technology is low (water-wheels,
lantern-light, little steel), and the uncanny Hollow Folk keep to the Whistling Woods —
held back by the old Warden Stones, one of which has just **cracked**.

It's a **test world** built to exercise the engine, not a finished campaign — rewrite or
extend it freely. It lives under `tests/fixtures/worlds/` and isn't shipped; the CLI
defaults to the flagship `worlds/wakeward-isles`.

## Play it

```sh
bun src/cli/main.ts tests/fixtures/worlds/thistledown          # path arg
SEED_WORLD_DIR=tests/fixtures/worlds/thistledown bun run dev   # …or via env var
```

## What it exercises

- **7 connected locations** (inn → green → forge / mill / ford → woods → barrow) for movement.
- **Two companions from the start** — *Maelle* (a `leader`, for the M2 Director) and *Dorran*
  (`reactive`) — both answer when you address them by name.
- **DM-voiced NPCs** in their locations (Bett the innkeeper, Emrin the smith, Wren the
  miller's daughter, Thistle the fae-touched woods-dweller).
- Monsters, items, spells, lore, and three factions for flavor and context.
- A campaign (**The Souring Ward**) with an opening scene, two active quests, and a hidden
  cozy side-quest (gather woods-honey for Bett).

## Hooks to try

- Talk to your companions: `Lyra…` — er, `Maelle, where do we start?` / `Dorran, what do you smell?`
- Explore: `go to the green`, `head down to the mill`, `cross the ford into the woods`
- Attempt things: `I search the flour sacks`, `I sneak past the mist cat`, `I try to bargain with Thistle`
