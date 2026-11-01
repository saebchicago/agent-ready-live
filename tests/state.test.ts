import { describe, expect, it } from "vitest";
import type { Target } from "../src/config.js";
import { GameEngine } from "../src/server/game.js";
import {
  CORRECT_BET_POINTS,
  LEADERBOARD_TTL_MS,
  QUEUE_CAP,
  createInitialState,
  gameReducer,
} from "../src/server/state.js";

const baseTime = Date.parse("2026-10-31T12:00:00Z");

function target(alias: string, mode: "knock" | "audit" = "knock"): Target {
  return {
    alias,
    name: alias,
    host: `${alias}.example.test`,
    mode,
    ...(mode === "audit" ? { catalogUrl: `https://${alias}.example.test/data.json`, dialect: "dcat" as const } : {}),
    tos: { status: "prohibited", sourceUrl: `https://${alias}.example.test/terms`, evidence: "No automation.", reviewedOn: "2026-10-31" },
    tosReviewed: true,
    notes: "Synthetic reducer target",
  };
}

function beginAudit(alias = "alpha") {
  let state = createInitialState("REPLAY");
  state = gameReducer(state, {
    type: "ENQUEUE",
    now: baseTime,
    entry: {
      id: "round-1",
      targetAlias: alias,
      targetName: alias,
      targetMode: "knock",
      requestedBy: "viewer",
      enqueuedAt: new Date(baseTime).toISOString(),
    },
  });
  return gameReducer(state, { type: "START_NEXT", now: baseTime });
}

describe("gameReducer", () => {
  it("caps queue at five and starts one audit at a time", () => {
    let state = createInitialState("LIVE");
    for (let index = 0; index < QUEUE_CAP + 1; index += 1) {
      state = gameReducer(state, {
        type: "ENQUEUE",
        now: baseTime,
        entry: {
          id: `id-${index}`,
          targetAlias: `alias-${index}`,
          targetName: `Alias ${index}`,
          targetMode: "knock",
          requestedBy: "chat",
          enqueuedAt: new Date(baseTime).toISOString(),
        },
      });
    }
    expect(state.queue).toHaveLength(QUEUE_CAP);
    state = gameReducer(state, { type: "START_NEXT", now: baseTime });
    expect(state.currentAudit?.targetAlias).toBe("alias-0");
    expect(state.queue).toHaveLength(QUEUE_CAP - 1);
    expect(gameReducer(state, { type: "START_NEXT", now: baseTime })).toBe(state);
  });

  it("scores correct bets, advances streaks, and counts distinct correct bettors", () => {
    let state = beginAudit();
    state = gameReducer(state, { type: "BET_OPEN", now: baseTime, checkId: "K2", question: "Allowed?", closesAt: new Date(baseTime + 8_000).toISOString() });
    state = gameReducer(state, { type: "BET_PLACE", now: baseTime + 1, userId: "u1", displayHandle: "viewer-one", choice: "y" });
    state = gameReducer(state, { type: "BET_PLACE", now: baseTime + 2, userId: "u2", displayHandle: "viewer-two", choice: "n" });
    expect(state.bet?.yes).toBe(1);
    expect(state.bet?.no).toBe(1);
    state = gameReducer(state, { type: "BET_CLOSE", now: baseTime + 8_000, correctChoice: "y" });
    expect(state.scores.u1?.points).toBe(CORRECT_BET_POINTS);
    expect(state.scores.u1?.streak).toBe(1);
    expect(state.scores.u2?.streak).toBe(0);
    expect(state.currentAudit?.correctBettors).toEqual(["viewer-one"]);
  });

  it("uses the last vote per chatter and closes voting at the deadline", () => {
    let state = beginAudit();
    state = gameReducer(state, { type: "BET_OPEN", now: baseTime, checkId: "K2", question: "Allowed?", closesAt: new Date(baseTime + 8_000).toISOString() });
    state = gameReducer(state, { type: "BET_PLACE", now: baseTime + 1, userId: "u1", displayHandle: "viewer", choice: "y" });
    state = gameReducer(state, { type: "BET_PLACE", now: baseTime + 2, userId: "u1", displayHandle: "viewer", choice: "n" });
    expect(state.bet?.yes).toBe(0);
    expect(state.bet?.no).toBe(1);
    const closed = gameReducer(state, { type: "BET_PLACE", now: baseTime + 8_000, userId: "u2", displayHandle: "late", choice: "y" });
    expect(closed).toBe(state);
  });

  it("expires leaderboard rows after seven days and retains sample metadata", () => {
    let state = beginAudit();
    state = gameReducer(state, {
      type: "VERDICT",
      now: baseTime,
      score: 90,
      text: "90/100 | Sampled 3 | Probed 2026-10-31 | Rubric v1 | Not a ranking of agency quality",
      reasons: ["K2:allowed"],
      sampledEntries: 3,
      probedOn: "2026-10-31",
    });
    const row = state.leaderboards.knock[0];
    expect(row?.sampledEntries).toBe(3);
    expect(row?.rubricVersion).toBe("Rubric v1");
    expect(Date.parse(row?.expiresAt ?? "") - Date.parse("2026-10-31T00:00:00.000Z")).toBe(LEADERBOARD_TTL_MS);
    state = gameReducer(state, { type: "PRUNE", now: Date.parse(row?.expiresAt ?? "") + 1 });
    expect(state.leaderboards.knock).toHaveLength(0);
  });

  it("stop clears the queue and blocks new work", () => {
    let state = createInitialState("LIVE");
    state = gameReducer(state, { type: "STOP", now: baseTime });
    state = gameReducer(state, {
      type: "ENQUEUE",
      now: baseTime + 1,
      entry: { id: "x", targetAlias: "x", targetName: "x", targetMode: "knock", requestedBy: "x", enqueuedAt: "" },
    });
    expect(state.stopped).toBe(true);
    expect(state.queue).toHaveLength(0);
  });
});

describe("GameEngine terms replay", () => {
  it("shows the featured terms door without invoking its fetcher", async () => {
    let calls = 0;
    const game = new GameEngine({
      runtimeMode: "REPLAY",
      targets: [target("michigan")],
      fetcher: { runAudit: async () => { calls += 1; throw new Error("no request expected"); } },
      now: () => baseTime,
      sleep: async () => undefined,
      doorClosedMs: 0,
    });
    game.queueAudit({ alias: "michigan", mode: "knock", requestedBy: "demo" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(0);
    expect(game.store.getState().phase).toBe("idle");
  });
});
