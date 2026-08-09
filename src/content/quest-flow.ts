/**
 * Quest-flow compiler — author-friendly quest/interactions -> ordinary Campaign.events.
 *
 * The runtime still sees the same deterministic event/effect data it already understands. This
 * module only expands higher-level content shapes at load/editor-validation time.
 *
 * @author Runkai Zhang
 */
import {
  PrebakedEventSchema,
  QuestSchema,
  type Campaign,
  type Condition,
  type Effect,
  type LocationInteraction,
  type PrebakedEvent,
  type QuestFlow,
  type QuestFlowBeat,
  type QuestFlowHandIn,
  type QuestFlowStage,
  type World,
} from "./schema.ts";

export const GENERATED_EVENT_PREFIXES = ["qf.", "li."] as const;

export interface ContentDiagnostic {
  severity: "warning";
  code:
    | "reservedGeneratedEventId"
    | "duplicateEventId"
    | "unguardedQuestOffer"
    | "hiddenQuestNoOffer"
    | "objectiveNoCompletionBeat"
    | "questNoCompletionBeat"
    | "handInNpcAbsent"
    | "questItemNoSource"
    | "orphanLocation";
  message: string;
  path?: string;
}

export interface AuthoringCompileResult {
  campaign: Campaign;
  diagnostics: ContentDiagnostic[];
}

export function isGeneratedEventId(id: string): boolean {
  return GENERATED_EVENT_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export function stripGeneratedEvents(events: PrebakedEvent[]): PrebakedEvent[] {
  return events.filter((ev) => !isGeneratedEventId(ev.id));
}

export function compileAuthoringLayer(world: World, campaign: Campaign): AuthoringCompileResult {
  const diagnostics: ContentDiagnostic[] = [];
  const generatedEvents: PrebakedEvent[] = [];
  const authoredEvents: PrebakedEvent[] = [];

  for (const [index, ev] of campaign.events.entries()) {
    if (isGeneratedEventId(ev.id)) {
      diagnostics.push({
        severity: "warning",
        code: "reservedGeneratedEventId",
        path: `campaign.events[${index}]`,
        message: `Event "${ev.id}" uses a generated-event prefix and will be replaced by compiled authoring output.`,
      });
      continue;
    }
    authoredEvents.push(ev);
  }

  const quests = [...campaign.quests];
  const questIds = new Set(quests.map((q) => q.id));
  for (const flow of campaign.questFlows ?? []) {
    if (flow.quest && !questIds.has(flow.questId)) {
      const questFields = { ...flow.quest };
      delete questFields.id;
      const quest = QuestSchema.parse({ id: flow.questId, state: "hidden", ...questFields });
      quests.push(quest);
      questIds.add(quest.id);
    }
    generatedEvents.push(...compileQuestFlow(flow, playerSlotOf(campaign)));
  }

  for (const loc of world.locations) {
    for (const interaction of loc.interactions ?? []) {
      generatedEvents.push(compileLocationInteraction(loc.id, interaction));
    }
  }

  const compiled = {
    ...structuredClone(campaign),
    quests,
    events: [...authoredEvents, ...generatedEvents],
  } satisfies Campaign;
  diagnostics.push(...diagnoseContent(world, compiled, campaign));
  return { campaign: compiled, diagnostics };
}

/**
 * The campaign's player-slot id — whose pack a compiled hand-in takes the quest item FROM. Derived
 * from the campaign rather than hard-coded, because the authoring layer can compile on either side
 * of `bindCharacter` (content/character.ts): compile FIRST and the generated default id is one more
 * reference the bind's remap rewrites; compile a playset that is ALREADY bound and there is no
 * default id left to rewrite, so a literal would emit a hand-in gate the real PC can never satisfy.
 * Same fallback chain the engine seeds the PC with (`GameEngine.initialState`).
 */
function playerSlotOf(campaign: Campaign): string {
  return campaign.startingState.party[0] ?? campaign.characters[0]?.id ?? "pc.you";
}

function compileQuestFlow(flow: QuestFlow, playerId: string): PrebakedEvent[] {
  const out: PrebakedEvent[] = [];
  if (flow.offer) {
    out.push(
      event({
        id: `qf.${flow.id}.offer`,
        when: "onEnterLocation",
        once: flow.offer.once,
        trigger: triggerFor(flow.offer, flow.questId, "hidden"),
        effects: effectsFor(flow.offer, [{ kind: "setQuestState", questId: flow.questId, state: "offered" }]),
      }),
    );
  }
  if (flow.acceptance) {
    out.push(
      event({
        id: `qf.${flow.id}.acceptance`,
        when: "onTick",
        once: flow.acceptance.once,
        trigger: triggerFor(flow.acceptance, flow.questId, "active"),
        effects: effectsFor(flow.acceptance),
      }),
    );
  }
  for (const stage of flow.stages) {
    out.push(compileStage(flow.questId, flow.id, stage));
  }
  if (flow.handIn) out.push(compileHandIn(flow.questId, flow.id, flow.handIn, playerId));
  for (const fail of flow.failStates) {
    out.push(
      event({
        id: `qf.${flow.id}.fail.${fail.id}`,
        when: "onTick",
        once: fail.once,
        trigger: triggerFor(fail, flow.questId, "active"),
        effects: effectsFor(fail, [{ kind: "setQuestState", questId: flow.questId, state: "failed" }]),
      }),
    );
  }
  return out;
}

function compileStage(questId: string, flowId: string, stage: QuestFlowStage): PrebakedEvent {
  const extra: Effect[] = [];
  if (stage.objectiveId) {
    extra.push({ kind: "setObjectiveDone", questId, objectiveId: stage.objectiveId, done: true });
  }
  extra.push(...stage.effects);
  return event({
    id: `qf.${flowId}.stage.${stage.id}`,
    when: stage.locationId ? "onEnterLocation" : "onTick",
    once: stage.once,
    trigger: triggerFor({ ...stage, effects: [] }, questId, "active"),
    effects: effectsFor({ ...stage, effects: [] }, extra),
  });
}

function compileHandIn(questId: string, flowId: string, handIn: QuestFlowHandIn, playerId: string): PrebakedEvent {
  const extra: Effect[] = [];
  if (handIn.objectiveId) {
    extra.push({ kind: "setObjectiveDone", questId, objectiveId: handIn.objectiveId, done: true });
  }
  if (handIn.itemId && handIn.npcId) {
    extra.push({ kind: "transferItem", itemId: handIn.itemId, from: playerId, to: handIn.npcId });
  }
  extra.push(...handIn.effects, { kind: "setQuestState", questId, state: "complete" });
  const triggerBeat =
    handIn.itemId
      ? {
          ...handIn,
          conditions: [...handIn.conditions, { kind: "hasItem", entityId: playerId, itemId: handIn.itemId } satisfies Condition],
          effects: [],
        }
      : { ...handIn, effects: [] };
  return event({
    id: `qf.${flowId}.hand-in`,
    when: "onTick",
    once: handIn.once,
    trigger: triggerFor(triggerBeat, questId, "active"),
    effects: effectsFor({ ...handIn, effects: [] }, extra),
  });
}

function compileLocationInteraction(locationId: string, interaction: LocationInteraction): PrebakedEvent {
  const conditions: Condition[] = [
    { kind: "atLocation", locationId },
    ...interaction.conditions,
  ];
  if (interaction.mode === "action") {
    conditions.unshift({ kind: "interactionUsed", locationId, interactionId: interaction.id });
  }
  const extra = [...interaction.effects];
  if (interaction.revealExit) {
    extra.push({
      kind: "linkExit",
      fromLocationId: locationId,
      to: interaction.revealExit.to,
      ...(interaction.revealExit.name ? { name: interaction.revealExit.name } : {}),
    });
  }
  return event({
    id: `li.${locationId}.${interaction.id}`,
    when: interaction.mode === "auto" ? "onEnterLocation" : "onCommand",
    once: interaction.once,
    trigger: { allOf: conditions },
    effects: effectsFor(interaction, extra),
  });
}

function triggerFor(beat: QuestFlowBeat, questId: string, state: "hidden" | "active"): PrebakedEvent["trigger"] {
  const allOf: Condition[] = [{ kind: "questState", questId, state }, ...beat.conditions];
  if (beat.locationId) allOf.unshift({ kind: "atLocation", locationId: beat.locationId });
  if (beat.npcId) allOf.push({ kind: "entityPresent", entityId: beat.npcId, locationId: beat.locationId });
  return { allOf };
}

function effectsFor(beat: { text?: string; effects?: Effect[] }, extra: Effect[] = []): Effect[] {
  const effects: Effect[] = [];
  if (beat.text && beat.text.trim().length > 0) effects.push({ kind: "narrate", text: beat.text.trim() });
  effects.push(...(beat.effects ?? []), ...extra);
  return effects;
}

function event(ev: PrebakedEvent): PrebakedEvent {
  return PrebakedEventSchema.parse(ev);
}

function diagnoseContent(world: World, compiled: Campaign, raw: Campaign): ContentDiagnostic[] {
  const diagnostics: ContentDiagnostic[] = [];
  // A mystery's VERDICT is an authored completion beat too — `accusation.successEffects` /
  // `failEffects` are the case's own ending, applied by `resolveCaseAction`, and they are where a
  // case quest ticks its final objective and closes. Scanning only `events` reported every case
  // quest as debt while its ending sat authored two keys away.
  const caseEffects = (compiled.cases ?? []).flatMap((c) =>
    flattenEffects([...c.accusation.successEffects, ...c.accusation.wrongAccusationEffects, ...c.accusation.failEffects]),
  );
  const allEffects = [...compiled.events.flatMap((ev) => flattenEffects(ev.effects)), ...caseEffects];
  const allConditions = compiled.events.flatMap((ev) => ev.trigger.allOf);

  const seenEvents = new Set<string>();
  for (const ev of compiled.events) {
    if (seenEvents.has(ev.id)) {
      diagnostics.push({
        severity: "warning",
        code: "duplicateEventId",
        path: `campaign.events.${ev.id}`,
        message: `Event id "${ev.id}" appears more than once after authoring compilation.`,
      });
    }
    seenEvents.add(ev.id);
  }

  // An offer/activation beat that a REVISIT can re-fire must be gated on the quest's own state, or it
  // will roll a quest the player already took back onto the table (playtest 07-24 P0: the hand-authored
  // `ev.hub.saltmarket-rumor` lacked the guard that `compileQuestFlow` injects automatically, and
  // `once: "visit"` re-armed it on every re-entry). The reducer now refuses the regression outright;
  // this diagnostic catches the authoring mistake at load time, where it is cheap to fix.
  for (const ev of compiled.events) {
    if (ev.when !== "onEnterLocation" || ev.once === "campaign") continue;
    const guarded = new Set(ev.trigger.allOf.flatMap((c) => (c.kind === "questState" ? [c.questId] : [])));
    for (const eff of flattenEffects(ev.effects)) {
      if (eff.kind !== "setQuestState") continue;
      if (eff.state !== "offered" && eff.state !== "active") continue;
      if (guarded.has(eff.questId)) continue;
      diagnostics.push({
        severity: "warning",
        code: "unguardedQuestOffer",
        path: `campaign.events.${ev.id}`,
        message:
          `Event "${ev.id}" can re-fire on revisit and sets quest "${eff.questId}" to "${eff.state}" ` +
          `without a questState guard — add {"kind":"questState","questId":"${eff.questId}","state":"hidden"} ` +
          `to its trigger, or set once:"campaign".`,
      });
    }
  }

  // A hidden quest is reachable when authored content can put it on the table — either OFFERED (the
  // notice-board/NPC pattern the player accepts) or set ACTIVE outright. The second form is how a
  // case quest begins: you do not accept a corpse, you walk into the Old Quarter and find one, and
  // the scene beat arms the investigation. Both are real paths out of `hidden`; only neither is debt.
  const offerPaths = new Set<string>();
  for (const eff of allEffects) {
    if (eff.kind === "setQuestState" && (eff.state === "offered" || eff.state === "active")) {
      offerPaths.add(eff.questId);
    }
  }
  for (const item of world.items) {
    const offersQuest = typeof item.properties.offersQuest === "string" ? item.properties.offersQuest : null;
    if (offersQuest) offerPaths.add(offersQuest);
  }
  const completedQuests = new Set<string>();
  const failedQuests = new Set<string>();
  const completedObjectives = new Set<string>();
  for (const eff of allEffects) {
    if (eff.kind === "setQuestState" && eff.state === "complete") completedQuests.add(eff.questId);
    if (eff.kind === "setQuestState" && eff.state === "failed") failedQuests.add(eff.questId);
    if (eff.kind === "setObjectiveDone" && eff.done) completedObjectives.add(`${eff.questId}:${eff.objectiveId}`);
  }
  for (const quest of compiled.quests) {
    if (quest.state === "hidden" && !offerPaths.has(quest.id)) {
      diagnostics.push({
        severity: "warning",
        code: "hiddenQuestNoOffer",
        path: `campaign.quests.${quest.id}`,
        message: `Hidden quest "${quest.id}" has no authored offer path.`,
      });
    }
    if (!completedQuests.has(quest.id) && !failedQuests.has(quest.id)) {
      diagnostics.push({
        severity: "warning",
        code: "questNoCompletionBeat",
        path: `campaign.quests.${quest.id}`,
        message: `Quest "${quest.id}" has no completion or failure beat.`,
      });
    }
    for (const objective of quest.objectives) {
      if (!completedObjectives.has(`${quest.id}:${objective.id}`)) {
        diagnostics.push({
          severity: "warning",
          code: "objectiveNoCompletionBeat",
          path: `campaign.quests.${quest.id}.objectives.${objective.id}`,
          message: `Objective "${objective.id}" in quest "${quest.id}" is never marked done by authored events.`,
        });
      }
    }
  }

  const npcsByLocation = new Map(world.locations.map((loc) => [loc.id, new Set(loc.npcs)] as const));
  for (const [index, flow] of (raw.questFlows ?? []).entries()) {
    const handIn = flow.handIn;
    if (!handIn?.npcId || !handIn.locationId) continue;
    if (!npcsByLocation.get(handIn.locationId)?.has(handIn.npcId)) {
      diagnostics.push({
        severity: "warning",
        code: "handInNpcAbsent",
        path: `campaign.questFlows[${index}].handIn`,
        message: `Quest flow "${flow.id}" hands in to "${handIn.npcId}", but that NPC is not authored at "${handIn.locationId}".`,
      });
    }
  }

  const itemSources = new Set<string>();
  for (const pc of compiled.characters) for (const itemId of pc.inventory) itemSources.add(itemId);
  for (const npc of world.npcs) for (const itemId of npc.inventory) itemSources.add(itemId);
  // A monster's kit is loot the moment it dies (`lootDowned`) — the shipped bounty-proof pattern.
  for (const monster of world.monsters) for (const itemId of monster.inventory) itemSources.add(itemId);
  // Physical evidence a case CLUE carries: `revealCaseFact` mints these objects into the player's
  // hands at the clue's first fact (`effect-to-command.ts`), which is a real source — the token
  // beside Pettifer's body and his hidden ledger were both reported sourceless while the scene had
  // been handing them over since r5.
  for (const c of compiled.cases ?? []) {
    for (const clue of c.clues) for (const itemId of clue.evidenceItemIds ?? []) itemSources.add(itemId);
  }
  for (const eff of allEffects) {
    if (eff.kind === "giveItem") itemSources.add(eff.itemId);
    if (eff.kind === "transferItem" && eff.to !== null) itemSources.add(eff.itemId);
  }
  const questItemIds = new Set(world.items.filter((item) => item.kind === "quest").map((item) => item.id));
  for (const c of allConditions) {
    if (c.kind === "hasItem") questItemIds.add(c.itemId);
  }
  for (const itemId of questItemIds) {
    if (!itemSources.has(itemId)) {
      diagnostics.push({
        severity: "warning",
        code: "questItemNoSource",
        path: `world.items.${itemId}`,
        message: `Quest item "${itemId}" is required by authored content but has no source.`,
      });
    }
  }

  for (const locId of unreachableLocations(world, compiled.startingState.locationId)) {
    diagnostics.push({
      severity: "warning",
      code: "orphanLocation",
      path: `world.locations.${locId}`,
      message: `Location "${locId}" is unreachable from starting location "${compiled.startingState.locationId}".`,
    });
  }

  return diagnostics;
}

function flattenEffects(effects: Effect[]): Effect[] {
  const out: Effect[] = [];
  for (const eff of effects) {
    out.push(eff);
    if (eff.kind === "check") {
      out.push(...flattenEffects(eff.onSuccess), ...flattenEffects(eff.onFail));
    }
  }
  return out;
}

function unreachableLocations(world: World, startId: string): string[] {
  const byId = new Map(world.locations.map((loc) => [loc.id, loc] as const));
  const seen = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const loc = byId.get(id);
    if (!loc) continue;
    for (const exit of loc.exits.length > 0 ? loc.exits : loc.connections.map((to) => ({ to }))) {
      if (exit.to.startsWith("frontier:") || seen.has(exit.to)) continue;
      queue.push(exit.to);
    }
  }
  return world.locations.filter((loc) => !seen.has(loc.id)).map((loc) => loc.id);
}
