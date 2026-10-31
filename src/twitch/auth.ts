import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadOAuthConfig, type OAuthConfig } from "../config.js";

const AUTHORIZE_URL = "https://id.twitch.tv/oauth2/authorize";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const REDIRECT_URI = "http://localhost:3000";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 3000;
const VALIDATION_INTERVAL_MS = 60 * 60 * 1_000;

export const CHAT_SCOPES = [
  "user:read:chat",
  "user:write:chat",
  "user:bot",
] as const;

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
  token_type: string;
  saved_at: string;
}

export interface TokenValidation {
  client_id: string;
  login: string;
  scopes: string[];
  user_id: string;
  expires_in: number;
}

export type FetchImplementation = typeof fetch;

export class TwitchHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TwitchHttpError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Twitch response omitted ${name}`);
  }
  return value;
}

function numberField(input: Record<string, unknown>, name: string): number {
  const value = input[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Twitch response omitted ${name}`);
  }
  return value;
}

function stringArrayField(input: Record<string, unknown>, name: string): string[] {
  const value = input[name];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Twitch response omitted ${name}`);
  }
  return value;
}

function parseTokenResponse(value: unknown): StoredTokens {
  const input = object(value, "Twitch token response");
  return {
    access_token: stringField(input, "access_token"),
    refresh_token: stringField(input, "refresh_token"),
    expires_in: numberField(input, "expires_in"),
    scope: stringArrayField(input, "scope"),
    token_type: stringField(input, "token_type"),
    saved_at:
      typeof input.saved_at === "string" ? input.saved_at : new Date().toISOString(),
  };
}

function parseValidation(value: unknown): TokenValidation {
  const input = object(value, "Twitch validation response");
  return {
    client_id: stringField(input, "client_id"),
    login: stringField(input, "login"),
    scopes: stringArrayField(input, "scopes"),
    user_id: stringField(input, "user_id"),
    expires_in: numberField(input, "expires_in"),
  };
}

async function twitchJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new TwitchHttpError(`${label} failed with HTTP ${response.status}`, response.status);
  }
  return response.json() as Promise<unknown>;
}

async function requestTokens(
  body: URLSearchParams,
  fetchImpl: FetchImplementation,
  label: string,
): Promise<StoredTokens> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  return parseTokenResponse(await twitchJson(response, label));
}

async function exchangeAuthorizationCode(
  config: OAuthConfig,
  code: string,
  fetchImpl: FetchImplementation,
): Promise<StoredTokens> {
  return requestTokens(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
    fetchImpl,
    "Authorization code exchange",
  );
}

async function refreshTokens(
  config: OAuthConfig,
  refreshToken: string,
  fetchImpl: FetchImplementation,
): Promise<StoredTokens> {
  return requestTokens(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    fetchImpl,
    "Token refresh",
  );
}

async function validateAccessToken(
  accessToken: string,
  fetchImpl: FetchImplementation,
): Promise<TokenValidation> {
  const response = await fetchImpl(VALIDATE_URL, {
    headers: { Authorization: `OAuth ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  return parseValidation(await twitchJson(response, "Token validation"));
}

async function saveTokens(path: string, tokens: StoredTokens): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(tokens, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function loadTokens(path: string): Promise<StoredTokens> {
  try {
    return parseTokenResponse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("No Twitch tokens found. Run npm run auth first.");
    }
    throw new Error("Could not load the Twitch token file", { cause: error });
  }
}

function assertValidation(
  validation: TokenValidation,
  config: OAuthConfig,
  expectedUserId?: string,
): void {
  if (validation.client_id !== config.clientId) {
    throw new Error("Stored Twitch token belongs to a different client ID");
  }
  if (expectedUserId !== undefined && validation.user_id !== expectedUserId) {
    throw new Error("Stored Twitch token does not belong to TWITCH_BOT_USER_ID");
  }
  const missing = CHAT_SCOPES.filter((scope) => !validation.scopes.includes(scope));
  if (missing.length > 0) {
    throw new Error(`Stored Twitch token is missing scopes: ${missing.join(", ")}`);
  }
}

export class TwitchAuth {
  private tokens: StoredTokens | undefined;
  private refreshInFlight: Promise<StoredTokens> | undefined;
  private validationTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: OAuthConfig,
    private readonly fetchImpl: FetchImplementation = fetch,
  ) {}

  async initialize(expectedUserId?: string): Promise<TokenValidation> {
    this.tokens = await loadTokens(this.config.tokensPath);
    const validation = await this.validateWithRefresh();
    assertValidation(validation, this.config, expectedUserId);
    return validation;
  }

  startHourlyValidation(
    expectedUserId: string,
    onError: (error: unknown) => void,
  ): () => void {
    if (this.validationTimer !== undefined) {
      throw new Error("Hourly token validation is already running");
    }
    this.validationTimer = setInterval(() => {
      void this.validateWithRefresh()
        .then((validation) => assertValidation(validation, this.config, expectedUserId))
        .catch(onError);
    }, VALIDATION_INTERVAL_MS);
    return () => {
      if (this.validationTimer !== undefined) {
        clearInterval(this.validationTimer);
        this.validationTimer = undefined;
      }
    };
  }

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const tokens = this.requireTokens();
    const response = await this.fetchOnce(input, init, tokens.access_token);
    if (response.status !== 401) {
      return response;
    }
    await response.body?.cancel();
    const refreshed = await this.refresh();
    return this.fetchOnce(input, init, refreshed.access_token);
  }

  private async fetchOnce(
    input: string | URL,
    init: RequestInit,
    accessToken: string,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    headers.set("Client-Id", this.config.clientId);
    return this.fetchImpl(input, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
  }

  private async validateWithRefresh(): Promise<TokenValidation> {
    try {
      return await validateAccessToken(this.requireTokens().access_token, this.fetchImpl);
    } catch (error) {
      if (!(error instanceof TwitchHttpError) || error.status !== 401) {
        throw error;
      }
      const refreshed = await this.refresh();
      return validateAccessToken(refreshed.access_token, this.fetchImpl);
    }
  }

  private async refresh(): Promise<StoredTokens> {
    if (this.refreshInFlight !== undefined) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = (async () => {
      const refreshed = await refreshTokens(
        this.config,
        this.requireTokens().refresh_token,
        this.fetchImpl,
      );
      await saveTokens(this.config.tokensPath, refreshed);
      this.tokens = refreshed;
      return refreshed;
    })();
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  private requireTokens(): StoredTokens {
    if (this.tokens === undefined) {
      throw new Error("TwitchAuth.initialize() must be called first");
    }
    return this.tokens;
  }
}

function checkCallbackRequest(
  request: IncomingMessage,
  response: ServerResponse,
): URL | undefined {
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" }).end("Method not allowed");
    return undefined;
  }
  if (request.headers.host !== "localhost:3000") {
    response.writeHead(400).end("Invalid callback host");
    return undefined;
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== REDIRECT_URI) {
    response.writeHead(403).end("Invalid callback origin");
    return undefined;
  }
  const url = new URL(request.url ?? "/", REDIRECT_URI);
  if (url.pathname !== "/") {
    response.writeHead(404).end("Not found");
    return undefined;
  }
  return url;
}

async function waitForAuthorizationCode(loginUrl: URL, state: string): Promise<string> {
  return new Promise<string>((resolveCode, rejectCode) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      callback();
    };
    const server = createServer((request, response) => {
      const url = checkCallbackRequest(request, response);
      if (url === undefined) return;
      if (url.searchParams.get("state") !== state) {
        response.writeHead(400).end("OAuth state mismatch");
        settle(() => rejectCode(new Error("OAuth state mismatch")));
        return;
      }
      const oauthError = url.searchParams.get("error");
      if (oauthError !== null) {
        response.writeHead(400).end("Twitch authorization was not completed");
        settle(() => rejectCode(new Error(`Twitch authorization failed: ${oauthError}`)));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        response.writeHead(400).end("Missing authorization code");
        settle(() => rejectCode(new Error("Twitch callback omitted the authorization code")));
        return;
      }
      response
        .writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
        .end("Agent-Ready Live authorization complete. You can close this tab.");
      settle(() => resolveCode(code));
    });
    server.on("error", (error) => settle(() => rejectCode(error)));
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      console.log("Open this URL in an incognito window logged in as the BOT account:");
      console.log(loginUrl.toString());
    });
    const timeout = setTimeout(
      () => settle(() => rejectCode(new Error("Twitch authorization timed out"))),
      5 * 60 * 1_000,
    );
  });
}

export async function runAuthorization(
  config: OAuthConfig = loadOAuthConfig(),
  fetchImpl: FetchImplementation = fetch,
): Promise<TokenValidation> {
  const state = randomBytes(32).toString("hex");
  const loginUrl = new URL(AUTHORIZE_URL);
  loginUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: REDIRECT_URI,
    scope: CHAT_SCOPES.join(" "),
    state,
    force_verify: "true",
  }).toString();

  const code = await waitForAuthorizationCode(loginUrl, state);
  const tokens = await exchangeAuthorizationCode(config, code, fetchImpl);
  await saveTokens(config.tokensPath, tokens);
  const validation = await validateAccessToken(tokens.access_token, fetchImpl);
  assertValidation(validation, config);
  console.log(`Authenticated bot: ${validation.login} (${validation.user_id})`);
  return validation;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  runAuthorization().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Authorization failed");
    process.exitCode = 1;
  });
}
