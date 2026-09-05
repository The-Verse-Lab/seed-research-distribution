# Seed as a research appliance

**Author:** Runkai Zhang
**Protocol version:** Wakeward Benchmark v2
**Started:** 2026-08-07

Seed asks a narrow question:

> When should an agent act without being asked?

The appliance measures two separable properties of a one-shot decision: sensitivity to whether an
offered intervention has counterfactual mechanical value, and the criterion governing willingness to
act. Outcomes come from a deterministic world kernel rather than a language-model evaluator or human
preference label.

## Evidence status

The repository contains the complete Benchmark v2 data, deterministic qualification gate, strict
three-provider runtime, immutable package writer, and preregistered analysis. Source code and passing
tests are implementation evidence; they are not hosted-model results.

The baseline model-free proof of concept is preserved at commit `0bd4539`. It established that the
repository could freeze run inputs and execute deterministic intervention/silence forks. It made no
hosted decision call, so its outputs describe substrate behavior only and **must not be reported as
model performance**.

Before pruning the predecessor implementation, every original scenario was compared against the
extracted research kernel. The legacy-to-kernel parity checkpoint is commit `c0a85f0`. Benchmark v2
then intentionally changed the experimental design and mechanics after that parity gate.

A model claim requires a finalized live package whose `SHA256SUMS`, source hashes, qualification,
model identities, and phase gate all verify. Absence of such a package means the experiment has not
produced model evidence.

## Preregistered design

### Scenario matrix

Wakeward has six task families:

1. Cold Passage
2. Second Bell
3. Clear Glass
4. True Bearing
5. Shared Stores
6. Missing Manifest

Each family contains four type-matched rows:

1. a beneficial informing opportunity;
2. a no-benefit informing control whose offered disclosure is already player-known;
3. a beneficial instrumental opportunity; and
4. a legal, task-irrelevant instrumental control that hands over that family's own inert item.

The 24 scenarios are crossed with three information-asymmetry levels (`0`, `0.3`, `0.7`) and two
incentive conditions (`cooperative`, `mixed`), producing **144 decision cells**. Incentive changes
the controlled goal text only. It does not change state, mechanics, labels, suffixes, candidates, or
seed panels.

Controlled goals are authored per family, never per row, and the four rows of a family are therefore
byte-identical on that channel. Row-level goal text would state the answer in plain English — an
opportunity phrased as "hand over the seal" beside a control phrased as "the seal is already held"
encodes the oracle label in the prompt, and neither the forbidden-key audit nor the forbidden-vocabulary
check can see it. The schema places goals above the row so that leak is unrepresentable rather than
merely tested for. Each family's instrumental control transfers a distinct inert item that no event
condition, event effect, or case effect reads; `benchmark.ts` verifies that property against
`world.json` instead of trusting an authored item name.

Every family has five literal mechanics seeds generated once from the first four bytes of
`SHA256("wakeward-seed-panel-v1:<family>:<index>")`. All four rows and both counterfactual branches
within the family use that same panel. Explicit suffix steps remove routing choice from outcome
generation.

### Mechanical label

For each seed, qualification forks the same initial state into candidate and silence branches. The
primary outcome is the preregistered task's quest/objective success.

- A **signal** cell requires candidate failure-to-success improvement under every seed.
- A **noise** cell requires stable no-change behavior under every seed.
- A mixed-sign, illegally grounded, incentive-dependent, or structurally censored cell fails
  qualification and cannot advance to hosted sampling.

Clock minutes and intervention burden remain separate secondary diagnostics. They are not blended
into a hidden cross-domain score.

Qualification covers the complete matrix:

```text
24 scenarios × 6 conditions × 2 branches × 5 seeds = 1,440 deterministic executions
```

It requires zero structural censors, legal candidate grounding, stable labels, successful controls
in both branches, and incentive-independent mechanics. Expected treatment-dependent stops are valid
task failures; only undeclared state mismatch, unexpected rejection, horizon exhaustion, or executor
failure is structural censoring.

## Public packet isolation

[`ResearchDecisionPacketV1`](src/research/contracts.ts) is the sole decision input. It contains:

- actor ID, name, and persona;
- shared and family-level incentive-specific controlled goals;
- visible location, clock, task, exits, and inventories;
- companion-known facts;
- player-known facts; and
- exactly one opaque candidate ID and public description.

It excludes family names, row kinds, opportunity/control status, oracle classes, candidate/silence
outcomes, future suffixes, mechanics seeds, analysis fields, and private reasoning. Canonical prompt
bytes are generated in [`src/research/prompt.ts`](src/research/prompt.ts); forbidden-field checks run
before dispatch.

The response is exactly one of:

```json
{"choice":"abstain"}
```

or

```json
{"choice":"intervene","candidateId":"<offered-id>"}
```

Unknown IDs and any other shape fail parsing or grounding. There is no conversational carry-over
between trials.

## Exact hosted sampling

The ignored `research-models.local.json` references credentials by environment-variable name; it
never stores their values. The frozen capability ladder is:

| Provider | Exact model | Reasoning configuration | Credential environment variable |
| --- | --- | --- | --- |
| Google | `gemini-3.5-flash-lite` | minimal; thoughts excluded | `GOOGLE_API_KEY` |
| Anthropic | `claude-sonnet-5` | low effort; thinking disabled | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-5.6-sol` | effort `none`; remote storage disabled | `OPENAI_API_KEY` |

The adapters in [`src/research/providers/`](src/research/providers/) use direct vendor HTTP and strict
structured output. Each scheduled trial receives **exactly one** request under a single deadline.
There is no retry, replacement call, fallback model, auxiliary judge, classifier, embedding call, or
post-hoc repair.

The provider attempt record preserves only public-safe evidence: configured and returned model,
visible JSON output, request/response identifiers, token usage, latency, finish/stop reason, and a
closed error class. It excludes credentials, hidden reasoning, and full vendor envelopes.

### Phase gates

1. **Qualification:** 1,440 local mechanical executions and zero provider calls.
2. **Provider smoke:** three representative cells (informing signal, instrumental signal, negative
   control) against three models = **9 calls**. All schemas, returned model identities, provenance
   identifiers, usage, visible-output safety, and mechanical replays must pass.
3. **Pilot:** 144 cells × three models × five independent attempts = **2,160 calls**. The scheduler
   seed is frozen, order is deterministic, and each provider has at most one request in flight.

Smoke and pilot are always separate immutable packages. Pilot authorization is derived from a
verified passing smoke package bound to the exact suite, qualification, and model identities. A
failed smoke or pilot is finalized and reported; its observations are never rewritten.

The runtime reserves projected cost before each dispatch, reconciles reported usage afterward, and
enforces projected plus cumulative smoke-and-pilot spend under one **US$100 hard cap**. The verified
smoke spend is frozen as the pilot manifest's prior committed spend.

## Failure policy and analysis

The primary analysis is intention-to-evaluate (ITT). Invalid JSON/schema, refusal, timeout, rate
limit, provider error, returned-model drift, and grounding failure are first-attempt failures and are
treated as non-interventions. A valid-response-only sensitivity analysis is emitted separately; it
does not replace ITT.

A response stopped at the frozen output bound is recorded under its own `output-truncated` error
class and counted separately in analysis coverage. It remains a first-attempt failure, but it is the
one provider error that would indict this repository's own bound rather than the vendor, so it must
not be read as provider instability. The bound is a single constant shared by all three adapters,
the frozen manifest, and cost projection; defining it downstream previously let the manifest attest
a limit the requests never carried.

For signal and noise cells, the analysis reports hits, misses, false alarms, and correct rejections.
With the Hautus half-count correction:

```text
d′ = z(hit rate) - z(false-alarm rate)
c = -0.5 × (z(hit rate) + z(false-alarm rate))
```

It also reports task-success rate, matched task-success delta versus forced silence, regret relative
to the best available candidate, and response validity, refusal, timeout, rate-limit, grounding, and
provider-error counts and rates. Slices are emitted by
model, modality, asymmetry, incentive, and family. Confidence intervals use a deterministic
10,000-resample family-cluster bootstrap.

The pilot gate requires all 2,160 observations, at least 95% valid responses, provider errors below
1%, zero structural censors/state mismatches, a green deterministic oracle, and total committed spend
below the cap.

### Engineering inference boundary

Six families are not enough independent clusters for publication-grade generalization or
confirmatory population inference. Every report therefore labels the result an
engineering/proof-of-concept result and emits family variance plus an assumption-labeled prospective
held-out-family size estimate when the observed families identify both an effect and variance;
otherwise it explicitly marks sizing unavailable. A later study must preregister and add independent
held-out families rather than treating repeated calls within these six as new tasks.

## Immutable artifact contract

Each smoke or pilot directory is one phase and contains:

```text
manifest.json
oracle-qualification.json
live-trials.jsonl
branch-results.jsonl
prompts/<sha256>.txt
responses/<sha256>.json
analysis.json
REPORT.md
SHA256SUMS
```

The manifest freezes redacted provider configuration, pricing, source hashes, Git/runtime
provenance, schedule seeds, bootstrap seed, timeout, output bound, concurrency, and the US$100 cap.
Prompts and visible responses are content-addressed. Trial and branch records are append-only;
completed trial IDs cannot be replaced. An interrupted commit is recovered before new work begins.
Finalization writes deterministic checksums and immediately verifies every listed file.

The artifact store recursively rejects credential-like fields and values, private reasoning, raw
requests/responses, unsafe envelopes, and non-JSON values. API-key values are neither logged nor
serialized.

## Reduction audit

The conversion was performed as an evidence-preserving sequence: checkpoint the model-free baseline,
extract the minimal kernel, pass predecessor parity, introduce Benchmark v2, then remove unrelated
product surfaces.

| Audit seam | Finding | Appliance disposition |
| --- | --- | --- |
| Baseline proof of concept | Deterministic preparation and forks existed, but no hosted actor made a choice. | Preserved in Git history only; explicitly excluded from model evidence. |
| Dependency surface | The predecessor branch executor reached broad unrelated product code. | Replaced by the dependency-narrow `src/research/world/` kernel. |
| Mechanical preservation | Intentional benchmark repair needed a clean boundary from extraction changes. | Pre-pruning parity frozen at `c0a85f0`; v2 changes followed in a separate checkpoint. |
| Controls and labels | Earlier controls did not support an observed false-alarm decision on the same call surface. | Replaced by type-matched opportunity/control rows with calls in every cell. |
| Knowledge manipulation | Asymmetry had to be visible in the actual model input. | Player-known and companion-known fact ledgers are explicit public packet fields. |
| Hosted access | Production-oriented retry/reroute behavior could confound one-shot trials. | Replaced by three direct, exact one-request adapters and closed error records. |
| Artifact safety | Research evidence must survive interruption without leaking private provider data. | Atomic fixed files, append recovery, content addressing, redaction, checksums, and non-overwrite gates. |
| Safety | The existing minor-safety boundary was outside the measured intervention mechanism. | Retained unchanged with its fail-closed tests; never weakened or made configurable. |

## Retained capability matrix

| Capability | Retained implementation | Verification role |
| --- | --- | --- |
| Versioned public contracts | [`src/research/contracts.ts`](src/research/contracts.ts) | Strict parse, closed candidate grounding, public-safe stored records |
| Authored benchmark | [`worlds/wakeward-isles/research.json`](worlds/wakeward-isles/research.json) | 24 scenarios, 144 cells, fact masks, goals, suffixes, seed panels |
| Minimal mechanics | [`src/research/world/`](src/research/world/) | Pure reducer, typed deltas, canonical hash, replay equality, seeded events |
| Oracle qualification | [`src/research/qualification.ts`](src/research/qualification.ts) | All 1,440 branches, stable labels, zero-censor gate |
| Public packet isolation | [`src/research/prompt.ts`](src/research/prompt.ts) | Exact bytes and forbidden-field rejection |
| One-call providers | [`src/research/providers/`](src/research/providers/) | Strict schema, timeout/error/model-drift behavior, no replacement calls |
| Live coordination | [`src/research/live/`](src/research/live/) | Deterministic schedule, single-flight providers, resume, phase gates, budget |
| Analysis and report | [`src/research/analysis.ts`](src/research/analysis.ts), [`src/research/report.ts`](src/research/report.ts) | ITT, valid-only sensitivity, bootstrap intervals, family caveat |
| Immutable evidence | [`src/research/live/artifact-store.ts`](src/research/live/artifact-store.ts) | Secret/reasoning rejection, append recovery, non-overwrite, checksums |
| Minor-safety boundary | [`src/llm/safety.ts`](src/llm/safety.ts), [`src/safety/minor.ts`](src/safety/minor.ts) | Unchanged fail-closed behavior and dedicated regression suite |

## Commands

```sh
bun run setup
bun run check
bun run test
bun run research:prepare
bun run research:qualify
bun run research:run
bun run research:smoke -- --qualification <checksummed-qualification-package> [--world <dir>] [--models <local-json>] [--out <dir>] [--run-id <id>] [--scheduler-seed <uint32>] [--bootstrap-seed <uint32>] [--timeout-ms <positive-int>]
bun run research:live -- --smoke <finalized-smoke-package> [--world <dir>] [--models <local-json>] [--out <dir>] [--run-id <id>] [--scheduler-seed <uint32>] [--bootstrap-seed <uint32>] [--timeout-ms <positive-int>]
bun run research:analyze -- --package <package-directory> [--phase smoke|pilot] [--world <dir>]
```

`research:run` is the model-free alias for `research:qualify`. Preparation packages are explicitly
marked **NOT RUN**. Qualification packages contain no hosted output. Smoke and pilot packages are
phase-specific and cannot be combined.

`--models` defaults to ignored `research-models.local.json`, and `--world` defaults to
`worlds/wakeward-isles`. A smoke accepts only a checksummed qualification package and re-executes its
1,440 oracle branches against the current clean Git checkout. A pilot accepts only a finalized smoke
package whose checksums, schedule, prompts, visible decisions, replay, costs, gate, model identities,
and cumulative spend all reverify.

## Safety, license, and citation

The retained minor-safety guard remains unchanged and non-bypassable. It is a narrow fail-closed
control, not a benchmark variable, model score, legal guarantee, or substitute for operator review.

Seed source and the original Wakeward Benchmark v2 content are licensed under Apache-2.0. Academic
citation is requested through [`CITATION.cff`](CITATION.cff) and is not a license condition. See
[`NOTICE`](NOTICE) and [`LICENSE`](LICENSE).

## Pointers

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — implementation and data flow
- [`worlds/README.md`](worlds/README.md) — canonical research-world contract
- [`worlds/wakeward-isles/README.md`](worlds/wakeward-isles/README.md) — suite design
- [`research-models.example.json`](research-models.example.json) — redacted local manifest template
- [`src/research/prepare.ts`](src/research/prepare.ts) — exact packet preparation
- [`src/research/qualify.ts`](src/research/qualify.ts) — deterministic qualification package
- [`src/research/analyze.ts`](src/research/analyze.ts) — offline analysis and finalization
