/**
 * Structured physical features for narrator and NPC perception prompts.
 *
 * @author Runkai Zhang
 */
import type { Body } from "../content/schema.ts";

/**
 * The physical-feature phrases a text prompt should carry, in head-to-body order. Empty facets are
 * dropped, so an unauthored body contributes nothing and the line is omit-when-empty for its caller.
 */
export function bodyFacetPhrases(body: Body | undefined): string[] {
  if (!body) return [];
  const facets = [body.height, body.build, body.hair, body.eyes, body.skin, body.face, body.distinguishing];
  return facets.map((facet) => facet?.trim() ?? "").filter((facet) => facet.length > 0);
}

/** {@link bodyFacetPhrases} joined into one readable clause; "" when nothing is perceivable. */
export function describeBody(body: Body | undefined): string {
  return bodyFacetPhrases(body).join(", ");
}
