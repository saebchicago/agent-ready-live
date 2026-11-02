import { resolve } from "node:path";
import { loadRuntimeConfig } from "./config.js";
import { CommandRouter } from "./commands.js";
import { LiveFetcher } from "./audit/fetcher.js";
import { GameEngine } from "./server/game.js";
import { loadLatestNationalCensus } from "./audit/census.js";
import { OverlayServer } from "./server/server.js";
import { TwitchAuth } from "./twitch/auth.js";
import { ChatSender } from "./twitch/chat.js";
import { EventSubClient } from "./twitch/eventsub.js";

interface EventSubEndpoints {
  websocketUrl?: string;
  subscriptionUrl?: string;
}

function parseEventSubEndpoints(args: string[]): EventSubEndpoints {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      (flag !== "--eventsub-url" && flag !== "--eventsub-api-url") ||
      value === undefined
    ) {
      throw new Error(
        "Usage: npm run dev -- [--eventsub-url <url> --eventsub-api-url <url>]",
      );
    }
    values.set(flag, value);
  }
  const websocketUrl = values.get("--eventsub-url");
  const subscriptionUrl = values.get("--eventsub-api-url");
  if ((websocketUrl === undefined) !== (subscriptionUrl === undefined)) {
    throw new Error("Local EventSub testing requires both EventSub URL arguments");
  }
  return {
    ...(websocketUrl === undefined ? {} : { websocketUrl }),
    ...(subscriptionUrl === undefined ? {} : { subscriptionUrl }),
  };
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const endpoints = parseEventSubEndpoints(process.argv.slice(2));
  const auth = new TwitchAuth(config);
  const identity = await auth.initialize(config.botUserId);
  const chat = new ChatSender({
    auth,
    botUserId: config.botUserId,
    channelUserId: config.channelUserId,
  });
  const nationalCensus = await loadLatestNationalCensus();
  let game: GameEngine | undefined;
  const fetcher = new LiveFetcher({
    repoUrl: config.repoUrl,
    contactEmail: config.contactEmail,
    allowlist: config.targets,
    onEvent: (event) => game?.handleFetcherEvent(event),
  });
  game = new GameEngine({
    runtimeMode: "LIVE",
    targets: config.targets,
    fetcher,
    ...(nationalCensus === undefined ? {} : { nationalCensus }),
    announce: (message) => void chat.send(message),
  });
  const overlay = new OverlayServer({ store: game.store, assetRoot: resolve("overlay/dist") });
  const overlayUrl = await overlay.start();
  const commands = new CommandRouter({
    game,
    displayHandle: (login) => config.consentingHandles.has(login.toLowerCase()) ? login : "Anonymous viewer",
  });
  const eventSub = new EventSubClient({
    auth,
    botUserId: config.botUserId,
    channelUserId: config.channelUserId,
    ...endpoints,
    onMessage: async (message) => {
      const reply = commands.handle({
        userId: message.userId,
        userLogin: message.userLogin,
        text: message.text,
        isModerator: message.isModerator,
        isBroadcaster: message.isBroadcaster,
      });
      if (reply !== undefined) await chat.send(reply);
    },
    onRevocation: ({ type, status }) => {
      console.error(`EventSub subscription revoked: ${type} (${status})`);
    },
    onError: (error) => {
      console.error(error instanceof Error ? error.message : "EventSub error");
    },
  });
  let stopValidation = (): void => undefined;
  stopValidation = auth.startHourlyValidation(config.botUserId, (error) => {
    console.error(error instanceof Error ? error.message : "Token validation failed");
    eventSub.stop();
    stopValidation();
    void overlay.stop();
    process.exitCode = 1;
  });

  const shutdown = (): void => {
    eventSub.stop();
    stopValidation();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  eventSub.start();
  console.log(`Agent-Ready Live connected as ${identity.login}.`);
  console.log(`Overlay ready at ${overlayUrl}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Agent-Ready Live failed to start");
  process.exitCode = 1;
});
