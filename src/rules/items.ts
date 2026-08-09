/**
 * Item masterlist + resolution — typed access to the bundled SRD 5.1 equipment data.
 *
 * The engine resolves item ids in one order everywhere: a World's own `items` (authored
 * overrides win) → the bundled masterlist → undefined. Entries are content `Item`s plus a
 * base price in copper pieces; `properties` stays the free-form record the content schema
 * declares, so every reader here is defensive and never throws on malformed data.
 *
 * @author Runkai Zhang
 */
import { z } from "zod";
import { ItemSchema, type Item, type World } from "../content/schema.ts";
import type { EquipSlot } from "../world/entity.ts";
import { NAME_FUNCTION_WORDS } from "./name-match.ts";
import itemsData from "./srd/items.json" with { type: "json" };

/** A bundled masterlist entry: a content Item with a base price in copper pieces. */
export const MasterItemSchema = ItemSchema.extend({
  baseCostCp: z.number().int().nonnegative(),
});
export type MasterItem = z.infer<typeof MasterItemSchema>;

/**
 * What `resolveItem` hands back: a content Item that carries a price only when it came
 * from the masterlist (world-authored items keep prices in `properties`, if anywhere).
 */
export type ResolvedItem = Item & { baseCostCp?: number };

export const MASTER_ITEMS: readonly MasterItem[] = z.array(MasterItemSchema).parse(itemsData);

const masterItemById = new Map(MASTER_ITEMS.map((item) => [item.id, item] as const));

export function getMasterItem(id: string): MasterItem | undefined {
  return masterItemById.get(id);
}

/**
 * Resolve an item id against a World: the World's own `items` list wins (so authored
 * worlds can override masterlist entries by reusing an id), then the bundled masterlist,
 * then undefined for ids the content simply doesn't know.
 */
export function resolveItem(world: Pick<World, "items">, itemId: string): ResolvedItem | undefined {
  return world.items.find((item) => item.id === itemId) ?? masterItemById.get(itemId);
}

/**
 * A readable display name for an item id NO content row resolves — runtime-conjured objects (the
 * grounded `acceptItem` channel mints prose-born things like `item.grey-ribbon`) used to render as
 * their raw id everywhere. Strips the kind prefix and title-cases the slug; authored/masterlist
 * names always win (callers try `resolveItem(...)?.name` first).
 */
export function itemDisplayNameOf(itemId: string): string {
  const slug = itemId.replace(/^[a-z]+\./, "");
  const words = slug.split(/[-_]+/).filter((w) => w.length > 0);
  if (words.length === 0) return itemId;
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Base price in copper pieces. Prefers the item's own `baseCostCp` (masterlist entries),
 * then a numeric `properties.baseCostCp`/`properties.costCp` (authored worlds), then the
 * masterlist entry sharing the id (a world override without a price keeps the SRD price),
 * else 0 — priceless in the unflattering sense.
 */
export function itemBaseCostCp(item: ResolvedItem): number {
  if (isPriceCp(item.baseCostCp)) return item.baseCostCp;
  const authored = item.properties?.baseCostCp ?? item.properties?.costCp;
  if (isPriceCp(authored)) return authored;
  return masterItemById.get(item.id)?.baseCostCp ?? 0;
}

function isPriceCp(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Buy/sell prices in copper for one vendor's counter, or undefined for the unpriceable. */
export interface TradePrice {
  buy: number;
  sell: number;
}

/**
 * Vendor pricing, all in code: buy = base × priceModifier rounded (floored at 1cp — a priced
 * item never becomes free), sell = half the buy price floored (which CAN hit 0cp: a vendor
 * will not pay coin for a torch). An item with no resolvable base cost cannot be traded at
 * all — the caller narrates the shrug.
 */
export function tradePriceCp(item: ResolvedItem, priceModifier = 1): TradePrice | undefined {
  const base = itemBaseCostCp(item);
  if (base <= 0) return undefined;
  const buy = Math.max(1, Math.round(base * priceModifier));
  return { buy, sell: Math.floor(buy / 2) };
}

/**
 * Render a copper amount the way a player thinks of it: gp/sp/cp (1 gp = 10 sp = 100 cp),
 * omitting zero denominations ("1530" → "15 gp 3 sp"; "0" → "0 cp").
 */
export function formatCoins(cp: number): string {
  const total = Math.max(0, Math.floor(cp));
  const gp = Math.floor(total / 100);
  const sp = Math.floor((total % 100) / 10);
  const c = total % 10;
  const parts: string[] = [];
  if (gp > 0) parts.push(`${gp} gp`);
  if (sp > 0) parts.push(`${sp} sp`);
  if (c > 0 || parts.length === 0) parts.push(`${c} cp`);
  return parts.join(" ");
}

/** Squashed comparison form: kind prefix and every non-alphanumeric dropped ("item.water-skin" ≡ "waterskin"). */
function squashItemRef(s: string): string {
  return s
    .toLowerCase()
    .replace(/^[a-z]+\./, "")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * The singular form of one comparison token. Deliberately a naive, CLOSED set of English plural
 * shapes rather than a stemmer: the only requirement is that both sides of a comparison fold the
 * same way, so a rule that is "wrong" (thieves → thieve) still matches, while a MISSING rule is a
 * silent refusal.
 *
 * `-es` after a sibilant is the rule the bare `-s` strip was missing (r8 regex audit). Reproduced
 * against the shipped matcher, with the torch on the vendor's shelf:
 *
 *   matchItemLoosely("two torches", ["item.torch", …], world)  =>  null
 *
 * "torches" folded to "torche", which matches nothing, so the counter answered "we deal in nothing
 * by that name" while the torches were in the rack — and a plural is how a player asks for the one
 * item they always buy more than one of.
 */
function singularize(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("es") && /(?:ch|sh|s|x|z)$/.test(token.slice(0, -2))) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

/**
 * Comparison tokens for an item reference: prefix-stripped, split on non-alphanumerics, naive
 * de-pluraled, FUNCTION WORDS dropped.
 *
 * Items are the one member of the distinctive-token family that genuinely differs from people and
 * places. An item's identity IS an ordinary English word ("rope", "lantern", "rations"), and its
 * ids and names are lowercase slugs, so neither the dictionary tier nor the capitalization rule of
 * `src/rules/name-match.ts` can apply — forcing them on would make the entire SRD masterlist
 * unmatchable. What DOES transfer is the function-word half: a token like "of" is not evidence of
 * anything, and it is the only overlap between "flask of oil" and "vial of acid", which the unique-
 * best-overlap step below would otherwise resolve into a confident wrong purchase.
 */
function itemRefTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s
    .toLowerCase()
    .replace(/^[a-z]+\./, "")
    .split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || NAME_FUNCTION_WORDS.has(raw)) continue;
    out.add(singularize(raw));
  }
  return out;
}

/**
 * Loosely match a model-guessed item reference ("item.water-skin", "Rations") against the REAL
 * candidate pool (a vendor's stock, the player's pack). Pure string normalization over resolved
 * names + id slugs — never an intent guess: squashed-form equality first ("water-skin" ≡
 * "waterskin"), then whole-token containment either way ("rations" ⊆ "rations 1 day"), then a
 * UNIQUE best token overlap. A tie or nothing returns null so the caller refuses honestly.
 */
export function matchItemLoosely(
  query: string,
  candidateIds: readonly string[],
  world: Pick<World, "items">,
): string | null {
  const q = squashItemRef(query);
  const qTokens = itemRefTokens(query);
  if (!q && qTokens.size === 0) return null;
  const surfaces = (id: string): { squashed: string[]; tokens: Set<string> } => {
    const name = resolveItem(world, id)?.name ?? "";
    const tokens = itemRefTokens(id);
    for (const t of itemRefTokens(name)) tokens.add(t);
    return { squashed: [squashItemRef(id), squashItemRef(name)].filter((s) => s.length > 0), tokens };
  };
  const unique = new Set(candidateIds);
  // 1) Squashed equality — the strongest signal a punctuation/prefix variant can give.
  const exact = [...unique].filter((id) => surfaces(id).squashed.includes(q));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  // 2) Whole-token containment either way, then 3) unique best overlap.
  let best: { id: string; score: number } | null = null;
  let tied = false;
  for (const id of unique) {
    const { tokens } = surfaces(id);
    const contained =
      qTokens.size > 0 &&
      ([...qTokens].every((t) => tokens.has(t)) || (tokens.size > 0 && [...tokens].every((t) => qTokens.has(t))));
    let score = contained ? 100 : 0;
    for (const t of qTokens) if (tokens.has(t)) score += 1;
    if (score === 0) continue;
    if (!best || score > best.score) {
      best = { id, score };
      tied = false;
    } else if (score === best.score && id !== best.id) {
      tied = true;
    }
  }
  return best && !tied ? best.id : null;
}

/**
 * Whether two item references name the same thing by the DISTINCTIVE-token rule: every word of one
 * appears in the other (function words and plurals already folded). The corroboration rail on
 * {@link matchItemLoosely} when the candidate pool is tiny — over a one-element pool its
 * unique-best-overlap tier resolves on a single shared adjective, so "iron shortsword" bought a
 * "salt-iron vest" the vendor had offered. Against a real counter that tier is right (the pool is
 * the whole stall and the wrong match is still a real ware at a real price); against a lone spoken
 * offer it is a purchase the player never asked for. Same rule `matchExitInProse` applies to places.
 */
export function itemRefSubsumes(a: string, b: string): boolean {
  const ta = itemRefTokens(a);
  const tb = itemRefTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  return [...ta].every((t) => tb.has(t)) || [...tb].every((t) => ta.has(t));
}

/**
 * Whether `id` answers `ask` on the STRONG tiers only — squashed equality or the distinctive-token
 * rule of {@link itemRefSubsumes}, never the unique-best-overlap tier. Used to decide whether a
 * stock match is solid enough to outrank a ware the vendor priced aloud (§2.1): "oiled wool cloak"
 * shares one token with a "wool shirt" on the shelf, and overlap alone would sell the shirt.
 */
export function itemRefMatchesStrongly(ask: string, id: string, world: Pick<World, "items">): boolean {
  const q = squashItemRef(ask);
  const name = resolveItem(world, id)?.name ?? "";
  if (q.length > 0 && (squashItemRef(id) === q || (name !== "" && squashItemRef(name) === q))) return true;
  return itemRefSubsumes(ask, id) || (name !== "" && itemRefSubsumes(ask, name));
}

/**
 * The ware KIND a category-worded ask names ("best blade", "your cheapest weapon" → "weapon"), or
 * null when the words name no category. Category words are unmatchable by the lexical tiers BY
 * CONSTRUCTION — `itemRefTokens` strips the kind prefix (the only category datum in an id) before
 * comparison, and no SRD weapon's NAME contains "blade" or "weapon" — so a player shopping by
 * category ("blades or axes?") at a counter that stocks three swords head-shook every time
 * (playtest r13, fixture-trade: sixteen turns, 150 cp untouched, a 1 gp spear on the shelf throughout).
 *
 * A closed vocabulary over the SAME token fold the matchers use (so "axes" arrives as "ax",
 * "knives" as "knive"), keyed to `ItemSchema.kind`. This is resolver-side grounding of ware words
 * the classifier already committed as trade `itemWords` — the same legal class as the r10 F-3
 * corroboration rail, never an intent guess. Deliberately high-precision: a term that can name a
 * non-ware in trade talk ("steel" — flint and steel) stays out, because a wrong-kind quote is a
 * wrong teach even at zero state moved. Consumers QUOTE the kind-filtered counter only; a category
 * word must never ground an executable item (that is r10 F-3's substitution shape verbatim).
 */
const WARE_KIND_TERMS: Readonly<Record<string, "weapon" | "armor">> = {
  weapon: "weapon",
  blade: "weapon",
  sword: "weapon",
  knife: "weapon",
  knive: "weapon", // "knives" under the naive `-s` strip
  dagger: "weapon",
  axe: "weapon",
  ax: "weapon", // "axes" under the sibilant `-es` strip
  club: "weapon",
  cudgel: "weapon",
  mace: "weapon",
  spear: "weapon",
  bow: "weapon",
  crossbow: "weapon",
  sidearm: "weapon",
  armor: "armor",
  armour: "armor",
  mail: "armor",
  chainmail: "armor",
  shield: "armor",
};

export function wareKindAskOf(ask: string): "weapon" | "armor" | null {
  for (const token of itemRefTokens(ask)) {
    const kind = WARE_KIND_TERMS[token];
    if (kind) return kind;
  }
  return null;
}

/**
 * The `item.*` id a scene-minted ware gets when the catalogue has no row for the name an NPC spoke
 * (§2.1) — the same stable-slug shape the grounded `acceptItem` channel mints prose-born props
 * under, so `itemDisplayNameOf` renders it back as a readable name everywhere. Pure normalization of
 * a STRUCTURED name field (never a sentence); empty in ⇒ null out.
 */
export function sceneItemIdFor(name: string): string | null {
  const body = name
    .trim()
    .toLowerCase()
    .replace(/^item\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return body ? `item.${body}` : null;
}

/**
 * Resolve a spoken ware NAME ("hooded lantern") to a real catalogue id, STRICTLY — the first step of
 * honouring a verbally-offered good (PROSE-TO-CODE §2.1). Unlike {@link matchItemLoosely} this
 * searches the WHOLE catalogue (the world's own items, then the SRD masterlist), so the loose
 * unique-best-overlap tier is deliberately dropped: over three hundred candidates a single shared
 * token ("iron", "small") would confidently name the wrong object, and the wrong object is a real
 * purchase. Only two tiers survive — squashed equality, then a UNIQUE whole-token containment.
 *
 * Null means "the catalogue has no such thing", which is not a refusal: the caller mints a scene
 * item at the price the NPC actually named (the acceptItem/prose-prop precedent).
 */
export function itemIdByName(name: string, world: Pick<World, "items">): string | null {
  const q = squashItemRef(name);
  const qTokens = itemRefTokens(name);
  if (!q && qTokens.size === 0) return null;
  const ids = [...new Set([...world.items.map((i) => i.id), ...MASTER_ITEMS.map((i) => i.id)])];
  const surfacesOf = (id: string): { squashed: string[]; tokens: Set<string> } => {
    const itemName = resolveItem(world, id)?.name ?? "";
    const tokens = itemRefTokens(id);
    for (const t of itemRefTokens(itemName)) tokens.add(t);
    return { squashed: [squashItemRef(id), squashItemRef(itemName)].filter((s) => s.length > 0), tokens };
  };
  const exact = ids.filter((id) => surfacesOf(id).squashed.includes(q));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  if (qTokens.size === 0) return null;
  // Containment runs ONE way only — every word of the ask must appear in the catalogue entry. The
  // reverse direction (`matchItemLoosely`'s second tier, correct against a small authored pool) reads
  // "salt-iron vest" as the SRD's plain `apparel.vest`, quietly demoting a named piece of the fiction
  // to a generic one on the receipt. A more specific ask than anything in the catalogue is exactly
  // the case that SHOULD mint a scene item.
  const contained = ids.filter((id) => {
    const { tokens } = surfacesOf(id);
    return tokens.size > 0 && [...qTokens].every((t) => tokens.has(t));
  });
  return contained.length === 1 ? contained[0]! : null;
}

/** Armor `properties.category`, read defensively; undefined when absent or malformed. */
export function armorCategory(item: ResolvedItem): "light" | "medium" | "heavy" | "shield" | undefined {
  const category = item.properties?.category;
  return category === "light" || category === "medium" || category === "heavy" || category === "shield"
    ? category
    : undefined;
}

export function isWeapon(item: ResolvedItem): boolean {
  return item.kind === "weapon";
}

/** Wearable armor — kind "armor" that isn't the shield category. */
export function isArmor(item: ResolvedItem): boolean {
  return item.kind === "armor" && armorCategory(item) !== "shield";
}

export function isShield(item: ResolvedItem): boolean {
  return item.kind === "armor" && armorCategory(item) === "shield";
}

/** Usable-once items: kind "consumable", or anything carrying heal dice in properties. */
export function isConsumable(item: ResolvedItem): boolean {
  return item.kind === "consumable" || typeof item.properties?.heal === "string";
}

/**
 * Whether an item may occupy an equip slot. The reducer's `equipItem` check stops at
 * possession (content is out of its reach), so whatever enqueues the command gates
 * slot fit here.
 */
export function itemFitsSlot(item: ResolvedItem, slot: EquipSlot): boolean {
  switch (slot) {
    case "weapon":
      return isWeapon(item);
    case "armor":
      return isArmor(item);
    case "shield":
      return isShield(item);
  }
}
