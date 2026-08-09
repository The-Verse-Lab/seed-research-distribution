# Bundled SRD data

This directory holds Seed's **5e SRD** reference data, bundled **locally** so the engine
has no runtime dependency on an external rules API — a requirement for true self-hosting.

## Contents & licensing

- `weapons.json`, `conditions.json` — combat profiles and conditions, SRD-derived under
  the **Open Game License v1.0a**; see [OGL.md](OGL.md) for the notice and license text.
- `items.json` — the equipment masterlist (all simple/martial weapons, armors and shield,
  ammunition, core adventuring gear, healing potions) with base prices in copper pieces,
  derived from the **SRD 5.1** under **CC-BY-4.0**; see [CC-BY-4.0.md](CC-BY-4.0.md) for
  the required attribution. Entry descriptions are original project prose.

Required attribution (CC-BY-4.0): This work includes material taken from the System
Reference Document 5.1 (“SRD 5.1”) by Wizards of the Coast LLC and available at
https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed
under the Creative Commons Attribution 4.0 International License available at
https://creativecommons.org/licenses/by/4.0/legalcode.

## Typed access

- `index.ts` — weapon/condition loaders (`getWeapon`, `weaponProfileFromItem`, `UNARMED`).
- `../items.ts` — the item masterlist (`MASTER_ITEMS`, `getMasterItem`) and `resolveItem`,
  which resolves ids as `World.items` (authored overrides win) → masterlist → undefined.

A World's own content overrides entries on top of this SRD baseline by reusing an id.

> Keep attribution and the license notices with any vendored data.
