# Example world — "Emberford"

A **throwaway** play set whose only job is to exercise the content schema end to end, so
the scaffold has something real to load. It is not the world you'll play; authored playsets
are documented in the [worlds guide](../../../../worlds/README.md).

What it demonstrates:

- A `World` with locations, NPCs, a monster, an item, a spell, lore, and a faction.
- A `Campaign` (`First Embers`) with a player character, an opening scene, and a quest.
- **A proactive leader NPC** — *Lyra Vane* has `autonomy.level: "leader"` and
  `canLead: true`, the configuration the Director (M2) will use to let her drive the
  party. Running `bun run dev` prints her autonomy level to prove the wiring.

Delete it whenever your own world is ready.
