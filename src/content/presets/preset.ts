/**
 * Character preset catalogs - shared shape + resolver.
 *
 * A preset is authored behavioral guidance bundled like the SRD subset. NPCs reference preset ids;
 * prompt wiring resolves them later and folds the guidance into that NPC's own prompt. Presets are
 * character-behavior data only and are independent of the minor-safety guard.
 *
 * @author Runkai Zhang
 */

/** One entry in a preset catalog. `guidance` is the blurb injected into the NPC prompt. */
export interface Preset {
  /** Stable id authors reference, e.g. "ne" (neutral evil) or "trickster". */
  id: string;
  /** Short label for display. */
  label: string;
  /** One-line gloss for catalog/listing surfaces. */
  description: string;
  /** Behavioral guidance folded into the in-character system prompt. */
  guidance: string;
}

/** Ids already warned about, so an unknown id logs once instead of every prompt build. */
const warned = new Set<string>();

/**
 * Resolve a preset id against a catalog. Empty/unset ids return undefined without warning. Non-empty
 * unknown ids warn once and return undefined, matching loader leniency: warn, never throw.
 */
export function resolvePreset(catalog: readonly Preset[], id: string | undefined): Preset | undefined {
  const key = (id ?? "").trim();
  if (!key) return undefined;
  const found = catalog.find((p) => p.id === key);
  if (!found && !warned.has(key)) {
    warned.add(key);
    console.warn(`[presets] unknown preset id "${key}" - ignoring (check the bundled catalog ids).`);
  }
  return found;
}

/** A compact one-line-per-entry listing of a catalog. */
export function listPresets(catalog: readonly Preset[]): string {
  return catalog.map((p) => `${p.id} - ${p.label}: ${p.description}`).join("\n");
}
