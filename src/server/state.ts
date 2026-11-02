import type { CheckResult } from "../audit/checks.js";
import type { NationalCensus } from "../audit/census.js";
import type { DataGovV4Census } from "../audit/census-v4.js";
import type { CensusMeaning } from "../audit/census-meaning.js";
import type { ExplainerCard } from "../audit/explainers.js";
import type { LadderPlacement } from "../audit/ladder.js";
import type { FixItCard } from "../audit/fixit.js";
import type { FetcherEvent, HttpMethod } from "../audit/fetcher.js";
import type { GameTargetMode, TargetSideDoor } from "../config.js";

export const QUEUE_CAP = 5;
export const LEADERBOARD_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const CORRECT_BET_POINTS = 10;

export type RuntimeMode = "REPLAY" | "LIVE";
export type OverlayPhase =
  | "idle"
  | "betting"
  | "auditing"
  | "waiting"
  | "door_closed"
  | "verdict"
  | "mvp";
export type BetChoice = "y" | "n";

export interface AuditQueueEntry {
  id: string;
  targetAlias: string;
  targetName: string;
  targetMode: GameTargetMode;
  requestedBy: string;
  enqueuedAt: string;
  sideDoor?: TargetSideDoor;
}

export interface AuditInProgress extends AuditQueueEntry {
  startedAt: string;
  currentCheckId?: CheckResult["id"];
  checks: CheckResult[];
  correctBettors: string[];
  ladderPlacement?: LadderPlacement;
}

export interface VisibleExplainer extends ExplainerCard {
  expiresAt: string;
}

export interface BetVote {
  choice: BetChoice;
  displayHandle: string;
}

export interface BetState {
  checkId: CheckResult["id"];
  question: string;
  closesAt: string;
  votes: Record<string, BetVote>;
  yes: number;
  no: number;
}

export interface ScoreState {
  displayHandle: string;
  points: number;
  streak: number;
  bestStreak: number;
  roundPoints: number;
}

export interface RequestTickerItem {
  method: HttpMethod;
  path: string;
  status: number | "UNREACHABLE";
  ms: number;
}

export interface WaitingState {
  host: string;
  waitMs: number;
  until: string;
}

export interface DoorClosedState {
  evidence: string;
  sourceUrl: string;
  sourceDomain: string;
  readDate: string;
  sideDoor?: TargetSideDoor;
}

export interface VerdictState {
  text: string;
  reasons: string[];
  checks: Array<Pick<CheckResult, "id" | "outcome">>;
  correctBettors: number;
  ladderPlacement: LadderPlacement;
  fixIt?: FixItCard;
}

export interface MvpState {
  displayHandle: string;
  roundPoints: number;
  streak: number;
}

export interface LeaderboardRow {
  targetAlias: string;
  targetName: string;
  targetMode: GameTargetMode;
  checks: Array<Pick<CheckResult, "id" | "outcome">>;
  sampledEntries: number;
  probedOn: string;
  rubricVersion: "Rubric v1";
  expiresAt: string;
}

export interface GameState {
  revision: number;
  runtimeMode: RuntimeMode;
  phase: OverlayPhase;
  stopped: boolean;
  queue: AuditQueueEntry[];
  currentAudit: AuditInProgress | undefined;
  bet: BetState | undefined;
  scores: Record<string, ScoreState>;
  leaderboards: {
    knock: LeaderboardRow[];
    audit: LeaderboardRow[];
  };
  requestTicker: RequestTickerItem[];
  waiting: WaitingState | undefined;
  doorClosed: DoorClosedState | undefined;
  verdict: VerdictState | undefined;
  mvp: MvpState | undefined;
  error: string | undefined;
  explainer: VisibleExplainer | undefined;
  globalContextVisible: boolean;
  nationalCensus: NationalCensus | undefined;
  nationalCensusV4: DataGovV4Census | undefined;
  censusMeaning: CensusMeaning | undefined;
}

interface TimedAction {
  now: number;
}

export type GameAction =
  | (TimedAction & { type: "ENQUEUE"; entry: AuditQueueEntry })
  | (TimedAction & { type: "START_NEXT" })
  | (TimedAction & { type: "CHECK_BEGIN"; checkId: CheckResult["id"] })
  | (TimedAction & { type: "CHECK_REVEAL"; check: CheckResult; explainer: ExplainerCard })
  | (TimedAction & {
      type: "BET_OPEN";
      checkId: CheckResult["id"];
      question: string;
      closesAt: string;
    })
  | (TimedAction & {
      type: "BET_PLACE";
      userId: string;
      displayHandle: string;
      choice: BetChoice;
    })
  | (TimedAction & { type: "BET_CLOSE"; correctChoice: BetChoice })
  | (TimedAction & { type: "FETCHER_EVENT"; event: FetcherEvent })
  | (TimedAction & { type: "DOOR_CLOSED"; evidence: string; sourceUrl: string; sourceDomain: string; readDate: string; sideDoor?: TargetSideDoor })
  | (TimedAction & { type: "LADDER_RESULT"; placement: LadderPlacement })
  | (TimedAction & {
      type: "VERDICT";
      text: string;
      reasons: string[];
      checks: Array<Pick<CheckResult, "id" | "outcome">>;
      ladderPlacement: LadderPlacement;
      fixIt?: FixItCard;
      sampledEntries: number;
      probedOn: string;
    })
  | (TimedAction & { type: "SHOW_MVP" })
  | (TimedAction & { type: "AUDIT_ERROR"; message: string })
  | (TimedAction & { type: "NATIONAL_LENS"; census: NationalCensus | undefined })
  | (TimedAction & { type: "NATIONAL_LENS_V4"; census: DataGovV4Census | undefined })
  | (TimedAction & { type: "CENSUS_MEANING"; census: CensusMeaning | undefined })
  | (TimedAction & { type: "FINISH_AUDIT" })
  | (TimedAction & { type: "PRUNE" })
  | (TimedAction & { type: "STOP" });

export function createInitialState(runtimeMode: RuntimeMode): GameState {
  return {
    revision: 0,
    runtimeMode,
    phase: "idle",
    stopped: false,
    queue: [],
    currentAudit: undefined,
    bet: undefined,
    scores: {},
    leaderboards: { knock: [], audit: [] },
    requestTicker: [],
    waiting: undefined,
    doorClosed: undefined,
    verdict: undefined,
    mvp: undefined,
    error: undefined,
    explainer: undefined,
    globalContextVisible: true,
    nationalCensus: undefined,
    nationalCensusV4: undefined,
    censusMeaning: undefined,
  };
}

function withRevision(state: GameState, values: Partial<GameState>): GameState {
  return { ...state, ...values, revision: state.revision + 1 };
}

function pruneLeaderboards(state: GameState, now: number): GameState {
  const knock = state.leaderboards.knock.filter((row) => Date.parse(row.expiresAt) > now);
  const audit = state.leaderboards.audit.filter((row) => Date.parse(row.expiresAt) > now);
  if (knock.length === state.leaderboards.knock.length && audit.length === state.leaderboards.audit.length) {
    return state;
  }
  return { ...state, leaderboards: { knock, audit } };
}

function ranked(rows: LeaderboardRow[]): LeaderboardRow[] {
  return [...rows]
    .sort((left, right) => right.probedOn.localeCompare(left.probedOn))
    .slice(0, 10);
}

function clearTransient(): Pick<
  GameState,
  "bet" | "waiting" | "doorClosed" | "verdict" | "mvp" | "error"
> {
  return {
    bet: undefined,
    waiting: undefined,
    doorClosed: undefined,
    verdict: undefined,
    mvp: undefined,
    error: undefined,
  };
}

export function gameReducer(input: GameState, action: GameAction): GameState {
  const state = pruneLeaderboards(input, action.now);
  if (action.type === "PRUNE") {
    return state === input ? input : { ...state, revision: input.revision + 1 };
  }
  switch (action.type) {
    case "ENQUEUE":
      if (state.stopped || state.queue.length >= QUEUE_CAP) return state;
      return withRevision(state, { queue: [...state.queue, action.entry] });
    case "START_NEXT": {
      if (state.stopped || state.currentAudit !== undefined) return state;
      const [entry, ...queue] = state.queue;
      if (entry === undefined) return state;
      const scores = Object.fromEntries(
        Object.entries(state.scores).map(([userId, score]) => [userId, { ...score, roundPoints: 0 }]),
      );
      return withRevision(state, {
        ...clearTransient(),
        queue,
        scores,
        phase: "auditing",
        globalContextVisible: false,
        requestTicker: [],
        currentAudit: {
          ...entry,
          startedAt: new Date(action.now).toISOString(),
          checks: [],
          correctBettors: [],
        },
      });
    }
    case "CHECK_BEGIN":
      if (state.currentAudit === undefined) return state;
      return withRevision(state, {
        phase: "auditing",
        waiting: undefined,
        currentAudit: { ...state.currentAudit, currentCheckId: action.checkId },
      });
    case "CHECK_REVEAL":
      if (state.currentAudit === undefined) return state;
      return withRevision(state, {
        phase: "auditing",
        waiting: undefined,
        currentAudit: {
          ...state.currentAudit,
          currentCheckId: action.check.id,
          checks: [...state.currentAudit.checks, action.check],
        },
        explainer: { ...action.explainer, expiresAt: new Date(action.now + 8_000).toISOString() },
      });
    case "BET_OPEN":
      if (state.currentAudit === undefined || state.stopped) return state;
      return withRevision(state, {
        phase: "betting",
        bet: {
          checkId: action.checkId,
          question: action.question,
          closesAt: action.closesAt,
          votes: {},
          yes: 0,
          no: 0,
        },
      });
    case "BET_PLACE": {
      if (state.phase !== "betting" || state.bet === undefined || action.now >= Date.parse(state.bet.closesAt)) {
        return state;
      }
      const votes = {
        ...state.bet.votes,
        [action.userId]: { choice: action.choice, displayHandle: action.displayHandle },
      };
      const values = Object.values(votes);
      return withRevision(state, {
        bet: {
          ...state.bet,
          votes,
          yes: values.filter(({ choice }) => choice === "y").length,
          no: values.filter(({ choice }) => choice === "n").length,
        },
      });
    }
    case "BET_CLOSE": {
      if (state.bet === undefined || state.currentAudit === undefined) return state;
      const scores = { ...state.scores };
      const correctBettors = new Set(state.currentAudit.correctBettors);
      for (const [userId, vote] of Object.entries(state.bet.votes)) {
        const previous = scores[userId] ?? {
          displayHandle: vote.displayHandle,
          points: 0,
          streak: 0,
          bestStreak: 0,
          roundPoints: 0,
        };
        if (vote.choice === action.correctChoice) {
          const streak = previous.streak + 1;
          scores[userId] = {
            ...previous,
            displayHandle: vote.displayHandle,
            points: previous.points + CORRECT_BET_POINTS,
            roundPoints: previous.roundPoints + CORRECT_BET_POINTS,
            streak,
            bestStreak: Math.max(previous.bestStreak, streak),
          };
          correctBettors.add(vote.displayHandle);
        } else {
          scores[userId] = { ...previous, displayHandle: vote.displayHandle, streak: 0 };
        }
      }
      return withRevision(state, {
        phase: "auditing",
        bet: undefined,
        scores,
        currentAudit: {
          ...state.currentAudit,
          correctBettors: [...correctBettors],
        },
      });
    }
    case "FETCHER_EVENT":
      if (action.event.type === "crawl-delay") {
        return withRevision(state, {
          phase: "waiting",
          waiting: {
            host: action.event.host,
            waitMs: action.event.waitMs,
            until: action.event.until,
          },
        });
      }
      return withRevision(state, {
        phase: "auditing",
        waiting: undefined,
        requestTicker: [
          ...state.requestTicker,
          {
            method: action.event.method,
            path: action.event.path,
            status: action.event.status,
            ms: action.event.ms,
          },
        ].slice(-6),
      });
    case "DOOR_CLOSED":
      return withRevision(state, {
        phase: "door_closed",
        bet: undefined,
        waiting: undefined,
        doorClosed: {
          evidence: action.evidence,
          sourceUrl: action.sourceUrl,
          sourceDomain: action.sourceDomain,
          readDate: action.readDate,
          ...(action.sideDoor === undefined ? {} : { sideDoor: action.sideDoor }),
        },
      });
    case "LADDER_RESULT":
      if (state.currentAudit === undefined) return state;
      return withRevision(state, {
        currentAudit: { ...state.currentAudit, ladderPlacement: action.placement },
      });
    case "VERDICT": {
      if (state.currentAudit === undefined) return state;
      const row: LeaderboardRow = {
        targetAlias: state.currentAudit.targetAlias,
        targetName: state.currentAudit.targetName,
        targetMode: state.currentAudit.targetMode,
        checks: action.checks,
        sampledEntries: action.sampledEntries,
        probedOn: action.probedOn,
        rubricVersion: "Rubric v1",
        expiresAt: new Date(
          Date.parse(`${action.probedOn}T00:00:00.000Z`) + LEADERBOARD_TTL_MS,
        ).toISOString(),
      };
      const mode = state.currentAudit.targetMode;
      const withoutPrevious = state.leaderboards[mode].filter(
        ({ targetAlias }) => targetAlias !== row.targetAlias,
      );
      return withRevision(state, {
        phase: "verdict",
        bet: undefined,
        waiting: undefined,
        verdict: {
          text: action.text,
          reasons: action.reasons.slice(0, 3),
          checks: action.checks,
          correctBettors: state.currentAudit.correctBettors.length,
          ladderPlacement: action.ladderPlacement,
          ...(action.fixIt === undefined ? {} : { fixIt: action.fixIt }),
        },
        leaderboards: {
          ...state.leaderboards,
          [mode]: ranked([...withoutPrevious, row]),
        },
      });
    }
    case "SHOW_MVP": {
      const winner = Object.values(state.scores)
        .filter(({ roundPoints }) => roundPoints > 0)
        .sort((left, right) => right.roundPoints - left.roundPoints || right.streak - left.streak)[0];
      if (winner === undefined) return state;
      return withRevision(state, {
        phase: "mvp",
        mvp: {
          displayHandle: winner.displayHandle,
          roundPoints: winner.roundPoints,
          streak: winner.streak,
        },
      });
    }
    case "AUDIT_ERROR":
      return withRevision(state, {
        phase: "verdict",
        bet: undefined,
        waiting: undefined,
        error: action.message,
      });
    case "NATIONAL_LENS":
      return withRevision(state, { nationalCensus: action.census });
    case "NATIONAL_LENS_V4":
      return withRevision(state, { nationalCensusV4: action.census });
    case "CENSUS_MEANING":
      return withRevision(state, { censusMeaning: action.census });
    case "FINISH_AUDIT":
      return withRevision(state, {
        ...clearTransient(),
        phase: "idle",
        currentAudit: undefined,
        requestTicker: [],
        globalContextVisible: true,
      });
    case "STOP":
      return withRevision(state, {
        ...clearTransient(),
        stopped: true,
        phase: "idle",
        queue: [],
        currentAudit: undefined,
        requestTicker: [],
        globalContextVisible: true,
      });
  }
}

export type StateListener = (state: GameState) => void;

export class GameStateStore {
  private state: GameState;
  private readonly listeners = new Set<StateListener>();

  constructor(runtimeMode: RuntimeMode) {
    this.state = createInitialState(runtimeMode);
  }

  getState(): GameState {
    return this.state;
  }

  dispatch(action: GameAction): GameState {
    const next = gameReducer(this.state, action);
    if (next !== this.state) {
      this.state = next;
      for (const listener of this.listeners) listener(next);
    }
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
