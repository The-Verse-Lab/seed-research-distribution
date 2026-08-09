/**
 * Visible-prose role invariant — the structural lock behind the minor-safety guard.
 *
 * The GuardedGateway screens exactly the role set {`narrator`, `creative`}. That is only sound if
 * every path that produces player-visible prose actually requests a screened role (a generation
 * on `utility`/`embedding` would bypass the guard entirely). This test pins the play-time agents
 * to `narrator` and the authoring prose path (party enrichment) to `creative`, and locks both
 * roles into the screened set, so a future refactor can't silently move a visible generation onto
 * an unguarded role. The converse — that the guard screens the prose roles and lets
 * `utility`/`embedding` through — is covered in `guarded-gateway.test.ts`.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { DungeonMaster } from "../src/agents/dm.ts";
import { NpcAgent } from "../src/agents/npc.ts";
import { isScreenedRole } from "../src/llm/guarded-gateway.ts";
import { OfflineGateway } from "./support/offline-gateway.ts";
import type { LlmGateway } from "../src/llm/gateway.ts";
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  LlmRole,
} from "../src/llm/types.ts";
import { enrichTemplateProse } from "../src/modules/party/enrich.ts";
import type { NpcTemplate, World } from "../src/content/schema.ts";
import type { GameState } from "../src/state/types.ts";

/** Records the role of every model call so the test can assert visible prose used `narrator`. */
class RoleSpyGateway implements LlmGateway {
  readonly streamRoles: LlmRole[] = [];
  readonly completeRoles: LlmRole[] = [];
  complete(role: LlmRole, _req: CompletionRequest): Promise<CompletionResult> {
    this.completeRoles.push(role);
    return Promise.resolve({ text: "ok", model: "spy" });
  }
  async *stream(role: LlmRole, _req: CompletionRequest): AsyncIterable<CompletionChunk> {
    this.streamRoles.push(role);
    yield { delta: "ok", done: false };
    yield { delta: "", done: true };
  }
  embed(_role: LlmRole, texts: string[]): Promise<EmbeddingResult> {
    return Promise.resolve({ vectors: texts.map(() => [0]), model: "spy" });
  }
}

// Minimal fixtures — only the fields the agents read when building their prompts.
const world = { name: "Thistledown", summary: "A quiet vale." } as unknown as World;
const template = {
  name: "Bett",
  summary: "the innkeeper",
  persona: "warm and watchful",
  goals: ["keep the peace"],
} as unknown as NpcTemplate;
const state = {} as unknown as GameState;

describe("visible-prose agents are pinned to the guarded `narrator` role", () => {
  test("DungeonMaster.narrate generates on `narrator` (never utility/embedding)", async () => {
    const spy = new RoleSpyGateway();
    const dm = new DungeonMaster(spy, world);
    await dm.narrate(state, { contextText: "# NOW\nyou look around", trigger: "you look around" });
    expect(spy.streamRoles).toEqual(["narrator"]);
    expect(spy.completeRoles).toEqual([]);
  });

  test("NpcAgent.reply generates on `narrator`", async () => {
    const spy = new RoleSpyGateway();
    const npc = new NpcAgent(spy, template);
    await npc.reply(state, { contextText: "# NOW\nx", playerLine: "hello", fromName: "Sable" });
    expect(spy.streamRoles).toEqual(["narrator"]);
    expect(spy.completeRoles).toEqual([]);
  });

  test("NpcAgent.decide (autonomous beat) generates on `narrator`", async () => {
    const spy = new RoleSpyGateway();
    const npc = new NpcAgent(spy, template);
    await npc.decide(state, { contextText: "# NOW\nx", stimulus: "the party is idle", replyDepth: 0 });
    expect(spy.streamRoles).toEqual(["narrator"]);
    expect(spy.completeRoles).toEqual([]);
  });
});

describe("the guard's screened-role set is exactly {narrator, creative}", () => {
  test("both prose roles are screened; utility/embedding are intentionally not", () => {
    expect(isScreenedRole("narrator")).toBe(true);
    expect(isScreenedRole("creative")).toBe(true);
    // `utility` hosts the safety judge itself — screening it would recurse the guard.
    expect(isScreenedRole("utility")).toBe(false);
    expect(isScreenedRole("embedding")).toBe(false);
  });
});

describe("authoring prose paths are pinned to the screened `creative` role", () => {
  test("party enrichment prose generates on `creative` (a screened role)", async () => {
    const spy = new RoleSpyGateway();
    // The spy's non-JSON reply drops the pass to its deterministic floor — the ROLE is the point.
    const floor = { name: "Vex" } as unknown as NpcTemplate;
    await enrichTemplateProse(spy, world, floor);
    expect(spy.completeRoles).toEqual(["creative"]);
    for (const role of spy.completeRoles) expect(isScreenedRole(role)).toBe(true);
  });

  test("the offline gateway answers `creative` exactly like `narrator` (role-agnostic prose floor)", async () => {
    const offline = new OfflineGateway();
    const req: CompletionRequest = {
      messages: [{ role: "user", content: "# NOW\nThe tide pulls back from the basalt shore." }],
    };
    const asNarrator = await offline.complete("narrator", req);
    const asCreative = await offline.complete("creative", req);
    expect(asCreative.text).toBe(asNarrator.text); // byte-identical prose ⇒ worldsmith determinism holds
    expect(asCreative.model).toBe("offline-creative"); // still self-identifies as the offline floor
  });
});
