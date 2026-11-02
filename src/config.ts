import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TargetMode = "knock" | "audit" | "catalog-census" | "catalog-census-v4" | "meaning";
export type GameTargetMode = Exclude<TargetMode, "catalog-census" | "catalog-census-v4" | "meaning">;
export type TargetDialect = "dcat" | "socrata" | "ckan";
export type TosStatus =
  | "allowed-with-conditions"
  | "no-prohibition-found"
  | "unclear"
  | "prohibited";

export interface TargetTerms {
  status: TosStatus;
  sourceUrl: string;
  evidence: string;
  reviewedOn: string;
}

export interface TargetSideDoor {
  label: string;
  url?: string;
  evidence: string;
  readDate: string;
}

export interface Target {
  alias: string;
  name: string;
  host: string;
  mode: TargetMode;
  catalogUrl?: string;
  dialect?: TargetDialect;
  tos: TargetTerms;
  sideDoor?: TargetSideDoor;
  tosReviewed: boolean;
  notes: string;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  tokensPath: string;
}

export interface RuntimeConfig extends OAuthConfig {
  botUserId: string;
  channelUserId: string;
  contactEmail: string;
  repoUrl: string;
  consentingHandles: ReadonlySet<string>;
  targets: readonly Target[];
}

const TARGETS_PATH = new URL("../config/targets.json", import.meta.url);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TARGET_MODES = new Set<TargetMode>(["knock", "audit", "catalog-census", "catalog-census-v4", "meaning"]);
const TARGET_DIALECTS = new Set<TargetDialect>(["dcat", "socrata", "ckan"]);
const TOS_STATUSES = new Set<TosStatus>([
  "allowed-with-conditions",
  "no-prohibition-found",
  "unclear",
  "prohibited",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (
    typeof value !== "string" ||
    (!options.allowEmpty && value.trim().length === 0)
  ) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredString(value, label);
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string,
): T {
  const parsed = requiredString(value, label);
  if (!allowed.has(parsed as T)) {
    throw new Error(`${label} has unsupported value ${JSON.stringify(parsed)}`);
  }
  return parsed as T;
}

function httpsUrl(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
  return parsed;
}

function parseTarget(value: unknown, index: number): Target {
  const label = `targets[${index}]`;
  const input = record(value, label);
  const alias = requiredString(input.alias, `${label}.alias`);
  if (!/^[a-z0-9-]+$/.test(alias)) {
    throw new Error(`${label}.alias must contain lowercase letters, numbers, or hyphens`);
  }

  const host = requiredString(input.host, `${label}.host`);
  if (host !== host.toLowerCase() || host.includes(":") || host.includes("/")) {
    throw new Error(`${label}.host must be a lowercase hostname without a port or path`);
  }
  try {
    if (new URL(`https://${host}`).hostname !== host) {
      throw new Error("hostname mismatch");
    }
  } catch {
    throw new Error(`${label}.host must be a valid hostname`);
  }

  const tosInput = record(input.tos, `${label}.tos`);
  const reviewedOn = requiredString(tosInput.reviewedOn, `${label}.tos.reviewedOn`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedOn)) {
    throw new Error(`${label}.tos.reviewedOn must use YYYY-MM-DD`);
  }

  if (typeof input.tosReviewed !== "boolean") {
    throw new Error(`${label}.tosReviewed must be a boolean`);
  }

  const catalogUrl = optionalString(input.catalogUrl, `${label}.catalogUrl`);
  const sideDoorInput = input.sideDoor === undefined ? undefined : record(input.sideDoor, `${label}.sideDoor`);
  const sideDoorReadDate = sideDoorInput === undefined
    ? undefined
    : requiredString(sideDoorInput.readDate, `${label}.sideDoor.readDate`);
  if (sideDoorReadDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(sideDoorReadDate)) {
    throw new Error(`${label}.sideDoor.readDate must use YYYY-MM-DD`);
  }
  const dialect =
    input.dialect === undefined
      ? undefined
      : enumValue(input.dialect, TARGET_DIALECTS, `${label}.dialect`);

  return {
    alias,
    name: requiredString(input.name, `${label}.name`),
    host,
    mode: enumValue(input.mode, TARGET_MODES, `${label}.mode`),
    ...(catalogUrl === undefined
      ? {}
      : { catalogUrl: httpsUrl(catalogUrl, `${label}.catalogUrl`) }),
    ...(dialect === undefined ? {} : { dialect }),
    ...(sideDoorInput === undefined ? {} : {
      sideDoor: {
        label: requiredString(sideDoorInput.label, `${label}.sideDoor.label`),
        ...(sideDoorInput.url === undefined ? {} : { url: httpsUrl(sideDoorInput.url, `${label}.sideDoor.url`) }),
        evidence: requiredString(sideDoorInput.evidence, `${label}.sideDoor.evidence`),
        readDate: sideDoorReadDate as string,
      },
    }),
    tos: {
      status: enumValue(tosInput.status, TOS_STATUSES, `${label}.tos.status`),
      sourceUrl: httpsUrl(tosInput.sourceUrl, `${label}.tos.sourceUrl`),
      evidence: requiredString(tosInput.evidence, `${label}.tos.evidence`),
      reviewedOn,
    },
    tosReviewed: input.tosReviewed,
    notes: requiredString(input.notes, `${label}.notes`, { allowEmpty: true }),
  };
}

export function loadTargets(): readonly Target[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(TARGETS_PATH, "utf8")) as unknown;
  } catch (error) {
    throw new Error("Could not read config/targets.json", { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("config/targets.json must contain an array");
  }

  const result = parsed.map(parseTarget);
  const aliases = new Set<string>();
  for (const target of result) {
    if (aliases.has(target.alias)) {
      throw new Error(`Duplicate target alias ${JSON.stringify(target.alias)}`);
    }
    aliases.add(target.alias);
  }
  return Object.freeze(result);
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function tokensPath(): string {
  const configured = process.env.TOKENS_PATH?.trim();
  const expanded = configured
    ? configured === "~"
      ? homedir()
      : configured.startsWith("~/")
        ? resolve(homedir(), configured.slice(2))
        : configured
    : resolve(homedir(), ".agent-ready-live", "tokens.json");
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(expanded);
  const fromRepo = relative(REPO_ROOT, absolute);
  if (fromRepo === "" || (!fromRepo.startsWith("..") && !isAbsolute(fromRepo))) {
    throw new Error("TOKENS_PATH must be outside the repository");
  }
  return absolute;
}

function userId(name: "TWITCH_BOT_USER_ID" | "TWITCH_CHANNEL_USER_ID"): string {
  const value = env(name);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must contain only digits`);
  }
  return value;
}

export function loadOAuthConfig(): OAuthConfig {
  return {
    clientId: env("TWITCH_CLIENT_ID"),
    clientSecret: env("TWITCH_CLIENT_SECRET"),
    tokensPath: tokensPath(),
  };
}

export function loadRuntimeConfig(): RuntimeConfig {
  const oauth = loadOAuthConfig();
  const contactEmail = env("CONTACT_EMAIL");
  if (!/^\S+@\S+\.\S+$/.test(contactEmail)) {
    throw new Error("CONTACT_EMAIL must be an email address");
  }
  const repoUrl = httpsUrl(env("REPO_URL"), "REPO_URL");
  const consentingHandles = new Set(
    (process.env.CONSENTING_HANDLES ?? "")
      .split(",")
      .map((handle) => handle.trim().toLowerCase())
      .filter(Boolean),
  );
  return {
    ...oauth,
    botUserId: userId("TWITCH_BOT_USER_ID"),
    channelUserId: userId("TWITCH_CHANNEL_USER_ID"),
    contactEmail,
    repoUrl,
    consentingHandles,
    targets,
  };
}

export const targets = loadTargets();
