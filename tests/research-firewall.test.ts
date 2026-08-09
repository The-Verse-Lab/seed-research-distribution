/**
 * Distribution firewall for the research extraction.
 *
 * Executable code, tests, configuration, active documentation, authored worlds, and playtest
 * assets must stay free of retired product surfaces and the replaced bundled campaign.
 */
import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaySetFromDir } from "../src/content/loader.ts";
import { loadResearchSuiteFromDir } from "../src/research/scenario.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SELF = "tests/research-firewall.test.ts";
const retiredWorldTitle = ["Sundered", "Reach"].join(" ");
const retiredWorldPath = ["worlds", ["sundered", "reach"].join("-")].join("/");
const bundledWorldSlug = ["wakeward", "isles"].join("-");

const safetyAllowlist = new Set([
  "src/llm/safety.ts",
  "src/llm/guarded-gateway.ts",
  "src/safety/minor.ts",
  "tests/safety.test.ts",
  "tests/guarded-gateway.test.ts",
  "playtest/scripts/safety-matrix.ts",
  "playtest/scripts/safety-engine-probe.txt",
]);

const removedPaths = [
  ["src", "modules", ["inti", "macy"].join("")].join("/"),
  ["src", "rules", `${["inti", "macy"].join("")}.ts`].join("/"),
  ["src", "rules", `${["preda", "tion"].join("")}.ts`].join("/"),
  ["src", "rules", `${["preda", "tion-mark"].join("")}.ts`].join("/"),
  ["src", "safety", `${["player", "coercion"].join("-")}.ts`].join("/"),
  ["src", "rules", "claims.ts"].join("/"),
  ["src", "rules", "opportunity.ts"].join("/"),
  ["src", "engine", "resolvers", "claims.ts"].join("/"),
  ["src", "web"].join("/"),
  ["src", "web-ui"].join("/"),
  ["src", "art"].join("/"),
  ["src", "analytics"].join("/"),
  ["playtest", "run-live.sh"].join("/"),
  ["playtest", "bc-live.txt"].join("/"),
  ["playtest", "bc-long.txt"].join("/"),
  ["playtest", "bc-reload.txt"].join("/"),
  ["playtest", "thistle-short.txt"].join("/"),
  "workflows",
];

const retiredIdentifiers = [
  ["intimate", "Advance"].join(""),
  ["consensual", "Action"].join(""),
  ["consensual", "Scene"].join(""),
  ["intimacy", "FocusId"].join(""),
  ["open", "Predation"].join(""),
  ["predator", "Style"].join(""),
  ["predator", "Targets"].join(""),
  ["predator", "Share"].join(""),
  ["predator", "Pool"].join(""),
  ["predation", "Mark"].join(""),
  ["exposureInvites", "Predation"].join(""),
  ["vulnerabilityInvites", "Predation"].join(""),
  ["requires", "AdultLayer"].join(""),
  ["requiresAllParticipants", "Adult"].join(""),
  ["requiresExplicitAdult", "Ages"].join(""),
  ["content", "Profile"].join(""),
  ["allowNon", "Consensual"].join(""),
  ["coercive", "Courtship"].join(""),
  ["relationship", "Stats"].join(""),
  ["adjustRelationship", "Stat"].join(""),
  ["relationshipStat", "Changed"].join(""),
  ["coercion", "Risk"].join(""),
  ["SEED", "INTIMACY"].join("_"),
  ["N", "SFW"].join(""),
  ["Client", "Msg"].join(""),
  ["Server", "Msg"].join(""),
  ["Action", "Msg"].join(""),
  ["OpenShop", "Msg"].join(""),
  ["open", "shop"].join("-"),
  ["guidance", "Of"].join(""),
  ["Character", "Art"].join(""),
  ["SEED", "GUARDRAIL", "DISABLED"].join("_"),
];

const retiredContentWords = [
  ["ad", "ult"].join(""),
  ["inti", "macy"].join(""),
  ["inti", "mate"].join(""),
  ["pred", "ator"].join(""),
  ["pred", "atory"].join(""),
  ["preda", "tion"].join(""),
  ["rom", "ance"].join(""),
  ["N", "SFW"].join(""),
  ["sex", "ual"].join(""),
  ["sex", "ualized"].join(""),
  ["ero", "tic"].join(""),
  ["nu", "de"].join(""),
  ["nu", "dity"].join(""),
  ["na", "ked"].join(""),
  ["sed", "uce"].join(""),
  ["seduc", "tion"].join(""),
  ["seduc", "tive"].join(""),
  ["lu", "st"].join(""),
  ["lust", "ful"].join(""),
  ["arou", "sal"].join(""),
  ["org", "asm"].join(""),
  ["ra", "pe"].join(""),
  ["rap", "ed"].join(""),
  ["rap", "ist"].join(""),
  ["bro", "thel"].join(""),
  ["pros", "titute"].join(""),
  ["prosti", "tution"].join(""),
  ["cour", "tesan"].join(""),
  ["lib", "ido"].join(""),
  ["fet", "ish"].join(""),
  ["ki", "nk"].join(""),
  ["po", "rn"].join(""),
  ["porno", "graphic"].join(""),
  ["in", "cest"].join(""),
  ["vir", "gin"].join(""),
  ["virgin", "ity"].join(""),
  ["gen", "ital"].join(""),
  ["bre", "ast"].join(""),
  ["who", "re"].join(""),
  ["fu", "ck"].join(""),
  ["fuck", "ing"].join(""),
];

const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".json",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".sh",
  ".toml",
  ".py",
  ".cff",
  ".example",
  "",
]);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function filesBelow(path: string): Promise<string[]> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (info.isFile()) return [path];
  const out: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) out.push(...(await filesBelow(child)));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

function extensionOf(path: string): string {
  const at = path.lastIndexOf(".");
  return at < 0 ? "" : path.slice(at);
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("research distribution firewall", () => {
  test("retired implementation directories and files stay deleted", async () => {
    const present: string[] = [];
    for (const path of removedPaths) {
      if (await exists(resolve(ROOT, path))) present.push(path);
    }
    expect(present).toEqual([]);
  });

  test("cut identifiers do not return to executable or authored surfaces", async () => {
    const roots = [
      "src",
      "tests",
      "worlds",
      "characters",
      "playtest",
      "docs",
      "README.md",
      "RESEARCH.md",
      "CLAUDE.md",
      "AGENTS.md",
      "NOTICE",
      "CITATION.cff",
      ".claude",
      ".codex",
      ".conductor",
      "package.json",
      ".env.example",
    ];
    const files = (await Promise.all(roots.map((path) => filesBelow(resolve(ROOT, path))))).flat();
    const identifierPattern = new RegExp(retiredIdentifiers.map(escaped).join("|"), "i");
    const contentPattern = new RegExp(`\\b(?:${retiredContentWords.map(escaped).join("|")})s?\\b`, "i");
    const legacyKeys = [
      ["ad", "ult"].join(""),
      ["orien", "tation"].join(""),
      ["all", "ure"].join(""),
      ["bu", "st"].join(""),
      ["gen", "itals"].join(""),
    ];
    const legacyKeyPattern = new RegExp(`['\"](?:${legacyKeys.map(escaped).join("|")})['\"]\\s*:`, "i");
    const failures: string[] = [];

    for (const file of files) {
      const path = relative(ROOT, file);
      if (path === SELF || safetyAllowlist.has(path) || !textExtensions.has(extensionOf(file))) continue;
      const text = await readFile(file, "utf8");
      const authoredContent =
        path.startsWith("worlds/") ||
        path.startsWith("characters/") ||
        path.startsWith("tests/fixtures/") ||
        path.startsWith("playtest/worlds/");
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (identifierPattern.test(line) || legacyKeyPattern.test(line) || (authoredContent && contentPattern.test(line))) {
          failures.push(`${path}:${index + 1}: ${line.trim()}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  test("the replaced campaign title and path stay absent from active distribution surfaces", async () => {
    const roots = [
      "src",
      "tests",
      "worlds",
      "characters",
      "playtest",
      "docs",
      "README.md",
      "RESEARCH.md",
      "CLAUDE.md",
      "AGENTS.md",
      "NOTICE",
      "CITATION.cff",
      ".claude",
      ".codex",
      ".conductor",
      "package.json",
      ".env.example",
    ];
    const files = (await Promise.all(roots.map((path) => filesBelow(resolve(ROOT, path))))).flat();
    const retiredTitleAcrossWhitespace = retiredWorldTitle.split(/\s+/).map(escaped).join("\\s+");
    const pattern = new RegExp(`${retiredTitleAcrossWhitespace}|${escaped(retiredWorldPath)}`, "i");
    const failures: string[] = [];

    for (const file of files) {
      if (!textExtensions.has(extensionOf(file))) continue;
      const path = relative(ROOT, file);
      if (pattern.test(await readFile(file, "utf8"))) failures.push(path);
    }

    expect(failures).toEqual([]);
    expect(await exists(resolve(ROOT, retiredWorldPath))).toBe(false);
  });

  test("distribution metadata contains no machine-specific home path or private-fork instructions", async () => {
    const roots = [
      "README.md",
      "RESEARCH.md",
      "NOTICE",
      "CITATION.cff",
      "AGENTS.md",
      "CLAUDE.md",
      ".claude",
      ".codex",
      ".conductor",
    ];
    const files = (await Promise.all(roots.map((path) => filesBelow(resolve(ROOT, path))))).flat();
    const privateMarkers = [
      "/Users/",
      "/home/",
      ["The-Verse-Lab", "seed"].join("/"),
      ["upstream", "main"].join("/"),
      ["strip", "adult-layer"].join("/"),
    ];
    const windowsHome = /[A-Za-z]:\\Users\\/i;
    const failures: string[] = [];

    for (const file of files) {
      const path = relative(ROOT, file);
      if (!textExtensions.has(extensionOf(file))) continue;
      for (const [index, line] of (await readFile(file, "utf8")).split(/\r?\n/).entries()) {
        if (privateMarkers.some((marker) => line.includes(marker)) || windowsHome.test(line)) {
          failures.push(`${path}:${index + 1}`);
        }
      }
    }

    expect(failures).toEqual([]);
    expect(await readFile(resolve(ROOT, ".gitignore"), "utf8")).toContain("playtest/transcripts/");
  });

  test("Wakeward Isles is the only bundled playset and the CLI default resolves to it", async () => {
    const bundledDirectories = (await readdir(resolve(ROOT, "worlds"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(bundledDirectories).toEqual([bundledWorldSlug]);

    const worldDir = resolve(ROOT, "worlds", bundledWorldSlug);
    const playset = await loadPlaySetFromDir(worldDir);
    const suite = await loadResearchSuiteFromDir(worldDir);
    expect(playset.world.id).toBe("world.wakeward-isles");
    expect(playset.campaign.id).toBe("camp.wakeward.first-circuit");
    expect(suite.manifest.scenarios).toHaveLength(18);

    const cli = await readFile(resolve(ROOT, "src/cli/main.ts"), "utf8");
    expect(cli).toContain(["..", "..", "worlds", bundledWorldSlug].join("/"));
  });

  test("the package exposes only retained CLI and observability scripts", async () => {
    const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scripts = Object.keys(pkg.scripts ?? {});
    expect(scripts).not.toContain("web");
    expect(scripts).not.toContain("build:web");
    expect(scripts).not.toContain("playtest");

    const packages = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    const retiredPackageFragments = [["post", "hog"].join(""), ["svel", "te"].join(""), ["vi", "te"].join("")];
    expect(packages.filter((name) => retiredPackageFragments.some((part) => name.toLowerCase().includes(part)))).toEqual([]);
  });
});
