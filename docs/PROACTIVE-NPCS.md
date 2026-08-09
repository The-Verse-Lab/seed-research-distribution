# Proactive NPCs — Bounded Autonomy in Seed

> How a party-member NPC can take initiative, make decisions, and even *lead* — without
> spamming the table, interrupting the player, or railroading the story.
> This is the design for `src/director`. It is the project's defining feature.

The hard problem isn't making an NPC *act*. It's making it act **the right amount, at
the right time**. An NPC that can do anything whenever it wants is exhausting and breaks
immersion. The model here is **bounded autonomy**: real initiative inside firm rails.

The mechanisms below adapt
["Bounded Autonomy: Controlling LLM Characters in Live Multiplayer Games" (2026)](https://arxiv.org/html/2604.04703v1)
to a cooperative TTRPG party. Citations point at the concept Seed borrows.

---

## 1. The Director's job

The **Director** sits between the agents and the engine and answers one question on
every tick and every event: *should any NPC act right now, and if so, who, and is what
they want to do allowed?*

It never generates prose itself — it **schedules** and **gates** the NPC agents, then
hands their output to action grounding. Four mechanisms do the work.

---

## 2. When an NPC may act — heartbeat + events

Each autonomous NPC has two wake conditions:

1. **Heartbeat** — a periodic tick (`autonomy.heartbeatSeconds` on the NPC, default
   ~30–45s of *in-game idle*, not wall-clock during a player's turn). On tick, the NPC
   *considers* acting. Most ticks should resolve to "do nothing."
2. **Event-driven** — a relevant `GameEvent` (someone spoke to them, combat started, a
   threat appeared) wakes them immediately, ahead of the next heartbeat.

> Borrowed: an independent behavior heartbeat plus event dispatch, trading a little
> reactivity for bounded inference cost.

In a turn-based tabletop frame, "idle time" is the space between player commands and
during exploration/social scenes — exactly where a proactive companion should feel
alive. In structured combat, the heartbeat is suppressed in favor of initiative order.

---

## 3. Who gets the floor — priority A > B > C

When multiple things could happen, the Director resolves precedence with a strict
hierarchy. **The player always wins.**

| Priority | Source | Example | Rule |
| --- | --- | --- | --- |
| **A** | Player input / direct address / *whisper* | "Lyra, what do you think?" | Overrides everything; can interrupt an NPC mid-action. |
| **B** | Reactive — responding to another character | An NPC answers another NPC | Beats spontaneous behavior. |
| **C** | Spontaneous — self-initiated | An NPC proposes a plan unprompted | Only when nothing higher is pending. |

> Borrowed: the three-level A/B/C stimulus hierarchy and player-override semantics.

**Reply-focus arbitration (within B):** if several characters could be answered, the
NPC replies to the one with the **highest relationship score**, ties broken randomly.
This keeps multi-NPC scenes coherent (companions talk *to* people, not *over* them) and
makes relationships mechanically meaningful.

---

## 4. How NPC-to-NPC chatter dies down — reply-chain decay

Left alone, two LLM NPCs will happily talk to each other forever. Seed bounds this with
**probabilistic decay** rather than a hard turn cap, so conversations taper *naturally*:

```
P_reply(depth) = max(0, 1 − (depth − 1) · α)

  depth 0 = a player- or world-injected prompt
  depth 1 = an NPC's first autonomous line     → P = 1.0
  depth 2 = a reply to that line               → P = 0.8   (α = 0.2)
  ...
  depth 5                                       → P = 0.2
  depth 6                                       → P = 0.0   (chain ends)
```

`α` (`replyDecayAlpha`, default `0.2`) is the one knob that tunes how chatty the party
is. Every player or world event resets the chain to depth 0, so the party re-engages
the moment something real happens.

> Borrowed: reply-chain decay `P = max(0, 1 − (s−1)·α)` for natural conversation
> termination instead of hard caps.

---

## 5. What an NPC may actually do — action grounding

An NPC agent returns free text describing intent. That text is **never** applied
directly. The Director routes it through grounding
(`src/modules/autonomy/grounding.ts`):

1. The intent is matched against the **typed Command space** (`src/world/commands.ts`)
   — move, speak, transfer/equip/use an item, party actions, … — scoped to what's
   *currently legal* given state + rules.
2. The best match above a confidence threshold becomes a typed `Command`, applied only
   by the reducer (the single mutation chokepoint).
3. Below threshold → a **safe fallback** (usually a spoken flavor line),
   never an invalid world mutation.

This is what stops a companion from "casting a spell it doesn't have" or "opening a door
that isn't there." The model's creativity lives in *phrasing*; the world only moves
through validated Actions.

> Borrowed: grounding free-text output to a fixed pool of valid behaviors with a
> confidence-gated safe fallback.

---

## 6. The NPC as leader — proposals, not fiat

Your headline case: *"your NPC party member can be the leader and make decisions."*
Seed expresses leadership as a **graded autonomy level** on the NPC, not a binary:

| `autonomyLevel` | Behavior |
| --- | --- |
| `passive` | Acts only when directly addressed (priority A). A normal follower. |
| `reactive` | Adds priority-B reactions; chimes into conversation, answers threats. |
| `proactive` | Adds priority-C: suggests directions, flags danger, starts banter. |
| `leader` | May issue **party-level proposals** — "We should take the north road" — and, if `canLead` and the players don't object within a beat, **act on them** within the consent gate below. |

A **leader proposal** is a first-class event (`NpcProposal`) the client surfaces
distinctly: the players can **accept, override, or ignore** it. Silence = tacit
consent, so a leader keeps things moving on a quiet table; a single word from a player
(priority A) overrides instantly. That's leadership with a leash.

### The consent gate — what silence can and cannot buy

Tacit consent is bounded by an **allowlist in code** (`src/modules/autonomy/consent.ts`),
not by the leader's judgment or the model's:

> An NPC may act unasked only on **itself and its own property**. Anything that moves the
> player, spends their things, or commits the party needs an actual answer.

So a leader may rest, ready its own gear, hand over something it owns, or open a way it
can already open, all on a quiet beat. It may **not** walk the party anywhere, take up a
job in the party's name, spend the party's coin, or take anything out of the player's
pack — those wait, and the plan that carried them is narrated as a nudge that "waits on
your word". Nothing is lost to the gate: an explicit **yes** (the accept path, `resolvePlayer`)
executes the same plan whole, movement included. The list defaults to **ask** — a verb
grounding learns tomorrow is refused until somebody classifies it on purpose.

Both surfaces that can act unasked are gated: tacit consent (an expired proposal consumed
on a quiet heartbeat) and the direct-act branch (grounding produced a command while the
proposal path was closed by the cooldown). Suppressions are counted on the turn trace
(`consentBlocks`) and shown in the Observatory, because a gate nobody can measure is
indistinguishable from a Director that never tried.

*Why:* playtest r9 finding F-1 ("idle-to-win"). A player idled five minutes composing a
question; the Director walked the party two locations west, fired the arrival events and
completed a quest objective on the way. Each surface had been patched with a denylist of
command *types*, which fails open on every verb added afterwards — `take_job` shipped after
the movement ban and committed the party to a contract nobody answered.

**What a leader proposes — goal-directed, not random.** A leading companion's idle
stimulus carries a pure, code-derived nudge (`leaderGoalHint`, gated on `canLeadNow`)
so its proposals point somewhere purposeful — in priority order: **call a rest** for a
worn party → pursue the **active quest's** first open objective → take up an **offered**
job → **when no quest calls the party at all, set the course toward the leader's own
authored goal** (the aim rides the leader's private brief; the nudge is a directive to
lead toward it, never a verbatim recital) → push into an **unexplored frontier** exit.
Quest text echoed is authored, player-visible copy — the model only phrases; the goal
stays code-owned truth. **Whether a line becomes a proposal is decided by grounding, not
keywords:** a leader's line is a proposal on any spontaneous (C) beat, or when it
**grounds to a concrete world move** — the same oracle that decides it is executable at
all — so a proposal always has teeth on tacit consent and pure banter stays plain
dialogue.

This pairs with **soft steering** — implemented as **private chat threads** in the web
client (click an NPC to open a one-on-one thread; the CLI has no private channel): a
player can privately nudge an NPC ("Lyra, stop trusting the merchant") and it
conditions future behavior **without** hard-scripting the next line — the NPC still
chooses how to act on the nudge. Private lines are structurally invisible to bystander
NPCs and to the public narration. Leadership itself is also runtime state now: any
party member can be **appointed leader** in play (`modules.party.leaderId`), not only
NPCs authored with `autonomyLevel: "leader"`.

> Borrowed: player-guided *steering* as soft conditioning rather than direct command.

---

## 7. Anti-spam plumbing

- **Talk-lock** — a per-NPC flag prevents two overlapping autonomous outputs from the
  same character; only a priority-A input may interrupt a held lock.
- **Dedup** — outgoing dialogue is timestamp-gated to suppress near-duplicate lines
  within a short window (models love to restate themselves).
- **Idle-only spontaneity** — priority-C behavior is suppressed while a player command
  is being resolved, so the party never talks over the GM's response to the player.

> Borrowed: per-character talk-state lock + timestamped dedup of outgoing dialogue.

---

## 8. Where this lives in code

| Concern | File |
| --- | --- |
| Orchestration, A/B/C precedence, idle gating | `src/modules/autonomy/module.ts` |
| Reply-focus + reply-chain decay | `src/director/arbitration.ts` |
| Heartbeat scheduling | `src/director/heartbeat.ts` |
| Intent → typed Command, confidence + fallback | `src/modules/autonomy/grounding.ts` |
| What may act without the player's word (consent gate) | `src/modules/autonomy/consent.ts` |
| Per-NPC autonomy config (level, leader, α, heartbeat) | `autonomy` block in `src/content/schema.ts` |
| `NpcProposal` and related events | `src/events/types.ts` |

Implemented at M2 as the `AutonomyModule` on the tick spine; this document is its contract.

---

## 9. Tuning summary (the knobs that matter)

| Knob | Default | Effect |
| --- | --- | --- |
| `autonomyLevel` | `reactive` | How much initiative an NPC takes. `leader` unlocks proposals. |
| `canLead` | `false` | Whether proposals may auto-execute on tacit consent — within the consent gate (§6): self-scoped acts only. |
| `heartbeatSeconds` | `40` | How often a quiet NPC reconsiders acting. |
| `replyDecayAlpha` (`α`) | `0.2` | How fast NPC-to-NPC chatter tapers. Higher = terser party. |
| grounding confidence threshold | `0.5` | Below this, fall back to a safe Action. |
