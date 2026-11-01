import { describe, expect, it, vi } from "vitest";
import {
  EventSubClient,
  type ChatMessageEvent,
  type EventSocket,
} from "../src/twitch/eventsub.js";

type ListenerMap = {
  message: Array<(data: unknown) => void>;
  close: Array<(code: number, reason: Buffer) => void>;
  error: Array<(error: Error) => void>;
};

class MockSocket implements EventSocket {
  readonly listeners: ListenerMap = { message: [], close: [], error: [] };
  closed = false;

  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: keyof ListenerMap, listener: ListenerMap[typeof event][number]): this {
    (this.listeners[event] as Array<typeof listener>).push(listener);
    return this;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.listeners.close) listener(1000, Buffer.alloc(0));
  }

  message(value: unknown): void {
    const data = Buffer.from(JSON.stringify(value));
    for (const listener of this.listeners.message) listener(data);
  }
}

function envelope(messageId: string, messageType: string, payload: object): object {
  return {
    metadata: { message_id: messageId, message_type: messageType },
    payload,
  };
}

function welcome(messageId: string, sessionId: string): object {
  return envelope(messageId, "session_welcome", {
    session: {
      id: sessionId,
      keepalive_timeout_seconds: 10,
      reconnect_url: null,
    },
  });
}

function notification(
  envelopeId: string,
  messageId: string,
  chatterUserId = "viewer-id",
  badges: Array<{ set_id: string }> = [],
): object {
  return envelope(envelopeId, "notification", {
    subscription: { type: "channel.chat.message" },
    event: {
      message_id: messageId,
      chatter_user_id: chatterUserId,
      badges,
      chatter_user_login: "viewer",
      message: { text: "!ping" },
    },
  });
}

function setup(onMessage: (message: ChatMessageEvent) => void) {
  const sockets: Array<{ url: string; socket: MockSocket }> = [];
  const auth = {
    fetch: vi.fn(async () => new Response(null, { status: 202 })),
  };
  const client = new EventSubClient({
    auth,
    botUserId: "bot-id",
    channelUserId: "channel-id",
    onMessage,
    socketFactory: (url) => {
      const socket = new MockSocket();
      sockets.push({ url, socket });
      return socket;
    },
  });
  client.start();
  return { auth, client, sockets };
}

describe("EventSubClient chat filtering", () => {
  it("deduplicates chat events by message_id", () => {
    const received: ChatMessageEvent[] = [];
    const { client, sockets } = setup((message) => received.push(message));
    const socket = sockets[0]?.socket;
    expect(socket).toBeDefined();

    socket?.message(notification("event-1", "chat-1"));
    socket?.message(notification("event-2", "chat-1"));

    expect(received).toHaveLength(1);
    client.stop();
  });

  it("ignores messages sent by the bot", () => {
    const received: ChatMessageEvent[] = [];
    const { client, sockets } = setup((message) => received.push(message));

    sockets[0]?.socket.message(notification("event-1", "chat-1", "bot-id"));

    expect(received).toEqual([]);
    client.stop();
  });

  it("identifies broadcaster and moderator badges for protected commands", () => {
    const received: ChatMessageEvent[] = [];
    const { client, sockets } = setup((message) => received.push(message));
    sockets[0]?.socket.message(notification("event-mod", "chat-mod", "mod-id", [{ set_id: "moderator" }]));
    sockets[0]?.socket.message(notification("event-broadcaster", "chat-broadcaster", "channel-id"));
    expect(received.map(({ isModerator, isBroadcaster }) => ({ isModerator, isBroadcaster }))).toEqual([
      { isModerator: true, isBroadcaster: false },
      { isModerator: true, isBroadcaster: true },
    ]);
    client.stop();
  });
});

describe("EventSubClient reconnect handling", () => {
  it("waits for the replacement welcome before closing the old socket", async () => {
    const { auth, client, sockets } = setup(() => undefined);
    const oldSocket = sockets[0]?.socket;
    expect(oldSocket).toBeDefined();
    oldSocket?.message(welcome("welcome-1", "session-1"));
    await Promise.resolve();

    const reconnectUrl = "wss://eventsub.wss.twitch.tv/ws?reconnect=opaque";
    oldSocket?.message(
      envelope("reconnect-1", "session_reconnect", {
        session: { reconnect_url: reconnectUrl },
      }),
    );

    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.url).toBe(reconnectUrl);
    expect(oldSocket?.closed).toBe(false);

    sockets[1]?.socket.message(welcome("welcome-2", "session-2"));

    expect(oldSocket?.closed).toBe(true);
    expect(auth.fetch).toHaveBeenCalledTimes(1);
    client.stop();
  });
});
