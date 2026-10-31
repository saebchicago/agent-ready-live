import type { TwitchAuth } from "./auth.js";

const CHAT_MESSAGES_URL = "https://api.twitch.tv/helix/chat/messages";
const MESSAGE_INTERVAL_MS = 1_000;
const MAX_MESSAGE_CHARACTERS = 500;

interface PendingMessage {
  text: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export interface ChatSenderOptions {
  auth: Pick<TwitchAuth, "fetch">;
  botUserId: string;
  channelUserId: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function truncateMessage(message: string): string {
  return Array.from(message).slice(0, MAX_MESSAGE_CHARACTERS).join("");
}

export class ChatSender {
  private readonly queue: PendingMessage[] = [];
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private draining = false;
  private lastSentAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: ChatSenderOptions) {
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  }

  send(message: string): Promise<void> {
    const text = truncateMessage(message);
    if (text.length === 0) return Promise.reject(new Error("Chat message cannot be empty"));
    return new Promise<void>((resolveMessage, rejectMessage) => {
      this.queue.push({ text, resolve: resolveMessage, reject: rejectMessage });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const wait = Math.max(0, this.lastSentAt + MESSAGE_INTERVAL_MS - this.now());
        if (wait > 0) await this.sleep(wait);
        const pending = this.queue.shift();
        if (pending === undefined) continue;
        this.lastSentAt = this.now();
        try {
          await this.post(pending.text);
          pending.resolve();
        } catch (error) {
          pending.reject(error);
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length > 0) void this.drain();
    }
  }

  private async post(message: string): Promise<void> {
    const response = await this.options.auth.fetch(CHAT_MESSAGES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        broadcaster_id: this.options.channelUserId,
        sender_id: this.options.botUserId,
        message,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Send Chat Message failed with HTTP ${response.status}`);
    }
    await response.body?.cancel();
  }
}
