# Seed Research Appliance

Seed is a batch research appliance for controlled, one-shot autonomous-intervention experiments.
It exposes a deterministic counterfactual world kernel, a frozen benchmark, strict hosted-model
adapters, resumable artifact storage, and preregistered analysis. The repository's executable
surface is intentionally limited to research preparation, qualification, hosted sampling, and
analysis.

## Frozen experiment

- **24 scenarios:** six task families, each with informing and instrumental opportunity/control
  rows.
- **144 decision cells:** every scenario crossed with three information-asymmetry levels and two
  incentive conditions.
- **1,440 qualification executions:** candidate and silence branches over five frozen mechanics
  seeds per family, with no hosted-model calls.
- **9-call provider smoke:** three representative cells against all three configured models.
- **2,160-call pilot:** five independent first attempts per cell and model.

Every hosted call receives only a versioned public decision packet: actor/persona, controlled goals,
visible state, companion-known facts, player-known facts, and one closed intervention candidate.
Family names, control status, oracle labels, suffix steps, outcome metrics, and private reasoning are
excluded. See [RESEARCH.md](RESEARCH.md) for the full contract.

## Install and verify

Seed requires Bun 1.3 or newer.

```sh
bun run setup
bun run check
bun run test
```

## Offline preparation and qualification

```sh
bun run research:prepare
bun run research:qualify
bun run research:run
```

`research:prepare` writes a checksummed, explicitly **NOT RUN** packet package. It performs zero
mechanical executions and zero provider calls. `research:qualify` executes the complete deterministic
oracle matrix. `research:run` is a compatibility alias for `research:qualify`; it does not contact a
model.

Generated packages go under ignored `research-artifacts/` unless `--out` is supplied. Run any
command with `-- --help` for its exact options.

## Hosted-model phases

Copy the redacted local manifest and set credentials only in the process environment:

```sh
cp research-models.example.json research-models.local.json
export GOOGLE_API_KEY=...
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
```

The manifest freezes these exact model IDs:

| Provider | Model | Environment variable |
| --- | --- | --- |
| Google | `gemini-3.5-flash-lite` | `GOOGLE_API_KEY` |
| Anthropic | `claude-sonnet-5` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-5.6-sol` | `OPENAI_API_KEY` |

The hosted sequence is deliberately gated:

```sh
bun run research:smoke -- --qualification <checksummed-qualification-package> [--world <dir>] [--models <local-json>] [--out <dir>] [--run-id <id>] [--scheduler-seed <uint32>] [--bootstrap-seed <uint32>] [--timeout-ms <positive-int>]
bun run research:live -- --smoke <finalized-smoke-package> [--world <dir>] [--models <local-json>] [--out <dir>] [--run-id <id>] [--scheduler-seed <uint32>] [--bootstrap-seed <uint32>] [--timeout-ms <positive-int>]
bun run research:analyze -- --package <package-directory> [--phase smoke|pilot] [--world <dir>]
```

For example:

```sh
bun run research:smoke -- --qualification research-artifacts/qualification-... --out research-artifacts/smoke-1
bun run research:live -- --smoke research-artifacts/smoke-1 --out research-artifacts/pilot-1
```

`--models` defaults to ignored `research-models.local.json`; `--world` defaults to
`worlds/wakeward-isles`.

Qualification must be a checksummed package, green, and an exact replay match for the current
deterministic executor before smoke. Hosted phases require a clean Git checkout and freeze its exact
commit. The nine-call smoke is finalized as its own immutable, checksummed package. A pilot is
authorized only from a semantically reverified passing smoke package and is written to a different
package directory. Each adapter makes exactly one HTTP request per scheduled trial;
there is no retry, fallback, or replacement observation. Invalid responses and provider failures are
preserved as first-attempt failures and counted as non-interventions in the primary
intention-to-evaluate analysis.

Projected and cumulative smoke-plus-pilot spend are constrained by one **US$100 hard cap**. The
pilot manifest carries the verified smoke spend forward. Hosted calls should be run only with
explicit authorization.

## Immutable live package

A completed smoke or pilot package contains:

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

Prompts and visible responses are content-addressed. Completed trial IDs are resumable and cannot be
overwritten. Credentials, hidden reasoning, and raw provider envelopes are rejected by the artifact
store.

## Evidence boundary

The baseline model-free proof of concept is preserved in Git history. It established preparation and
deterministic branch machinery without asking a hosted model to choose an intervention. Those outputs
are substrate evidence, **not model-performance evidence**. Only a verified live result package can
support claims about a configured model.

The benchmark has only six independent task families. Its intervals, family variance, and
assumption-labeled prospective held-out-family sizing are engineering proof-of-concept diagnostics,
not publication-grade inference for a wider task population.

The pre-existing minor-safety guard is retained unchanged, including its fail-closed behavior and
regression suite.

## Repository map

```text
src/research/                 contracts, benchmark, kernel, providers, runtime, and analysis
src/llm/ and src/safety/      retained minor-safety guard
tests/                        research, artifact, firewall, and safety verification
worlds/wakeward-isles/        canonical world.json and research.json inputs
research-models.example.json redacted local-manifest template
```

Further reading:

- [Research protocol and audit](RESEARCH.md)
- [Architecture](docs/ARCHITECTURE.md)
- [World data contract](worlds/README.md)
- [Wakeward benchmark](worlds/wakeward-isles/README.md)

Seed and the original Benchmark v2 content are licensed under Apache-2.0. Citation metadata is in
[CITATION.cff](CITATION.cff).
