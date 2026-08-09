/**
 * Configuration — environment → typed config.
 *
 * Every value has a local-first default (Ollama on localhost), so Seed runs with an
 * empty environment as long as a local model server is up. The CREATIVE, UTILITY and
 * EMBEDDING roles fall back to the NARRATOR endpoint when unset.
 *
 * @author Runkai Zhang
 */
import type { ProviderConfig } from "../llm/types.ts";
import type { LlmGateway } from "../llm/gateway.ts";
import type { BunSqliteGameStateStore } from "../state/sqlite-store.ts";

export interface SeedConfig {
  gateway: {
    narrator: ProviderConfig;
    creative: ProviderConfig;
    utility: ProviderConfig;
    embedding: ProviderConfig;
  };
  /**
   * Optional RESCUE endpoint (`SEED_RESCUE_*`): when the primary model answers a prose
   * role with an EMPTY completion or an HTTP-200 out-of-character REFUSAL, the RescueGateway
   * retries the base once, then reroutes the request here (e.g. a local LM Studio model). Absent
   * base URL ⇒ reroute disabled (the retry-once still smooths transient empties). The minor-safety
   * guard wraps the rescue too — the one hard line screens rescued output like any other.
   */
  rescue?: ProviderConfig & { model: string };
  /** Where saves / indexes live. */
  dataDir: string;
  /**
   * Text prepended to every GM/NPC system prompt. Used for model-specific "unlock"
   * directives required by a particular local model.
   * Empty by default.
   */
  systemPrefix: string;
  /**
   * Read-only lore retrieval (M4) knobs — config, not magic numbers. `k` is the max snippets
   * injected per turn; `minScore` is the cosine floor a hit must clear so weak matches don't add
   * noise. `cache` persists the lore embeddings to disk (under `dataDir`) so a cold start skips
   * re-embedding an unchanged corpus — default ON, `SEED_LORE_CACHE=off` to disable. Defaults are
   * conservative; retrieval stays best-effort either way.
   */
  lore: { k: number; minScore: number; cache: boolean };
  /**
   * Campaign rolling-summary ("story so far", M4 follow-up). Default ON; `SEED_SUMMARY=off` to
   * disable. When on, the engine maintains a best-effort, regenerated summary in a sidecar under
   * `dataDir` and the brief carries it as `# STORY SO FAR`. It is an LLM-generated DERIVED CACHE —
   * never source of truth (not in the WorldModel/deltas/snapshot/event-log).
   */
  summary: boolean;
  /**
   * Continuity Judge (verification-only agent). Default ON; `SEED_CONTINUITY_JUDGE=off` disables it.
   * When on, buffered GM prose + NPC whispers are adjudicated against the authoritative game state
   * before reaching the player (a deterministic floor plus a best-effort model tier that fails closed).
   */
  continuityJudge: boolean;
  /**
   * Optional model id the Continuity Judge's Tier-2 verdicts run on (`SEED_JUDGE_MODEL`), served on
   * the utility role's endpoint. The judge shares `utility` with the intent classifier; this lets a
   * stronger, slower arbiter (e.g. deepseek-v4-pro) judge drift without taxing every classification.
   * Unset ⇒ the utility role's own model, byte-identical behavior.
   */
  judgeModel?: string;
  /**
   * Opt-in (`SEED_JUDGE_STREAM_CLEAN`, default OFF) that lets the Continuity Judge STREAM prose live
   * on a turn that is provably non-escalating before generation (no absent cast, no established facts,
   * not in combat, nobody downed) — the only remaining escalation path there is a deterministic Tier-1
   * flag, screened post-stream, which retracts + regenerates on the rare catch. Restores time-to-first-
   * token on the common flavor/exploration turn. OFF ⇒ every judged turn buffers (byte-identical).
   */
  judgeStreamClean: boolean;
  /**
   * Dev-only opt-in (`SEED_DEV_TRACE`) that surfaces the per-turn agent trace in the CLI
   * (Workstream D). OFF by default: ordinary play stays byte-identical (no `turnTrace` wire message,
   * no CLI trace line). Traces are ALWAYS persisted when the store supports it (the Observatory
   * "Turns" view reads them regardless) — this flag gates only the in-play surfacing.
   */
  devTrace: boolean;
  /**
   * Telemetry retention (`SEED_TELEMETRY_RETENTION_DAYS`): prune `llm_calls` + `turn_traces` rows
   * older than N days once at store open. 0 (the default) = keep forever. TELEMETRY ONLY — the
   * `events` table is never pruned: its deltas are load-bearing for rewind and corrupt-snapshot
   * recovery (both fold from seq 0). The cost of pruning is older Observatory history/export.
   */
  telemetryRetentionDays: number;
}

type Env = Record<string, string | undefined>;

const pick = (value: string | undefined, fallback: string): string =>
  value && value.length > 0 ? value : fallback;

/** Parse a boolean opt-in env flag (truthy: 1/true/on/yes, case-insensitive). Default OFF. */
const flag = (value: string | undefined): boolean =>
  ["1", "true", "on", "yes"].includes((value ?? "").trim().toLowerCase());

/** Parse a boolean opt-OUT env flag — default ON; only an explicit 0/false/off/no turns it off. */
const flagOn = (value: string | undefined): boolean => {
  const v = (value ?? "").trim().toLowerCase();
  return v === "" || !["0", "false", "off", "no"].includes(v);
};

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Parse a `SEED_<ROLE>_THINKING` knob. Only an explicit off-token disables model reasoning for
 * that role (sent as DeepSeek-style `thinking: {type:"disabled"}`); absent/anything else leaves
 * the request untouched. Per-role only — deliberately NOT inherited from the narrator, because
 * thinking is a per-model behavior, not part of the endpoint fallback chain.
 */
const thinkingOf = (value: string | undefined): "off" | undefined =>
  ["off", "0", "false", "no", "disabled"].includes((value ?? "").trim().toLowerCase())
    ? "off"
    : undefined;

export function loadConfig(env: Env = process.env): SeedConfig {
  const timeoutMs = Number(env.SEED_REQUEST_TIMEOUT_MS) || 60_000;
  const narrator: ProviderConfig = {
    baseUrl: pick(env.SEED_NARRATOR_BASE_URL, "http://localhost:11434/v1"),
    apiKey: pick(env.SEED_NARRATOR_API_KEY, "ollama"),
    model: pick(env.SEED_NARRATOR_MODEL, "llama3.1:8b"),
    timeoutMs,
    ...(thinkingOf(env.SEED_NARRATOR_THINKING) ? { thinking: "off" as const } : {}),
  };

  // Creative + utility + embedding default to the narrator endpoint/key when not given their own.
  const creative: ProviderConfig = {
    baseUrl: pick(env.SEED_CREATIVE_BASE_URL, narrator.baseUrl),
    apiKey: pick(env.SEED_CREATIVE_API_KEY, narrator.apiKey),
    model: pick(env.SEED_CREATIVE_MODEL, narrator.model),
    timeoutMs,
    ...(thinkingOf(env.SEED_CREATIVE_THINKING) ? { thinking: "off" as const } : {}),
  };

  const utility: ProviderConfig = {
    baseUrl: pick(env.SEED_UTILITY_BASE_URL, narrator.baseUrl),
    apiKey: pick(env.SEED_UTILITY_API_KEY, narrator.apiKey),
    model: pick(env.SEED_UTILITY_MODEL, narrator.model),
    timeoutMs,
    ...(thinkingOf(env.SEED_UTILITY_THINKING) ? { thinking: "off" as const } : {}),
  };

  const embedding: ProviderConfig = {
    baseUrl: pick(env.SEED_EMBEDDING_BASE_URL, narrator.baseUrl),
    apiKey: pick(env.SEED_EMBEDDING_API_KEY, narrator.apiKey),
    model: pick(env.SEED_EMBEDDING_MODEL, "nomic-embed-text"),
    timeoutMs,
  };

  // Rescue route: enabled by SEED_RESCUE_BASE_URL alone; key/model have LM Studio-friendly
  // defaults ("local-model" is LM Studio's classic served id; a wrong id degrades gracefully —
  // the rescue call fails and the base result stands).
  const rescueBaseUrl = (env.SEED_RESCUE_BASE_URL ?? "").trim();
  const rescue: SeedConfig["rescue"] = rescueBaseUrl
    ? {
        baseUrl: rescueBaseUrl,
        apiKey: pick(env.SEED_RESCUE_API_KEY, "lm-studio"),
        model: pick(env.SEED_RESCUE_MODEL, "local-model"),
        timeoutMs,
        ...(thinkingOf(env.SEED_RESCUE_THINKING) ? { thinking: "off" as const } : {}),
      }
    : undefined;

  const loreK = Number(env.SEED_LORE_K);
  const loreMinScore = Number(env.SEED_LORE_MIN_SCORE);

  const dataDir = pick(env.SEED_DATA_DIR, "./data");

  return {
    gateway: { narrator, creative, utility, embedding },
    rescue,
    dataDir,
    systemPrefix: pick(env.SEED_SYSTEM_PREFIX, ""),
    lore: {
      k: Number.isFinite(loreK) && loreK > 0 ? Math.floor(loreK) : 4,
      minScore: Number.isFinite(loreMinScore) ? loreMinScore : 0.1,
      cache: flagOn(env.SEED_LORE_CACHE),
    },
    summary: flagOn(env.SEED_SUMMARY),
    // Continuity Judge (verification-only agent). Default ON; `SEED_CONTINUITY_JUDGE=off` is the
    // instant kill-switch if it ever misbehaves live.
    continuityJudge: flagOn(env.SEED_CONTINUITY_JUDGE),
    // Dedicated judge model (same endpoint as utility) — arbitration quality without classifier tax.
    ...(pick(env.SEED_JUDGE_MODEL, "") ? { judgeModel: pick(env.SEED_JUDGE_MODEL, "") } : {}),
    // Live-stream provably-clean judged turns (default OFF — an explicit opt-in because it trades the
    // release-gate buffer for a rare flash-then-retract when a post-stream Tier-1 flag fires).
    judgeStreamClean: flag(env.SEED_JUDGE_STREAM_CLEAN),
    devTrace: flag(env.SEED_DEV_TRACE),
    telemetryRetentionDays: positiveInt(env.SEED_TELEMETRY_RETENTION_DAYS, 0),
  };
}

/**
 * Build the default gateway from config, wrapped in the minor-safety GuardedGateway. Kept here so
 * wiring lives in one place. The guard is always on. The judge runs on the BASE gateway's utility role — screening only the prose roles
 * (narrator/creative), never utility, keeps it from recursing through the guard.
 *
 * Composition order: base → RescueGateway → GuardedGateway (→ LoggingGateway at the call sites).
 * The rescue sits INSIDE the guard so the one hard line screens rescued output too; the rescue's
 * retry-once path is active even with no rescue endpoint configured.
 */
export async function createGateway(config: SeedConfig): Promise<LlmGateway> {
  const { Gateway } = await import("../llm/gateway.ts");
  const { OpenAICompatibleProvider } = await import(
    "../llm/providers/openai-compatible.ts"
  );
  const { GuardedGateway } = await import("../llm/guarded-gateway.ts");
  const { RescueGateway } = await import("../llm/rescue.ts");
  const { makeGatewayJudge } = await import("../llm/safety.ts");
  const base = new Gateway({
    narrator: new OpenAICompatibleProvider(config.gateway.narrator),
    creative: new OpenAICompatibleProvider(config.gateway.creative),
    utility: new OpenAICompatibleProvider(config.gateway.utility),
    embedding: new OpenAICompatibleProvider(config.gateway.embedding),
  });
  // One provider serves every role of the rescue route — only the prose roles ever reach it.
  const rescueProvider = config.rescue ? new OpenAICompatibleProvider(config.rescue) : undefined;
  const rescue = rescueProvider
    ? {
        provider: new Gateway({
          narrator: rescueProvider,
          creative: rescueProvider,
          utility: rescueProvider,
          embedding: rescueProvider,
        }),
        model: config.rescue?.model,
      }
    : undefined;
  return new GuardedGateway(new RescueGateway(base, rescue), { judge: makeGatewayJudge(base) });
}

/**
 * The configured endpoint cannot serve play — unreachable, or up but rejecting the key. There is
 * no offline fallback (owner decision, 2026-07-04): clients catch this and surface the notice to
 * the player instead of degrading to silently-templated play.
 */
export class EndpointUnreachableError extends Error {}

/**
 * Build the gateway, probing the narrator endpoint first so a dead endpoint fails in ~1.5s with
 * an actionable message instead of a slow first-turn timeout. `fetchImpl` is injectable so tests
 * can simulate an up/down endpoint without real network.
 */
export async function createProbedGateway(
  config: SeedConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<LlmGateway> {
  const baseUrl = config.gateway.narrator.baseUrl;
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      // Send the key so an auth-walled /models returns 200 (not a misleading 401).
      res = await fetchImpl(`${baseUrl}/models`, {
        method: "GET",
        headers: { authorization: `Bearer ${config.gateway.narrator.apiKey}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    throw new EndpointUnreachableError(
      `LLM endpoint ${baseUrl} is unreachable. Seed needs a model to play — start your server (or set SEED_NARRATOR_BASE_URL) and try again.`,
    );
  }
  // Server answered but rejected the key — up, yet unusable. Be honest about it.
  if (res.status === 401 || res.status === 403) {
    throw new EndpointUnreachableError(
      `LLM endpoint ${baseUrl} rejected authentication (HTTP ${res.status}). Check SEED_NARRATOR_API_KEY and try again.`,
    );
  }
  // Any other resolved response (200, or a 404 from servers without /models) → reachable.
  return createGateway(config);
}

/** Single wiring point for durable persistence (lazily imports bun:sqlite). */
export async function createStore(config: SeedConfig): Promise<BunSqliteGameStateStore> {
  const { BunSqliteGameStateStore: Store } = await import("../state/sqlite-store.ts");
  return Store.open(config);
}
