import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const violations: string[] = [];
const oauthMarker = ["o", "auth:"].join("");
const secretPatterns = [
  /(?:TWITCH_)?CLIENT_SECRET[ \t]*[=:][ \t]*["']?[a-z0-9_-]{16,}/iu,
  /(?:access|refresh)_token["']?[ \t]*[:=][ \t]*["'][a-z0-9._-]{16,}["']/iu,
];

for (const file of tracked) {
  if (!existsSync(file)) continue;
  const normalized = file.replaceAll("\\", "/");
  if (/(^|\/)\.env(?:$|\.)/iu.test(normalized) && !normalized.endsWith(".env.example")) {
    violations.push(`${file}: tracked .env file`);
    continue;
  }
  if (/(^|\/)(?:\.tokens\.json|tokens\.json)$/iu.test(normalized)) {
    violations.push(`${file}: tracked token file`);
    continue;
  }
  const content = readFileSync(file);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  if (text.toLowerCase().includes(oauthMarker) || secretPatterns.some((pattern) => pattern.test(text))) {
    violations.push(`${file}: secret-like value`);
  }
}

if (violations.length > 0) {
  console.error(`Secret check failed:\n${violations.map((item) => `- ${item}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Secret check passed (${tracked.length} tracked files scanned).`);
}
