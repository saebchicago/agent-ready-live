import type { GameState, LeaderboardRow } from "../../src/server/state.js";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing overlay element ${id}`);
  return value as T;
}

const app = element<HTMLElement>("app");
const connection = element<HTMLElement>("connection");
let state: GameState | undefined;

function text(id: string, value: string | number): void {
  element(id).textContent = String(value);
}

function visible(id: string, show: boolean): void {
  element(id).hidden = !show;
}

function renderRows(id: string, rows: readonly LeaderboardRow[]): void {
  const container = element(id);
  const elements = rows.slice(0, 3).map((row, index) => {
    const item = document.createElement("div");
    item.className = "board-row";
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(index + 1).padStart(2, "0");
    const name = document.createElement("strong");
    name.textContent = row.targetAlias;
    const meta = document.createElement("span");
    meta.textContent = `${row.score}/100 · N=${row.sampledEntries} · ${row.probedOn} · ${row.rubricVersion}`;
    item.append(rank, name, meta);
    return item;
  });
  if (elements.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-row";
    empty.textContent = "No sampled rounds yet";
    elements.push(empty);
  }
  container.replaceChildren(...elements);
}

function renderChecks(current: GameState["currentAudit"]): void {
  const container = element("check-tiles");
  if (current === undefined) {
    container.replaceChildren();
    return;
  }
  const ids = current.targetMode === "knock"
    ? ["T0", "K1", "K2", "K3", "K4"]
    : ["T0", "K1", "K2", "K3", "K4", "D1", "D2", "D3", "D4", "D5"];
  const tiles = ids.map((id) => {
    const result = current.checks.find((check) => check.id === id);
    const tile = document.createElement("div");
    tile.className = "check-tile";
    if (result !== undefined) tile.dataset.status = "complete";
    else if (current.currentCheckId === id) tile.dataset.status = "active";
    const code = document.createElement("strong");
    code.textContent = id;
    const outcome = document.createElement("span");
    outcome.textContent = result?.outcome.replaceAll("_", " ") ?? "waiting";
    tile.append(code, outcome);
    if (result?.id === "K2" && result.evidence.includes("Blocked by robots.txt:")) {
      const evidence = document.createElement("span");
      evidence.className = "check-evidence";
      evidence.textContent = result.evidence.slice(result.evidence.indexOf("Blocked by robots.txt:"));
      tile.append(evidence);
    }
    return tile;
  });
  container.replaceChildren(...tiles);
}

function renderTicker(currentState: GameState): void {
  const container = element("request-ticker");
  const rows = currentState.requestTicker.map((request) => {
    const row = document.createElement("div");
    row.className = "ticker-row";
    const method = document.createElement("strong");
    method.textContent = request.method;
    const path = document.createElement("span");
    path.textContent = request.path;
    const result = document.createElement("span");
    result.textContent = `${request.status === "UNREACHABLE" ? "UNREACHABLE" : request.status} · ${request.ms}ms`;
    row.append(method, path, result);
    return row;
  });
  container.replaceChildren(...rows);
}

function remainingSeconds(iso: string): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 1_000));
}

function renderCountdowns(): void {
  if (state?.bet !== undefined) text("bet-countdown", remainingSeconds(state.bet.closesAt));
  if (state?.waiting !== undefined) text("wait-countdown", `${remainingSeconds(state.waiting.until)}s`);
}

function render(next: GameState): void {
  state = next;
  app.dataset.phase = next.phase;
  text("mode-badge", next.runtimeMode);
  text("queue-count", `QUEUE ${next.queue.length}/5`);
  visible("idle-panel", next.currentAudit === undefined);
  visible("active-panel", next.currentAudit !== undefined);
  visible("boards", next.phase === "idle");
  renderRows("knock-board", next.leaderboards.knock);
  renderRows("audit-board", next.leaderboards.audit);

  const current = next.currentAudit;
  if (current === undefined) return;
  text("target-name", current.targetName);
  text("target-mode", current.targetMode === "knock" ? "QUICK KNOCK" : "DEEP AUDIT");

  visible("bet-panel", next.phase === "betting" && next.bet !== undefined);
  if (next.bet !== undefined) {
    text("bet-question", next.bet.question);
    text("yes-count", next.bet.yes);
    text("no-count", next.bet.no);
  }

  visible("wait-panel", next.phase === "waiting" && next.waiting !== undefined);
  if (next.waiting !== undefined) {
    const seconds = Math.ceil(next.waiting.waitMs / 1_000);
    text("wait-message", `${current.targetName} asks us to wait ${seconds}s between knocks. We wait.`);
  }

  visible("door-panel", next.phase === "door_closed" && next.doorClosed !== undefined);
  if (next.doorClosed !== undefined) {
    text("terms-evidence", next.doorClosed.evidence);
    const source = element<HTMLAnchorElement>("terms-source");
    source.textContent = next.doorClosed.sourceUrl;
    source.href = next.doorClosed.sourceUrl;
  }

  visible("verdict-panel", next.phase === "verdict");
  if (next.verdict !== undefined) {
    text("verdict-score", next.verdict.score);
    text("verdict-line", next.verdict.text);
    text("correct-bettors", `${next.verdict.correctBettors} correct bettors`);
    const reasons = next.verdict.reasons.map((reason) => {
      const item = document.createElement("li");
      item.textContent = reason;
      return item;
    });
    element("reason-list").replaceChildren(...reasons);
  }
  text("error-line", next.error ?? "");

  visible("mvp-panel", next.phase === "mvp" && next.mvp !== undefined);
  if (next.mvp !== undefined) {
    text("mvp-name", next.mvp.displayHandle);
    text("mvp-points", next.mvp.roundPoints);
    text("mvp-streak", next.mvp.streak);
  }

  visible("audit-panel", next.phase === "auditing" || next.phase === "betting" || next.phase === "waiting");
  renderChecks(current);
  renderTicker(next);
  renderCountdowns();
}

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.addEventListener("open", () => {
    connection.textContent = "CONNECTED";
    connection.dataset.connected = "true";
  });
  socket.addEventListener("message", (event) => {
    let value: unknown;
    try {
      value = JSON.parse(String(event.data)) as unknown;
    } catch {
      return;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "snapshot" &&
      "state" in value
    ) {
      render(value.state as GameState);
    }
  });
  socket.addEventListener("close", () => {
    connection.textContent = "RECONNECTING";
    delete connection.dataset.connected;
    setTimeout(connect, 1_000);
  });
}

setInterval(renderCountdowns, 200);
connect();
