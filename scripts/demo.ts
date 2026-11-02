import { createInterface } from "node:readline";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CommandRouter } from "../src/commands.js";
import { ReplayFetcher } from "../src/audit/fetcher.js";
import type { AuditRecording } from "../src/audit/fetcher.js";
import { createFixItCard } from "../src/audit/fixit.js";
import { loadLatestNationalCensus } from "../src/audit/census.js";
import { loadLatestDataGovV4Census } from "../src/audit/census-v4.js";
import { targets } from "../src/config.js";
import { GameEngine } from "../src/server/game.js";
import { OverlayServer } from "../src/server/server.js";

const ROUND_ALIASES = ["wikipedia", "boston", "nyc", "detroit", "michigan", "twitch", "samgov", "arcgis-hub"];

function targetByAlias(alias: string) {
  const target = targets.find((candidate) => candidate.alias === alias);
  if (target === undefined) throw new Error(`Missing demo target ${alias}`);
  return target;
}

async function waitForRound(alias: string, game: GameEngine): Promise<void> {
  let started = false;
  for (;;) {
    const state = game.store.getState();
    if (state.currentAudit?.targetAlias === alias) started = true;
    if (started && state.currentAudit === undefined && state.queue.length === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 2));
  }
}

export async function runDemo(smoke = false): Promise<void> {
  const recordings = new Map<string, AuditRecording>();
  for (const file of (await readdir(resolve("fixtures/recorded"))).filter((name) => name.endsWith(".json"))) {
    const recording = JSON.parse(await readFile(resolve("fixtures/recorded", file), "utf8")) as AuditRecording;
    const previous = recordings.get(recording.alias);
    if (previous === undefined || previous.recordedAt < recording.recordedAt) recordings.set(recording.alias, recording);
  }
  const nationalCensus = await loadLatestNationalCensus();
  const nationalCensusV4 = await loadLatestDataGovV4Census();
  let game: GameEngine | undefined;
  const fetcher = new ReplayFetcher({
    timeScale: 0.01,
    onEvent: (event) => game?.handleFetcherEvent(event),
  });
  game = new GameEngine({
    runtimeMode: "REPLAY",
    targets,
    fetcher,
    betWindowMs: smoke ? 5 : 20_000,
    doorClosedMs: smoke ? 5 : 3_000,
    verdictMs: smoke ? 5 : 2_000,
    mvpMs: smoke ? 5 : 500,
    announce: (message) => console.log(`[chat] ${message}`),
    fixItForTarget: (target, checks) => createFixItCard(target, recordings.get(target.alias), checks),
    ...(nationalCensus === undefined ? {} : { nationalCensus }),
    ...(nationalCensusV4 === undefined ? {} : { nationalCensusV4 }),
  });
  const overlay = new OverlayServer({ store: game.store, assetRoot: resolve("overlay/dist"), port: 3000 });
  const url = await overlay.start();
  console.log(`Offline REPLAY demo ready at ${url}.`);
  if (!smoke) {
    console.log("Type !y, !n, !whois, !knock <alias>, !audit <alias>, !score, !board, !why, !fix, !national, or !publisher <name> and press Enter.");
    const commands = new CommandRouter({ game, displayHandle: () => "Judge" });
    const input = createInterface({ input: process.stdin, output: process.stdout, prompt: "chat> " });
    input.on("line", (text) => {
      const reply = commands.handle({ userId: "offline-judge", userLogin: "judge", text });
      if (reply !== undefined) console.log(`[bot] ${reply}`);
      input.prompt();
    });
    input.prompt();
  }

  const aliases = smoke ? ["wikipedia"] : ROUND_ALIASES;
  try {
    for (const alias of aliases) {
      const target = targetByAlias(alias);
      if (target.mode === "catalog-census" || target.mode === "catalog-census-v4") continue;
      const result = game.queueAudit({ alias, mode: target.mode, requestedBy: "Offline judge demo" });
      if (result.status !== "queued") throw new Error(`Could not queue demo round ${alias}: ${result.status}`);
      await waitForRound(alias, game);
      if (!smoke) await new Promise((resolveWait) => setTimeout(resolveWait, 2_500));
    }
    if (smoke) await overlay.stop();
  } catch (error) {
    await overlay.stop();
    throw error;
  }
}

const args = process.argv.slice(2);
const smoke = args.length === 1 && args[0] === "--smoke";
if (args.length > 0 && !smoke) throw new Error("Usage: npm run demo -- [--smoke]");
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDemo(smoke).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Demo failed");
    process.exitCode = 1;
  });
}
