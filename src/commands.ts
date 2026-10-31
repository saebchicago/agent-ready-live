const USER_COOLDOWN_MS = 3_000;

export interface ParsedCommand {
  name: string;
  args: string[];
}

export interface CommandMessage {
  userId: string;
  text: string;
}

export function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("!")) return undefined;
  const parts = trimmed.slice(1).split(/\s+/u);
  const name = parts.shift()?.toLowerCase();
  if (!name) return undefined;
  return { name, args: parts };
}

export class CommandRouter {
  private readonly lastCommandAtByUser = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  handle(message: CommandMessage): string | undefined {
    const command = parseCommand(message.text);
    if (command?.name !== "ping") return undefined;

    const now = this.now();
    const lastCommandAt = this.lastCommandAtByUser.get(message.userId);
    if (lastCommandAt !== undefined && now - lastCommandAt < USER_COOLDOWN_MS) {
      return undefined;
    }
    this.lastCommandAtByUser.set(message.userId, now);
    return "pong (Agent-Ready Live is alive)";
  }
}
