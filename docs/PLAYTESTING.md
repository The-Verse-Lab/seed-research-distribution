# Playtesting Seed

This guide covers the CLI-only research tree. A reachable OpenAI-compatible model endpoint is
required for live play; deterministic tests use local stubs.

## Setup

```sh
bun run setup
cp .env.example .env
bun run check
```

Configure the narrator, utility, and embedding roles in `.env`. The creative role defaults to the
narrator. Give concurrent runs distinct `SEED_DATA_DIR` values so saves and traces do not overlap.

## Run

```sh
bun run dev worlds/wakeward-isles
bun run viewer
```

The Observatory is read-only and listens on `http://localhost:4505` by default. Use it to inspect:

- the player-facing transcript;
- every model request and response;
- latency, usage, model, and provider finish metadata;
- turn plans and module execution;
- committed events, deltas, and projected state.

Set `SEED_DEV_TRACE=1` to print a compact trace with each CLI turn. Traces are persisted even when
inline printing is disabled.

## Scripted live runs

```sh
./playtest/scripts/run-live.sh tests/fixtures/worlds/thistledown playtest/scripts/live-smoke.txt
```

Script files are ordinary CLI input ending in `/quit`. They use real model tokens. Use a throwaway
data directory and preserve the resulting transcript plus the matching Observatory export when a
run finds a defect.

After changes to the retained minor-safety guard, also run its model-free adversarial matrix:

```sh
bun playtest/scripts/safety-matrix.ts
```

## Coverage protocol

### Grounding and state

- Try valid, invalid, ambiguous, and multi-clause actions.
- Verify each mechanical result has an authorizing command and committed delta.
- Reload after movement, inventory changes, combat, quest updates, captivity, and NPC promotion.
- Compare the saved projection with a replay fold when investigating divergence.

### Narration and continuity

- Watch for absent characters, invented movement, invented items, premature quest outcomes, and
  contradictions with current combat or location state.
- Inspect the exact narrator brief before changing prompts. Determine whether the brief was wrong or
  the model ignored a correct brief.
- Reproduce reported failures with the exact player phrase before broadening a matcher or schema.

### NPC knowledge and memory

- Tell one NPC a private fact and verify bystanders do not learn it.
- Ask present and absent NPCs about facts across public, secret, disclosed, and unknown scopes.
- Verify remembered claims retain speaker provenance rather than becoming world truth.
- Follow scheduled NPCs across phase boundaries and test whereabouts answers against learned habits.

### Autonomy and party behavior

- Exercise direct replies, reactive interjections, spontaneous turns, proposals, no-op opportunities,
  leadership, joining, leaving, and betrayal.
- Verify player priority, reply-depth decay, locks, cooldowns, and scene ownership.
- Confirm model intent that cannot ground produces no unauthorized state change.

### Mechanics

- Cover attacks, damage, defeat, recovery, items, equipment, trade, work, travel, lodging, camp,
  captivity, status effects, magic, progression, cases, errands, and quest deadlines.
- Test success and failure branches with deterministic seeds.
- Confirm DCs, costs, targets, and displayed outcomes agree with committed state.

### Safety

- Run the automated safety suite and matrix rather than relying on a manual spot check.
- Confirm non-sexual content involving minors is not over-blocked.
- Confirm sexualized content involving a minor is blocked for explicit, contextual, and obfuscated
  signals, including judge-unavailable behavior.

## Findings workflow

For every reproducible defect, record:

1. world/campaign and starting save;
2. exact input sequence;
3. expected and observed player-visible outcome;
4. classifier plan and confidence;
5. relevant context packet or narration brief;
6. queued commands and committed deltas;
7. model/provider metadata and errors;
8. smallest regression test that captures the failure.

Trace the fault to its owning layer before implementing a fix. Prefer classifier answers and
authoritative state signals over new broad regex matching.

## Clean runs and data safety

Stop the CLI and Observatory before moving a data directory. Preserve runs with a recoverable move:

```sh
mv data "data.backup-$(date +%Y%m%d-%H%M%S)"
```

Do not delete a data directory held open by a live process. Secrets belong only in the ignored
`.env`; redact tokens and private endpoint details from transcripts and bug reports.
