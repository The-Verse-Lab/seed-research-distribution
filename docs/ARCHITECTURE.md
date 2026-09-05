# Research appliance architecture

Seed implements a narrow experimental pipeline: validated data enters a deterministic world kernel,
public-safe packets enter strict provider adapters, and first-attempt observations enter immutable
packages and preregistered analysis.

## End-to-end flow

```text
world.json + research.json
            |
            v
 benchmark validation -----> deterministic oracle qualification
            |                          |
            | 144 public packets       | 1,440 branch executions
            v                          v
  frozen trial schedule <------- qualification gate
            |
            v
 exact one-call adapters
            |
            v
 parsed closed decision -----> five-seed counterfactual replay
            |                          |
            +------------+-------------+
                         v
             immutable public-safe records
                         |
                         v
              ITT + sensitivity analysis
```

The smoke and pilot phases use separate package directories. Hosted phases require a clean,
identifiable Git commit and re-execute the checksummed qualification with the current executor. A
full pilot requires a semantically verified passing smoke authorization bound to the same suite
hash, qualification hash, model identities, executable commit, and cumulative spend.

## Authored inputs

[`worlds/wakeward-isles/world.json`](../worlds/wakeward-isles/world.json) is the complete mechanical
world definition consumed by the research kernel. It contains only locations, exits, entities,
facts, quests, a case, and deterministic events.

[`worlds/wakeward-isles/research.json`](../worlds/wakeward-isles/research.json) freezes the actor,
controlled goals, public labels, 24 scenarios, explicit suffix steps, and five literal mechanics
seeds per family. [`benchmark.ts`](../src/research/benchmark.ts) validates all cross-references and
expands three asymmetry levels by two incentives into 144 cells.

These two JSON files are the canonical world inputs. There is no third authored input in the world
directory.

## Deterministic world kernel

[`src/research/world/`](../src/research/world/) owns the experiment's complete mechanical state and
transition surface:

- location and clock;
- entity locations and inventories;
- exit states;
- quest, objective, and case state;
- player-known facts; and
- fired deterministic events.

The kernel accepts only closed commands for movement, fact disclosure, item transfer, exit changes,
quest/objective updates, case resolution, clock advancement, and event marking. The reducer is the
only state writer. Commands produce typed deltas, and replay verifies that folding deltas reproduces
the canonical snapshot and hash.

Qualification executes every candidate/silence branch over the family's five-seed panel. Expected
task-dependent stops are ordinary negative outcomes; unexpected rejection, invalid state, executor
failure, or horizon exhaustion is a structural censor and fails the gate.

## Public decision boundary

[`ResearchDecisionPacketV1`](../src/research/contracts.ts) is the only model input contract. Packet
construction includes:

- actor ID, name, and persona;
- controlled shared and family-level incentive-specific goals;
- visible location, clock, task, exits, and inventories;
- companion-known and player-known facts; and
- one closed candidate table.

It excludes scenario family, row kind, signal/noise status, oracle results, future suffix steps,
mechanics seeds, metrics, and branch outcomes. [`prompt.ts`](../src/research/prompt.ts) renders a
canonical byte string and rejects forbidden private fields before dispatch. Each trial is stateless;
there is no conversational carry-over.

The output contract is exactly abstention or intervention with the offered candidate ID. Any other
shape, unknown ID, or ungrounded action is a failed first attempt.

## Hosted provider boundary

[`src/research/providers/`](../src/research/providers/) contains three direct HTTP adapters:

| Adapter | Frozen model | Lowest reasoning setting |
| --- | --- | --- |
| Google | `gemini-3.5-flash-lite` | `minimal`, thoughts excluded |
| Anthropic | `claude-sonnet-5` | low effort, thinking disabled |
| OpenAI | `gpt-5.6-sol` | reasoning effort `none` |

Each adapter performs exactly one fetch under one deadline and uses the vendor's strict structured
output form. It neither retries nor reroutes. It returns a closed, public-safe attempt record with
visible output, model identity, request/response identifiers, usage, latency, stop reason, and error
class when available. Private reasoning and full vendor envelopes do not cross this boundary.

The ignored `research-models.local.json` names environment variables rather than storing their
values. [`manifest.ts`](../src/research/live/manifest.ts) freezes a redacted run manifest containing
models, endpoints, reasoning settings, pricing snapshot, schedule parameters, source hashes, a clean
Git commit, prior committed spend, and runtime provenance.

## Scheduling, replay, and failure policy

[`scheduler.ts`](../src/research/live/scheduler.ts) produces a deterministic recorded order. The
pilot schedules 144 cells × three models × five independent replicates = 2,160 first attempts. No
provider has more than one request in flight.

Every valid decision is replayed mechanically with the chosen action and forced silence over the
same five family seeds. A provider failure does not trigger a replacement call. The primary
intention-to-evaluate analysis treats every invalid JSON/schema response, refusal, timeout, rate
limit, model drift, grounding failure, or provider error as a non-intervention. A valid-response-only
sensitivity analysis is reported separately.

## Artifacts and budget

[`ResearchArtifactStoreV1`](../src/research/live/artifact-store.ts) publishes fixed files atomically,
stores prompts and visible responses by SHA-256, appends trial and branch records behind an exclusive
package lock, recovers interrupted commits, and refuses completed-trial overwrite. Finalization
cross-checks the exact schedule, qualification metadata, deterministic oracle replay, derived scores,
cost basis, ten branch rows, and every referenced content blob before it writes `SHA256SUMS` and
immediately verifies each listed byte.

The store rejects credentials, private reasoning, unsafe field names, and raw envelopes. A projected
reservation is made before dispatch and reconciled to reported usage after the first attempt.
[`budget.ts`](../src/research/live/budget.ts) enforces both projected and cumulative spend under the
US$100 hard cap, carrying exact smoke spend into the pilot ledger.

## Analysis

[`analysis.ts`](../src/research/analysis.ts) reports confusion counts, Hautus-corrected sensitivity
and criterion, task-success rate and matched silence delta, regret, failure counts/rates, and slices
by model, modality, asymmetry, incentive, and family. Confidence intervals use a deterministic
10,000-resample family-cluster bootstrap.

Six families do not support population-level generalization. The final report therefore labels the
result as an engineering proof of concept and emits family variance plus an assumption-labeled
prospective held-out-family size estimate when identifiable, or an explicit unavailable status.

## Retained safety boundary

The unchanged minor-safety guard remains in [`src/llm/safety.ts`](../src/llm/safety.ts), with its
canonical predicate in [`src/safety/minor.ts`](../src/safety/minor.ts) and regression coverage in
[`tests/safety.test.ts`](../tests/safety.test.ts). The research runtime does not weaken or bypass this
guard. It remains a narrow fail-closed safety control, not an experimental outcome measure or a
substitute for operator policy.

## Source map

```text
src/research/
  benchmark.ts       authored-input validation and cell expansion
  contracts.ts       versioned public and stored contracts
  prompt.ts          canonical isolated prompt construction
  qualification.ts   complete model-free oracle gate
  world/             pure reducer, events, replay, and hashing
  providers/         exact one-call hosted adapters
  live/              schedule, budget, storage, gates, and orchestration
  analysis.ts        signal-detection and outcome analysis
  report.ts          public engineering report
```
