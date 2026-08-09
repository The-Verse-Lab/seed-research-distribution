/**
 * Engine ↔ lore retrieval wiring (M4, Part A + secret-lore follow-up) — end-to-end, offline.
 *
 * Captures the exact narrator-role message during `submitPlayerInput` and asserts:
 *  - a world WITH lore surfaces a `# RELEVANT LORE` section in the shared brief (public retrieval ran);
 *  - secret-tagged lore is segregated into the DM-ONLY `=== SECRET LORE ===` block (after `# NOW`),
 *    NEVER into the shared `# RELEVANT LORE` / contextText portion;
 *  - a world WITHOUT lore produces a message with neither section (omit-when-empty, byte-stable seam).
 * Deterministic: offline gateway (hashToVec embeddings), so this exercises the PLUMBING, not ranking.
 *
 * @author Runkai Zhang
 */
import { heuristicClassifier } from "./support/test-classifier.ts";
import { describe, expect, test } from "bun:test";
import { GameEngine } from "../src/engine/engine.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type { ChatMessage, CompletionChunk, CompletionRequest, LlmRole } from "../src/llm/types.ts";
import { InMemoryGameStateStore } from "./support/memory-store.ts";
import { CampaignSchema, WorldSchema, type PlaySet } from "../src/content/schema.ts";

const STATS = { abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, maxHp: 10, armorClass: 10 };

/** A gateway that records the narrator-role user content of each stream, delegating to offline. */
class RecordingGateway implements LlmGateway {
  readonly narratorBriefs: string[] = [];
  private readonly inner = new OfflineGateway();
  complete(role: LlmRole, req: CompletionRequest) {
    return this.inner.complete(role, req);
  }
  async *stream(role: LlmRole, req: CompletionRequest): AsyncIterable<CompletionChunk> {
    if (role === "narrator") {
      const user = [...req.messages].reverse().find((m: ChatMessage) => m.role === "user");
      if (user) this.narratorBriefs.push(user.content);
    }
    yield* this.inner.stream(role, req);
  }
  embed(role: LlmRole, texts: string[]) {
    return this.inner.embed(role, texts);
  }
}

function playset(withLore: boolean): PlaySet {
  const world = WorldSchema.parse({
    id: "w.t",
    name: "Testhold",
    summary: "A quiet vale ringed by old stones.",
    lore: withLore
      ? [
          { id: "lore.stones", title: "The Warden Stones", body: "Seven standing stones ring the vale, set to hold back the dark.", tags: ["wards"] },
          { id: "lore.secret", title: "The Failing Seal", body: "Only the GM knows the eastern stone has cracked.", tags: ["secret"] },
        ]
      : [],
    locations: [{ id: "loc.room", name: "The Ring", description: "A circle of weathered stones." }],
  });
  const campaign = CampaignSchema.parse({
    id: "c.t",
    name: "C",
    worldId: "w.t",
    characters: [{ id: "pc.you", name: "You", stats: STATS }],
    startingState: { locationId: "loc.room", party: ["pc.you"] },
  });
  return { world, campaign };
}

describe("engine — read-only lore surfaces in the narrator brief (offline)", () => {
  test("a world with lore injects # RELEVANT LORE into the brief", async () => {
    const gateway = new RecordingGateway();
    const engine = new GameEngine({ classifier: heuristicClassifier,
      playset: playset(true),
      store: new InMemoryGameStateStore(),
      gateway,
      // minScore 0 so the (non-semantic) offline embeddings always clear the floor.
      lore: { k: 4, minScore: 0 },
    });
    await engine.start();
    await engine.submitPlayerInput("I study the warden stones around me.");

    // The narrator-role message now combines the shared brief AND the DM-only secret block. Split
    // it at the secret header so we can assert each side independently.
    const msg = gateway.narratorBriefs.at(-1) ?? "";
    const SECRET_HDR = "=== SECRET LORE (GM eyes only";
    const secretIdx = msg.indexOf(SECRET_HDR);
    expect(secretIdx).toBeGreaterThan(0); // the DM DOES receive a secret block (it matched the scene)
    const brief = msg.slice(0, secretIdx); // the shared-brief portion (== contextText)
    const gmBlock = msg.slice(secretIdx);

    expect(brief).toContain("# RELEVANT LORE");
    expect(brief).toContain("The Warden Stones");
    // The secret-tagged entry is NEVER in the shared `# RELEVANT LORE` / contextText portion — it is
    // segregated into the DM-only block that follows.
    expect(brief).not.toContain("The Failing Seal");
    expect(brief).not.toContain("eastern stone has cracked");
    // ...and it IS present in the GM-only block (so the GM can act on hidden canon).
    expect(gmBlock).toContain("The Failing Seal");
    expect(gmBlock).toContain("eastern stone has cracked");
    // Placement contract: public lore sits before the current-action marker; the secret block is
    // appended last (after `# NOW`), outside the shared brief entirely.
    expect(brief.indexOf("# RELEVANT LORE")).toBeLessThan(brief.indexOf("# NOW"));
    expect(secretIdx).toBeGreaterThan(msg.indexOf("# NOW"));
  });

  test("a world with no lore produces a brief without the section", async () => {
    const gateway = new RecordingGateway();
    const engine = new GameEngine({ classifier: heuristicClassifier,
      playset: playset(false),
      store: new InMemoryGameStateStore(),
      gateway,
      lore: { k: 4, minScore: 0 },
    });
    await engine.start();
    await engine.submitPlayerInput("I look around the ring.");

    const brief = gateway.narratorBriefs.at(-1) ?? "";
    expect(brief).not.toContain("# RELEVANT LORE");
  });
});
