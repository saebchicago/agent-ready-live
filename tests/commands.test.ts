import { describe, expect, it } from "vitest";
import { CommandRouter, parseCommand, type CommandGame } from "../src/commands.js";

describe("parseCommand", () => {
  it("parses command names case-insensitively and preserves arguments", () => {
    expect(parseCommand("  !PiNg one two  ")).toEqual({
      name: "ping",
      args: ["one", "two"],
    });
  });

  it("ignores ordinary chat and an empty command marker", () => {
    expect(parseCommand("hello chat")).toBeUndefined();
    expect(parseCommand("!")).toBeUndefined();
  });
});

describe("CommandRouter cooldowns", () => {
  it("enforces a three-second cooldown independently per user", () => {
    let now = 1_000;
    const router = new CommandRouter(() => now);

    expect(router.handle({ userId: "viewer-1", text: "!ping" })).toBe(
      "pong (Agent-Ready Live is alive)",
    );
    now = 3_999;
    expect(router.handle({ userId: "viewer-1", text: "!ping" })).toBeUndefined();
    expect(router.handle({ userId: "viewer-2", text: "!ping" })).toBe(
      "pong (Agent-Ready Live is alive)",
    );
    now = 4_000;
    expect(router.handle({ userId: "viewer-1", text: "!ping" })).toBe(
      "pong (Agent-Ready Live is alive)",
    );
  });

  it("does not apply cooldowns to unknown commands", () => {
    const router = new CommandRouter(() => 1_000);
    expect(router.handle({ userId: "viewer", text: "!audit detroit" })).toBeUndefined();
    expect(router.handle({ userId: "viewer", text: "!ping" })).toBe(
      "pong (Agent-Ready Live is alive)",
    );
  });
});

describe("game command routing", () => {
  function fakeGame(): CommandGame & { queued: unknown[]; stopped: number } {
    const game = {
      queued: [] as unknown[],
      stopped: 0,
      queueAudit(request: unknown) {
        this.queued.push(request);
        return { status: "queued" as const, position: 1, targetName: "Wikipedia" };
      },
      placeBet: () => "accepted" as const,
      score: () => ({ points: 20, streak: 2 }),
      board: () => "wikipedia K2 allowed",
      why: () => "K2 explainer",
      fix: () => "D3 fix-it",
      national: () => "National lens: 100 datasets. Probed 2026-11-02 | Not a ranking.",
      publisher: (name: string) => `${name}: 8. Probed 2026-11-02 | Not a ranking.`,
      trap: () => "Census notice and corrected sample trap.",
      stop() { this.stopped += 1; },
    };
    return game;
  }

  it("routes knocks, audits, bets, score, board, why, fix, national, publisher, and trap", () => {
    let now = 0;
    const game = fakeGame();
    const router = new CommandRouter({
      now: () => now,
      game,
      displayHandle: (login) => login === "consented" ? login : "Anonymous viewer",
    });
    expect(router.handle({ userId: "u1", userLogin: "consented", text: "!knock wikipedia" })).toBeUndefined();
    now += 1_000;
    expect(router.handle({ userId: "u1", userLogin: "consented", text: "!audit boston" })).toBeUndefined();
    expect(game.queued).toEqual([
      { alias: "wikipedia", mode: "knock", requestedBy: "consented" },
      { alias: "boston", mode: "audit", requestedBy: "consented" },
    ]);
    now += 1_000;
    expect(router.handle({ userId: "u1", userLogin: "consented", text: "!y" })).toContain("yes");
    now += 1_000;
    expect(router.handle({ userId: "u1", userLogin: "consented", text: "!score" })).toContain("20 points");
    now += 1_000;
    expect(router.handle({ userId: "u1", userLogin: "consented", text: "!board" })).toContain("wikipedia K2 allowed");
    now += 1_000;
    expect(router.handle({ userId: "u1", userLogin: "consented", text: "!why" })).toBe("K2 explainer");
    now += 1_000;
    expect(router.handle({ userId: "u1", userLogin: "consented", text: "!fix" })).toBe("D3 fix-it");
    now += 1_000;
    expect(router.handle({ userId: "u1", userLogin: "consented", text: "!national" })).toContain("100 datasets");
    now += 1_000;
    expect(router.handle({ userId: "u1", userLogin: "consented", text: "!publisher Michigan" })).toContain("Michigan: 8");
    now += 1_000;
    expect(router.handle({ userId: "u1", userLogin: "consented", text: "!trap" })).toContain("Census notice");
  });

  it("allows only a moderator or broadcaster to engage the kill switch", () => {
    let now = 0;
    const game = fakeGame();
    const router = new CommandRouter({ now: () => now, game });
    expect(router.handle({ userId: "u1", text: "!stop" })).toContain("Only");
    now += 1_000;
    expect(router.handle({ userId: "u2", text: "!stop", isModerator: true })).toContain("Kill switch");
    expect(game.stopped).toBe(1);
  });
});
