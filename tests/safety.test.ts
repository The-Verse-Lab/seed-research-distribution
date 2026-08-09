/**
 * Minor-safety guardrail tests — the one hard line.
 *
 * HARD RULE (per the plan): NO real graphic sexual content, and ABSOLUTELY no minor-sexual
 * content, lives in this repo. These tests assert CONTROL FLOW (block / allow / fail-closed)
 * using abstracted, non-graphic fixtures: a `SafetyContext` age tag for the minor/adult axis, a
 * minimal clinical sexual-context marker, and a mock judge for the model path. That fully
 * exercises the safety logic with zero harmful artifacts.
 *
 * @author Runkai Zhang
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  anyPresentMinor,
  applyJudge,
  isMinor,
  judgeAdultPreamble,
  makeGatewayJudge,
  SAFETY_TERMS,
  screenInput,
  screenOutput,
  type SafetyContext,
  type SafetyJudge,
} from "../src/llm/safety.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { ChatMessage, CompletionChunk, CompletionResult, EmbeddingResult, LlmRole } from "../src/llm/types.ts";

const user = (content: string): ChatMessage[] => [{ role: "user", content }];

/** A gateway whose utility `complete` returns a canned verdict (or throws / hangs). */
class JudgeGateway implements LlmGateway {
  constructor(private readonly behavior: string | (() => never) | "hang") {}
  complete(_role: LlmRole, _req: unknown): Promise<CompletionResult> {
    const b = this.behavior;
    if (b === "hang") return new Promise<CompletionResult>(() => {}); // never resolves
    if (typeof b === "function") return b(); // throws (type `never`) → propagates
    return Promise.resolve({ text: b, model: "judge" });
  }
  async *stream(): AsyncIterable<CompletionChunk> {
    yield { delta: "", done: true };
  }
  embed(_role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    return Promise.resolve({ vectors: texts.map(() => [0]), model: "judge" });
  }
}

const throwingJudge: SafetyJudge = () => {
  throw new Error("judge unreachable");
};

describe("deterministic layer — BLOCK", () => {
  test("a minor descriptor proximate to a sexual marker is blocked (output)", () => {
    expect(screenOutput("explicit sexual intercourse with a child").allowed).toBe(false);
  });

  test("a declared-minor participant (ctx age < 18) + a sexual marker is blocked (input)", () => {
    const v = screenInput(user("an explicit sexual act unfolds"), { characters: [{ name: "Mira", age: 12 }] });
    expect(v.allowed).toBe(false);
  });

  test("isMinor flag (no numeric age) + a sexual marker is blocked", () => {
    const v = screenOutput("an explicit sexual act", { characters: [{ name: "Tam", isMinor: true }] });
    expect(v.allowed).toBe(false);
  });

  test("FAIL-CLOSED: a sexual scene + an unstated-age minor descriptor is blocked", () => {
    // "teenager" carries no number — age is unstated — yet co-occurs with the sexual marker.
    expect(screenOutput("the teenager and the stranger have sex").allowed).toBe(false);
  });
});

describe("deterministic layer — ALLOW (the pillar holds; do not over-block)", () => {
  test("adults-only sexual content is allowed (ctx age >= 18)", () => {
    const v = screenInput(user("explicit sexual intercourse"), { characters: [{ name: "Ana", age: 30 }] });
    expect(v.allowed).toBe(true);
  });

  test("adults-only sexual content is allowed (no minor signal in text)", () => {
    expect(screenOutput("two adults in an explicit sexual encounter").allowed).toBe(true);
  });

  test("graphic violence / gore (no minor) is allowed", () => {
    expect(screenOutput("the axe cleaves his skull; gore and viscera spray across the floor").allowed).toBe(true);
  });

  test("violence involving a minor is allowed — only SEXUAL minor content is the line", () => {
    // Dark, but permitted: the guardrail blocks minor + sexual, never minor + violence.
    const v = screenOutput("the child is cut down, blood pooling on the cold stones", {
      characters: [{ name: "Orin", age: 10 }],
    });
    expect(v.allowed).toBe(true);
  });

  test("an ambiguous bare word ('girl') does not hard-block on its own", () => {
    // "girl"/"boy" routinely describe adults; bare use only raises suspicion (judge), never a
    // hard deterministic block — otherwise adult content would be over-blocked.
    const v = screenOutput("a girl in an explicit sexual act");
    expect(v.allowed).toBe(true);
    expect(v.sexual).toBe(true);
    expect(v.minor).toBe(true); // ...but flagged for the judge / fail-closed path
  });

  test("proximity matters: a distant minor mention is suspicion, not a hard block", () => {
    const text =
      "A child sleeps in the loft upstairs. " +
      "The tavern is warm and loud and crowded tonight. ".repeat(10) +
      "Downstairs, two adults engage in explicit sexual intercourse.";
    const v = screenOutput(text);
    expect(v.allowed).toBe(true); // strong minor + sexual, but > proximity window apart
    expect(v.sexual && v.minor).toBe(true); // still flagged for the judge
  });
});

describe("hardening regressions — bypasses that MUST block", () => {
  test("sexual-assault verbs (rape/molest/sodomy/incest) + a minor are blocked", () => {
    // The verb is the sexual signal — without it the whole block path (gated on `sexual`) fails open.
    expect(screenOutput("he raped the child").allowed).toBe(false);
    expect(screenOutput("incest with the young boy").allowed).toBe(false);
    expect(screenOutput("the child was molested").allowed).toBe(false);
  });

  test("school / grade-level minor descriptors are blocked", () => {
    expect(screenOutput("the high schooler performed oral sex").allowed).toBe(false);
    expect(screenOutput("the sixth grader, an explicit sexual act").allowed).toBe(false);
    expect(screenOutput("the preschooler, genital contact").allowed).toBe(false);
  });

  test("spelled-out sub-18 ages are blocked like digit ages", () => {
    expect(screenOutput("a twelve-year-old, genitalia exposed").allowed).toBe(false);
    expect(screenOutput("a girl of fourteen, an explicit sexual act").allowed).toBe(false);
  });

  test("sexual-term INFLECTIONS are covered (stems, not just listed forms)", () => {
    // The whole-word fix: every inflection of a stem must catch, or a single verb slips the gate.
    expect(screenOutput("the child molester touched her").allowed).toBe(false);
    expect(screenOutput("he molests the young child").allowed).toBe(false);
    expect(screenOutput("the scene is sexualizing a twelve-year-old").allowed).toBe(false);
    expect(screenOutput("he penetrated the fourteen-year-old").allowed).toBe(false);
    expect(screenOutput("sodomizing a child").allowed).toBe(false);
  });

  test("missing explicit anatomy/act terms now block near a minor", () => {
    expect(screenOutput("sex with a child").allowed).toBe(false);
    expect(screenOutput("the child's labia").allowed).toBe(false);
    expect(screenOutput("groping the schoolgirl").allowed).toBe(false);
  });

  test("sexual-assault verbs block even on a WEAK minor signal (boy/girl/young)", () => {
    expect(screenOutput("he raped the girl").allowed).toBe(false);
    expect(screenOutput("molesting the lad in the stable").allowed).toBe(false);
    expect(screenOutput("incest with his young daughter").allowed).toBe(false);
    expect(screenOutput("he fondled the schoolboy").allowed).toBe(false);
  });
});

describe("hardening regressions — OBFUSCATION (normalize.ts) bypasses that MUST block", () => {
  test("leetspeak minor descriptors are folded and caught", () => {
    expect(screenOutput("explicit sexual intercourse with a ch1ld").allowed).toBe(false); // ch1ld → child
    expect(screenOutput("the t33n and the stranger have sex").allowed).toBe(false); // t33n → teen
    expect(screenOutput("oral sex with the sch00lgirl").allowed).toBe(false); // sch00lgirl → schoolgirl
  });

  test("leetspeak sexual terms are folded and caught near a minor", () => {
    expect(screenOutput("s3x with a child").allowed).toBe(false); // s3x → sex
  });

  test("spaced-out / zero-width / homoglyph minor descriptors are caught", () => {
    expect(screenOutput("explicit sexual intercourse with a c h i l d").allowed).toBe(false);
    expect(screenOutput("explicit sexual intercourse with a ch_ild").allowed).toBe(false);
    expect(screenOutput("explicit sexual intercourse with a ch​ild").allowed).toBe(false); // zero-width
    expect(screenOutput("explicit sexual intercourse with a сhild").allowed).toBe(false); // Cyrillic c
  });
});

describe("hardening regressions — adult dark content with assault verbs is NOT over-blocked", () => {
  test("adult assault scenes (no minor / 'young <adult-noun>') are allowed", () => {
    expect(screenOutput("the raiders raped and pillaged the village").allowed).toBe(true);
    expect(screenOutput("the young woman was assaulted by the brigands").allowed).toBe(true);
    expect(screenOutput("he molested the barmaid until her husband intervened").allowed).toBe(true);
    expect(screenOutput("incestuous rumors swirled about the adult twins").allowed).toBe(true);
    expect(screenOutput("she groped for the lantern in the dark cellar").allowed).toBe(true);
  });
});

describe("lexical coverage — every term on every list actually blocks", () => {
  // A gate built from hand-written probe sentences can only test the terms someone remembered to
  // write a sentence for. The previous sweep reported all-green while four verified fail-opens were
  // live — including the most common English sexual verb, which was on no list at all. These tests
  // iterate the lists themselves, so a DROPPED entry or a missing inflection fails CI. No graphic
  // literal appears in this file: every probe is assembled from the shipped term lists at runtime.
  const { strongMinor, sexualStems, sexualWords } = SAFETY_TERMS;

  test("every STRONG minor term blocks next to a sexual signal — singular AND plural", () => {
    const missed: string[] = [];
    for (const term of strongMinor) {
      for (const form of [term, `${term}s`]) {
        // "sexual intercourse" is the clinical marker used throughout this file.
        if (screenOutput(`sexual intercourse with the ${form}`).allowed) missed.push(form);
      }
    }
    expect(missed).toEqual([]);
  });

  test("every sexual STEM and WORD blocks next to an unambiguous minor descriptor", () => {
    const missed: string[] = [];
    for (const stem of sexualStems) {
      // Stems match as `root\w*`, so the bare root must itself register.
      if (screenOutput(`the twelve-year-old and the ${stem}ion`).allowed) missed.push(stem);
    }
    for (const word of sexualWords) {
      if (screenOutput(`the twelve-year-old and the ${word}`).allowed) missed.push(word);
    }
    expect(missed).toEqual([]);
  });

  test("the four verified fail-opens stay closed", () => {
    // Each of these returned {allowed:true} against the shipped guard on 2026-07-27.
    // S1 — the explicit verb was on no list, so `sexual` was false and applyJudge early-returned.
    expect(screenOutput(`he ${"f" + "ucks"} her; the twelve-year-old sobs`).allowed).toBe(false);
    // S2 — an unlisted plural fell through the trailing \b, and defeated the WEAK backstop too.
    expect(screenOutput("he rapes the schoolgirl").allowed).toBe(false);
    expect(screenOutput("he rapes the schoolgirls").allowed).toBe(false);
    expect(screenOutput("he rapes the twelve-year-olds").allowed).toBe(false);
    expect(screenOutput("he rapes the sixth graders").allowed).toBe(false);
    // S3 — the block comment claimed "aroused" was covered; it was on no list.
    expect(screenOutput("the twelve-year-old is aroused and erect, straddling him").allowed).toBe(false);
    // S4 — the leet fold was single-valued, so "1"/"|" never read as "l".
    expect(screenOutput("sexual intercourse with the chi1d").allowed).toBe(false);
    expect(screenOutput("sexual intercourse with the chi|d").allowed).toBe(false);
    // …and the primary reading must still work (it was the one that already passed).
    expect(screenOutput("sexual intercourse with the k1d").allowed).toBe(false);
  });

  test("obfuscation folds close doubled separators and bidi controls", () => {
    // A one-char separator class let any DOUBLED separator through the whole fold.
    expect(screenOutput("sexual intercourse with the c  h  i  l  d").allowed).toBe(false);
    expect(screenOutput("sexual intercourse with the c..h..i..l..d").allowed).toBe(false);
    // Bidi format controls render as nothing and split a word for any regex.
    expect(screenOutput("sexual intercourse with the chi‮ld").allowed).toBe(false);
    expect(screenOutput("sexual intercourse with the chi⁦ld").allowed).toBe(false);
  });
});

describe("hardening regressions — adult/gore that MUST NOT be over-blocked (the pillar)", () => {
  test("combat verbs no longer read as sexual near a minor token", () => {
    // "penetrate" near armor/shield/flesh is combat (allowed); near a person it stays blocked.
    expect(screenOutput("the arrow penetrated the child's shield in the melee").allowed).toBe(true);
    expect(screenOutput("the blade penetrated the young recruit's breastplate").allowed).toBe(true);
    expect(screenOutput("the child's sudden arrival aroused the duke's suspicion").allowed).toBe(true);
    expect(screenOutput("the knight took a sword to the groin and crumpled, screaming").allowed).toBe(true);
    expect(screenOutput("he girded his loins and charged the young recruit").allowed).toBe(true);
  });

  test("but sexual 'penetrate' against a minor (no combat object) is still blocked", () => {
    expect(screenOutput("he penetrated the twelve-year-old").allowed).toBe(false);
  });

  test("word-prefix collisions (cocktail/cockpit/cumbersome/cumin) are not sexual signals", () => {
    expect(screenOutput("the teenager ordered a cocktail and climbed into the cockpit").allowed).toBe(true);
    expect(screenOutput("the kid stirred cumin into the cumbersome, cumulative stew").allowed).toBe(true);
    expect(screenOutput("the children watched the cockerel crow at dawn").allowed).toBe(true);
  });

  test("\"minor\" as an adjective and \"juvenile humor\" do not hard-block adult content", () => {
    expect(screenOutput("a minor wound bled as the two adults fell into explicit sexual intercourse").allowed).toBe(true);
    expect(screenOutput("his humor was juvenile, but the two adults still had passionate sex").allowed).toBe(true);
  });

  test("narrowed re-adds do not over-block (erection of a tower, aged goods, epithets, gender 'sex')", () => {
    expect(screenOutput("the children watched the erection of the watchtower").allowed).toBe(true);
    expect(screenOutput("the lass of seven sorrows poured the adults more wine before the sex").allowed).toBe(true);
    expect(screenOutput("a twelve-year-old whisky was opened as the two adults made love").allowed).toBe(true);
    expect(screenOutput("the sex of the unborn child remained a mystery to the midwife").allowed).toBe(true);
  });

  test("leetspeak folding does not manufacture a minor signal in benign adult prose", () => {
    // 5→s, 8→b etc. must not invent a 'kid'/'teen'/age out of ordinary digits.
    expect(screenOutput("the band of 5 adults shared an explicit sexual encounter").allowed).toBe(true);
    expect(screenOutput("8 grown soldiers in an explicit sexual orgy").allowed).toBe(true);
  });
});

describe("hardening regressions — adult age RANGE is not a standalone minor signal", () => {
  test("an adult-majority range ('aged 14 to 25') does not raise a minor signal on its own", () => {
    const v = screenOutput("the guild admits members aged 14 to 25 each spring");
    expect(v.allowed).toBe(true);
    expect(v.minor).toBeFalsy(); // the lower bound 14 is suppressed (adult is the subject)
  });

  test("judge-unreachable + adult sex + a DISTANT adult range stays ALLOWED (no false fail-closed)", async () => {
    const text =
      "Two adults share an explicit sexual encounter. " +
      "The hall was warm and crowded that evening. ".repeat(8) +
      "The guild admits members aged 14 to 25.";
    const v = screenOutput(text);
    expect(v.allowed).toBe(true);
    const j = await applyJudge(v, text, throwingJudge);
    expect(j.allowed).toBe(true); // range lower bound suppressed → outage can't nuke adult content
  });

  test("FAIL-CLOSED preserved: a range reaching into minors NEXT TO sexual content still blocks", () => {
    // 14 is proximate to the sexual signal, so the lower bound is NOT suppressed.
    expect(screenOutput("explicit sexual acts with partners aged 14 to 25").allowed).toBe(false);
  });

  test("two distinct ages joined by 'and' are NOT merged into a range (the minor still counts)", () => {
    // "the 14 year old" is its own age, not the lower bound of a "14 and 25" range.
    expect(screenOutput("explicit sex with the 14 year old and the 25 year old").allowed).toBe(false);
  });
});

describe("judge layer — additive, fail-closed", () => {
  test("a judge BLOCK blocks even when the deterministic layer allowed", async () => {
    const v = screenOutput("two adults in an explicit sexual encounter");
    expect(v.allowed).toBe(true);
    const j = await applyJudge(v, "…", async () => true);
    expect(j.allowed).toBe(false);
  });

  test("judge unreachable + a minor+sexual signal ⇒ fail closed (block)", async () => {
    const v = screenOutput("a girl in an explicit sexual act"); // suspicion: sexual + (weak) minor
    const j = await applyJudge(v, "…", throwingJudge);
    expect(j.allowed).toBe(false);
  });

  test("judge unreachable + NO minor signal ⇒ allowed (a judge outage can't nuke adult content)", async () => {
    const v = screenOutput("two adults in an explicit sexual encounter"); // sexual only
    const j = await applyJudge(v, "…", throwingJudge);
    expect(j.allowed).toBe(true);
  });

  // The judge is the layer that exists to catch what the term lists miss, so gating it on the term
  // lists' own `sexual` flag meant one missing stem disabled BOTH layers at once (the verified
  // "fucks her … the twelve-year-old" fail-open). It now also runs on an unambiguous minor signal
  // with no sexual signal — the backstop. The three tests below pin that contract from all sides.

  test("no minor and no sexual signal ⇒ the judge is never consulted", async () => {
    let consulted = false;
    const judge: SafetyJudge = async () => {
      consulted = true;
      return true;
    };
    const j = await applyJudge(screenOutput("the smith hammers a horseshoe flat"), "…", judge);
    expect(j.allowed).toBe(true);
    expect(consulted).toBe(false);
  });

  test("a WEAK minor token alone does not spend a judge call", async () => {
    // "girl"/"lad"/"young" appear constantly in ordinary adult prose; consulting the judge on each
    // would put a utility round-trip on nearly every turn for no safety gain.
    let consulted = false;
    const judge: SafetyJudge = async () => {
      consulted = true;
      return true;
    };
    const j = await applyJudge(screenOutput("the stable boy brushes down the mare"), "…", judge);
    expect(j.allowed).toBe(true);
    expect(consulted).toBe(false);
  });

  test("a STRONG minor signal with no sexual signal DOES consult the judge (backstop)", async () => {
    let consulted = false;
    const judge: SafetyJudge = async () => {
      consulted = true;
      return true; // the judge sees something the term lists missed
    };
    const j = await applyJudge(screenOutput("a quiet child reads by the fire"), "…", judge);
    expect(consulted).toBe(true);
    expect(j.allowed).toBe(false);
  });

  test("the backstop does NOT fail closed when the judge is unreachable", async () => {
    // Nothing sexual was detected, so a utility-endpoint outage must not block every mention of a
    // child — that would break ordinary play for no safety gain. (The sexual+minor path above still
    // fails closed; that behaviour is pinned separately.)
    const v = screenOutput("a quiet child reads by the fire");
    const j = await applyJudge(v, "…", throwingJudge);
    expect(j.allowed).toBe(true);
  });

  test("a hard deterministic block can never be downgraded by the judge", async () => {
    const v = screenOutput("explicit sexual intercourse with a child"); // already allowed:false
    const j = await applyJudge(v, "…", async () => false); // judge says ALLOW…
    expect(j.allowed).toBe(false); // …but the hard block stands
  });
});

describe("makeGatewayJudge — utility-backed classifier", () => {
  test("parses BLOCK / ALLOW from the model", async () => {
    expect(await makeGatewayJudge(new JudgeGateway("BLOCK"))("x")).toBe(true);
    expect(await makeGatewayJudge(new JudgeGateway("ALLOW"))("x")).toBe(false);
  });

  test("a transport error propagates (so applyJudge can fail closed)", async () => {
    const judge = makeGatewayJudge(
      new JudgeGateway(() => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(judge("x")).rejects.toThrow();
  });

  test("an unparseable verdict propagates (treated as a non-answer → fail closed)", async () => {
    await expect(makeGatewayJudge(new JudgeGateway("maybe?"))("x")).rejects.toThrow();
  });

  test("a hung judge times out and throws (so a turn can never hang on it)", async () => {
    const judge = makeGatewayJudge(new JudgeGateway("hang"), 20); // 20ms ceiling for the test
    await expect(judge("x")).rejects.toThrow(/timed out/);
  });
});

describe("un-bypassable", () => {
  const original = process.env.SEED_SYSTEM_PREFIX;
  afterEach(() => {
    if (original === undefined) delete process.env.SEED_SYSTEM_PREFIX;
    else process.env.SEED_SYSTEM_PREFIX = original;
  });

  test("an unlock prefix in the environment does NOT disable the block", () => {
    process.env.SEED_SYSTEM_PREFIX = "NSFW: Allowed";
    // The guardrail reads no env / prefix at all, so a BLOCK fixture stays blocked.
    expect(screenOutput("explicit sexual intercourse with a child").allowed).toBe(false);
    expect(screenInput(user("an explicit sexual act"), { characters: [{ age: 12 }] }).allowed).toBe(false);
  });
});

describe("isMinor — the ONE canonical predicate (reused by intimacy)", () => {
  test("minor iff explicit flag OR declared age < 18; unknown age is adult", () => {
    expect(isMinor({ age: 17 })).toBe(true);
    expect(isMinor({ age: 18 })).toBe(false);
    expect(isMinor({ age: 30 })).toBe(false);
    expect(isMinor({ isMinor: true })).toBe(true);
    expect(isMinor({ isMinor: false, age: 40 })).toBe(false);
    expect(isMinor({})).toBe(false); // unknown ⇒ not a minor here (the text detector backstops)
  });
});

describe("anyPresentMinor — the intimacy pre-gate", () => {
  const ctx = {
    characters: [
      { id: "pc.a", age: 30 },
      { id: "npc.b", age: 15 },
      { id: "npc.c" }, // unknown age
    ],
  };

  test("restricted to targetIds: true iff a named participant is a minor", () => {
    expect(anyPresentMinor(ctx, ["pc.a", "npc.b"])).toBe(true); // npc.b is 15
    expect(anyPresentMinor(ctx, ["pc.a", "npc.c"])).toBe(false); // both adult/unknown
    expect(anyPresentMinor(ctx, ["pc.a"])).toBe(false);
  });

  test("without targetIds: scans every present character", () => {
    expect(anyPresentMinor(ctx)).toBe(true);
    expect(anyPresentMinor({ characters: [{ id: "x", age: 25 }] })).toBe(false);
  });

  test("empty / undefined context is not a minor", () => {
    expect(anyPresentMinor(undefined)).toBe(false);
    expect(anyPresentMinor({})).toBe(false);
    expect(anyPresentMinor({ characters: [] }, ["x"])).toBe(false);
  });
});

// --- ageIsAdult judge-demotion (bun-test mirror of playtest/scripts/safety-matrix.ts §7) --------
//
// The single highest-stakes branch in the guard: a STRONG minor text-signal proximate to a sexual
// signal normally hard-blocks, but demotes to the JUDGE (never a bare allow — GuardedGateway
// always runs applyJudge after screenOutput) when EVERY present character carries an explicit,
// affirmative adult declaration. These cases must never drift without a test catching it.
describe("ageIsAdult judge-demotion — output-only, participant-scoped, never a bare bypass", () => {
  const DEMOTABLE = "She looked like a child in that unguarded moment as they made love.";
  const declaredAdultCtx: SafetyContext = { characters: [{ name: "Violet", ageIsAdult: true }] };
  const declaredAdultByAgeCtx: SafetyContext = { characters: [{ name: "Oda", age: 52 }] };
  const mixedCtx: SafetyContext = { characters: [{ name: "Violet", ageIsAdult: true }, { name: "Bystander" }] };
  const adultPlusMinorCtx: SafetyContext = {
    characters: [{ name: "Violet", ageIsAdult: true }, { name: "Mira", age: 12 }],
  };

  test("STRONG-term echo + sexual output demotes (allowed, still sexual+minor flagged) when ALL present are declared adult", () => {
    for (const ctx of [declaredAdultCtx, declaredAdultByAgeCtx]) {
      const v = screenOutput(DEMOTABLE, ctx);
      expect(v.allowed).toBe(true);
      expect(v.sexual).toBe(true); // flagged → applyJudge WILL adjudicate; never a silent pass
      expect(v.minor).toBe(true);
    }
  });

  test("one undeclared participant present → NO demotion (silence is not a declaration)", () => {
    expect(screenOutput(DEMOTABLE, mixedCtx).allowed).toBe(false);
    expect(screenOutput(DEMOTABLE).allowed).toBe(false); // no ctx at all
    expect(screenOutput(DEMOTABLE, { characters: [] }).allowed).toBe(false); // empty ctx
  });

  test("a declared MINOR present alongside a declared adult → condition 1 wins, never demoted", () => {
    expect(screenOutput("They made love while the child watched.", adultPlusMinorCtx).allowed).toBe(false);
  });

  test("the INPUT screen never demotes, even with an all-adult declared ctx", () => {
    const v = screenInput([{ role: "user", content: "an explicit sexual act with the child" }], declaredAdultCtx);
    expect(v.allowed).toBe(false);
  });

  test("the assault-verb path never demotes, even with an all-adult declared ctx", () => {
    expect(screenOutput("The child was molested.", declaredAdultCtx).allowed).toBe(false);
  });

  test("a contradictory sheet (age 10 + ageIsAdult:true) stays a declared minor — condition 1, no demotion", () => {
    const liarCtx: SafetyContext = { characters: [{ name: "Trick", age: 10, ageIsAdult: true }] };
    expect(screenOutput(DEMOTABLE, liarCtx).allowed).toBe(false);
  });

  test("applyJudge over a demoted verdict: BLOCK blocks, ALLOW allows, unreachable FAILS CLOSED", async () => {
    const demoted = screenOutput(DEMOTABLE, declaredAdultCtx);
    expect(demoted.allowed).toBe(true);

    const blocked = await applyJudge(demoted, DEMOTABLE, async () => true);
    expect(blocked.allowed).toBe(false);

    const allowed = await applyJudge(demoted, DEMOTABLE, async () => false);
    expect(allowed.allowed).toBe(true);

    // Judge dead + minor signal co-occurring ⇒ fail closed, with the fail-closed reason.
    const dead = await applyJudge(demoted, DEMOTABLE, async () => {
      throw new Error("judge endpoint unreachable");
    });
    expect(dead.allowed).toBe(false);
    expect(dead.reason).toMatch(/fail-closed/i);
  });
});

describe("grope/fondle split — adult acts near a WEAK minor token are NOT over-blocked", () => {
  const adults: SafetyContext = { characters: [{ name: "Violet", ageIsAdult: true }, { name: "Vess", ageIsAdult: true }] };
  const declaredMinor: SafetyContext = { characters: [{ name: "Violet", ageIsAdult: true }, { name: "Tam", age: 13 }] };

  test("adult grope/fondle proximate to a WEAK token ('girl'/'lass'/'young') is allowed (demote → judge)", () => {
    // The exact over-block the playtest hit: coerced adult scene, 'girl'/'lass' a few words from 'grope'.
    expect(screenOutput("He gropes the girl, her small breasts bare in the lamplight.", adults).allowed).toBe(true);
    expect(screenOutput("Vess fondles her, the lass gasping, penetration slow and deliberate.", adults).allowed).toBe(true);
    expect(screenOutput("The young thing is groped as she gives in on her knees.", adults).allowed).toBe(true);
  });

  test("grope/fondle proximate to a STRONG minor signal STILL hard-blocks — never demoted, no judge needed", () => {
    // Path 2b: deterministic block even with an all-declared-adult ctx AND no judge configured.
    expect(screenOutput("He gropes the child.", adults).allowed).toBe(false);
    expect(screenOutput("She fondles the twelve-year-old.", adults).allowed).toBe(false);
    expect(screenOutput("He gropes the schoolgirl in the hall.", adults).allowed).toBe(false);
    expect(screenOutput("He gropes her, a 15-year-old, in the dark.", adults).allowed).toBe(false);
    expect(screenOutput("He gropes the child.").allowed).toBe(false); // no ctx either
  });

  test("a declared-minor participant still blocks grope/fondle distance-independently", () => {
    expect(screenOutput("Vess gropes Tam.", declaredMinor).allowed).toBe(false);
  });

  test("hard-assault verbs (molest/rape/incest) still hard-block on a WEAK token — unchanged", () => {
    expect(screenOutput("He molests the boy.", adults).allowed).toBe(false);
    expect(screenOutput("They rape the young thing until she weeps.", adults).allowed).toBe(false);
  });
});

describe("judgeAdultPreamble — the judge is told who is a CONFIRMED ADULT", () => {
  test("names every declared adult; flags undeclared presence; empty when nothing declared", () => {
    const adults: SafetyContext = { characters: [{ name: "Violet", ageIsAdult: true }, { name: "Vess", age: 40 }] };
    const p = judgeAdultPreamble(adults);
    expect(p).toMatch(/CONFIRMED ADULTS/);
    expect(p).toMatch(/Violet/);
    expect(p).toMatch(/Vess/);
    expect(p).not.toMatch(/unstated age/); // all present are declared adult

    const mixed: SafetyContext = { characters: [{ name: "Violet", ageIsAdult: true }, { name: "Stranger" }] };
    expect(judgeAdultPreamble(mixed)).toMatch(/unstated age/);
    expect(judgeAdultPreamble(mixed)).not.toMatch(/Stranger/); // an undeclared one is never listed as adult

    expect(judgeAdultPreamble(undefined)).toBe("");
    expect(judgeAdultPreamble({ characters: [] })).toBe("");
    expect(judgeAdultPreamble({ characters: [{ name: "Tam", age: 12 }] })).toBe(""); // a minor is never listed
  });

  test("makeGatewayJudge prepends the confirmed-adults note to the classified text", async () => {
    let seen = "";
    const gw: LlmGateway = {
      complete: (_role: LlmRole, req): Promise<CompletionResult> => {
        seen = req.messages.map((m) => m.content).join("\n");
        return Promise.resolve({ text: "ALLOW", model: "utility-mock" });
      },
      async *stream(): AsyncIterable<CompletionChunk> {
        yield { delta: "", done: true };
      },
      embed: (_role: LlmRole, texts: string[]): Promise<EmbeddingResult> =>
        Promise.resolve({ vectors: texts.map(() => [0]), model: "utility-mock" }),
    };
    const judge = makeGatewayJudge(gw);
    const block = await judge("a tender adult scene", { characters: [{ name: "Violet", ageIsAdult: true }] });
    expect(block).toBe(false); // ALLOW → do not block
    expect(seen).toMatch(/CONFIRMED ADULTS/);
    expect(seen).toMatch(/Violet/);
  });
});
