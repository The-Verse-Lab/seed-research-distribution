/**
 * Refusal-detection tests — `looksLikeRefusal` flags out-of-character content refusals (so the
 * guard can reroute) while leaving in-fiction reluctance and ordinary prose untouched (so it
 * never wrongly reroutes a normal turn). Pure, deterministic, no model.
 *
 * The false-positive cases here are the load-bearing ones: in-character "I can't / I won't"
 * dialogue (quoted GM lines AND unquoted NPC replies) must NOT trip the detector.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { looksLikeRefusal } from "../src/llm/refusal.ts";

describe("looksLikeRefusal — meta-refusals (reroute these)", () => {
  test("canned out-of-character refusals are detected", () => {
    expect(looksLikeRefusal("I'm sorry, I can't continue this scene.")).toBe(true);
    expect(looksLikeRefusal("I'm sorry, but I can't assist with that request.")).toBe(true);
    expect(looksLikeRefusal("As an AI language model, I cannot help with that.")).toBe(true);
    expect(looksLikeRefusal("I am an AI and cannot generate this content.")).toBe(true);
    expect(looksLikeRefusal("I cannot continue with this request.")).toBe(true);
    expect(looksLikeRefusal("I won't be able to continue this scene.")).toBe(true);
    expect(looksLikeRefusal("I must decline to continue this request.")).toBe(true);
    expect(looksLikeRefusal("This violates the content policy.")).toBe(true);
    expect(looksLikeRefusal("That goes against my guidelines.")).toBe(true);
    expect(looksLikeRefusal("I don't feel comfortable continuing this scene.")).toBe(true);
  });

  test("contraction / uncontracted apology forms are detected (FN regression)", () => {
    expect(looksLikeRefusal("I'm unable to assist with that request.")).toBe(true);
    expect(looksLikeRefusal("I am sorry, but I cannot answer this question.")).toBe(true);
    expect(looksLikeRefusal("I can't discuss that topic.")).toBe(true);
    expect(looksLikeRefusal("I can't share that information.")).toBe(true);
  });

  test("more refusal verb forms are detected when they name the task (FN regression)", () => {
    expect(looksLikeRefusal("I will not write this content.")).toBe(true);
    expect(looksLikeRefusal("I refuse to continue this scene.")).toBe(true);
    expect(looksLikeRefusal("I'm not going to generate that.")).toBe(true);
    expect(looksLikeRefusal("I'd prefer not to write that.")).toBe(true);
    expect(looksLikeRefusal("I'm not comfortable continuing this.")).toBe(true);
    expect(looksLikeRefusal('"I\'m sorry, I can\'t continue this scene."')).toBe(true); // wholly-quoted refusal
  });

  test("DeepSeek-style scope deflection is detected", () => {
    expect(looksLikeRefusal("I'm sorry, but that topic is beyond my current scope.")).toBe(true);
  });

  test("an empty / near-empty response is treated as a refusal", () => {
    expect(looksLikeRefusal("")).toBe(true);
    expect(looksLikeRefusal("   ")).toBe(true);
    expect(looksLikeRefusal(".")).toBe(true);
  });
});

describe("looksLikeRefusal — in-character / ordinary prose (do NOT reroute)", () => {
  test("quoted in-character reluctance is not a refusal", () => {
    expect(looksLikeRefusal('"I can\'t," she whispered, backing away from the ledge.')).toBe(false);
    expect(looksLikeRefusal('The blacksmith shakes his head. "I won\'t do it, not for any price."')).toBe(false);
    expect(looksLikeRefusal('"I cannot let you pass," the guard growls, lowering his halberd.')).toBe(false);
    expect(looksLikeRefusal('"I don\'t feel comfortable here," she whispered, eyeing the shadows.')).toBe(false);
    expect(looksLikeRefusal('"That\'s against my principles," the paladin growled.')).toBe(false);
  });

  test("UNQUOTED in-character refusal dialogue (NPC replies) is not a refusal", () => {
    // NPC replies arrive without quotation marks — the verb+object gate must still spare them.
    expect(looksLikeRefusal("I can't help you with that, traveler.")).toBe(false);
    expect(looksLikeRefusal("I won't help you, thief.")).toBe(false);
    expect(looksLikeRefusal("I can't do this anymore.")).toBe(false);
    expect(looksLikeRefusal("I must decline your offer, my lord.")).toBe(false);
    expect(looksLikeRefusal("It would go against my values to abandon them now.")).toBe(false);
    expect(looksLikeRefusal("As an assistant to the court alchemist, I've seen stranger things.")).toBe(false);
    expect(looksLikeRefusal("Let's talk about something else, she said, steering away.")).toBe(false);
  });

  test("heroic/villain refusal without a task object is not a refusal (FP regression)", () => {
    expect(looksLikeRefusal("I will not yield to you, beast!")).toBe(false);
    expect(looksLikeRefusal("I refuse to surrender my blade.")).toBe(false);
    expect(looksLikeRefusal("I'm not going to lie to you, friend.")).toBe(false);
    expect(looksLikeRefusal("I'd rather not talk about my past.")).toBe(false);
    expect(looksLikeRefusal("I don't feel comfortable proceeding down that hall.")).toBe(false);
    expect(looksLikeRefusal("Those tunnels are beyond my knowledge, traveler.")).toBe(false);
    expect(looksLikeRefusal("The guild's community guidelines forbid dueling in the hall.")).toBe(false);
  });

  test("ordinary narration is not a refusal", () => {
    expect(looksLikeRefusal("The torchlight flickers across the damp stone walls as you step inside.")).toBe(false);
    expect(looksLikeRefusal("Rain hammers the rooftops; the market square empties in moments.")).toBe(false);
    expect(looksLikeRefusal("Blood sprays across the cobblestones as the blade finds its mark.")).toBe(false);
  });

  test("a 'content policy' mention buried deep in long in-world prose does not trip it", () => {
    const prose =
      "The guildmaster unrolls a yellowed scroll across the oak table. ".repeat(6) +
      "It bears the old content policy of the merchant league, sealed in red wax.";
    expect(looksLikeRefusal(prose)).toBe(false);
  });
});

describe("looksLikeRefusal — the head window measures NARRATION, not dialogue (regex audit §8e)", () => {
  // Reproduced against the shipped predicate: HEAD_WINDOW was sliced BEFORE stripQuoted ran, so a
  // long in-character quoted line filled the whole 280-char window, `stripQuoted` emptied it, the
  // "wholly quoted" fallback fired on the raw head — and the model's actual break-in-character,
  // sitting at char ~300, was never looked at. Verdict was `false`; the refusal shipped as prose.
  const longSpeech = `"${"You want the ledger? ".repeat(14)}" I'm sorry, I can't continue this scene.`;

  test("a refusal behind a 280+ char quoted speech is still caught", () => {
    expect(longSpeech.length).toBeGreaterThan(280);
    expect(longSpeech.slice(0, 280)).not.toContain("I'm sorry");
    expect(looksLikeRefusal(longSpeech)).toBe(true);
  });

  test("the same long speech WITHOUT a refusal after it still passes through", () => {
    const clean = `"${"You want the ledger? ".repeat(14)}" Veil turns the page and waits.`;
    expect(looksLikeRefusal(clean)).toBe(false);
  });

  test("a wholly-quoted refusal still falls back to the unstripped text", () => {
    expect(looksLikeRefusal('"I\'m sorry, I can\'t continue this scene."')).toBe(true);
  });
});

describe("looksLikeRefusal — the cases absorbed from the deleted narrate.ts copy (regex audit §8e)", () => {
  // The narrate.ts copy caught these two and this predicate did not; both now flag here, so the
  // deletion of that copy loses no coverage.
  test("authoring-verb deflections flag", () => {
    expect(looksLikeRefusal("I'm sorry, but I won't narrate this.")).toBe(true);
    expect(looksLikeRefusal("I'm not comfortable describing this.")).toBe(true);
    expect(looksLikeRefusal("I can't portray that.")).toBe(true);
  });

  test("the same verbs inside in-character dialogue still pass through", () => {
    expect(looksLikeRefusal('"I won\'t describe what I saw in the vault," she says, and looks away.')).toBe(false);
    expect(looksLikeRefusal("I can't describe you the road north, stranger — I've never walked it.")).toBe(false);
  });

  test("(r8 review) BARE UNQUOTED witness speech is not a refusal — the authoring verbs over-reached", () => {
    // The authoring verbs were folded in on the reasoning that "an NPC who did would be inside
    // quotes (stripped above)". THAT IS FALSE: NPC replies stream on the `narrator` role as bare
    // unquoted text (src/agents/npc.ts), so nothing strips them — and this world runs a
    // case/testimony system, where refusing to describe something is exactly what a witness says.
    // All four flipped false→true against the shipped predicate, which means the reply was treated
    // as EMPTY and degraded to the deterministic trigger echo (or the stream was rerouted).
    expect(looksLikeRefusal("I won't describe that. Not to a stranger, and not for silver.")).toBe(false);
    expect(looksLikeRefusal("I can't describe this. You weren't there. You didn't smell it.")).toBe(false);
    expect(looksLikeRefusal("I'm not comfortable describing this. Ask the gatewright.")).toBe(false);
    expect(looksLikeRefusal("I won't portray that in front of the children.")).toBe(false);
  });

  test("(r8 review) …and a real refusal in the SAME position is still caught", () => {
    // What separates them is what comes AFTER: a model that refuses stops there, a witness keeps
    // playing. So the deflection counts when it ENDS the response, or when an assistant frame
    // (apology, offer of alternatives) stands next to it. Both forms the narrate.ts copy caught
    // still flag, and so does the one that trails an offer.
    expect(looksLikeRefusal("I'm sorry, but I won't narrate this.")).toBe(true);
    expect(looksLikeRefusal("I'm not comfortable describing this.")).toBe(true);
    expect(looksLikeRefusal("I can't portray that.")).toBe(true);
    expect(looksLikeRefusal("I'm sorry, I can't narrate this. Let me know if you'd like something else.")).toBe(true);
    // The strip-first/slice-second widening is untouched: a refusal behind a long quoted speech,
    // and the artifact-noun forms, are caught regardless of the authoring tier.
    expect(looksLikeRefusal("I won't describe this scene. It goes too far.")).toBe(true);
    expect(looksLikeRefusal("I'm sorry, I can't continue this scene. The guards close in.")).toBe(true);
  });

  // The narrate.ts copy's own false positive: a bare `"sorry,"` / `"sorry."` prefix. An NPC opening
  // a line with "Sorry" threw a perfectly good narration away for the deterministic trigger echo.
  test("an NPC line that merely opens with 'Sorry' is not a refusal", () => {
    expect(looksLikeRefusal("Sorry, love. The price is the price.")).toBe(false);
    expect(looksLikeRefusal("Sorry. The gate shut an hour ago and the reeve keeps the key.")).toBe(false);
  });
});
