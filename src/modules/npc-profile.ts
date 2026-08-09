/**
 * NPC profile — first-observation identity binding (Workstream A, slim slice).
 *
 * The moment a runtime-spawned NPC shares a location with the party, this module records its
 * deterministic seeded profile (the enrichment composer's floor: sex, explicit 18+ age,
 * personality, look, social role, voice, preferences) through the reducer via
 * `enrichNpc { promote: false }` — identity binds at FIRST SIGHT, before any GM prose can
 * improvise a contradictory one, while the NPC stays transient/tracked and cullable like any
 * bystander. NO LLM runs here: the floor is pure seeded composition (`composeNpcTemplate`),
 * so profiling costs nothing and replays byte-identically.
 *
 * Id-reuse policy: profiles are keyed to the ENTITY id (`npc.guard#0`). The events module
 * probes the registry for the first free suffix, so a despawned id that is later re-spawned
 * gets the SAME seeded profile — the same guard returns, it does not become someone new. That
 * is the continuity contract, not a bug, and it has two halves: first sight RECORDS the
 * profile, and a re-spawned body carrying the shared authored templateId gets the recorded
 * template RE-APPLIED (retargeting templateId to the entity id) instead of being skipped.
 * Monsters are excluded (`kind === "npc"` only), as are authored NPCs standing under their
 * own template id (they already carry full identity) and significant NPCs.
 *
 * @author Runkai Zhang
 */
import type { TickContext, TickModule } from "../engine/tick.ts";
import { partyLocationOf } from "../world/model.ts";
import { enrichmentsOf, mirrorEnrichment } from "../world/enrichment.ts";
import { composeNpcTemplate } from "./party/enrich.ts";

export class NpcProfileModule implements TickModule {
  readonly id = "npc-profile";
  /** Profile after core settles the tick and after events (spawns land at commit — next tick). */
  readonly after = ["core", "events"];
  readonly phases: TickModule["phases"] = { react: (ctx) => this.onReact(ctx) };

  private onReact(ctx: TickContext): void {
    const partyLoc = partyLocationOf(ctx.model);
    if (!partyLoc) return;
    const world = ctx.services.world;
    const recorded = enrichmentsOf(ctx.model.modules);
    for (const e of ctx.model.entities.values()) {
      if (e.kind !== "npc" || e.tier === "significant") continue;
      if (e.locationId !== partyLoc) continue;
      const rec = recorded[e.id];
      if (rec) {
        // The continuity contract's second half: a culled body whose id was RE-SPAWNED arrives
        // wearing the shared authored templateId again (the events module hands every instance
        // `templateId: eff.templateId`). Re-apply the RECORDED profile verbatim — the reducer
        // retargets templateId back to the entity id (and no-ops when already bound), so the
        // same guard really does return instead of silently reverting to the shared template.
        if (e.templateId !== e.id) {
          const res = ctx.apply({ type: "enrichNpc", npcId: e.id, template: structuredClone(rec), promote: false });
          if (res.mutated) {
            mirrorEnrichment(world, rec);
            ctx.data.persist = true; // a heartbeat tick must snapshot this too, not just log it
          }
        }
        continue;
      }
      if (world.npcs.some((n) => n.id === e.id)) continue; // authored under its own id
      const template = composeNpcTemplate(world, e);
      // Applied (not enqueued) so the content mirror can follow the command in lockstep —
      // the promoteAndEnrich pattern. `promote: false` leaves the tier untouched.
      const res = ctx.apply({ type: "enrichNpc", npcId: e.id, template, promote: false });
      if (res.mutated) {
        mirrorEnrichment(world, template);
        ctx.data.persist = true; // AutonomyModule's convention: applied-on-heartbeat ⇒ persist
      }
    }
  }
}
