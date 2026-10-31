import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadOAuthConfig } from "../config.js";
import { TwitchAuth } from "./auth.js";

interface TwitchUser {
  id: string;
  login: string;
}

function parseUser(value: unknown): TwitchUser | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const user = data[0];
  if (typeof user !== "object" || user === null || Array.isArray(user)) return undefined;
  const input = user as Record<string, unknown>;
  if (typeof input.id !== "string" || typeof input.login !== "string") return undefined;
  return { id: input.id, login: input.login };
}

export async function runWhois(loginArgument = process.argv[2]): Promise<void> {
  const login = loginArgument?.trim().toLowerCase();
  if (!login || !/^[a-z0-9_]{1,25}$/.test(login)) {
    throw new Error("Usage: npm run whois -- <login>");
  }

  const auth = new TwitchAuth(loadOAuthConfig());
  await auth.initialize();
  const url = new URL("https://api.twitch.tv/helix/users");
  url.searchParams.set("login", login);
  const response = await auth.fetch(url);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Get Users failed with HTTP ${response.status}`);
  }
  const user = parseUser((await response.json()) as unknown);
  if (user === undefined) {
    throw new Error(`No Twitch user found for ${login}`);
  }
  console.log(`${user.login}: ${user.id}`);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  runWhois().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Whois failed");
    process.exitCode = 1;
  });
}
