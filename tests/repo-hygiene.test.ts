import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { targets } from "../src/config.js";

const fixtureDirectory = "fixtures/recorded";
const fixtureNames = readdirSync(fixtureDirectory).filter((name) => name.endsWith(".json"));

describe("recorded fixture hygiene", () => {
  it("marks sanitized headers and contains no cookie headers", () => {
    for (const name of fixtureNames) {
      const recording = JSON.parse(readFileSync(join(fixtureDirectory, name), "utf8")) as {
        sanitized?: string[];
        exchanges: Array<{ headers: Record<string, string> }>;
      };
      expect(recording.sanitized).toEqual(["set-cookie", "cookie"]);
      for (const exchange of recording.exchanges) {
        expect(Object.keys(exchange.headers).map((key) => key.toLowerCase()))
          .not.toContain("set-cookie");
        expect(Object.keys(exchange.headers).map((key) => key.toLowerCase()))
          .not.toContain("cookie");
      }
    }
  });
});

describe("terms review consistency", () => {
  it("has matching terms status rows and keeps prohibited targets fixture-free", () => {
    const review = readFileSync("docs/TOS-REVIEW.md", "utf8");
    const rows = new Map<string, string>();
    for (const line of review.split(/\r?\n/u)) {
      if (!line.startsWith("|")) continue;
      const columns = line.split("|").map((column) => column.trim());
      if (columns.length >= 4 && columns[1] !== "Alias" && columns[1] !== "---") {
        rows.set(columns[1] ?? "", columns[3] ?? "");
      }
    }
    const fixtureAliases = new Set(fixtureNames.map((name) => name.replace(/-\d{4}-\d{2}-\d{2}\.json$/u, "")));
    for (const target of targets) {
      expect(rows.get(target.alias), `${target.alias} review row`).toBe(target.tos.status);
      if (target.tos.status === "prohibited") expect(fixtureAliases.has(target.alias)).toBe(false);
      if (fixtureAliases.has(target.alias)) expect(target.tosReviewed, target.alias).toBe(true);
    }
  });
});
