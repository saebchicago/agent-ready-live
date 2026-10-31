import { describe, expect, it, vi } from "vitest";
import { ChatSender } from "../src/twitch/chat.js";

describe("ChatSender", () => {
  it("starts outgoing messages at least one second apart", async () => {
    let now = 0;
    const sendTimes: number[] = [];
    const waits: number[] = [];
    const auth = {
      fetch: vi.fn(async () => {
        sendTimes.push(now);
        return new Response(null, { status: 204 });
      }),
    };
    const sender = new ChatSender({
      auth,
      botUserId: "10",
      channelUserId: "20",
      now: () => now,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    });

    await Promise.all([sender.send("one"), sender.send("two"), sender.send("three")]);

    expect(sendTimes).toEqual([0, 1_000, 2_000]);
    expect(waits).toEqual([1_000, 1_000]);
  });

  it("truncates messages to 500 Unicode characters", async () => {
    let sentBody = "";
    const auth = {
      fetch: vi.fn(async (_url: string | URL, init?: RequestInit) => {
        sentBody = String(init?.body);
        return new Response(null, { status: 204 });
      }),
    };
    const sender = new ChatSender({
      auth,
      botUserId: "10",
      channelUserId: "20",
    });

    await sender.send("😀".repeat(501));

    const body = JSON.parse(sentBody) as { message: string };
    expect(Array.from(body.message)).toHaveLength(500);
  });
});
