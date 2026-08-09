# Prose to code: deterministic fiction invariants

Seed lets models propose and phrase fiction, but state changes belong to deterministic code. The
standing rule is:

> Anything the player can act on must have a mechanical referent, or the narration must avoid
> claiming that it happened.

This document is the compact public ledger for the seams enforced by the engine and its tests. It
describes current invariants, not historical campaign incidents.

## 1. Ownership boundary

- The classifier may propose a typed intent using IDs supplied in its brief.
- Reconcilers ground those IDs against the current map, cast, inventory, quests, and closed action
  candidates. A miss degrades safely; it never invents a referent.
- Resolvers enqueue typed commands. The reducer is the sole writer of mutable world state.
- Narration receives applied commands and resolved outcomes. It may add texture, but may not add a
  payment, transfer, arrival, injury, death, opened barrier, or completed objective of its own.
- Continuity screens catch unsupported assertions before prose reaches the player.
- Public diagnostics record inputs, candidates, reason codes, grounding, commands, and outcomes;
  they do not record hidden reasoning.

## 2. Enforced seams

### 2.1 Verbally offered goods become grounded stock

An NPC may self-report a bounded `offers` row beside its spoken line. The offer is location-scoped,
time-bounded, and stored through the reducer. A later purchase still runs the ordinary vendor,
inventory, affordability, receipt, and replay paths. Free prose is never parsed for a price, and a
failed purchase does not mint stock.

Primary coverage: `tests/pending-offers.test.ts`, `tests/trade-honesty.test.ts`, and
`tests/trade-category-quote.test.ts`.

### 2.2 Deals are state, not scrollback

Settled agreements are reducer-owned rows with parties, terms, lifecycle state, and timestamps.
Prompts expose only relevant open agreements; narration cannot silently create, honor, or break a
deal. Replay and rewind rebuild the same ledger from deltas.

Primary coverage: `tests/deals.test.ts` and `tests/freeform-effects.test.ts`.

### 2.3 NPC assistance uses closed actions

Autonomous NPCs choose only from the candidate lists produced for the current state. `move`,
`give`, `open`, `pick`, and `force` are grounded to exact IDs and pass through the same reducer as
player actions. Illegal or stale proposals become an explicit fallback or a correct no-op. A model
cannot add a new verb or bypass consent, combat, coercion, or safety gates.

Primary coverage: `tests/grounding.test.ts`, `tests/autonomy-consent-gate.test.ts`, and
`tests/research-suite.test.ts`.

### 2.4 Compound intentions settle every represented half

A line that closes business and then moves may carry a grounded secondary move. The settle action
commits first; the move then resolves against the resulting state. If the classifier cannot
represent a requested half, the engine surfaces an honest dropped-intent note instead of implying
completion.

Primary coverage: `tests/freeform-effects.test.ts` and `tests/settle-then-move.test.ts`.

### 2.5 The narrator does not invent player speech

Quoted player words must be supported by the actual input. Short glue phrases and clearly
attributed NPC speech are excluded, while invented first-person commitments are escalated or
scrubbed. Required NPC lines remain verbatim.

Primary coverage: `tests/continuity.test.ts`.

### 2.6 Corrections stay diegetic and time stays grounded

Judge corrections are instructions to regenerate, not prose to show verbatim. Engine vocabulary
such as command names, authorization language, or internal IDs is scrubbed from player-facing
text. Time-of-day and celestial claims must agree with the campaign clock unless a resolved action
advanced it.

Primary coverage: `tests/correction-dialect.test.ts`, `tests/prose-scrub.test.ts`, and
`tests/continuity.test.ts`.

### 2.7 Custody, payment, and consequences are atomic

Items and coins move through typed commands with affordability, ownership, recipient, and location
checks. Mechanical receipts are emitted once. Social pressure, property violations, and faction
effects bind to persistent relationship or standing state rather than existing only in prose.

Primary coverage: `tests/exchange-services.test.ts`, `tests/consequence-binder.test.ts`, and
`tests/engine-submit-action.test.ts`.

### 2.8 Knowledge has provenance and disclosure policy

Canonical facts use stable IDs, scope, validity, and provenance. NPC knowledge is structured and
separate from private knowledge and GM-only truth. Public testimony can teach co-located listeners
only through grounded fact handles. Current questions do not silently receive superseded facts.

Primary coverage: `tests/npc-epistemic-memory.test.ts`, `tests/npc-epistemic-knowledge.test.ts`, and
`tests/wakeward-epistemic.test.ts`.

### 2.9 Travel changes one map state

An arrival requires an applied move. Named destinations ground only to real exits, visited routes,
or enabled authored frontier entries. If movement is impossible, the engine reports the real ways
out and narration remains at the current location.

Primary coverage: `tests/travel-time.test.ts`, `tests/far-travel.test.ts`, and
`tests/journey-fabrication.test.ts`.

### 2.10 Combat and defeat remain mechanically explicit

Initiative, HP, joining, fleeing, and encounter termination are reducer-owned. A campaign may
disable generic defeat outcomes and require no combat. Narration cannot start, end, or continue a
fight that the combat slice does not contain.

Primary coverage: `tests/combat-module.test.ts`, `tests/combat-ally-join.test.ts`, and
`tests/turn-outcome.test.ts`.

### 2.11 Deadlines use the campaign clock

Accepting a timed quest arms an absolute due time. Warnings and failure are deterministic events;
failure text must describe the authored mechanical consequence. Route-feasibility tests keep the
deadline achievable under the authored map's travel costs.

Primary coverage: `tests/quest-deadline.test.ts` and `tests/wakeward-isles.test.ts`.

### 2.12 Quest-flow diagnostics are binding

Bundled quest objectives must have reachable authored effects, item sources, and completion paths.
Known diagnostic debt is pinned explicitly; a new orphan objective or impossible source fails CI
instead of being papered over with campaign-specific engine behavior.

Primary coverage: `tests/bundled-world-quest-flow.test.ts`, `tests/quest-flow.test.ts`, and
`tests/quest-regression-guard.test.ts`.

### 2.13 Research labels do not define value

Research scenario tags organize strata only. Fact masks, controlled goals, legal interventions,
and outcome metrics are validated content. Intervention value is the measured mechanical state
difference between intervention and silence branches, never a scenario label or model assertion.

Primary coverage: `tests/research-suite.test.ts` and `tests/research-firewall.test.ts`.

## 3. Verification

Run `bun run check`, the safety matrix, authored-JSON parsing, Markdown-link/orphan scans, the
distribution firewall, and `graphify update .` after changes that touch these seams.
