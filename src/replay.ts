import { resolve } from "node:path";
import { ReplayFetcher } from "./audit/fetcher.js";
import { targets } from "./config.js";
import { GameEngine } from "./server/game.js";
import { OverlayServer } from "./server/server.js";

async function main(): Promise<void> {
  const [alias = "michigan", ...extra] = process.argv.slice(2);
  if (extra.length > 0) throw new Error("Usage: npm run replay -- [alias]");
  const target = targets.find((candidate) => candidate.alias === alias);
  if (target === undefined) throw new Error(`Unknown target alias ${JSON.stringify(alias)}`);
  if (target.mode === "catalog-census") throw new Error("Use !national for the catalog census. Replay aliases are knock or audit targets.");
  let game: GameEngine | undefined;
  const fetcher = new ReplayFetcher({ timeScale: 0.02, onEvent: (event) => game?.handleFetcherEvent(event) });
  game = new GameEngine({ runtimeMode: "REPLAY", targets, fetcher, announce: console.log });
  const server = new OverlayServer({ store: game.store, assetRoot: resolve("overlay/dist") });
  const url = await server.start();
  console.log(`REPLAY overlay ready at ${url}.`);
  game.queueAudit({ alias: target.alias, mode: target.mode, requestedBy: "Replay demo" });
  const stop = (): void => { void server.stop(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Replay failed to start");
  process.exitCode = 1;
});
