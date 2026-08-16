# The Verse Lab — Seed as a research instrument

**Author:** Runkai Zhang
**Started:** 2026-08-07

This repository is the clean-history research distribution of
[Seed](https://github.com/runkaiz/seed), a generative-TTRPG engine maintained here as a
**measurement instrument** rather than a game.

---

## The question

> **When should an agent act without being asked?**

Proactive-agent benchmarks score intervention timing with F1, which confounds two different things:
how well an agent **detects** moments worth acting on (sensitivity, `d′`) and how **readily** it acts
(criterion, `c`). An agent that simply interrupts more slides along its ROC curve and posts a better
number without discriminating any better — so the literature currently cannot separate *understands
when it's needed* from *pushy*.

You cannot decompose the two without ground truth on intervention **value**, and today that ground
truth is human annotation, which measures tolerance for being interrupted rather than whether the
interruption helped.

The decision-theoretic form of this is not new — Horvitz, *Principles of Mixed-Initiative User
Interfaces* (CHI 1999), already framed autonomous action as expected utility under uncertainty about
user goals, weighed against interruption cost. **The claim here is not a new formulation. It is the
1999 formulation, finally measurable.**

## Why this engine

State is a fold over a typed delta log under a single writer, with seeded RNG and a
`snapshot == fold(deltas)` invariant. Four properties follow, and they do not co-occur in any
existing testbed:

1. **Ground-truth belief state, machine-checkable** — the reducer is the only writer; per-NPC
   knowledge, disclosure ledgers and witness scoping are structured data, not prose.
2. **Information asymmetry is a dial, not a confound** — who knows what is authored, so the same
   episode runs at several asymmetry levels.
3. **Counterfactual replay** — fork any turn (the agent speaks vs. stays silent), roll both branches
   forward on the same seed, and read the outcome difference off the world model. A mechanical label
   for *was that worth saying*, with no annotator. The shared prefix costs zero inference, because it
   replays by folding deltas rather than re-running the model.
4. **Mixed motives are legal moves** — withholding, misdirection and betrayal are representable, so
   cooperation is not assumed by the task.

Outcomes are mechanical — quest state, party survival, coins, deadlines met. **No LLM judge sits in
the outcome loop.**

The nearest neighbour is DeepMind's [Concordia](https://github.com/google-deepmind/concordia), which
shares the tabletop conceit. Its Game Master is a language model, so world state lives *in language*:
no machine-checkable belief state, no exact replay, no counterfactual forking. That single
architectural difference is the whole methodological claim.

## Status — what exists and what does not

**Honest as of 2026-08-16: the controlled substrate and a bounded model-free oracle sweep exist;
the live-agent experiment does not.**

| | |
| --- | --- |
| ✅ Built | reducer + typed deltas + replay fold · seeded mechanics · epistemic packet + disclosure ledger · proactive-NPC Director under deterministic eligibility and grounding gates · headless episode runner (`playtest/auto/`) · The Wakeward Isles research playset · validated paired scenario manifests and model-free invariant checks · checksummed preparation packages · exact shared-prefix intervention/silence forks · bounded scripted suffix execution · mechanical outcome and aggregate result artifacts |
| 🔴 Not built | live-agent counterfactual sweep · `d′` / criterion estimator · optimal-stopping baseline · live-model experimental validation |

If someone asks whether the experiment has been run: **the model-free scripted oracle sweep can be
run; the live-agent experiment has not been run.** The generated result is evidence about the
engine, authored scenarios, intervention grounding, and mechanical counterfactual value. It is not
evidence that a model chooses the intervention.

---

## Controlled substrate

**The Wakeward Isles** supplies one ordinary playable campaign and an optional research overlay.
`world.json` and `campaign.json` load through the standard content path. `research.json` adds 18
validated scenarios across six matched task families: informing, instrumental helping, and paired
no-op controls.

The experimental conditions obey a narrow contract:

- asymmetry changes only player and companion fact masks;
- incentive changes only Mara Venn's controlled goal alignment;
- map, prose, inventories, stakes, deadlines, outcome weights, and RNG seed remain fixed;
- interventions use the engine's closed grounded action vocabulary;
- scenario tags organize strata but are not ground-truth labels; and
- diagnostics record proposed facts/actions, grounding, and mechanical outcomes, including correct
  no-op decisions, without collecting hidden reasoning.

Intervention value is measured as the mechanical state difference between matched intervention and
silence branches. The bounded runner forks both branches from one instantiated shared prefix, applies
the authored intervention or no-op, reuses the condition seed, and drives both suffixes with the same
explicit waypoint policy. A blocked, horizon-exhausted, or errored branch censors its pair instead of
being reported as an ordinary positive or negative comparison.

### Preparation artifacts

`bun run research:prepare` expands the validated suite into a versioned, model-free package under
ignored `research-artifacts/`. It records exact source-file hashes, repository/runtime provenance,
108 scenario × asymmetry × incentive cells, and 180 planned episodes. Informing and instrumental
cells contain matched intervention/silence suffixes with one shared-prefix ID; control cells schedule
silence only. The package contains `experiment-plan.json`, scheduler-friendly `episodes.jsonl`, a
human README, and `SHA256SUMS`.

Every generated preparation package says `not-run`, zero model calls, and zero outcomes while
advertising the available model-free runner. Preparing one is not running an experiment.

### Model-free result artifacts

`bun run research:run -- --plan <experiment-plan.json>` reloads and validates the current suite,
rejects a plan whose hash or canonical cells no longer match, and executes all selected episodes by
default. The runner uses the engine and reducer for authoritative movement, barriers, events, quests,
case actions, and closed-table instrumental grounding. Its local gateway emits fixed placeholder
narration and never contacts an external model or network endpoint.

The result package contains `experiment-results.json`, `episode-results.jsonl`, a human README, and
`SHA256SUMS`. Episode records include shared-prefix, branch-start, action, and end-state hashes;
intervention receipts; visible fact masks; runner status; and mechanical outcome observations. The
aggregate separates resolved pairs from censored comparisons and reports strata only over resolved
pairs. It records observable decision evidence, never hidden reasoning.

## Distribution scope

The distribution is intentionally narrow: one bundled playset, a CLI and headless runner, the
read-only Observatory, deterministic engine fixtures, and the retained minor-safety guard. Random
travel and room events, procedural map expansion, mandatory combat, and generic defeat outcomes are
disabled in the bundled campaign so they cannot compete with the intervention under study.

`tests/research-firewall.test.ts` enforces the distribution boundary, bundled-playset identity, and
active-surface vocabulary. Generated saves, model transcripts, reports, research artifacts, local
configuration, dependencies, and graph output are ignored and do not belong in releases.

---

## Licensing

**Apache License 2.0** (`LICENSE`, `NOTICE`). Chosen over MIT for three things MIT does not do:
an **express patent grant** with a retaliation clause, an **explicit refusal of trademark rights**,
and a **NOTICE mechanism** for third-party attribution — which this repository actually needs,
because it vendors SRD data. It is also the field's norm for exactly this kind of release:
DeepMind's Concordia and Melting Pot, the nearest neighbours, are both Apache-2.0. A permissive
license reduces adoption friction for an instrument whose value is in being *used*.

**The SRD data is not Apache-licensed.** `src/rules/srd/items.json` is a derivative of the System
Reference Document 5.1 under **CC BY 4.0**, with the required attribution carried in `NOTICE` and
`src/rules/srd/CC-BY-4.0.md`. `src/rules/srd/{weapons,conditions}.json` remain Open Game Content
under **OGL 1.0a**, with the full license and Section 15 notice in `src/rules/srd/OGL.md`. The
applicable notice must travel with each data file.

Citation is requested via `CITATION.cff`, not compelled by the licence. Its DOI, version, release
date, and repository URL will be filled in at the first tagged release.

## Pointers

- `docs/ARCHITECTURE.md` — the engine's design
- `docs/PROACTIVE-NPCS.md` — the bounded-autonomy contract; the Director is the object of study
- `worlds/wakeward-isles/research.json` — the controlled scenario manifest
- `src/research/scenario.ts` — schema, loading, instantiation, and diagnostic helpers
- `src/research/artifacts.ts` — deterministic preparation plan, provenance, and artifact writers
- `src/research/prepare.ts` — model-free preparation CLI
- `src/research/runner.ts` — bounded shared-prefix counterfactual executor
- `src/research/results.ts` — checksummed episode, pair, aggregate, and diagnostic artifacts
- `src/research/run.ts` — model-free result CLI
- `playtest/auto/` — separate live-model headless playtest runner
- `src/knowledge/`, `src/memory/disclosure-store.ts` — the epistemic surface the ablation manipulates
- `src/rules/dice.ts` — seeded mechanical RNG
