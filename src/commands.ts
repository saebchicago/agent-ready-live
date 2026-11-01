import type { TargetMode } from "./config.js";
import type { BetChoice } from "./server/state.js";

const USER_COOLDOWN_MS = 500;
const COMMAND_COOLDOWN_MS = 3_000;

export interface ParsedCommand {
  name: string;
  args: string[];
}

export interface CommandMessage {
  userId: string;
  userLogin?: string;
  text: string;
  isModerator?: boolean;
  isBroadcaster?: boolean;
}

export interface CommandGame {
  queueAudit(request: {
    alias: string;
    mode: TargetMode;
    requestedBy: string;
  }):
    | { status: "queued"; position: number; targetName: string }
    | { status: "full" }
    | { status: "stopped" }
    | { status: "unknown" }
    | { status: "wrong_mode"; actualMode: TargetMode };
  placeBet(userId: string, displayHandle: string, choice: BetChoice): "accepted" | "closed";
  score(userId: string): { points: number; streak: number };
  board(): string;
  stop(): void;
}

export interface CommandRouterOptions {
  now?: () => number;
  game?: CommandGame;
  displayHandle?: (userLogin: string) => string;
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
  private readonly lastNamedCommandAtByUser = new Map<string, number>();
  private readonly now: () => number;
  private readonly game: CommandGame | undefined;
  private readonly displayHandle: (userLogin: string) => string;

  constructor(options: CommandRouterOptions | (() => number) = {}) {
    const normalized = typeof options === "function" ? { now: options } : options;
    this.now = normalized.now ?? Date.now;
    this.game = normalized.game;
    this.displayHandle = normalized.displayHandle ?? (() => "Anonymous viewer");
  }

  handle(message: CommandMessage): string | undefined {
    const command = parseCommand(message.text);
    if (command === undefined || !this.isSupported(command.name)) return undefined;
    if (!this.takeCooldown(message.userId, command.name)) return undefined;

    if (command.name === "ping") return "pong (Agent-Ready Live is alive)";
    if (command.name === "whois") return "I am Agent-Ready Live, a polite robot that checks public bot-facing files.";
    const game = this.game;
    if (game === undefined) return undefined;

    if (command.name === "knock" || command.name === "audit") {
      const alias = command.args[0]?.toLowerCase();
      if (alias === undefined || command.args.length !== 1) {
        return `Usage: !${command.name} <alias>`;
      }
      const mode = command.name === "knock" ? "knock" : "audit";
      const queued = game.queueAudit({
        alias,
        mode,
        requestedBy: this.displayName(message),
      });
      if (queued.status === "queued") return undefined;
      if (queued.status === "full") return "Queue is full. Try again after a round.";
      if (queued.status === "stopped") return "Audits are stopped by the kill switch.";
      if (queued.status === "wrong_mode") {
        return `${alias} is for !${queued.actualMode === "knock" ? "knock" : "audit"}.`;
      }
      return `Unknown ${mode === "knock" ? "knock" : "audit"} alias.`;
    }

    if (command.name === "y" || command.name === "n") {
      const outcome = game.placeBet(
        message.userId,
        this.displayName(message),
        command.name,
      );
      return outcome === "accepted"
        ? `Bet locked: ${command.name === "y" ? "yes" : "no"}.`
        : "Betting is closed.";
    }

    if (command.name === "score") {
      const score = game.score(message.userId);
      return `${message.userLogin ?? "viewer"}: ${score.points} points, streak ${score.streak}.`;
    }

    if (command.name === "board") return `Board: ${game.board()}`;

    if (command.name === "stop") {
      if (message.isBroadcaster !== true && message.isModerator !== true) {
        return "Only the broadcaster or a moderator can stop audits.";
      }
      game.stop();
      return "Kill switch engaged. Queue cleared.";
    }

    return undefined;
  }

  private isSupported(name: string): boolean {
    if (name === "ping" || name === "whois") return true;
    return this.game !== undefined && ["knock", "audit", "y", "n", "score", "board", "stop"].includes(name);
  }

  private takeCooldown(userId: string, name: string): boolean {
    const now = this.now();
    const lastUser = this.lastCommandAtByUser.get(userId);
    const key = `${userId}:${name}`;
    const lastNamed = this.lastNamedCommandAtByUser.get(key);
    if (
      (lastUser !== undefined && now - lastUser < USER_COOLDOWN_MS) ||
      (lastNamed !== undefined && now - lastNamed < COMMAND_COOLDOWN_MS)
    ) {
      return false;
    }
    this.lastCommandAtByUser.set(userId, now);
    this.lastNamedCommandAtByUser.set(key, now);
    return true;
  }

  private displayName(message: CommandMessage): string {
    return this.displayHandle(message.userLogin ?? "viewer");
  }
}
