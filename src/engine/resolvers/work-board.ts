/**
 * The work board — what jobs are on offer where the party stands.
 *
 * Lifted verbatim out of `GameEngine`. Read by two callers that must never disagree: the
 * classifier's grounding surface and the economy resolver's ranking of "the best-paying work".
 * A light {id,label,+hints} view only — `workOpportunityById` re-resolves the authoritative row at
 * resolve time, so wages and DCs here are advisory and never trusted back from the wire.
 *
 * @author Runkai Zhang
 */
import type { ClassifierWorkRef } from "../turn-plan.ts";
import { workRequiresMet } from "../../rules/work-gate.ts";
import type { Entity } from "../../world/entity.ts";
import type { Campaign, World } from "../../content/schema.ts";
import { playerEntity, type WorldModel } from "../../world/model.ts";

/**
 * Work on offer at the party's location right now (the job system): the location's own board
 * plus every present NPC who hires (`template.work`). Deduped by id; the id-keyed
 * `workOpportunityById` re-resolves the full row at resolve time, so this stays a light
 * {id,label} grounding surface — the classifier + Buy/Work UI never see wages or DCs.
 */
export function workOpportunitiesHere(
  world: World,
  campaign: Campaign,
  model: WorldModel,
  loc: string,
  present: Entity[],
): ClassifierWorkRef[] {
  const out = new Map<string, ClassifierWorkRef>();
  const add = (w: { id: string; label: string; wageCp?: number; ability?: string; dc?: number }): void => {
    // Carry wage/DC/ability so the classifier can honor "the best-paying / easiest work" (finding #9).
    // Resolve-time authority is unchanged: `workOpportunityById` still re-resolves the full Work row —
    // these fields are advisory grounding hints, never trusted back from the wire.
    if (!out.has(w.id)) out.set(w.id, { id: w.id, label: w.label, wageCp: w.wageCp, ability: w.ability, dc: w.dc });
  };
  // The location's job board is GUILD-ONLY (owner decision 2026-07-22): jobs surface only at an
  // adventure-guild hall, never ambiently. A present hirer's own `template.work` is a face-to-face
  // offer (already diegetic), so that path is ungated; a world without such rows stays inert.
  const pcId = playerEntity(model)?.id ?? "pc.you";
  const locData = world.locations.find((l) => l.id === loc);
  // Reputation gate: a `requires` shift surfaces only when its predicate (guild standing / shifts
  // worked) holds — so a better-paying job unlocks as the PC earns standing.
  if (locData?.guild) {
    for (const w of locData.work ?? []) if (workRequiresMet(w.requires, model, world, campaign.characters)) add(w);
  }
  for (const e of present) {
    if (e.kind !== "npc") continue;
    const template = world.npcs.find((n) => n.id === (e.templateId ?? e.id));
    for (const w of template?.work ?? []) add(w);
  }
  return [...out.values()];
}
