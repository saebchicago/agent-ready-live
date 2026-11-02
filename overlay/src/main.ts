import type { GameState, LeaderboardRow } from "../../src/server/state.js";
import { DOOR_LADDER } from "../../src/audit/ladder.js";
import { stageScale } from "./layout.js";
import { CENSUS_NOTICE } from "../../src/audit/census-notice.js";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing overlay element ${id}`);
  return value as T;
}

const app = element<HTMLElement>("app");
const connection = element<HTMLElement>("connection");
const stylesheetLink = element<HTMLLinkElement>("overlay-stylesheet");
let state: GameState | undefined;

function fitStage(): void {
  const sheet = stylesheetLink.sheet;
  if (sheet === null) return;
  const stageRule = Array.from(sheet.cssRules).find(
    (rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText === "#stage",
  );
  stageRule?.style.setProperty(
    "transform",
    `translate(-50%, -50%) scale(${stageScale(window.innerWidth, window.innerHeight)})`,
  );
}

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
    const badges = document.createElement("span");
    badges.className = "board-checks";
    badges.textContent = row.checks.map(({ id, outcome }) => `${id} ${outcome.replaceAll("_", " ")}`).join(" · ");
    const meta = document.createElement("span");
    const sample = row.targetMode === "knock"
      ? "Knock only: no catalog sampled"
      : `Sampled ${row.sampledEntries}`;
    meta.textContent = `${sample} | Probed ${row.probedOn} | ${row.rubricVersion} | Not a ranking of agency quality`;
    item.append(rank, name, badges, meta);
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
  visible("global-context", next.phase === "idle" && next.globalContextVisible);
  const census = next.nationalCensus;
  const v4 = next.nationalCensusV4;
  const countOrMissing = (value: number | undefined): string => value === undefined ? "not available" : String(value);
  text("national-v4-summary", `${countOrMissing(v4?.publishers)} publishers | ${countOrMissing(v4?.datasets)} datasets | by type: Federal ${countOrMissing(v4?.byType.Federal)}, State ${countOrMissing(v4?.byType.State)}, City ${countOrMissing(v4?.byType.City)}, County ${countOrMissing(v4?.byType.County)} | Probed ${v4?.probedOn ?? "not available"} | Not a ranking`);
  text("national-v4-label", v4
    ? "Publisher totals and type counts are Verified from the recorded organizations response where available. Publisher license shares are Modeled from a sample of N records."
    : "No v4 response recorded. Publisher and type counts are not available; publisher license shares, when available, are Modeled from a sample of N records.");
  const legacyLine = census?.legacyRoundLine;
  text("legacy-ckan-line", legacyLine ?? "");
  visible("legacy-ckan-line", legacyLine !== undefined);
  visible("legacy-ckan-explainer", legacyLine !== undefined);
  visible("legacy-census-stats", census?.totalDatasets !== undefined);
  text("national-total", census?.totalDatasets === undefined ? "Total datasets: not available in this catalog" : `Total datasets: ${census.totalDatasets}`);
  text("national-licenses", census?.licenseFacetAvailable
    ? `License counts and share: ${census.licenses.map(({ name, count, share }) => `${name} ${count} (${share === undefined ? "share not available in this catalog" : `${(share * 100).toFixed(2)}%`})`).join("; ") || "none reported"}`
    : "Licenses: not available in this catalog");
  text("national-no-license", census?.noLicenseCount === undefined
    ? "No-license count and share: not available in this catalog"
    : `No license: ${census.noLicenseCount} (${census.noLicenseShare === undefined ? "share not available in this catalog" : `${(census.noLicenseShare * 100).toFixed(2)}%`})`);
  text("national-formats", census?.formatsAvailable
    ? `Top formats: ${census.formats.slice(0, 5).map(({ name, count }) => `${name} ${count}`).join("; ") || "none reported"}`
    : "Formats: not available in this catalog");
  text("national-publishers", census?.publishersAvailable
    ? `Top publishers: ${census.publishers.slice(0, 5).map(({ name, count }) => `${name} ${count}`).join("; ") || "none reported"}`
    : "Publishers: not available in this catalog");
  const publisherSamples = v4?.publishersBySearch.map((publisher) => {
    const datasets = publisher.datasetCount === undefined ? "dataset count not available" : `${publisher.datasetCount} datasets`;
    const sample = publisher.sampleCount === undefined ? "sample not available" : `Modeled: sample of ${publisher.sampleCount} records`;
    const share = publisher.licenseShare === undefined ? "license share not available" : `${(publisher.licenseShare * 100).toFixed(2)}% have dcat.license`;
    return `${publisher.name}: ${datasets}; ${share}; ${sample}`;
  }) ?? [];
  const missingPublishers = v4?.notInDataGov.map((name) => `${name} not in data.gov`) ?? [];
  text("national-matched-publishers", v4
    ? [...publisherSamples, ...missingPublishers].join("; ") || "Publisher matches not available in this API response."
    : census?.legacyRoundLine
      ? "Publisher samples are not available until the v4 census is recorded."
    : census
      ? `Named publisher counts: ${Object.entries(census.namedPublisherCounts).map(([name, count]) => `${name} ${count === undefined ? "not available in this catalog" : count}`).join("; ")}`
      : "Named publisher counts: not available in this catalog");
  const censusNotes = census?.legacyRoundLine ? [] : census?.notes ?? [];
  text("national-notes", [...(v4?.notes ?? []), ...censusNotes].join(" ") || (census === undefined && v4 === undefined ? "No local national census fixture is recorded." : ""));
  text("national-probed", `Probed ${v4?.probedOn ?? "not available"} | Not a ranking`);
  const meaning = next.censusMeaning;
  visible("census-meaning-panel", meaning !== undefined && next.phase === "idle");
  if (meaning !== undefined) {
    text("census-api-notice", CENSUS_NOTICE);
    text("census-sample-meta", `${meaning.source === "synthetic" ? "SYNTHETIC REPLAY FIXTURE" : "REPLAY"} | Probed ${meaning.probedOn} | ${meaning.tracts.length} sampled Wayne County tracts`);
    text("census-error-count", `${meaning.errorTracts} of ${meaning.tracts.length} tracts return an error code`);
    const renderTracts = (id: string, tracts: typeof meaning.naiveLowest, naive: boolean): void => {
      const rows = tracts.map((tract) => {
        const item = document.createElement("li");
        const raw = naive ? `raw income ${tract.rawIncome ?? "missing"}` : `$${tract.income} ±$${tract.marginOfError}`;
        const reason = tract.errorReasons.length > 0 ? `; treated as missing: ${tract.errorReasons.join("; ")}` : "";
        item.textContent = `${tract.name} (${tract.tract}): ${raw}${reason}`;
        return item;
      });
      const list = element<HTMLOListElement>(id);
      list.replaceChildren(...rows);
    };
    renderTracts("census-naive-list", meaning.naiveLowest, true);
    renderTracts("census-corrected-list", meaning.correctedLowest, false);
  }
  renderRows("knock-board", next.leaderboards.knock);
  renderRows("audit-board", next.leaderboards.audit);

  const card = next.explainer;
  const showCard = card !== undefined && Date.parse(card.expiresAt) > Date.now();
  visible("explainer-card", showCard);
  if (showCard && card) { text("explainer-title", `${card.checkId} ${card.outcome}`); text("explainer-what", `What an agent gets wrong: ${card.what}`); text("explainer-fix", `The fix: ${card.fix}`); text("explainer-standard", `Standard: ${card.standard}`); }

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
    text("terms-origin", `Source domain: ${next.doorClosed.sourceDomain} | Read ${next.doorClosed.readDate}`);
    const placement = next.currentAudit?.ladderPlacement;
    text("terms-ladder-placement", placement ? `Ladder: ${placement.step}. ${placement.evidence}` : "");
    const rungs = DOOR_LADDER.map((step) => { const rung = document.createElement("span"); rung.textContent = step; rung.dataset.active = String(step === placement?.step); return rung; });
    element("terms-door-ladder").replaceChildren(...rungs);
    const source = element<HTMLAnchorElement>("terms-source");
    source.textContent = next.doorClosed.sourceUrl;
    source.href = next.doorClosed.sourceUrl;
    text("terms-side-door", next.doorClosed.sideDoor ? `Front door closed. Side door: ${next.doorClosed.sideDoor.label}.` : "");
    visible("platform-terms-message", next.currentAudit?.targetAlias === "arcgis-hub");
    const sideLink = element<HTMLAnchorElement>("side-door-link");
    visible("side-door-link", Boolean(next.doorClosed.sideDoor?.url));
    if (next.doorClosed.sideDoor?.url) { sideLink.textContent = next.doorClosed.sideDoor.url; sideLink.href = next.doorClosed.sideDoor.url; }
  }

  visible("verdict-panel", next.phase === "verdict");
  if (next.verdict !== undefined) {
    text("verdict-line", next.verdict.text);
    text("ladder-placement", `Ladder: ${next.verdict.ladderPlacement.step}. ${next.verdict.ladderPlacement.evidence}`);
    const rungs = DOOR_LADDER.map((step) => { const rung = document.createElement("span"); rung.textContent = step; rung.dataset.active = String(step === next.verdict?.ladderPlacement.step); return rung; });
    element("door-ladder").replaceChildren(...rungs);
    const target = next.currentAudit;
    const side = target?.sideDoor;
    text("verdict-side-door", next.verdict.ladderPlacement.step === "Closed by robots" && side ? `Front door closed. Side door: ${side.label}.` : "");
    const fix = element("fixit-card");
    fix.replaceChildren();
    visible("fixit-card", next.verdict.fixIt !== undefined);
    if (next.verdict.fixIt) {
      const title = document.createElement("strong"); title.textContent = `Fix-it sample: ${next.verdict.fixIt.recordTitle} (${next.verdict.fixIt.fixtureDate})`;
      fix.append(title);
      for (const field of next.verdict.fixIt.fields) { const line = document.createElement("p"); line.textContent = `${field.field} Before: ${field.before}. After: ${field.after}.`; fix.append(line); }
    }
    text("correct-bettors", `${next.verdict.correctBettors} correct bettors`);
    const badges = next.verdict.checks.map(({ id, outcome }) => {
      const item = document.createElement("span");
      item.className = "verdict-check-badge";
      item.textContent = `${id} ${outcome.replaceAll("_", " ")}`;
      return item;
    });
    element("verdict-checks").replaceChildren(...badges);
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

fitStage();
window.addEventListener("resize", fitStage);
setInterval(renderCountdowns, 200);
connect();
