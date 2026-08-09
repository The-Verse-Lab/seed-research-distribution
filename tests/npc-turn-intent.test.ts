/**
 * NpcTurnIntent — the rich structured intent an NPC emits for PUBLIC turns (the DM renders it into
 * staged prose; the NPC no longer speaks a raw bubble). Proves: the defensive JSON parse (short keys +
 * interface-name aliases, fence tolerance, clamping); replyTurn/decideTurn map the JSON to fields;
 * a non-JSON model falls back to the whole line as speech (never-stall); a minor-safety block carries
 * the OOC refusal with blocked:true and is never parsed; a blocked/empty autonomous beat goes silent.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { NpcAgent, actVerbsOffered, parseNpcTurnIntent } from "../src/agents/npc.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { ChatMessage, CompletionChunk } from "../src/llm/types.ts";
import type { GameState } from "../src/state/types.ts";
import { loadExample } from "./support/harness.ts";

/** A gateway whose stream yields exactly the given chunks (delta/blocked) — the only method these methods use. */
const scriptGateway = (chunks: CompletionChunk[]): LlmGateway =>
  ({
    // eslint-disable-next-line require-yield
    async *stream() {
      for (const c of chunks) yield c;
    },
  }) as unknown as LlmGateway;

const deltas = (text: string): CompletionChunk[] => [{ delta: text, done: false }];
const NO_STATE = {} as unknown as GameState;

describe("parseNpcTurnIntent — defensive JSON", () => {
  test("maps short model keys to interface fields", () => {
    const p = parseNpcTurnIntent('{"speech":"The road is blocked.","action":"waves you closer","motive":"warn quietly","act":{"do":"move","target":"loc.gate"},"targets":["you"],"confidence":0.7,"facts":["the road is blocked"]}');
    expect(p).toEqual({
      visibleSpeech: "The road is blocked.",
      visibleAction: "waves you closer",
      privateIntent: "warn quietly",
      desiredAct: { do: "move", target: "loc.gate" },
      targets: ["you"],
      confidence: 0.7,
      factsAsserted: ["the road is blocked"],
    });
  });

  test("the CLOSED act: an unknown verb, a `none`, and the retired free-text `command` all yield no act", () => {
    // r8 regex audit. The act replaced a free-text imperative that a keyword net had to guess a
    // reducer Command from; a model that still emits the old field must not be half-understood —
    // "walk over to the counting-house and hand Mira the letter" is a sentence, not an id, and
    // guessing one from it is precisely the machinery this removed. All three degrade to speech.
    expect(parseNpcTurnIntent('{"speech":"Hi","act":{"do":"teleport","target":"loc.gate"}}')?.desiredAct).toBeUndefined();
    expect(parseNpcTurnIntent('{"speech":"Hi","act":{"do":"none"}}')?.desiredAct).toBeUndefined();
    expect(
      parseNpcTurnIntent('{"speech":"Hi","command":"walk over to the counting-house and hand Mira the letter"}')
        ?.desiredAct,
    ).toBeUndefined();
  });

  test("the act's ids are trimmed and a `give` keeps its recipient", () => {
    const p = parseNpcTurnIntent('{"speech":"Here.","act":{"do":"give","target":" item.letter ","to":"npc.mira"}}');
    expect(p?.desiredAct).toEqual({ do: "give", target: "item.letter", to: "npc.mira" });
  });

  test("accepts interface-name aliases and tolerates markdown fences / surrounding prose", () => {
    const p = parseNpcTurnIntent('Sure!\n```json\n{"visibleSpeech":"Hi","factsAsserted":["x"]}\n```\n');
    expect(p?.visibleSpeech).toBe("Hi");
    expect(p?.factsAsserted).toEqual(["x"]);
  });

  test("clamps confidence to 0..1 and drops blank/non-string array entries", () => {
    const p = parseNpcTurnIntent('{"speech":"hi","confidence":9,"facts":["ok","",3,"  "]}');
    expect(p?.confidence).toBe(1);
    expect(p?.factsAsserted).toEqual(["ok"]);
  });

  test("parses structured mood-tagged speech lines and flattens visibleSpeech", () => {
    const p = parseNpcTurnIntent(
      '{"speech":[{"say":"Get back!","mood":"angry"},{"say":"please","mood":"afraid"}],"action":"raises a hand"}',
    );
    expect(p?.visibleSpeech).toBe("Get back! please");
    expect(p?.lines).toEqual([
      { text: "Get back!", mood: "angry" },
      { text: "please", mood: "afraid" },
    ]);
    expect(p?.visibleAction).toBe("raises a hand");
  });

  test("clamps an unknown mood to neutral and accepts bare-string speech array entries", () => {
    const p = parseNpcTurnIntent('{"speech":[{"say":"Hi","mood":"smug"},"welcome"]}');
    expect(p?.lines).toEqual([
      { text: "Hi", mood: "neutral" },
      { text: "welcome", mood: "neutral" },
    ]);
  });

  test("a plain-string speech stays back-compatible — no `lines` key emitted", () => {
    const p = parseNpcTurnIntent('{"speech":"Well met."}');
    expect(p?.visibleSpeech).toBe("Well met.");
    expect(p && "lines" in p).toBe(false);
  });

  test("returns null when there is no JSON object", () => {
    expect(parseNpcTurnIntent("just a plain spoken line")).toBeNull();
    expect(parseNpcTurnIntent("")).toBeNull();
  });

  test("carries the raw relationship nudge (living relationships; clamped later at apply)", () => {
    expect(parseNpcTurnIntent('{"speech":"hi","relationship":2}')?.relationshipNudge).toBe(2);
    expect(parseNpcTurnIntent('{"speech":"hi","relationship":0}')?.relationshipNudge).toBe(0);
    expect(parseNpcTurnIntent('{"speech":"hi","relationship":9}')?.relationshipNudge).toBe(9); // raw; clamp is at apply
    expect(parseNpcTurnIntent('{"speech":"hi"}')?.relationshipNudge).toBeUndefined();
  });
});

describe("decideTurn / replyTurn — structured public intent", () => {
  test("decideTurn maps a JSON completion to a structured intent", async () => {
    const playset = await loadExample();
    const template = playset.world.npcs[0]!;
    const agent = new NpcAgent(
      scriptGateway(deltas('{"speech":"Hold there.","action":"steps into your path","motive":"stall the party","facts":["the gate is locked"]}')),
      template,
    );
    const intent = await agent.decideTurn(NO_STATE, { contextText: "", stimulus: "You spot the party.", replyDepth: 0 });
    expect(intent.visibleSpeech).toBe("Hold there.");
    expect(intent.visibleAction).toBe("steps into your path");
    expect(intent.privateIntent).toBe("stall the party");
    expect(intent.factsAsserted).toEqual(["the gate is locked"]);
    expect(intent.blocked).toBeUndefined();
  });

  test("a non-JSON model falls back to the whole line as spoken words (never-stall)", async () => {
    const playset = await loadExample();
    const agent = new NpcAgent(scriptGateway(deltas("Well met, traveler.")), playset.world.npcs[0]!);
    const intent = await agent.replyTurn(NO_STATE, { contextText: "", playerLine: "hello", fromName: "You" });
    expect(intent.visibleSpeech).toBe("Well met, traveler.");
    expect(intent.visibleAction).toBeUndefined();
    expect(intent.blocked).toBeUndefined();
  });

  test("a blocked reply carries the OOC refusal with blocked:true (never parsed as intent)", async () => {
    const playset = await loadExample();
    const agent = new NpcAgent(scriptGateway([{ delta: "I can't continue with that.", blocked: true, done: false }]), playset.world.npcs[0]!);
    const intent = await agent.replyTurn(NO_STATE, { contextText: "", playerLine: "…", fromName: "You" });
    expect(intent.blocked).toBe(true);
    expect(intent.visibleSpeech).toBe("I can't continue with that.");
  });

  test("motive-only JSON (valid silence) never leaks the raw JSON or private motive as speech (audit #4)", async () => {
    const playset = await loadExample();
    // Empty speech array + a private motive is VALID structured silence, not a parse failure. The old
    // `hasField` gate ignored motive/facts-only intents and dumped the raw JSON (motive and all) into
    // the player's dialogue. It must stay silent, with the motive captured privately.
    const agent = new NpcAgent(scriptGateway(deltas('{"speech":[],"motive":"secretly betray the party"}')), playset.world.npcs[0]!);
    const intent = await agent.replyTurn(NO_STATE, { contextText: "", playerLine: "hi", fromName: "You" });
    expect(intent.visibleSpeech).toBe("");
    expect(intent.privateIntent).toBe("secretly betray the party");
  });

  test("a truncated/garbled JSON completion is NOT spoken verbatim — degrades to silence (audit #4)", async () => {
    const playset = await loadExample();
    // A partial `{"speech":"We…` (transport cut mid-stream) fails to parse. It must never reach the
    // screen as literal braces/fragments — a JSON-shaped raw line degrades to silence, not speech.
    const agent = new NpcAgent(scriptGateway(deltas('{"speech":"We')), playset.world.npcs[0]!);
    const intent = await agent.replyTurn(NO_STATE, { contextText: "", playerLine: "hi", fromName: "You" });
    expect(intent.visibleSpeech).toBe("");
    expect(intent.visibleSpeech).not.toContain("{");
  });

  test("a blocked or empty autonomous beat goes silent — a NEUTRAL beat, NEVER the private goal (F5)", async () => {
    const playset = await loadExample();
    const template = playset.world.npcs[0]!;
    expect(template.goals.length).toBeGreaterThan(0); // the example NPC has authored goals to (not) leak

    // A minor-safety block: decideTurn degrades to the neutral filler, not the OOC refusal, and NOT the goal.
    const blockedAgent = new NpcAgent(scriptGateway([{ delta: "nope", blocked: true, done: false }]), template);
    const blocked = await blockedAgent.decideTurn(NO_STATE, { contextText: "", stimulus: "beat", replyDepth: 0 });
    expect(blocked.blocked).toBeUndefined(); // the OOC refusal is NOT surfaced on an autonomous beat
    expect(blocked.visibleSpeech).toBe("");
    expect(blocked.visibleSpeech).not.toBe(template.goals[0]); // the private motivation never leaks

    // An EMPTY completion (gateway hiccup) takes the same never-stall path in both decide() and decideTurn().
    const emptyAgent = new NpcAgent(scriptGateway([{ delta: "", done: true }]), template);
    const thin = await emptyAgent.decide(NO_STATE, { contextText: "", stimulus: "beat", replyDepth: 0 });
    expect(thin.text).toBe("");
    expect(thin.text).not.toBe(template.goals[0]);
    const structured = await emptyAgent.decideTurn(NO_STATE, { contextText: "", stimulus: "beat", replyDepth: 0 });
    expect(structured.visibleSpeech).toBe("");
    expect(structured.visibleSpeech).not.toBe(template.goals[0]);
  });
});

/**
 * r13 fix — playtest fixture-work t8/t18: Oda named `take_job` for dock work he was never offered as a
 * legal candidate (not party leader, nothing on the quest board), and it always dropped as an
 * `illegal` grounding fallback. Before this fix the "do" enum in the JSON schema instruction was
 * always the full static verb list, so the model saw `take_job` presented as a normal choice even
 * with an empty `take_job` candidate row. `actVerbsOffered` derives the legal enum from the actor's
 * own rendered `# CANDIDATE ACTIONS` block instead.
 */
describe("actVerbsOffered — the do-enum reflects only what this actor was actually offered", () => {
  test("an empty candidate block offers only 'none'", () => {
    expect(actVerbsOffered(undefined)).toEqual(["none"]);
    expect(actVerbsOffered([])).toEqual(["none"]);
  });

  test("reads the verb off each rendered candidate row, deduped, plus 'none'", () => {
    const lines = [
      `- "move": loc.b (The Vault) | loc.c (The Yard)`,
      `- "give": item.rope (a coil of rope)`,
      `  (for "give", also set "to" to one of: pc.you (You))`,
      `- "rest": no target — you would recover 4 energy`,
    ];
    expect(actVerbsOffered(lines).sort()).toEqual(["give", "move", "none", "rest"].sort());
  });

  test("take_job is absent when the actor's take_job candidate row is absent (the fixture-work repro)", () => {
    const lines = [`- "move": loc.b (The Vault)`];
    expect(actVerbsOffered(lines)).not.toContain("take_job");
  });
});

describe("decideTurn — the JSON schema's do enum matches the actor's real candidates", () => {
  /** Records the ChatMessage[] sent to the gateway, then replies with a fixed completion. */
  const capturingGateway = (
    sink: ChatMessage[][],
    text: string,
  ): LlmGateway =>
    ({
      async *stream(_role: string, req: { messages: ChatMessage[] }) {
        sink.push(req.messages);
        yield { delta: text, done: true } as CompletionChunk;
      },
    }) as unknown as LlmGateway;

  test("an actor offered no take_job candidate never sees take_job in the schema's do enum", async () => {
    const playset = await loadExample();
    const template = playset.world.npcs[0]!;
    const sent: ChatMessage[][] = [];
    const agent = new NpcAgent(capturingGateway(sent, '{"speech":"Just passing through."}'), template);
    await agent.decideTurn(NO_STATE, {
      contextText: "",
      stimulus: "You spot the party.",
      replyDepth: 0,
      actCandidates: [`- "move": loc.b (The Vault)`],
    });
    const prompt = sent[0]!.map((m) => m.content).join("\n");
    expect(prompt).toContain(`"do": "none|move"`);
    expect(prompt).not.toContain("take_job");
  });

  test("a leader offered a take_job candidate DOES see it in the schema's do enum", async () => {
    const playset = await loadExample();
    const template = playset.world.npcs[0]!;
    const sent: ChatMessage[][] = [];
    const agent = new NpcAgent(capturingGateway(sent, '{"speech":"On it."}'), template);
    await agent.decideTurn(NO_STATE, {
      contextText: "",
      stimulus: "You spot the party.",
      replyDepth: 0,
      actCandidates: [`- "take_job": q.deliver (Deliver the crate)`],
    });
    const prompt = sent[0]!.map((m) => m.content).join("\n");
    expect(prompt).toContain(`"do": "none|take_job"`);
  });
});
