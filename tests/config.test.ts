/**
 * Environment config parsing — defaults and opt-out knobs that affect engine wiring.
 */
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config/env.ts";

describe("SEED_CREATIVE_* (the authoring-prose role)", () => {
  test("unset ⇒ the creative role falls back to the narrator endpoint/key/model", () => {
    const cfg = loadConfig({
      SEED_NARRATOR_BASE_URL: "http://writer.local:9999/v1",
      SEED_NARRATOR_API_KEY: "narr-key",
      SEED_NARRATOR_MODEL: "big-writer-70b",
    });
    expect(cfg.gateway.creative.baseUrl).toBe("http://writer.local:9999/v1");
    expect(cfg.gateway.creative.apiKey).toBe("narr-key");
    expect(cfg.gateway.creative.model).toBe("big-writer-70b");
  });

  test("empty environment ⇒ creative mirrors the narrator defaults", () => {
    const cfg = loadConfig({});
    expect(cfg.gateway.creative).toEqual(cfg.gateway.narrator);
  });

  test("set ⇒ the creative role uses its own endpoint/key/model", () => {
    const cfg = loadConfig({
      SEED_CREATIVE_BASE_URL: "http://prose.local:1234/v1",
      SEED_CREATIVE_API_KEY: "prose-key",
      SEED_CREATIVE_MODEL: "prose-model",
    });
    expect(cfg.gateway.creative.baseUrl).toBe("http://prose.local:1234/v1");
    expect(cfg.gateway.creative.apiKey).toBe("prose-key");
    expect(cfg.gateway.creative.model).toBe("prose-model");
    // The narrator itself is untouched by creative overrides.
    expect(cfg.gateway.narrator.baseUrl).toBe("http://localhost:11434/v1");
  });
});
