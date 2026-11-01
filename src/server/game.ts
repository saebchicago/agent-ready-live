import {
  runAuditChecks,
  type CheckResult,
} from "../audit/checks.js";
import type { Fetcher, FetcherEvent } from "../audit/fetcher.js";
import { gradeAudit } from "../audit/grade.js";
import type { Target, TargetMode } from "../config.js";
import {
  GameStateStore,
  QUEUE_CAP,
  type BetChoice,
  type RuntimeMode,
} from "./state.js";

const BET_QUESTIONS: Readonly<Partial<Record<CheckResult["id"], string>>> = {
  K2: "Will it let Agent-Ready Live in?",
  K3: "Does it state an AI-use policy?",
  D2: "Is the sampled license machine-readable?",
};

const NEGATIVE_OUTCOMES = new Set([
  "BLOCKED_BY_WAF",
  "disallowed",
  "silent",
  "server_error",
  "unreachable",
  "not_found_in_sample",
  "empty_or_tbd",
  "empty_or_template",
  "impossible",
]);

class AuditStoppedError extends Error {}

export interface QueueRequest {
  alias: string;
  mode: TargetMode;
  requestedBy: string;
}

export type QueueResult =
  | { status: "queued"; position: number; targetName: string }
  | { status: "full" }
  | { status: "stopped" }
  | { status: "unknown" }
  | { status: "wrong_mode"; actualMode: TargetMode };

export interface GameEngineOptions {
  runtimeMode: RuntimeMode;
  targets: readonly Target[];
  fetcher: Fetcher;
  store?: GameStateStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  announce?: (message: string) => void | Promise<void>;
  betWindowMs?: number;
  doorClosedMs?: number;
  verdictMs?: number;
  mvpMs?: number;
}

export class GameEngine {
  readonly store: GameStateStore;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly announce: (message: string) => void | Promise<void>;
  private readonly betWindowMs: number;
  private readonly doorClosedMs: number;
  private readonly verdictMs: number;
  private readonly mvpMs: number;
  private draining = false;
  private nextAuditId = 1;

  constructor(private readonly options: GameEngineOptions) {
    this.store = options.store ?? new GameStateStore(options.runtimeMode);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
    this.announce = options.announce ?? (() => undefined);
    this.betWindowMs = options.betWindowMs ?? 8_000;
    this.doorClosedMs = options.doorClosedMs ?? 10_000;
    this.verdictMs = options.verdictMs ?? 10_000;
    this.mvpMs = options.mvpMs ?? 5_000;
  }

  queueAudit(request: QueueRequest): QueueResult {
    const state = this.store.getState();
    if (state.stopped) return { status: "stopped" };
    const target = this.options.targets.find(({ alias }) => alias === request.alias);
    if (target === undefined) return { status: "unknown" };
    if (target.mode !== request.mode) return { status: "wrong_mode", actualMode: target.mode };
    if (state.queue.length >= QUEUE_CAP) return { status: "full" };

    this.store.dispatch({
      type: "ENQUEUE",
      now: this.now(),
      entry: {
        id: `audit-${this.nextAuditId++}`,
        targetAlias: target.alias,
        targetName: target.name,
        targetMode: target.mode,
        requestedBy: request.requestedBy,
        enqueuedAt: new Date(this.now()).toISOString(),
      },
    });
    const position = this.store.getState().queue.length;
    void this.say(`${target.alias} joined the ${target.mode === "knock" ? "knock" : "audit"} queue.`);
    void this.drain();
    return { status: "queued", position, targetName: target.name };
  }

  placeBet(
    userId: string,
    displayHandle: string,
    choice: BetChoice,
  ): "accepted" | "closed" {
    const before = this.store.getState();
    if (before.phase !== "betting" || before.bet === undefined) return "closed";
    const revision = before.revision;
    this.store.dispatch({
      type: "BET_PLACE",
      now: this.now(),
      userId,
      displayHandle,
      choice,
    });
    return this.store.getState().revision === revision ? "closed" : "accepted";
  }

  score(userId: string): { points: number; streak: number } {
    const score = this.store.getState().scores[userId];
    return { points: score?.points ?? 0, streak: score?.streak ?? 0 };
  }

  board(): string {
    this.store.dispatch({ type: "PRUNE", now: this.now() });
    const state = this.store.getState();
    const rows = [...state.leaderboards.knock, ...state.leaderboards.audit]
      .sort((left, right) => right.score - left.score)
      .slice(0, 3);
    return rows.length === 0
      ? "Board is empty. Run a knock or audit first."
      : rows.map((row) => `${row.targetAlias} ${row.score}`).join(" | ");
  }

  stop(): void {
    this.store.dispatch({ type: "STOP", now: this.now() });
    void this.say("Kill switch engaged. Queue cleared and audit stopped.");
  }

  handleFetcherEvent(event: FetcherEvent): void {
    if (this.store.getState().stopped) return;
    this.store.dispatch({ type: "FETCHER_EVENT", now: this.now(), event });
    if (event.type === "request") {
      void this.say(`${event.method} ${event.path} ${event.status} in ${event.ms}ms.`);
    } else {
      const seconds = Math.ceil(event.waitMs / 1_000);
      void this.say(`${event.host} asks us to wait ${seconds}s. We wait.`);
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.store.getState().stopped && this.store.getState().queue.length > 0) {
        this.store.dispatch({ type: "START_NEXT", now: this.now() });
        const current = this.store.getState().currentAudit;
        if (current === undefined) break;
        const target = this.options.targets.find(({ alias }) => alias === current.targetAlias);
        if (target === undefined) {
          this.store.dispatch({ type: "AUDIT_ERROR", now: this.now(), message: "Target left the allowlist." });
          this.store.dispatch({ type: "FINISH_AUDIT", now: this.now() });
          continue;
        }
        await this.runTarget(target);
      }
    } finally {
      this.draining = false;
      if (!this.store.getState().stopped && this.store.getState().queue.length > 0) {
        void this.drain();
      }
    }
  }

  private async runTarget(target: Target): Promise<void> {
    try {
      await this.say(`Starting ${target.alias}. The robot approaches the door.`);
      const audit = await runAuditChecks(
        target,
        this.options.fetcher,
        () => new Date(this.now()),
        {
          beforeCheck: async (id) => {
            this.assertRunning();
            this.store.dispatch({ type: "CHECK_BEGIN", now: this.now(), checkId: id });
            const question = BET_QUESTIONS[id];
            if (question === undefined) return;
            const closesAt = new Date(this.now() + this.betWindowMs).toISOString();
            this.store.dispatch({ type: "BET_OPEN", now: this.now(), checkId: id, question, closesAt });
            await this.say(`${question} Vote !y or !n. ${this.betWindowMs / 1_000}s.`);
            await this.sleep(this.betWindowMs);
            this.assertRunning();
          },
          onCheck: async (check) => {
            this.assertRunning();
            const bet = this.store.getState().bet;
            if (bet?.checkId === check.id) {
              this.store.dispatch({
                type: "BET_CLOSE",
                now: this.now(),
                correctChoice: correctChoice(check),
              });
            }
            this.store.dispatch({ type: "CHECK_REVEAL", now: this.now(), check });
            await this.say(`${check.id}: ${humanOutcome(check.outcome)}.`);
          },
        },
      );
      this.assertRunning();

      const terms = audit.checks.find(({ id }) => id === "T0");
      if (terms?.outcome === "DOOR_CLOSED_BY_TERMS") {
        this.store.dispatch({
          type: "DOOR_CLOSED",
          now: this.now(),
          evidence: target.tos.evidence,
          sourceUrl: target.tos.sourceUrl,
        });
        await this.say(`${target.alias}: door closed by terms. Zero requests sent.`);
        await this.sleep(this.doorClosedMs);
        this.assertRunning();
        this.store.dispatch({ type: "FINISH_AUDIT", now: this.now() });
        return;
      }

      const grade = gradeAudit(target.mode, audit.checks, audit.sampledEntries, audit.probedOn);
      const reasons = reasonCodes(audit.checks);
      this.store.dispatch({
        type: "VERDICT",
        now: this.now(),
        score: grade.score,
        text: grade.verdict,
        reasons,
        sampledEntries: audit.sampledEntries,
        probedOn: audit.probedOn,
      });
      await this.say(`${target.alias}: ${grade.score}/100. ${reasons.join(", ")}.`);
      await this.sleep(this.verdictMs);
      this.assertRunning();
      const beforeMvp = this.store.getState().revision;
      this.store.dispatch({ type: "SHOW_MVP", now: this.now() });
      if (this.store.getState().revision !== beforeMvp) {
        await this.say(`Round MVP: ${this.store.getState().mvp?.displayHandle ?? "viewer"}.`);
        await this.sleep(this.mvpMs);
        this.assertRunning();
      }
      this.store.dispatch({ type: "FINISH_AUDIT", now: this.now() });
    } catch (error) {
      if (error instanceof AuditStoppedError) return;
      const message = error instanceof Error ? error.message : "Audit failed";
      this.store.dispatch({ type: "AUDIT_ERROR", now: this.now(), message });
      await this.say(`Audit stopped safely: ${message}`);
      await this.sleep(this.verdictMs);
      if (!this.store.getState().stopped) {
        this.store.dispatch({ type: "FINISH_AUDIT", now: this.now() });
      }
    }
  }

  private assertRunning(): void {
    if (this.store.getState().stopped) throw new AuditStoppedError("Audit stopped");
  }

  private async say(message: string): Promise<void> {
    await this.announce(message.replace(/\s+/gu, " ").trim());
  }
}

function correctChoice(check: CheckResult): BetChoice {
  if (check.id === "K2") return check.outcome === "disallowed" ? "n" : "y";
  if (check.id === "K3") return check.outcome === "silent" ? "n" : "y";
  if (check.id === "D2") return check.outcome === "url_or_spdx" ? "y" : "n";
  return NEGATIVE_OUTCOMES.has(check.outcome) ? "n" : "y";
}

function reasonCodes(checks: readonly CheckResult[]): string[] {
  const significant = checks
    .filter(({ id, outcome }) => id !== "T0" && NEGATIVE_OUTCOMES.has(outcome))
    .map(({ id, outcome }) => `${id}:${outcome}`);
  const fallback = checks
    .filter(({ id }) => id !== "T0")
    .slice(-3)
    .map(({ id, outcome }) => `${id}:${outcome}`);
  return (significant.length > 0 ? significant : fallback).slice(0, 3);
}

function humanOutcome(outcome: string): string {
  return outcome.replaceAll("_", " ");
}
