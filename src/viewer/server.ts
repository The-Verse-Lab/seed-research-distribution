/**
 * Observatory server — a local web tool over Seed's SQLite DB.
 *
 * Read-only HTTP/JSON API + SSE live tailing + Markdown/JSON export, plus the single-page
 * UI. It reads the same DB the game writes, so it works live during a session and after.
 *
 * @author Runkai Zhang
 */
import type { BunSqliteGameStateStore } from "../state/sqlite-store.ts";
import { makeSaveKey } from "../state/store.ts";
import { transcriptToJson, transcriptToMarkdown } from "../logging/export.ts";
import { briefBlocks, briefFromMessages } from "../logging/brief-blocks.ts";
import { INDEX_HTML } from "./web.ts";

interface PlaysetLike {
  world?: { name?: string; npcs?: { id: string; name: string }[] };
  campaign?: { name?: string; characters?: { id: string; name: string }[] };
}

function buildNames(playset: unknown): Record<string, string> {
  const ps = playset as PlaysetLike | null;
  const map: Record<string, string> = {};
  for (const c of ps?.campaign?.characters ?? []) map[c.id] = c.name;
  for (const n of ps?.world?.npcs ?? []) map[n.id] = n.name;
  return map;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

function sse(
  store: BunSqliteGameStateStore,
  campaign: string,
  character: string,
  startSeq: number,
  startId: number,
  startTraceSeq: number,
): Response {
  let lastSeq = startSeq;
  let lastId = startId;
  // Traces are keyed by `turnSeq`, a DIFFERENT counter from the event `seq` — seeding this from the
  // event seq (the old bug) meant the trace tail started past every real trace, so the Turns tab
  // never live-updated. The client now sends its own trace cursor (`sinceTraceSeq`).
  let lastTraceSeq = startTraceSeq;
  const key = makeSaveKey(campaign, character);
  let timer: ReturnType<typeof setInterval> | null = null;
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const tick = async (): Promise<void> => {
        try {
          const events = await store.readEvents(key, { sinceSeq: lastSeq + 1 });
          const llm = store.readLlmCalls(campaign, { sinceId: lastId });
          const traces = store.readTraces(campaign, character, { sinceSeq: lastTraceSeq + 1 });
          if (events.length || llm.length || traces.length) {
            for (const e of events) lastSeq = Math.max(lastSeq, e.seq);
            for (const c of llm) lastId = Math.max(lastId, c.id);
            for (const t of traces) lastTraceSeq = Math.max(lastTraceSeq, t.turnSeq);
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ events, llm, traces })}\n\n`));
          } else {
            controller.enqueue(enc.encode(`: ping\n\n`));
          }
        } catch {
          // ignore transient poll errors; the next tick retries
        }
      };
      timer = setInterval(() => void tick(), 1200);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

export function createViewerServer(store: BunSqliteGameStateStore, port: number) {
  return Bun.serve({
    port,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      const campaign = url.searchParams.get("campaign") ?? "";
      const character = url.searchParams.get("character") ?? "";
      const key = makeSaveKey(campaign, character);

      if (path === "/" || path === "/index.html") {
        return new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (path === "/api/campaigns") {
        return json(store.listCampaigns());
      }

      if (path === "/api/data") {
        const playset = store.loadPlayset(campaign);
        const [state, events] = [await store.load(key), await store.readEvents(key)];
        const llm = store.readLlmCalls(campaign);
        const traces = store.readTraces(campaign, character);
        return json({ campaignId: campaign, characterId: character, names: buildNames(playset), playset, state, events, llm, traces });
      }

      if (path === "/api/traces") {
        return json(store.readTraces(campaign, character));
      }

      // Brief composition for ONE logged call (see `logging/brief-blocks.ts`): which blocks the
      // prompt was made of and what each cost. Computed on demand rather than attached to every
      // `/api/data` row — a long campaign has thousands of calls and only the expanded one matters.
      if (path === "/api/brief") {
        const id = Number(url.searchParams.get("id") ?? "");
        if (!Number.isInteger(id) || id <= 0) return json({ error: "bad id" });
        // `sinceId` is exclusive, so this asks for exactly the row at `id` (ordered ASC, limit 1).
        const [call] = store.readLlmCalls(campaign, { sinceId: id - 1, limit: 1 });
        if (!call || call.id !== id) return json({ error: "not found" });
        const request = call.request as { messages?: unknown } | null;
        const brief = briefFromMessages(request?.messages);
        if (brief === null) return json({ blocks: [], totalBytes: 0, role: call.role, model: call.model });
        const blocks = briefBlocks(brief);
        return json({
          blocks,
          totalBytes: blocks.reduce((n, b) => n + b.bytes, 0),
          role: call.role,
          model: call.model,
          promptTokens: call.promptTokens,
        });
      }

      if (path === "/api/stream") {
        const sinceSeq = Number(url.searchParams.get("sinceSeq") ?? "-1");
        const sinceId = Number(url.searchParams.get("sinceId") ?? "0");
        const sinceTraceSeq = Number(url.searchParams.get("sinceTraceSeq") ?? "-1");
        return sse(store, campaign, character, sinceSeq, sinceId, sinceTraceSeq);
      }

      if (path === "/api/export") {
        const format = url.searchParams.get("format") ?? "md";
        const playset = store.loadPlayset(campaign) as PlaysetLike | null;
        const events = await store.readEvents(key);
        const base = playset?.campaign?.name ?? campaign;
        if (format === "json") {
          const state = await store.load(key);
          // The FULL bundle — not just prose. Include every logged model call (role, model, request
          // messages, response, reasoning/thinking, tokens, latency) and per-turn traces (classifier
          // kind/target/confidence, NPC beats, dropped actions, model calls), so an export can debug
          // the agent/model layer, not only the narrative.
          const llm = store.readLlmCalls(campaign);
          const traces = store.readTraces(campaign, character);
          const names = buildNames(playset);
          const body = transcriptToJson({
            campaignId: campaign,
            characterId: character,
            exportedAt: Date.now(),
            events,
            state,
            llm,
            traces,
            names,
          });
          return new Response(body, {
            headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${campaign}.json"` },
          });
        }
        const names = buildNames(playset);
        const body = transcriptToMarkdown(events, { title: `${base} — transcript`, nameOf: (id) => names[id] ?? id });
        return new Response(body, {
          headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${campaign}.md"` },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });
}
