import WebSocket from "ws";
import type { TwitchAuth } from "./auth.js";

const LIVE_WEBSOCKET_URL = "wss://eventsub.wss.twitch.tv/ws";
const LIVE_SUBSCRIPTION_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
const MAX_SEEN_MESSAGES = 10_000;

export interface ChatMessageEvent {
  messageId: string;
  userId: string;
  userLogin: string;
  text: string;
  isModerator: boolean;
  isBroadcaster: boolean;
}

export interface Revocation {
  type: string;
  status: string;
}

export interface EventSocket {
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  close(): void;
}

export type SocketFactory = (url: string) => EventSocket;

export interface EventSubOptions {
  auth: Pick<TwitchAuth, "fetch">;
  botUserId: string;
  channelUserId: string;
  onMessage: (message: ChatMessageEvent) => void | Promise<void>;
  onRevocation?: (revocation: Revocation) => void;
  onError?: (error: unknown) => void;
  websocketUrl?: string;
  subscriptionUrl?: string;
  socketFactory?: SocketFactory;
}

interface SocketState {
  socket: EventSocket;
  keepaliveTimer?: NodeJS.Timeout;
  keepaliveTimeoutSeconds?: number;
}

interface EventSubEnvelope {
  metadata: {
    message_id?: string;
    message_type?: string;
  };
  payload: Record<string, unknown>;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseEnvelope(data: unknown): EventSubEnvelope | undefined {
  let parsed: unknown;
  try {
    if (typeof data === "string") parsed = JSON.parse(data) as unknown;
    else if (Buffer.isBuffer(data)) parsed = JSON.parse(data.toString("utf8")) as unknown;
    else if (data instanceof ArrayBuffer) {
      parsed = JSON.parse(Buffer.from(data).toString("utf8")) as unknown;
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const envelope = asObject(parsed);
  const metadata = asObject(envelope?.metadata);
  const payload = asObject(envelope?.payload);
  if (metadata === undefined || payload === undefined) return undefined;
  return { metadata, payload } as EventSubEnvelope;
}

function parseChatEvent(
  payload: Record<string, unknown>,
  channelUserId: string,
): ChatMessageEvent | undefined {
  const subscription = asObject(payload.subscription);
  if (subscription?.type !== "channel.chat.message") return undefined;
  const event = asObject(payload.event);
  const message = asObject(event?.message);
  if (
    typeof event?.message_id !== "string" ||
    typeof event.chatter_user_id !== "string" ||
    typeof event.chatter_user_login !== "string" ||
    typeof message?.text !== "string"
  ) {
    return undefined;
  }
  const chatterLogin = event.chatter_user_login;
  const badges = Array.isArray(event.badges) ? event.badges : [];
  const badgeIds = new Set(
    badges.flatMap((badge) => {
      const value = asObject(badge)?.set_id;
      return typeof value === "string" ? [value] : [];
    }),
  );
  const isBroadcaster = event.chatter_user_id === channelUserId || badgeIds.has("broadcaster");
  return {
    messageId: event.message_id,
    userId: event.chatter_user_id,
    userLogin: typeof chatterLogin === "string" ? chatterLogin : "viewer",
    text: message.text,
    isModerator: isBroadcaster || badgeIds.has("moderator"),
    isBroadcaster,
  };
}

function parseSession(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  return asObject(payload.session);
}

function assertEndpoint(urlValue: string, kind: "websocket" | "subscription"): string {
  const url = new URL(urlValue);
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (kind === "websocket") {
    const live = url.protocol === "wss:" && url.hostname === "eventsub.wss.twitch.tv";
    const local = url.protocol === "ws:" && isLoopback;
    if (!live && !local) throw new Error("EventSub WebSocket URL is not allowed");
  } else {
    const live = url.href === LIVE_SUBSCRIPTION_URL;
    const local = url.protocol === "http:" && isLoopback;
    if (!live && !local) throw new Error("EventSub subscription URL is not allowed");
  }
  return urlValue;
}

export class EventSubClient {
  private readonly websocketUrl: string;
  private readonly subscriptionUrl: string;
  private readonly socketFactory: SocketFactory;
  private current: SocketState | undefined;
  private pendingReconnect: SocketState | undefined;
  private stopped = true;
  private readonly seenEnvelopeIds = new Set<string>();
  private readonly seenChatMessageIds = new Set<string>();

  constructor(private readonly options: EventSubOptions) {
    this.websocketUrl = assertEndpoint(
      options.websocketUrl ?? LIVE_WEBSOCKET_URL,
      "websocket",
    );
    this.subscriptionUrl = assertEndpoint(
      options.subscriptionUrl ?? LIVE_SUBSCRIPTION_URL,
      "subscription",
    );
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
  }

  start(): void {
    if (!this.stopped) throw new Error("EventSub client is already running");
    this.stopped = false;
    this.openInitialSocket();
  }

  stop(): void {
    this.stopped = true;
    this.clearKeepalive(this.current);
    this.clearKeepalive(this.pendingReconnect);
    this.current?.socket.close();
    this.pendingReconnect?.socket.close();
    this.current = undefined;
    this.pendingReconnect = undefined;
  }

  private openInitialSocket(): void {
    if (this.stopped) return;
    const state = this.attachSocket(this.websocketUrl);
    this.current = state;
  }

  private attachSocket(url: string): SocketState {
    const socket = this.socketFactory(url);
    const state: SocketState = { socket };
    socket.on("message", (data) => this.handleFrame(state, data));
    socket.on("error", (error) => this.reportError(error));
    socket.on("close", () => this.handleClose(state));
    return state;
  }

  private handleFrame(state: SocketState, data: unknown): void {
    const envelope = parseEnvelope(data);
    if (envelope === undefined) {
      this.reportError(new Error("Received an invalid EventSub message"));
      return;
    }

    const envelopeId = envelope.metadata.message_id;
    if (envelopeId !== undefined && this.remember(this.seenEnvelopeIds, envelopeId)) {
      return;
    }

    if (state === this.current) this.armKeepalive(state, envelope.payload);
    switch (envelope.metadata.message_type) {
      case "session_welcome":
        this.handleWelcome(state, envelope.payload);
        break;
      case "session_keepalive":
        break;
      case "session_reconnect":
        this.handleReconnect(state, envelope.payload);
        break;
      case "notification":
        this.handleNotification(envelope.payload);
        break;
      case "revocation":
        this.handleRevocation(envelope.payload);
        break;
      default:
        this.reportError(new Error("Received an unsupported EventSub message type"));
    }
  }

  private handleWelcome(state: SocketState, payload: Record<string, unknown>): void {
    const session = parseSession(payload);
    const sessionId = session?.id;
    if (typeof sessionId !== "string") {
      this.reportError(new Error("EventSub welcome omitted the session ID"));
      return;
    }

    if (state === this.pendingReconnect) {
      const old = this.current;
      this.pendingReconnect = undefined;
      this.current = state;
      this.armKeepalive(state, payload);
      this.clearKeepalive(old);
      old?.socket.close();
      return;
    }

    if (state !== this.current) return;
    this.armKeepalive(state, payload);
    void this.createSubscription(sessionId).catch((error: unknown) => {
      this.reportError(error);
    });
  }

  private handleReconnect(state: SocketState, payload: Record<string, unknown>): void {
    if (state !== this.current || this.pendingReconnect !== undefined) return;
    const reconnectUrl = parseSession(payload)?.reconnect_url;
    if (typeof reconnectUrl !== "string") {
      this.reportError(new Error("EventSub reconnect omitted the reconnect URL"));
      return;
    }
    try {
      assertEndpoint(reconnectUrl, "websocket");
      this.pendingReconnect = this.attachSocket(reconnectUrl);
    } catch (error) {
      this.reportError(error);
    }
  }

  private handleNotification(payload: Record<string, unknown>): void {
    const message = parseChatEvent(payload, this.options.channelUserId);
    if (message === undefined) return;
    if (this.remember(this.seenChatMessageIds, message.messageId)) return;
    if (message.userId === this.options.botUserId) return;
    void Promise.resolve(this.options.onMessage(message)).catch((error: unknown) => {
      this.reportError(error);
    });
  }

  private handleRevocation(payload: Record<string, unknown>): void {
    const subscription = asObject(payload.subscription);
    if (subscription === undefined) return;
    const type = subscription.type;
    const status = subscription.status;
    if (typeof type === "string" && typeof status === "string") {
      this.options.onRevocation?.({ type, status });
    }
  }

  private armKeepalive(state: SocketState, payload: Record<string, unknown>): void {
    const timeoutValue = parseSession(payload)?.keepalive_timeout_seconds;
    if (typeof timeoutValue === "number" && timeoutValue > 0) {
      state.keepaliveTimeoutSeconds = timeoutValue;
    }
    const timeoutSeconds = state.keepaliveTimeoutSeconds;
    if (timeoutSeconds === undefined) return;
    this.clearKeepalive(state);
    state.keepaliveTimer = setTimeout(() => {
      if (state !== this.current || this.stopped) return;
      this.reportError(new Error("EventSub keepalive timed out"));
      this.current = undefined;
      state.socket.close();
      if (this.pendingReconnect === undefined) this.openInitialSocket();
    }, (timeoutSeconds + 1) * 1_000);
  }

  private clearKeepalive(state: SocketState | undefined): void {
    if (state?.keepaliveTimer !== undefined) {
      clearTimeout(state.keepaliveTimer);
      delete state.keepaliveTimer;
    }
  }

  private handleClose(state: SocketState): void {
    this.clearKeepalive(state);
    if (state === this.pendingReconnect) {
      this.pendingReconnect = undefined;
      if (this.current === undefined && !this.stopped) this.openInitialSocket();
      return;
    }
    if (state !== this.current) return;
    this.current = undefined;
    if (!this.stopped && this.pendingReconnect === undefined) this.openInitialSocket();
  }

  private async createSubscription(sessionId: string): Promise<void> {
    const response = await this.options.auth.fetch(this.subscriptionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "channel.chat.message",
        version: "1",
        condition: {
          broadcaster_user_id: this.options.channelUserId,
          user_id: this.options.botUserId,
        },
        transport: { method: "websocket", session_id: sessionId },
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`EventSub subscription failed with HTTP ${response.status}`);
    }
    await response.body?.cancel();
  }

  private remember(collection: Set<string>, id: string): boolean {
    if (collection.has(id)) return true;
    collection.add(id);
    if (collection.size > MAX_SEEN_MESSAGES) {
      const oldest = collection.values().next().value as string | undefined;
      if (oldest !== undefined) collection.delete(oldest);
    }
    return false;
  }

  private reportError(error: unknown): void {
    this.options.onError?.(error);
  }
}
