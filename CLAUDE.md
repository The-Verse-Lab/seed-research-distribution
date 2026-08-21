# Seed research appliance — contributor guide

Seed is a TypeScript/Bun batch appliance for one-shot autonomous-intervention experiments. Keep the
repository limited to deterministic qualification, strict hosted sampling, immutable artifacts, and
analysis.

## Commands

```sh
bun run setup
bun run check
bun run test
bun run research:prepare
bun run research:qualify
bun run research:run       # model-free alias for research:qualify
bun run research:smoke -- --qualification <checksummed-qualification-package> [--world <dir>] [--models <local-json>] [--out <dir>] [--run-id <id>] [--scheduler-seed <uint32>] [--bootstrap-seed <uint32>] [--timeout-ms <positive-int>]
bun run research:live -- --smoke <finalized-smoke-package> [--world <dir>] [--models <local-json>] [--out <dir>] [--run-id <id>] [--scheduler-seed <uint32>] [--bootstrap-seed <uint32>] [--timeout-ms <positive-int>]
bun run research:analyze -- --package <package-directory> [--phase smoke|pilot] [--world <dir>]
```

Do not launch hosted requests without explicit authorization. Qualification must be green, the
nine-call smoke must pass, and the pilot must use a separate output package bound to that verified
smoke.

## Architecture

- `src/research/world/` is the pure command/delta/reducer/event/replay kernel.
- `src/research/benchmark.ts` validates `world.json` and `research.json` and expands 144 cells.
- `src/research/qualification.ts` executes all 1,440 model-free oracle branches.
- `src/research/contracts.ts` owns every versioned public and stored record.
- `src/research/prompt.ts` constructs canonical public-only packet bytes.
- `src/research/providers/` contains exact one-request Google, Anthropic, and OpenAI adapters.
- `src/research/live/` owns scheduling, budget, storage, resume, gates, and finalization.
- `src/research/analysis.ts` owns ITT, valid-only sensitivity, and family-cluster bootstrap analysis.
- `worlds/wakeward-isles/` contains only canonical `world.json` and `research.json`.
- `src/llm/`, `src/safety/`, and their tests retain the unchanged minor-safety guard.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [RESEARCH.md](RESEARCH.md) before changing a
public contract.

## Hard rules

- The reducer is the sole mechanical state writer. Commands authorize changes; deltas record what
  committed; replay must reproduce the canonical snapshot and hash.
- Mechanics and oracle labels are deterministic code and data. Hosted models choose only abstention
  or the offered candidate ID.
- A public packet must never contain family/control labels, oracle outcomes, suffix steps, mechanics
  seeds, metrics, or private reasoning.
- Keep one HTTP request per scheduled trial. Do not add retries, rescue models, fallbacks, judges,
  classifiers, embeddings, or conversational carry-over.
- Preserve every first attempt. Invalid JSON/schema, refusals, timeouts, rate limits, grounding
  failures, model drift, and provider errors count as non-interventions in primary ITT analysis.
- Keep provider identities exact: `gemini-3.5-flash-lite`, `claude-sonnet-5`, and `gpt-5.6-sol`.
- Credentials come only from `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY`. Never print,
  serialize, checksum, or commit their values.
- Keep smoke and pilot artifacts separate. Never overwrite completed trial IDs or finalized files.
- Require a clean identifiable Git commit for hosted phases, and re-execute supplied qualification
  bytes before any provider is constructed.
- Enforce projected and cumulative spend below the US$100 hard cap.
- Do not weaken, bypass, remove, or add a disable switch to the retained minor-safety guard.
- The six-family result is an engineering proof of concept; preserve the inference and power-sizing
  caveat.
- `research-artifacts/` and `research-models.local.json` are ignored runtime state, not source.
- Update the knowledge graph after code changes with `graphify update .`.

## Verification

Run at minimum:

```sh
bun run check
git diff --check
graphify update .
```

For public-contract, provider, world, or packaging changes also verify:

- the full 24-scenario/144-cell/1,440-execution qualification matrix;
- exact prompt-byte isolation and candidate grounding;
- one-request malformed-output, refusal, timeout, HTTP-error, and model-drift paths;
- artifact secret/reasoning rejection, checksums, resume, and non-overwrite behavior;
- deterministic 10,000-resample family bootstrap output;
- documentation links, license metadata, credential scans, and the distribution firewall.
