# The Observatory — logging & transparency

A local web tool that gives you (and anyone working on the model) full visibility into a
play session: the **transcript**, every **LLM call** (prompts, responses, reasoning,
tokens, latency), the **game state**, and one-click **export**.

```sh
bun run viewer            # → http://localhost:4505
bun run viewer 7000       # custom port (or set SEED_VIEWER_PORT)
```

It reads the same `data/seed.db` the game writes, so it works **live while you play** and
between sessions. Play with `bun run dev` in one terminal, watch in the browser in another.

## What's captured

Everything persists to the one SQLite DB:

- **LLM calls** (`llm_calls` table) — for every model call: role (narrator/creative/utility/embedding),
  model, the *full request* (system prompt + messages + sampling params), the response text,
  the **reasoning** (`<thinking>` or `reasoning_content`), token usage, latency, finish
  status, and any error. This is the core view for model work.
- **Transcript** — the game event log (narration, dialogue, dice, state changes, system notes).
- **State** — the latest snapshot (location, party, clock, quests, actors, relationships).
- **Playset** (`meta` table) — the world + campaign, so the tool shows real names, not ids.

## The views

- **Transcript** — the readable play log.
- **LLM Calls** — newest first; click any call to expand the full prompt → response →
  reasoning, with role/model/tokens/latency/finish. This is where you debug model behavior.
- **State** — party, location, time, quests, actor HP, and the raw snapshot.
- **Cost** — totals + per-role breakdown: calls, in/out tokens, throughput (tok/s), avg
  latency, error rate, and an optional **$ estimate** (enter your per-1M-token prices;
  leave 0 for local/free models — they persist in the browser). All computed from
  `llm_calls`, live. Token counts come from the model's usage report — streaming requests
  set `stream_options.include_usage`, so narration is measured too, not just classification.

Toggle **live** to tail new events/calls over SSE. **Export .md** (readable transcript) or
**.json** (self-contained bundle) downloads the current session.

## How it works

- `LoggingGateway` ([src/logging/logging-gateway.ts](../src/logging/logging-gateway.ts))
  transparently wraps the real `LlmGateway` and records every call. Recording is
  **best-effort** — a logging failure never affects or slows a turn.
- The SQLite store ([src/state/sqlite-store.ts](../src/state/sqlite-store.ts)) is the
  `LogSink`; it also stores events, snapshots, and the playset.
- The viewer ([src/viewer/](../src/viewer/server.ts)) is a read-only `Bun.serve` server
  exposing a small JSON API + SSE + the single-page UI, launched separately so it never
  touches the game loop.

## Notes

- The viewer is **read-only** and local; it does not modify the game DB.
- Logged prompts can contain mature content (it's an uncensored engine) and the full
  system prompt including any `SEED_SYSTEM_PREFIX` — that's intended for transparency. The
  API key is **never** logged (only the messages + params are).
