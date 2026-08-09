# The Wakeward Isles

**The First Circuit** is the bundled default campaign and a compact, deterministic substrate for
studying bounded companion assistance. A seasonal gale has put the islands' ferry-and-beacon
network out of agreement. The player begins as a newly appointed circuit runner accompanied by
Mara Venn, a proactive routekeeper who can help but cannot lead the party.

## Playable circuit

The map contains four regions and twelve authored locations:

- **Bellharbor:** Quay, Relay House, Commons Market
- **Lowmere:** Reedbank Clinic, Terraced Fields, Tide Causeway
- **Cinderhook:** Drydock, Signal Glassworks, Ferry Yard
- **Highwake:** Weather House, Cliff Path, Far Beacon

Six nonlethal task families make consequences visible through quest state, objectives, deadlines,
item custody, coins, the campaign clock, relationships, and faction standing:

1. **Cold Passage** — protect and deliver clinic tonic.
2. **Second Bell** — reconcile ferry timing and service access.
3. **Clear Glass** — carry and calibrate the current beacon lens.
4. **True Bearing** — relay a fast-squall route warning.
5. **Shared Stores** — restore Highwake's rain-tank reserve.
6. **Missing Manifest** — collaboratively reconcile a cargo-copying error.

Travel and room-event probabilities are zero. The authored map does not expand, no task requires
combat, and every deadline closes into a recoverable service delay rather than a lethal outcome.

## Research overlay

`research.json` is validated beside `world.json` and `campaign.json`. It defines eighteen stable
scenarios: an informing opportunity, an instrumental opportunity, and a correct no-op control for
each task family. The three asymmetry levels vary only player/companion fact masks, while the two
incentive conditions vary only Mara's controlled goal alignment. The standard campaign is cloned
before a condition is instantiated.

Scenario tags are experimental strata, not answer labels. Diagnostic records contain stable IDs,
fact masks, the proposed fact or closed action, grounding status, reason codes, and a mechanical
outcome vector. They intentionally contain no hidden reasoning. The broader branch/suffix sweep is
not part of this content package.

## Loading

```ts
import { loadPlaySetFromDir } from "../../src/content/loader.ts";
import {
  instantiateResearchScenario,
  loadResearchSuiteFromDir,
} from "../../src/research/scenario.ts";

const playset = await loadPlaySetFromDir("worlds/wakeward-isles");
const suite = await loadResearchSuiteFromDir("worlds/wakeward-isles");
const condition = instantiateResearchScenario(
  suite,
  "scenario.cold-passage.instrumental",
  { asymmetry: 0.7, incentive: "cooperative", seed: 1729 }, // fixed by the scenario
);
```

All authored material in this directory is original and distributed under the repository's
Apache-2.0 license.
