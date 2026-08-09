/**
 * Continuity checks — unit coverage for the deterministic enforcement floor (`src/rules/continuity.ts`).
 *
 * Each check is pure (prose + ground truth → violations), so these tests pin the exact flag/no-flag
 * boundary the Continuity Judge's Tier-1 relies on: cast presence, verbatim delivery, mechanics
 * honesty, and phantom-state assertion — including the doomed-command boundary (a claim backed only
 * by a command that was excluded from the authorized set must still flag).
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import {
  checkCastPresence,
  checkMechanicsHonesty,
  checkPhantomCompanion,
  checkPlayerQuoteFidelity,
  checkPronounDrift,
  checkSpatialDrift,
  checkStateAssertions,
  checkVerbatimDelivery,
  scrubUnauthorizedArrival,
  checkVerbatimRepeat,
  looksLikeName,
  screen,
  stripSentencesMentioning,
  type VerificationBundle,
} from "../src/rules/continuity.ts";
import type { Command } from "../src/world/commands.ts";

describe("checkCastPresence", () => {
  test("flags an absent character staged in the prose", () => {
    const v = checkCastPresence("Oda walks beside you, sword drawn.", ["Bram"], ["Oda"]);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("castPresence");
    expect(v[0]?.offender).toBe("Oda");
  });

  test("does not flag a present character", () => {
    expect(checkCastPresence("Bram nods at you.", ["Bram"], ["Oda"])).toHaveLength(0);
  });

  test("does not flag when no absent name appears", () => {
    expect(checkCastPresence("The wind picks up over the marsh.", ["Bram"], ["Oda"])).toHaveLength(0);
  });

  test("skips a token shared with a present character (never their fault)", () => {
    // Absent 'Oda Salt' and present 'Salt-reaver' share the 'salt' token — the shared token must not fire.
    expect(checkCastPresence("The Salt-reaver looms.", ["Salt-reaver"], ["Oda Salt"])).toHaveLength(0);
  });

  test("a variant styling of someone PRESENT never fires on its leftover tokens", () => {
    // r5 P1: the roster carried "Oda the Wayfarer" while the man himself stood here as "Oda". The old
    // filter dropped only the shared token, left `wayfarer`, and the absence floor announced his
    // absence directly under his own reply.
    expect(checkCastPresence("Oda the Wayfarer sets down his pack.", ["Oda"], ["Oda the Wayfarer"])).toHaveLength(0);
  });

  test("a name the TRIGGER hands the narrator is an authorized mention (r14)", () => {
    // fixture-work t7: the travel trigger's own honest left-behind notice — "(Sergeant Veil stays
    // behind — they are not travelling with you)" — instructs the narrator to convey Veil's
    // absence, and the raw screen then flagged every dutiful mention, pitting the correction
    // against the trigger for the whole regen budget and recording a false violation off the
    // floored echo. The checkMechanicsHonesty rule, applied to people.
    const trigger = "You travel to Fenwall. (Sergeant Veil stays behind — they are not travelling with you)";
    const prose = "You leave the muster-hall behind; Sergeant Veil stays at her board as the salt road takes you north.";
    expect(checkCastPresence(prose, [], ["Sergeant Veil"], undefined, [], trigger)).toHaveLength(0);
    // The SAME prose without the trigger's authorization still fires — the floor is intact.
    expect(checkCastPresence(prose, [], ["Sergeant Veil"], undefined, [])).toHaveLength(1);
    // The authorization is per-name: an absent NPC the trigger never named still fires.
    expect(
      checkCastPresence(`${prose} Brann Coldwater waves from the gate.`, [], ["Sergeant Veil", "Brann Coldwater"], undefined, [], trigger),
    ).toHaveLength(1);
  });

  test("screen() feeds bundle.trigger into the cast check (r14)", () => {
    const bundle: VerificationBundle = {
      mode: "narration",
      prose: "Sergeant Veil stays behind as you go.",
      present: [],
      absent: ["Sergeant Veil"],
      trigger: "You travel to Fenwall. (Sergeant Veil stays behind — they are not travelling with you)",
    };
    expect(screen(bundle).filter((v) => v.kind === "castPresence")).toHaveLength(0);
    expect(
      screen({ ...bundle, trigger: "You travel to Fenwall." }).filter((v) => v.kind === "castPresence"),
    ).toHaveLength(1);
  });

  test("someone who SPOKE a beat this turn is not absent from the scene they spoke in (r13)", () => {
    // fixture-work t10: Lys spoke a case fact and autonomy queued her departure in the same narrate phase,
    // so the queue-applied preview listed her absent while `checkVerbatimDelivery` still demanded her
    // line survive verbatim. Two checks in the same `screen()` call contradicting each other.
    const prose = `Lys the Quiet: "Pettifer had been boasting he would name the traitor at last."`;
    expect(checkCastPresence(prose, [], ["Lys the Quiet"])).toHaveLength(1);
    expect(checkCastPresence(prose, [], ["Lys the Quiet"], undefined, ["Lys the Quiet"])).toHaveLength(0);
    // The exemption is per-speaker: someone else absent in the same prose still fires.
    expect(
      checkCastPresence(`${prose} Bram nods from the doorway.`, [], ["Lys the Quiet", "Bram"], undefined, [
        "Lys the Quiet",
      ]),
    ).toHaveLength(1);
  });

  test("screen() feeds the beat roster through, so a delivered line is never a castPresence hit", () => {
    const bundle: VerificationBundle = {
      prose: `Lys the Quiet: "The ledger was already gone."`,
      mode: "narration",
      absent: ["Lys the Quiet"],
      beats: [{ name: "Lys the Quiet", dialogue: "The ledger was already gone." }],
    };
    expect(screen(bundle).filter((v) => v.kind === "castPresence")).toHaveLength(0);
    expect(screen({ ...bundle, beats: [] }).filter((v) => v.kind === "castPresence")).toHaveLength(1);
  });
});

describe("stripSentencesMentioning", () => {
  test("keeps every sentence that does not name the offender", () => {
    const kept = stripSentencesMentioning(
      "The pen gate hangs on one hinge. Bram would know whose boot did this. Two prints cross the mud, one deeper than the other.",
      ["Bram"],
    );
    expect(kept).toBe(
      "The pen gate hangs on one hinge. Two prints cross the mud, one deeper than the other.",
    );
  });

  test("returns empty when every sentence is about the offender", () => {
    expect(stripSentencesMentioning("Bram waits by the gate. Bram says nothing.", ["Bram"])).toBe("");
  });

  test("no names to strip leaves the prose whole", () => {
    expect(stripSentencesMentioning("The tide slides up the black sand.", [])).toBe(
      "The tide slides up the black sand.",
    );
  });
});

describe("looksLikeName", () => {
  test("accepts a name, refuses a sentence", () => {
    expect(looksLikeName("Kella Vane")).toBe(true);
    expect(looksLikeName("the Keeper of Weights")).toBe(false); // lower-case head
    expect(
      looksLikeName("The prose references 'Jessup' as a named character, but Jessup is not present."),
    ).toBe(false);
    expect(looksLikeName("")).toBe(false);
  });

  test("a SHORT sentence is still a sentence (07-27 harden)", () => {
    // Reproduced: unpunctuated, four words, capitalized — so the absence floor would have printed
    // "There is no sign of Jessup is not present here." to the player.
    expect(looksLikeName("Jessup is not present")).toBe(false);
    expect(looksLikeName("The prose references Jessup")).toBe(false);
    expect(looksLikeName("Someone else entirely here")).toBe(false);
  });

  test("accepts the shipped roster's own multi-word, comma'd names (07-27 harden)", () => {
    // Reproduced: all three were rejected — on the comma, or on the four-word cap — so a genuine
    // cast violation against any of them dropped its offender and lost the honest absence line.
    expect(looksLikeName("Osric, the Tithe-Clerk")).toBe(true);
    expect(looksLikeName("The Widow of the Tor")).toBe(true);
    expect(looksLikeName("Alda Umber, the Countess of Umberwick")).toBe(true);
  });
});

describe("checkVerbatimDelivery", () => {
  test("passes when the line is delivered verbatim", () => {
    const v = checkVerbatimDelivery('She catches your sleeve and murmurs, "Stay close."', [
      { name: "Oda", dialogue: "Stay close." },
    ]);
    expect(v).toHaveLength(0);
  });

  test("passes light punctuation/case edits (overlap tolerance)", () => {
    const v = checkVerbatimDelivery('"Stay close," she says, gripping your arm.', [
      { name: "Oda", dialogue: "Stay close" },
    ]);
    expect(v).toHaveLength(0);
  });

  test("flags a dropped line", () => {
    const v = checkVerbatimDelivery("The moment passes in silence.", [{ name: "Oda", dialogue: "We should turn back now." }]);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("verbatimDropped");
    expect(v[0]?.offender).toBe("Oda");
  });

  test("reads the structured lines[] form", () => {
    const v = checkVerbatimDelivery("You wait.", [{ name: "Bram", lines: [{ text: "Coin first, then the map." }] }]);
    expect(v).toHaveLength(1);
  });
});

describe("checkMechanicsHonesty", () => {
  test("flags an invented DC when no roll resolved and not in combat", () => {
    const v = checkMechanicsHonesty("You beat the DC 15 and the lock clicks.", null, "You try the lock.", false);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("inventedMechanics");
  });

  test("does not flag in combat (damage travels as trigger text)", () => {
    expect(checkMechanicsHonesty("Your blade rolls a 17 across his ribs.", null, "", true)).toHaveLength(0);
  });

  test("does not flag when a resolved verdict exists", () => {
    expect(
      checkMechanicsHonesty("The lock gives.", { label: "Dexterity check", success: true }, "", false),
    ).toHaveLength(0);
  });

  test("does not flag a number the engine embedded in the trigger", () => {
    const trigger = "You drink the draught and warmth knits 8 points of hurt closed.";
    expect(checkMechanicsHonesty("Warmth knits 8 points of hurt closed.", null, trigger, false)).toHaveLength(0);
  });
});

describe("checkStateAssertions", () => {
  const setExit: Command = { type: "setExitState", locationId: "loc.a", to: "loc.b", state: "open" };
  const kill: Command = { type: "setCondition", entityId: "npc.x", condition: "unconscious", active: true };

  test("flags a phantom door opening with no setExitState", () => {
    const v = checkStateAssertions("The heavy door swings open before you.", []);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("phantomState");
  });

  test("does not flag when setExitState authorizes it", () => {
    expect(checkStateAssertions("The heavy door swings open before you.", [setExit])).toHaveLength(0);
  });

  test("'you lift the X' is a raise, not a take (r12 — the burning brand held high)", () => {
    expect(checkStateAssertions("You lift the flame high, then low, sweeping the ash.", [])).toHaveLength(0);
    expect(checkStateAssertions("You lift the lantern to see the ledger.", [])).toHaveLength(0);
    // The unambiguous take verbs still assert a transfer.
    expect(checkStateAssertions("You snatch the ledger from the desk.", [])).toHaveLength(1);
  });

  test("a barrier moving ITSELF flags whatever verb the model reached for (07-27 harden)", () => {
    // The stem list is the pattern's whole reach, and it shipped with nine. Each of these was a
    // reproduced MISS: an unauthorized door opened in the fiction and nothing screened it.
    for (const line of [
      "The door groans open and cold air comes in.",
      "The gate yawns open ahead of you.",
      "The hatch eases open under your hand.",
      "The trapdoor shudders open.",
      "The portcullis rattles open.",
      "The door edges open.",
      "The door pops open.",
    ]) {
      expect(checkStateAssertions(line, [])).toHaveLength(1);
      expect(checkStateAssertions(line, [setExit])).toHaveLength(0);
    }
  });

  test("a barrier that does NOT open is not a phantom opening (negation guard, 07-27 harden)", () => {
    // Reproduced: all five raised a phantomState and sent the turn back with a correction telling
    // the narrator "the way remains exactly as it was" — which is what the prose already said.
    expect(checkStateAssertions("The door does not give way.", [])).toHaveLength(0);
    expect(checkStateAssertions("The bolt will not slide free.", [])).toHaveLength(0);
    expect(checkStateAssertions("The gate refuses to swing open.", [])).toHaveLength(0);
    expect(checkStateAssertions("The hatch never falls open on its own.", [])).toHaveLength(0);
    expect(checkStateAssertions("The lock does not click free.", [])).toHaveLength(0);
    // …and the affirmative sentence it was hiding behind still flags.
    expect(checkStateAssertions("The door gives way.", [])).toHaveLength(1);
    expect(checkStateAssertions("The lock clicks free.", [])).toHaveLength(1);
  });

  test("'dead' as an INTENSIFIER is not a death (07-27 harden)", () => {
    // Reproduced: every one of these asserted that a character had died.
    expect(checkStateAssertions("The room is dead quiet.", [])).toHaveLength(0);
    expect(checkStateAssertions("The market is dead still at this hour.", [])).toHaveLength(0);
    expect(checkStateAssertions("The air is dead calm.", [])).toHaveLength(0);
    expect(checkStateAssertions("He is dead certain the ferry ran yesterday.", [])).toHaveLength(0);
    expect(checkStateAssertions("The room falls dead quiet when you speak.", [])).toHaveLength(0);
    // A real death still flags on every shape the arm carries.
    expect(checkStateAssertions("The wight lies dead at your feet.", [])).toHaveLength(1);
    expect(checkStateAssertions("Bram falls dead across the table.", [])).toHaveLength(1);
    expect(checkStateAssertions("The drover is dead.", [])).toHaveLength(1);
  });

  test("a denied death or hand-off is not an authorized one (negation guard, 07-27 harden)", () => {
    expect(checkStateAssertions("He does not lie dead; he is breathing, barely.", [])).toHaveLength(0);
    expect(checkStateAssertions("Nobody falls dead here tonight.", [])).toHaveLength(0);
    expect(checkStateAssertions("She does not hand you the letter.", [])).toHaveLength(0);
    expect(checkStateAssertions("He will not hand over the ledger.", [])).toHaveLength(0);
  });

  test("the NOUN 'hands' never moves an item (07-27 harden)", () => {
    // Reproduced: three ordinary gestures each asserted a phantom item transfer. The noun reading
    // always carries its own determiner; the verb reading never can.
    expect(checkStateAssertions("She warms her hands over the brazier.", [])).toHaveLength(0);
    expect(checkStateAssertions("He rubs his hands over the map, thinking.", [])).toHaveLength(0);
    expect(checkStateAssertions("The old woman spreads her hands over the fire.", [])).toHaveLength(0);
    // The verb still moves things, in all three of its shapes.
    expect(checkStateAssertions("Oda hands you the letter.", [])).toHaveLength(1);
    expect(checkStateAssertions("She hands over the ledger without a word.", [])).toHaveLength(1);
    expect(checkStateAssertions("He hands it to you.", [])).toHaveLength(1);
  });

  test("a DEMAND to hand something over has moved nothing (07-27 harden)", () => {
    // Reproduced: the bare stem reads as an event. An NPC ordering the player to hand over the coin,
    // and a line reporting that she WANTS it, both asserted a completed transfer.
    expect(checkStateAssertions(`"Hand over the coin," she says, "or the gate stays shut."`, [])).toHaveLength(0);
    expect(checkStateAssertions("She wants you to hand over the writ.", [])).toHaveLength(0);
    // The player actually doing it, and an NPC actually doing it, still flag.
    expect(checkStateAssertions("You hand over the writ and she reads it.", [])).toHaveLength(1);
    expect(checkStateAssertions("The drover hands over the ledger.", [])).toHaveLength(1);
  });

  test("does not flag a death backed by a setCondition", () => {
    expect(checkStateAssertions("The bandit falls dead at your feet.", [kill])).toHaveLength(0);
  });

  test("flags a death claim when the backing command was excluded (doomed) from the authorized set", () => {
    // The doomed-command boundary: the autonomy beat's command was dry-run-rejected and therefore
    // excluded upstream, so the check sees an empty authorized set and MUST still flag the kill.
    expect(checkStateAssertions("The bandit falls dead at your feet.", [])).toHaveLength(1);
  });

  test("flags a phantom item transfer", () => {
    expect(checkStateAssertions("You pocket the silver ring without a word.", [])).toHaveLength(1);
  });

  const pay: Command = { type: "adjustCoins", entityId: "pc.you", by: -20 };
  const trade: Command = {
    type: "tradeWith",
    pcId: "pc.you",
    vendorId: "npc.sela",
    itemId: "it.stew",
    direction: "buy",
    priceCp: 20,
  };

  test("flags a phantom payment (the live 07-18 'coins clink… stew's on the hook' fabrication)", () => {
    const v = checkStateAssertions("The two silver coins clink onto the counter and vanish into her apron.", []);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("phantomState");
    expect(v[0]?.detail).toContain("coins were paid");
  });

  test("flags second-person payment verbs with a currency word in reach", () => {
    expect(checkStateAssertions("You count out three silver for the room.", [])).toHaveLength(1);
    expect(checkStateAssertions("You hand over six coppers without counting them.", [])).toHaveLength(1);
    expect(checkStateAssertions("Your purse feels lighter as you leave.", [])).toHaveLength(1);
  });

  test("does not flag payment idioms without currency ('you pay attention', 'pay a heavy toll')", () => {
    expect(checkStateAssertions("You pay close attention to her hands.", [])).toHaveLength(0);
    expect(checkStateAssertions("You pay a heavy toll in sweat and nerve.", [])).toHaveLength(0);
  });

  test("does not flag a payment backed by adjustCoins or tradeWith", () => {
    expect(
      checkStateAssertions("The two silver coins clink onto the counter and vanish into her apron.", [pay]),
    ).toHaveLength(0);
    expect(checkStateAssertions("You count out three silver for the room.", [trade])).toHaveLength(0);
  });

  // The INBOUND direction (live 07-24 #D1): the model narrated "a 50-silver advance handed over at
  // signing" over a quest accept that moved no coin, and every arm of the payment family above is
  // PC-pays-OUT, so nothing flagged and the quiet turn never escalated to the model tier.
  test("flags an NPC landing coin on the player (the live 07-24 phantom advance)", () => {
    const v = checkStateAssertions("Veil counts out fifty silver and pushes it across the table to you.", []);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("phantomState");
    expect(v[0]?.detail).toContain("paid TO the player");
    expect(checkStateAssertions("She presses three silver coins into your palm.", [])).toHaveLength(1);
    expect(checkStateAssertions("He slides a stack of coppers across to you.", [])).toHaveLength(1);
    expect(checkStateAssertions("Oda hands you twenty gold before you can object.", [])).toHaveLength(1);
    // The DEPOSIT family, unparticled: these are the commonest live phrasings and every one of them
    // used to walk through — "counts out" flagged while the identical "counts" did not.
    expect(checkStateAssertions("She counts fifty silver into your palm.", [])).toHaveLength(1);
    expect(checkStateAssertions("He drops three silver into your hand.", [])).toHaveLength(1);
    expect(checkStateAssertions("She tosses you a purse of coins.", [])).toHaveLength(1);
    expect(checkStateAssertions("He puts fifty silver into your hand.", [])).toHaveLength(1);
    // An unrelated idiom that happens to use an offer stem no longer disables the whole screen for
    // its sentence — the offer guard rides only the advance/retainer arms now.
    expect(checkStateAssertions("She offers a nod and hands you a purse of coins.", [])).toHaveLength(1);
    expect(checkStateAssertions("He owes the tavern a week of rent, and hands you twenty gold.", [])).toHaveLength(1);
  });

  test("ambient coin crossing a counter is not a payment TO the player", () => {
    // `PAY_LANDING` carried a bare "across the table|counter|bar|desk|board" alternative, which names
    // no recipient: market and tavern flavor moves coin over furniture constantly, and the player's
    // OWN coin leaving read as money arriving. A landing must name the player.
    const inbound = (line: string): number =>
      checkStateAssertions(line, []).filter((v) => v.detail.includes("paid TO the player")).length;
    expect(inbound("At the stall beside you a fishwife counts out coppers across the counter.")).toBe(0);
    expect(inbound("Two dicers argue over a pile of coins; one pushes a stack of silver across the board.")).toBe(0);
    expect(inbound("The night-clerk slides your coins across the desk and marks the ledger.")).toBe(0);
    expect(inbound("The barkeep slides a purse of silver across the bar to the stranger.")).toBe(0);
    // …while the player-directed forms of the same sentence still fire.
    expect(inbound("The barkeep slides a purse of silver across the bar to you.")).toBe(1);
    expect(inbound("She counts out fifty silver across the counter into your palm.")).toBe(1);
  });

  test("flags advance / retainer / down-payment phrasing carrying a counted sum", () => {
    expect(checkStateAssertions("A 50-silver advance is handed over at signing.", [])).toHaveLength(1);
    expect(checkStateAssertions("The contract carries an advance of fifty silver.", [])).toHaveLength(1);
    expect(checkStateAssertions("You sign, and a retainer of ten gold is yours.", [])).toHaveLength(1);
    expect(checkStateAssertions("Earnest money of five silver settles the matter.", [])).toHaveLength(1);
  });

  test("flags a purse growing heavier", () => {
    expect(checkStateAssertions("Your purse is heavier for it.", [])).toHaveLength(1);
    expect(checkStateAssertions("Your purse feels fatter than it did an hour ago.", [])).toHaveLength(1);
  });

  test("does not flag inbound payment backed by adjustCoins or tradeWith", () => {
    const gain: Command = { type: "adjustCoins", entityId: "pc.you", by: 500 };
    expect(
      checkStateAssertions("Veil counts out fifty silver and pushes it across the table to you.", [gain]),
    ).toHaveLength(0);
    expect(checkStateAssertions("A 50-silver advance is handed over at signing.", [gain])).toHaveLength(0);
    expect(checkStateAssertions("Your purse is heavier for it.", [gain])).toHaveLength(0);
    expect(checkStateAssertions("Oda hands you twenty gold before you can object.", [trade])).toHaveLength(0);
  });

  test("inbound-payment idiom guards: metaphor, an ITEM handed over, and a mere promise stay legal", () => {
    // No currency in reach — metaphors are not payments.
    expect(checkStateAssertions("You pay close attention to her hands.", [])).toHaveLength(0);
    expect(checkStateAssertions("You pay a heavy toll in sweat and nerve.", [])).toHaveLength(0);
    expect(checkStateAssertions("The gamble pays off and the crowd turns to you.", [])).toHaveLength(0);
    // Handing over an ITEM is the separate transferItem pattern's business, not a payment; a colour
    // adjective ("gold-leafed") must never read as coin. The line still earns its item violation —
    // what must not happen is the payment arm ALSO firing and demanding an unchanged purse.
    const letter = checkStateAssertions("She hands you a letter sealed in black wax.", []);
    expect(letter.filter((v) => v.detail.includes("paid TO the player"))).toHaveLength(0);
    const ledger = checkStateAssertions("She hands you the gold-leafed ledger.", []);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.detail).toContain("an item changed hands");
    // A PROMISE is not a payment — offer phrasing stays legal exactly as a quoted price does.
    expect(checkStateAssertions("Veil promises you fifty silver on delivery.", [])).toHaveLength(0);
    expect(checkStateAssertions("Veil promises you an advance of fifty silver on delivery.", [])).toHaveLength(0);
    expect(checkStateAssertions("She offers a 50-silver advance if you sign.", [])).toHaveLength(0);
    expect(checkStateAssertions("He will pay you fifty silver when the wagons reach Hollowmere.", [])).toHaveLength(0);
    expect(checkStateAssertions("He owes you fifty silver and both of you know it.", [])).toHaveLength(0);
    // `screen()` runs this check on NPC dialogue too, so an NPC RECALLING a real past payment must
    // not read as one landing this turn — hence the present-only verb list on the `<verb> you <coin>`
    // arm. The landing arm keeps past tense, where the coin demonstrably reaches the player.
    expect(checkStateAssertions("I paid you three silver last week and you know it.", [])).toHaveLength(0);
    expect(checkStateAssertions("I handed you six coppers at the gate.", [])).toHaveLength(0);
    expect(checkStateAssertions("She had counted out fifty silver and pushed it across to you.", [])).toHaveLength(1);
    // A wage or contract QUOTE moves no coin. The present-tense habitual ("the run pays you thirty
    // silver when the crates are ashore") is the same class as the modal form pinned above, and is
    // high-frequency prose in a world that routes work inquiries through NPC voice — flagging it cost
    // a utility round-trip on a free turn and MUTED the NPC outright on the private whisper path.
    expect(checkStateAssertions("The run pays you thirty silver when the crates are ashore.", [])).toHaveLength(0);
    expect(checkStateAssertions("This work pays you two silver a day and not a copper more.", [])).toHaveLength(0);
    expect(checkStateAssertions("Nobody here pays you in coin up front, stranger.", [])).toHaveLength(0);
    // An explicit offer verb guards its own sentence however long the aside between the two, and a
    // posted/quoted term is an offer too.
    expect(
      checkStateAssertions(
        "Oda offers, with the flat calm of someone who has done this a hundred times, a retainer of twenty silver.",
        [],
      ),
    ).toHaveLength(0);
    expect(checkStateAssertions("The posting names a retainer of twenty silver for the season.", [])).toHaveLength(0);
    // The wider deposit verbs keep their ordinary non-monetary readings.
    expect(checkStateAssertions("She sets the lantern down on the table and looks at you.", [])).toHaveLength(0);
    expect(checkStateAssertions("He drops his pack by the fire.", [])).toHaveLength(0);
    expect(checkStateAssertions("She lays a hand on your shoulder.", [])).toHaveLength(0);
    expect(checkStateAssertions("A purse of coins sits on the table, untouched.", [])).toHaveLength(0);
    // Past `put`/`set` are spelled like their bare stems, so they stay OUT of the verb list — a modal
    // offer must not read as a landing.
    expect(checkStateAssertions("He will put fifty silver into your hand when the job is done.", [])).toHaveLength(0);
  });

  test("the outbound payment family still fires exactly once (no inbound double-flag)", () => {
    // Second-person base forms are excluded from the inbound verb list on purpose, so a PC-pays-OUT
    // line keeps its single, correctly-directed violation.
    expect(checkStateAssertions("You count out three silver for the room.", [])).toHaveLength(1);
    expect(checkStateAssertions("Your purse feels lighter as you leave.", [])).toHaveLength(1);
  });

  test("flags a phantom completed purchase and honors the buy-time idiom guard", () => {
    const v = checkStateAssertions("You buy the dagger without another word.", []);
    expect(v).toHaveLength(1);
    expect(v[0]?.detail).toContain("purchase or sale");
    expect(checkStateAssertions("The deal is done, her grin says so.", [])).toHaveLength(1);
    // A vendor QUOTING a price is negotiation, not completion — must stay legal.
    expect(checkStateAssertions("The trinket is yours for five silver, she offers.", [])).toHaveLength(0);
    // Idioms stay legal: buying time/a moment is not commerce.
    expect(checkStateAssertions("You buy some time with a crooked joke.", [])).toHaveLength(0);
    expect(checkStateAssertions("You buy a moment to think.", [])).toHaveLength(0);
  });

  test("coin the player is ASKED for is not coin the player received (07-27 harden)", () => {
    // Reproduced: the landing-less `<verb> you <coin>` arm reads the verb alone as delivery, and a
    // bill presented to the player is spelled exactly the same way — so a demand was screened as a
    // phantom inbound payment.
    expect(checkStateAssertions("The gatewright presses you for five silver before the gate opens.", [])).toHaveLength(
      0,
    );
    expect(checkStateAssertions("He hands you a bill for two silver and waits.", [])).toHaveLength(0);
    // A genuine landing whose `for` sits PAST the coin still fires.
    expect(checkStateAssertions("She hands you a purse of coins for the ferry.", [])).toHaveLength(1);
    expect(checkStateAssertions("He hands you five silver.", [])).toHaveLength(1);
  });

  test("a COLOUR is not a currency (07-27 harden)", () => {
    // Reproduced: the clink/spill/scatter imagery arm took a bare `gold` / singular `silver`, so
    // ordinary description asserted that coins had moved.
    expect(checkStateAssertions("Her gold hair spills across the pillow.", [])).toHaveLength(0);
    expect(checkStateAssertions("The gold light of the lamp spills into the room.", [])).toHaveLength(0);
    expect(checkStateAssertions("Lamplight, thin and silver, scatters across the water.", [])).toHaveLength(0);
    expect(checkStateAssertions("Gold thread scatters across the table as she cuts it.", [])).toHaveLength(0);
    // Unambiguously monetary nouns still fire.
    expect(checkStateAssertions("The coins clink into the bowl.", [])).toHaveLength(1);
    expect(
      checkStateAssertions("The two silver coins clink onto the counter and vanish into her apron.", []),
    ).toHaveLength(1);
  });

  test("'pay' with a metaphorical object stays legal even with currency in the sentence (07-27 harden)", () => {
    // The block comment CLAIMED this was already true; it held only while no currency word was in
    // reach. Both of these were reproduced flags.
    expect(checkStateAssertions("You pay no mind to the tab the drunk is running.", [])).toHaveLength(0);
    expect(checkStateAssertions("You pay attention to the fee chalked on the board.", [])).toHaveLength(0);
    // A real second-person payment is untouched.
    expect(checkStateAssertions("You pay the two silver and she nods.", [])).toHaveLength(1);
  });

  test("does not flag a purchase backed by tradeWith", () => {
    expect(checkStateAssertions("You buy the dagger without another word.", [trade])).toHaveLength(0);
  });
});

describe("checkPhantomCompanion", () => {
  test("flags accompaniment prose when the player is SOLO (the reported crowd-as-escort)", () => {
    const v = checkPhantomCompanion("The four locals fall into step beside you as you walk south.", []);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("phantomCompanion");
  });

  test("flags 'your companions' and a person 'at your side' when solo", () => {
    expect(checkPhantomCompanion("Your companions spread out around you.", [])).toHaveLength(1);
    expect(checkPhantomCompanion("A woman keeps pace at your side.", [])).toHaveLength(1);
  });

  test("does NOT flag worn gear 'at your side' (audit #15 — a dagger is not a companion)", () => {
    expect(checkPhantomCompanion("Your rusted dagger hangs at your side.", [])).toHaveLength(0);
    expect(checkPhantomCompanion("The tankard sits by your side, half-empty.", [])).toHaveLength(0);
  });

  test("gear that STAYS or STANDS at your side is still gear (07-27 harden)", () => {
    // Reproduced: the verb guard admitted static verbs, so the same worn-gear prose the guard was
    // built for walked back in through them. Objects stay, remain and stand exactly as they hang.
    expect(checkPhantomCompanion("Your cloak stays at your side, sodden.", [])).toHaveLength(0);
    expect(checkPhantomCompanion("A stack of crates stands at your side.", [])).toHaveLength(0);
    expect(checkPhantomCompanion("Your pack remains at your side where you dropped it.", [])).toHaveLength(0);
    // Locomotion at your side is still a companion claim.
    expect(checkPhantomCompanion("A woman keeps pace at your side.", [])).toHaveLength(1);
    expect(checkPhantomCompanion("The drover walks at your side, saying nothing.", [])).toHaveLength(1);
  });

  test("the plainest accompaniment phrasing of all is covered ('walks with you')", () => {
    expect(checkPhantomCompanion("A hooded man walks with you as far as the bridge.", [])).toHaveLength(1);
    expect(checkPhantomCompanion("A hooded man walks with you as far as the bridge.", ["Oda"])).toHaveLength(0);
  });

  test("does NOT flag when the player has a real party companion (model tier disambiguates)", () => {
    expect(checkPhantomCompanion("Oda falls into step beside you.", ["Oda the Wayfarer"])).toHaveLength(0);
  });

  test("does NOT flag ordinary crowd prose ('around you' is not accompaniment)", () => {
    expect(checkPhantomCompanion("The crowd presses around you, loud and indifferent.", [])).toHaveLength(0);
  });

  test("an NPC OFFERING company in dialogue is an offer, not an escort (r12 recruit pitch)", () => {
    expect(
      checkPhantomCompanion(
        `"If you're of a mind to walk out of Anchorfall with somebody who's walked it before, I'll take that walk with you," Oda says.`,
        [],
      ),
    ).toHaveLength(0);
    // The narrator STAGING the same claim outside quotes is still a phantom escort.
    expect(checkPhantomCompanion("Oda walks with you toward the gate.", [])).toHaveLength(1);
  });

  test("a DENIAL of accompaniment is not a claim of one (r13 — the engine's own left-behind notice)", () => {
    // Verbatim from the r13 sweep: the trigger echo's honest notice matched the accompaniment arm.
    expect(
      checkPhantomCompanion(
        "You travel to Anchorfall. (Brann Coldwater stays behind — they are not travelling with you)",
        [],
      ),
    ).toHaveLength(0);
    expect(checkPhantomCompanion("Nobody walks with you out of the market.", [])).toHaveLength(0);
    expect(checkPhantomCompanion("The drover doesn't walk with you past the gate.", [])).toHaveLength(0);
    expect(checkPhantomCompanion("You have no escort on this road.", [])).toHaveLength(0);
    // A negation in a PREVIOUS clause cannot excuse a real claim in this one.
    expect(
      checkPhantomCompanion("Brann does not follow. A hooded man walks with you as far as the bridge.", []),
    ).toHaveLength(1);
  });
});

describe("checkSpatialDrift", () => {
  const move: Command = { type: "moveParty", to: "loc.tavern" };
  test("flags an arrival claim when NO move happened this turn", () => {
    const v = checkSpatialDrift("You arrive at the Salted Spoon, its blue door ajar.", []);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("spatialDrift");
  });

  test("does NOT flag when a real move was authorized", () => {
    expect(checkSpatialDrift("You arrive at the Salted Spoon.", [move])).toHaveLength(0);
  });

  test("does NOT flag in combat (positional movement, not travel)", () => {
    expect(checkSpatialDrift("You cross into the fray, blade up.", [], true)).toHaveLength(0);
  });

  test("does NOT flag ordinary in-place prose", () => {
    expect(checkSpatialDrift("You step to the window and look out over the harbor.", [])).toHaveLength(0);
  });

  test("r10 F-1: flags an NPC-LED arrival ('he leads you … into the tilted plazas')", () => {
    const v = checkSpatialDrift(
      "He leads you up out of the market's racket into the tilted plazas, where the light comes down slanted.",
      [],
    );
    expect(v).toHaveLength(1);
  });

  test("r10 F-1: flags a you-subject motion into a CAPITALIZED named place", () => {
    expect(checkSpatialDrift("You push into the Wreck and Riddle, ducking the low lintel.", [])).toHaveLength(1);
    expect(checkSpatialDrift("You head into the Saltmarket as the stalls open.", [])).toHaveLength(1);
  });

  test("r10 F-1: lowercase motion objects stay in-place color (crowd, lamplight)", () => {
    expect(checkSpatialDrift("You push into the crowd, shoulder first.", [])).toHaveLength(0);
    expect(checkSpatialDrift("You step into the lamplight so she can see your face.", [])).toHaveLength(0);
  });
});

describe("scrubUnauthorizedArrival (r10 F-1 rail)", () => {
  const move: Command = { type: "moveParty", to: "loc.tavern" };

  test("drops exactly the arrival sentences and keeps the rest of the turn", () => {
    const prose =
      "The Muster-Hall's quiet falls behind you as you step out into the Saltmarket. A gull screams overhead. The fish-stalls are already loud.";
    const out = scrubUnauthorizedArrival(prose, []);
    expect(out).not.toContain("Saltmarket");
    expect(out).toContain("A gull screams overhead.");
    expect(out).toContain("The fish-stalls are already loud.");
  });

  test("a real move keeps its arrival prose byte-identical", () => {
    const prose = "You arrive at the Salted Spoon, its blue door ajar.";
    expect(scrubUnauthorizedArrival(prose, [move])).toBe(prose);
  });

  test("clean prose passes through byte-identical", () => {
    const prose = "You wait at the crossroads. Nothing moves but the wind.";
    expect(scrubUnauthorizedArrival(prose, [])).toBe(prose);
  });

  test("all-arrival prose scrubs to empty (the caller falls to its deterministic echo)", () => {
    expect(scrubUnauthorizedArrival("You arrive at the Wreck and Riddle.", [])).toBe("");
  });

  test("paragraph structure survives a scrub in one paragraph", () => {
    const prose =
      "You make your way into the underhall, torch high.\n\nThe smell of tallow is everywhere. Someone coughs in the dark.";
    const out = scrubUnauthorizedArrival(prose, []);
    expect(out).toBe("The smell of tallow is everywhere. Someone coughs in the dark.");
  });
});

describe("checkVerbatimRepeat", () => {
  const greeting =
    "Sela looks up from the counter and wipes her hands. \"Coin up front. Bowl's two silver, bed's five, and the stew is better than the bed.\" Oda leans against the doorframe, waiting.";

  test("flags prose that replays a ≥12-word run from a recent narration (the 07-18 re-greeting)", () => {
    const prose =
      "The fight rages on, and yet — Sela looks up from the counter and wipes her hands. \"Coin up front. Bowl's two silver, bed's five, and the stew is better than the bed.\"";
    const v = checkVerbatimRepeat(prose, [greeting]);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("verbatimRepeat");
  });

  test("does not flag fresh prose that merely shares short phrases", () => {
    const prose = "Sela wipes her hands on her apron and watches you across the counter, saying nothing at all this time.";
    expect(checkVerbatimRepeat(prose, [greeting])).toHaveLength(0);
  });

  test("does not flag a run that is a REQUIRED verbatim NPC line (those must repeat)", () => {
    const line = "Coin up front. Bowl's two silver, bed's five, and the stew is better than the bed.";
    const prose = `She fixes you with a flat stare and repeats herself: "${line}"`;
    expect(checkVerbatimRepeat(prose, [greeting], [{ name: "Sela", dialogue: line }])).toHaveLength(0);
  });

  test("short prose and short recents never trip (threshold guard)", () => {
    expect(checkVerbatimRepeat("The wind howls.", [greeting])).toHaveLength(0);
    expect(checkVerbatimRepeat(greeting, ["The wind howls."])).toHaveLength(0);
  });
});

describe("screen", () => {
  test("narration mode runs the full set", () => {
    const bundle: VerificationBundle = {
      prose: "Oda walks beside you as the door swings open.",
      mode: "narration",
      present: [],
      absent: ["Oda"],
      authorizedCommands: [],
    };
    const kinds = screen(bundle).map((v) => v.kind);
    expect(kinds).toContain("castPresence");
    expect(kinds).toContain("phantomState");
  });

  test("whisper mode runs only the state-assertion check", () => {
    const bundle: VerificationBundle = {
      prose: "I already killed the guard — he lies dead in the cellar.",
      mode: "whisper",
      authorizedCommands: [],
    };
    const v = screen(bundle);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("phantomState");
  });

  test("an empty bundle yields no violations", () => {
    expect(screen({ prose: "The tide comes in.", mode: "narration" })).toHaveLength(0);
  });
});

describe("checkPronounDrift — Tier-1 escalation trigger (r4)", () => {
  test("the live sample: a lone male NPC referred to with 'she' in his own sentence flags", () => {
    // r4 P4: "Lys stands very still by the door, and does not pretend she only just found him."
    const v = checkPronounDrift(
      "Lys stands very still by the door, and does not pretend she only just found him.",
      ["Lys the Quiet (he/him)"],
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "pronounDrift", offender: "Lys the Quiet" });
  });

  test("suppressed when any present cast member of the pronoun's sex exists (legitimate referent)", () => {
    const v = checkPronounDrift("Lys frowns as she counts the coins again.", [
      "Lys the Quiet (he/him)",
      "Mira Dockhand (she/her)",
    ]);
    expect(v).toHaveLength(0);
  });

  test("suppressed when another cast name shares the sentence (ambiguous referent)", () => {
    const v = checkPronounDrift("Lys watches Oda, and he says nothing at all to her shadow.", [
      "Lys the Quiet (he/him)",
      "Oda the Wayfarer (he/him)",
    ]);
    expect(v).toHaveLength(0);
  });

  test("an ordinary English word inside a roster name never names that person (07-27 harden)", () => {
    // Reproduced: the member bind was `salientTokens(...).some()`, so ONE dictionary word out of a
    // name escalated a judge call on a quiet flavor turn — "quiet" for Lys the Quiet, "coast" for
    // the Coast Farmhand. The bind is the shared distinctive-token binder now.
    expect(
      checkPronounDrift("The room goes quiet as the ferryman shakes his head.", ["Lys the Quiet (she/her)"]),
    ).toHaveLength(0);
    expect(checkPronounDrift("The night is quiet; he counts the crates twice.", ["Lys the Quiet (she/her)"])).toHaveLength(
      0,
    );
    expect(
      checkPronounDrift("The coast road is empty and he walks it alone.", ["Coast Farmhand (she/her)"]),
    ).toHaveLength(0);
    // Naming her still escalates.
    const v = checkPronounDrift("Lys frowns as he counts the coins.", ["Lys the Quiet (she/her)"]);
    expect(v).toHaveLength(1);
    expect(v[0]?.offender).toBe("Lys the Quiet");
  });

  test("clean prose, correct pronouns, and possessives never flag", () => {
    expect(checkPronounDrift("Lys hands you his cup and he waits.", ["Lys the Quiet (he/him)"])).toHaveLength(0);
    expect(checkPronounDrift("Mira ties off her skiff.", ["Mira Dockhand (she/her)"])).toHaveLength(0);
    expect(checkPronounDrift("The tide comes in.", ["Lys the Quiet (he/him)"])).toHaveLength(0);
  });

  test("no presentPronouns (or unparseable rows) ⇒ the check is skipped entirely", () => {
    expect(checkPronounDrift("She laughs at him.", undefined)).toHaveLength(0);
    expect(checkPronounDrift("She laughs at him.", [])).toHaveLength(0);
    expect(checkPronounDrift("She laughs at him.", ["Someone (they/them)"])).toHaveLength(0);
  });

  test("screen() wires it on narration bundles", () => {
    const bundle: VerificationBundle = {
      prose: "Lys shrugs; she pockets the ledger.",
      mode: "narration",
      presentPronouns: ["Lys the Quiet (he/him)"],
    };
    expect(screen(bundle).some((v) => v.kind === "pronounDrift")).toBe(true);
  });
});

describe("checkPlayerQuoteFidelity (PROSE-TO-CODE §2.5)", () => {
  test("a quoted PC line the player never typed flags for escalation", () => {
    const v = checkPlayerQuoteFidelity(
      'You say, "I have walked these roads since before your father was born," and the room goes quiet.',
      "I ask the warden about the toll.",
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe("inventedPlayerSpeech");
  });

  test("a quote that IS a substring of the real input stays clean (verbatim echo is legal)", () => {
    const v = checkPlayerQuoteFidelity(
      '"Where can I find Maelle these days," you ask, keeping your voice level.',
      "Oda, where can I find Maelle these days?",
    );
    expect(v).toHaveLength(0);
  });

  test("the trailing-attribution shape flags too", () => {
    const v = checkPlayerQuoteFidelity('"The board owes me double," you snap.', "I look over the postings.");
    expect(v).toHaveLength(1);
  });

  test("one-word glue quotes are skipped; NPC quotes are not the PC's problem", () => {
    expect(checkPlayerQuoteFidelity('"Yes," you manage.', "I nod.")).toHaveLength(0);
    expect(
      checkPlayerQuoteFidelity('Veil says, "The ledger does not lie about salvage rights."', "I nod."),
    ).toHaveLength(0);
  });

  test("no playerInput (heartbeat turn) skips the check", () => {
    expect(checkPlayerQuoteFidelity('You say, "anything at all."', undefined)).toHaveLength(0);
  });

  test("adjacent NPC lines never mint a pseudo-span from a close+open quote pair (r12 fixture-social t9)", () => {
    // The old window regexes keyed on ANY quote character: between two NPC lines, the closing quote
    // of one and the opening quote of the next read as a span, and the UNQUOTED stage direction
    // between them (" She nods at the door. ") was flagged as the player's invented speech because
    // the next line happened to start with "You tell".
    const prose =
      `"I'll walk with you. The hall's just up this lane — past the coil-rope shed, under the sign ` +
      `with the chipped helm." She nods at the door. "You tell me what you're after once we're inside."`;
    expect(checkPlayerQuoteFidelity(prose, "Sergeant Veil, care to join my party?")).toHaveLength(0);
  });

  test("paired spans still catch a genuinely invented PC line on either attribution side (r12)", () => {
    expect(
      checkPlayerQuoteFidelity('You murmur, "The tide will not wait for us," and turn away.', "I look at the sea."),
    ).toHaveLength(1);
    expect(
      checkPlayerQuoteFidelity('"The tide will not wait for us," you murmur.', "I look at the sea."),
    ).toHaveLength(1);
  });
});
