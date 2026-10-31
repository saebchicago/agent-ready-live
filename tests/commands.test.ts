import { describe, expect, it } from "vitest";
import { CommandRouter, parseCommand } from "../src/commands.js";

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
