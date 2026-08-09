/**
 * effectToCommand — the pure Effect→Command mapping shared by the prebaked EventsModule and the
 * TravelEventsModule, so both surfaces expand authored effects identically (one source of truth).
 *
 * `ambush` and `check` remain module-owned because they need travel/camp-specific
 * branching or paired commands. The ordinary item hand-off effects (`giveItem`, `transferItem`) map
 * here so authored prebaked beats can use the same reducer spine as travel/camp events.
 *
 * @author Runkai Zhang
 */
import type { Campaign, Effect, World } from "../../content/schema.ts";
import type { Command } from "../../world/commands.ts";
import { entitiesAt, partyLocationOf, playerEntity, type WorldModel } from "../../world/model.ts";

/** The entity ids of every `spawnEntity` command in a pending queue — the ONE definition of
 *  "born in this tick's batch" (same-tick id dedup here; the commit chokepoint's cull exemption). */
export function queuedSpawnIds(pending: readonly Command[]): Set<string> {
  const ids = new Set<string>();
  for (const c of pending) if (c.type === "spawnEntity") ids.add(c.entity.id);
  return ids;
}

/** The first free deterministic spawn id for a template (`templateId#n`) — collision-free even when
 *  an instance's templateId was retargeted by enrichment or an earlier instance despawned. Pass the
 *  tick's pending command queue so two spawns of one template enqueued in the SAME tick (deferred —
 *  the registry hasn't seen the first yet) can't mint the same id and silently lose the second to
 *  the reducer's duplicate check. */
export function nextSpawnId(model: WorldModel, templateId: string, pending?: readonly Command[]): string {
  const queued = pending ? queuedSpawnIds(pending) : undefined;
  let n = 0;
  while (model.entities.has(`${templateId}#${n}`) || queued?.has(`${templateId}#${n}`)) n++;
  return `${templateId}#${n}`;
}

/** Build the spawnEntity command for a template at a location + tier; authored stats/inventory ride
 *  onto the fresh body. Pass an explicit `id` when the caller needs the id for a paired command
 *  (the exploitation opener), else it is computed here (thread `pending` for same-tick dedup). */
export function buildSpawnCommand(
  world: World,
  model: WorldModel,
  spec: {
    templateId: string;
    locationId: string;
    tier: "transient" | "tracked" | "significant";
    id?: string;
    name?: string;
    hp?: number;
  },
  pending?: readonly Command[],
): Command {
  const tpl = world.npcs.find((n) => n.id === spec.templateId);
  const mon = world.monsters.find((m) => m.id === spec.templateId);
  const stats = tpl?.stats ?? mon?.stats;
  const carried = mon?.inventory ?? tpl?.inventory ?? [];
  const overrideHp = spec.hp ?? stats?.maxHp;
  return {
    type: "spawnEntity",
    entity: {
      id: spec.id ?? nextSpawnId(model, spec.templateId, pending),
      kind: mon ? "monster" : "npc",
      tier: spec.tier,
      name: spec.name ?? tpl?.name ?? mon?.name ?? spec.templateId,
      locationId: spec.locationId,
      templateId: spec.templateId,
      stats: overrideHp != null
        ? {
            currentHp: overrideHp,
            maxHp: overrideHp,
            ...(carried.length > 0 ? { inventory: [...carried] } : {}),
          }
        : undefined,
    },
  };
}

/**
 * Expand one effect into a single reducer command (the only way an effect mutates truth). Returns
 * `null` for `narrate` (collected as prose by the caller) and for the module-owned travel kinds.
 * Exhaustive over the Effect union.
 */
export function effectToCommand(
  eff: Effect,
  world: World,
  model: WorldModel,
  pending?: readonly Command[],
  campaign?: Campaign,
): Command | null {
  switch (eff.kind) {
    case "narrate":
      return null;
    case "setFlag":
      return { type: "setFlag", scope: "world", key: eff.key, value: eff.value ?? true };
    case "setQuestState":
      return { type: "setQuestState", questId: eff.questId, state: eff.state };
    case "setObjectiveDone":
      return { type: "setObjectiveDone", questId: eff.questId, objectiveId: eff.objectiveId, done: eff.done };
    case "adjustRelationship":
      return { type: "adjustRelationship", actorId: eff.actorId, targetId: eff.targetId, by: eff.by };
    case "adjustHp":
      return { type: "adjustHp", entityId: eff.entityId, by: eff.by };
    case "setCondition":
      return { type: "setCondition", entityId: eff.entityId, condition: eff.condition, active: eff.active };
    case "adjustCoins": {
      const target = eff.target ?? playerEntity(model)?.id ?? null;
      return target ? { type: "adjustCoins", entityId: target, by: eff.by } : null;
    }
    case "adjustEnergy": {
      const target = eff.target ?? playerEntity(model)?.id ?? null;
      return target ? { type: "adjustEnergy", entityId: target, by: eff.by } : null;
    }
    case "adjustExhaustion": {
      const target = eff.target ?? playerEntity(model)?.id ?? null;
      return target ? { type: "adjustExhaustion", entityId: target, by: eff.by } : null;
    }
    case "spawn":
      return buildSpawnCommand(
        world,
        model,
        { templateId: eff.templateId, locationId: eff.locationId, tier: eff.tier },
        pending,
      );
    case "giveItem": {
      const target = eff.to ?? playerEntity(model)?.id ?? null;
      return target ? { type: "transferItem", itemId: eff.itemId, from: null, to: target } : null;
    }
    case "transferItem":
      return { type: "transferItem", itemId: eff.itemId, from: eff.from, to: eff.to };
    case "setExitState":
      return { type: "setExitState", locationId: eff.locationId, to: eff.to, state: eff.state };
    case "linkExit": {
      const name = eff.name ?? world.locations.find((l) => l.id === eff.to)?.name ?? eff.to;
      return { type: "linkExit", fromLocationId: eff.fromLocationId, to: eff.to, name };
    }
    case "revealCaseFact": {
      // Resolve the authored fact text + the present witnesses (limited perception): a reveal is
      // on-screen, so the NPCs who learn it are the case participants / party members standing where
      // the player is. No campaign in hand (a caller that owns no cases) ⇒ inert, never a bad command.
      const caseDef = campaign?.cases.find((c) => c.id === eff.caseId);
      if (!caseDef) return null;
      const factText = caseDef.facts.find((f) => f.id === eff.factId)?.text ?? "";
      const partyLoc = partyLocationOf(model);
      const playerId = playerEntity(model)?.id;
      const witnesses = partyLoc
        ? entitiesAt(model, partyLoc)
            .filter((e) => e.kind === "npc" && e.id !== playerId && (e.partyMember || caseDef.npcKnowledge[e.id] !== undefined))
            .map((e) => e.id)
        : [];
      return { type: "revealCaseFact", caseId: eff.caseId, factId: eff.factId, factText, witnesses };
    }
    case "ambush":
    case "check":
      return null; // module-owned travel effects — expanded by TravelEventsModule/CampEventsModule
    case "routineOverride":
      return null; // module-owned: NpcEventsModule folds it into a routines modulePatch
  }
}

/**
 * One authored effect, expanded to EVERY command it implies — the expander every caller should
 * use. `effectToCommand` answers "what one command is this effect?"; this answers "what does the
 * world owe after it fires?", which for a case reveal includes handing over the physical evidence
 * the clue manifest pairs with that fact.
 *
 * The mint is keyed on the CLUE, not the fact: `clue.scene` reveals five facts and hands over two
 * objects, and a per-fact mint would deal the player five of each. It dedupes against BOTH the
 * player's pack and the tick's PENDING queue — sibling reveals in one event are enqueued, not
 * applied, so the model is unchanged across all five expansions (the `queuedSpawnIds` idiom, for
 * the same reason). That also fixes a latent duplicate-on-refire in today's hand-written content.
 */
export function effectToCommands(
  eff: Effect,
  world: World,
  model: WorldModel,
  pending: readonly Command[] = [],
  campaign?: Campaign,
): Command[] {
  const first = effectToCommand(eff, world, model, pending, campaign);
  if (!first) return [];
  if (eff.kind !== "revealCaseFact" || !campaign) return [first];

  const caseDef = campaign.cases.find((c) => c.id === eff.caseId);
  if (!caseDef) return [first];
  const playerId = playerEntity(model)?.id;
  if (!playerId) return [first];
  const held = new Set(model.entities.get(playerId)?.stats?.inventory ?? []);
  const queued = new Set(
    pending.filter((c): c is Extract<Command, { type: "transferItem" }> => c.type === "transferItem").map((c) => c.itemId),
  );

  const out: Command[] = [first];
  for (const clue of caseDef.clues) {
    if (!clue.evidenceItemIds?.length) continue;
    if (!clue.revealsFactIds.includes(eff.factId)) continue;
    // Only the clue's FIRST fact mints, so a five-fact clue hands over its objects once.
    if (clue.revealsFactIds[0] !== eff.factId) continue;
    for (const itemId of clue.evidenceItemIds) {
      if (held.has(itemId) || queued.has(itemId)) continue;
      queued.add(itemId);
      out.push({ type: "transferItem", itemId, from: null, to: playerId });
    }
  }
  return out;
}
