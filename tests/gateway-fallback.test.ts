/**
 * Probed-gateway tests — a reachable endpoint yields the guarded real gateway; a dead or
 * auth-rejecting one throws `EndpointUnreachableError` with an actionable notice. There is no
 * offline fallback (owner decision, 2026-07-04): clients surface the error instead of degrading
 * to silently-templated play.
 *
 * @author Runkai Zhang
 */
import { describe, expect, test } from "bun:test";
import { EndpointUnreachableError, createProbedGateway, loadConfig } from "../src/config/env.ts";
import { GuardedGateway } from "../src/llm/guarded-gateway.ts";

describe("createProbedGateway", () => {
  test("throws an actionable EndpointUnreachableError when the endpoint is unreachable", async () => {
    const down = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    await expect(createProbedGateway(loadConfig({}), down)).rejects.toThrow(EndpointUnreachableError);
    await expect(createProbedGateway(loadConfig({}), down)).rejects.toThrow(/unreachable/i);
  });

  test("returns the guarded real gateway when the endpoint answers (even a 404)", async () => {
    const up = (() => Promise.resolve(new Response("not found", { status: 404 }))) as unknown as typeof fetch;
    const gateway = await createProbedGateway(loadConfig({}), up);
    expect(gateway).toBeInstanceOf(GuardedGateway);
  });

  test("the retired guard-disable environment variable cannot bypass the guard", async () => {
    const retiredKey = ["SEED", "GUARDRAIL", "DISABLED"].join("_");
    const prior = process.env[retiredKey];
    const up = (() => Promise.resolve(new Response("not found", { status: 404 }))) as unknown as typeof fetch;
    try {
      process.env[retiredKey] = "1";
      const gateway = await createProbedGateway(loadConfig({}), up);
      expect(gateway).toBeInstanceOf(GuardedGateway);
    } finally {
      if (prior === undefined) delete process.env[retiredKey];
      else process.env[retiredKey] = prior;
    }
  });

  test("treats an auth rejection (401) as an error, never a degraded session", async () => {
    const unauthorized = (() =>
      Promise.resolve(new Response("unauthorized", { status: 401 }))) as unknown as typeof fetch;
    await expect(createProbedGateway(loadConfig({}), unauthorized)).rejects.toThrow(/authentication/i);
  });
});
