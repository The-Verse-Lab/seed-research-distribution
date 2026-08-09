#!/usr/bin/env bun
/**
 * Seed Observatory — launch the local web tool over the game's SQLite DB.
 *
 * Reads the same DB the game writes (`<dataDir>/seed.db`), so it works live during a
 * session and after. Port: first CLI arg, then $SEED_VIEWER_PORT, else 4505.
 *
 * @author Runkai Zhang
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig } from "../config/env.ts";
import { BunSqliteGameStateStore } from "../state/sqlite-store.ts";
import { createViewerServer } from "./server.ts";

const config = loadConfig();
const port = Number(process.argv[2]) || Number(process.env.SEED_VIEWER_PORT) || 4505;
const dbPath = join(config.dataDir, "seed.db");

if (!existsSync(dbPath)) {
  console.log(`(no DB at ${dbPath} yet — play a session with \`bun run dev\`, then hit ↻ in the UI)`);
}

const store = new BunSqliteGameStateStore(dbPath);
const server = createViewerServer(store, port);

console.log(`\n  Seed Observatory  →  http://localhost:${server.port}`);
console.log(`  reading ${dbPath}`);
console.log(`  Ctrl-C to stop\n`);
