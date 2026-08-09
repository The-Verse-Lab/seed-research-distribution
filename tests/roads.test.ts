/**
 * Road network (Step 5, T6) — the spanning tree is stable across incremental town discovery,
 * connected, and degenerate cases don't throw.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { computeRoads, loopEdges, spanningTree, type MapNode, type RoadEdge } from "../src/world/roads.ts";

const N = (id: string, x: number, y: number): MapNode => ({ id, x, y, name: id, kind: "town" });

// A fixed discovery order (hub first), spread so the tree has real structure.
const TOWNS: MapNode[] = [
  N("hub", 0, 0),
  N("a", 12, 1),
  N("b", 1, 12),
  N("c", 22, 4),
  N("d", -9, 9),
  N("e", 14, 15),
];

const key = ([a, b]: RoadEdge): string => [a, b].sort().join("~");

function connected(nodes: MapNode[], edges: RoadEdge[]): boolean {
  if (nodes.length <= 1) return true;
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const [a, b] of edges) {
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  const seen = new Set<string>([nodes[0]!.id]);
  const stack = [nodes[0]!.id];
  while (stack.length) {
    for (const nb of adj.get(stack.pop()!) ?? []) {
      if (!seen.has(nb)) {
        seen.add(nb);
        stack.push(nb);
      }
    }
  }
  return seen.size === nodes.length;
}

describe("T6 — road spanning tree", () => {
  test("never rewires: each discovery step only APPENDS one edge", () => {
    for (let k = 2; k <= TOWNS.length; k++) {
      const prev = spanningTree(TOWNS.slice(0, k - 1)).map(key);
      const cur = spanningTree(TOWNS.slice(0, k)).map(key);
      expect(cur.length).toBe(k - 1);
      // The previous edges are all still present, unchanged.
      expect(cur.slice(0, prev.length)).toEqual(prev);
    }
  });

  test("connected, exactly n-1 edges", () => {
    const tree = spanningTree(TOWNS);
    expect(tree.length).toBe(TOWNS.length - 1);
    expect(connected(TOWNS, tree)).toBe(true);
  });

  test("computeRoads = tree prefix + a bounded number of unique loop edges", () => {
    const tree = spanningTree(TOWNS);
    const roads = computeRoads(TOWNS);
    expect(roads.slice(0, tree.length).map(key)).toEqual(tree.map(key));
    // No duplicate (undirected) edges.
    expect(new Set(roads.map(key)).size).toBe(roads.length);
    // Loops are bounded by ~n/3.
    expect(roads.length - tree.length).toBeLessThanOrEqual(Math.floor(TOWNS.length / 3));
    expect(connected(TOWNS, roads)).toBe(true);
  });

  test("degenerate inputs don't throw", () => {
    expect(spanningTree([])).toEqual([]);
    expect(spanningTree([N("hub", 0, 0)])).toEqual([]);
    expect(computeRoads([N("hub", 0, 0)])).toEqual([]);
    expect(loopEdges([N("hub", 0, 0)], [])).toEqual([]);
  });
});
