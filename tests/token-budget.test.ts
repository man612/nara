import { describe, expect, it } from "vitest";
import { DailyTokenBudget } from "../src/budget/token-ledger.js";

describe("DailyTokenBudget", () => {
  it("counts cumulative provider usage as deltas and warns on level crossings", () => {
    const now = new Date("2026-09-21T10:00:00.000Z");
    const budget = new DailyTokenBudget({
      limitTokens: 1000,
      lowFraction: 0.8,
      criticalFraction: 0.95,
      timeZone: "UTC",
      now: () => now
    });

    expect(budget.recordCumulative("session-a", 500)).toMatchObject({
      usedTokens: 500,
      remainingTokens: 500,
      level: "ok",
      changedLevel: false
    });

    expect(budget.recordCumulative("session-a", 850)).toMatchObject({
      usedTokens: 850,
      remainingTokens: 150,
      level: "low",
      changedLevel: true
    });

    expect(budget.recordCumulative("session-a", 900)).toMatchObject({
      usedTokens: 900,
      level: "low",
      changedLevel: false
    });

    expect(budget.recordCumulative("session-b", 70)).toMatchObject({
      usedTokens: 970,
      remainingTokens: 30,
      level: "critical",
      changedLevel: true
    });

    expect(budget.recordCumulative("session-b", 120)).toMatchObject({
      usedTokens: 1020,
      remainingTokens: 0,
      level: "exhausted",
      changedLevel: true
    });
  });

  it("resets on the configured local date boundary", () => {
    let now = new Date("2026-09-21T16:59:00.000Z");
    const budget = new DailyTokenBudget({
      limitTokens: 1000,
      timeZone: "Asia/Jakarta",
      now: () => now
    });

    budget.recordCumulative("session-a", 900);
    expect(budget.snapshot().localDate).toBe("2026-09-21");

    now = new Date("2026-09-21T17:01:00.000Z");
    expect(budget.snapshot()).toMatchObject({
      localDate: "2026-09-22",
      usedTokens: 0,
      remainingTokens: 1000,
      level: "ok"
    });
  });

  it("treats a provider counter decrease as a new cumulative epoch", () => {
    const budget = new DailyTokenBudget({
      limitTokens: 1000
    });
    budget.recordCumulative("session-a", 300);
    budget.recordCumulative("session-a", 20);
    expect(budget.snapshot().usedTokens).toBe(320);
  });
});
