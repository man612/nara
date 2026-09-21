import { describe, expect, it } from "vitest";
import {
  DeepSeekBudgetSource,
  OpenRouterBudgetSource,
  ProviderBudgetMonitor
} from "../src/budget/monitor.js";

describe("provider budget monitoring", () => {
  it("classifies DeepSeek balance without model calls", async () => {
    const source = new DeepSeekBudgetSource(
      "key",
      { low: 2, critical: 0.5 },
      {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              is_available: true,
              balance_infos: [
                {
                  currency: "USD",
                  total_balance: "0.40",
                  granted_balance: "0.00",
                  topped_up_balance: "0.40"
                }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )) as typeof fetch
      }
    );

    await expect(source.read()).resolves.toMatchObject({
      providerId: "deepseek",
      available: true,
      level: "critical",
      currency: "USD",
      remaining: 0.4
    });
  });

  it("reads OpenRouter per-key limit remaining", async () => {
    const source = new OpenRouterBudgetSource(
      "key",
      { low: 5, critical: 1 },
      {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              data: {
                usage: 4,
                limit: 10,
                limit_remaining: 6,
                disabled: false
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )) as typeof fetch
      }
    );

    await expect(source.read()).resolves.toMatchObject({
      providerId: "openrouter",
      available: true,
      level: "ok",
      remaining: 6,
      usage: 4,
      limit: 10
    });
  });

  it("fails closed per source without hiding other provider status", async () => {
    const monitor = new ProviderBudgetMonitor([
      {
        id: "broken",
        async read() {
          throw new Error("service unavailable");
        }
      },
      {
        id: "ok",
        async read() {
          return {
            providerId: "ok",
            available: true,
            level: "ok",
            checkedAt: "2026-09-21T00:00:00.000Z"
          };
        }
      }
    ]);

    await expect(monitor.readAll()).resolves.toEqual([
      expect.objectContaining({
        providerId: "broken",
        available: false,
        level: "critical",
        detail: "service unavailable"
      }),
      expect.objectContaining({
        providerId: "ok",
        level: "ok"
      })
    ]);
  });
});
