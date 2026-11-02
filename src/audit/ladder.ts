import type { CheckResult } from "./checks.js";
import type { Target } from "../config.js";

export const DOOR_LADDER = [
  "Closed by terms",
  "Closed by robots",
  "Open with gaps",
  "Open by law",
  "Agent lane offered",
] as const;

export type DoorLadderStep = (typeof DOOR_LADDER)[number];

export interface LadderPlacement {
  step: DoorLadderStep;
  evidence: string;
}

export function classifyDoorLadder(target: Target, checks: readonly CheckResult[]): LadderPlacement {
  const terms = checks.find(({ id }) => id === "T0");
  if (terms?.outcome === "DOOR_CLOSED_BY_TERMS") {
    return { step: "Closed by terms", evidence: "The configured terms gate prohibits automated access." };
  }
  if (terms?.outcome === "TERMS_NOT_REVIEWED") {
    return { step: "Closed by terms", evidence: "Terms review is incomplete; no requests were sent." };
  }

  const k2 = checks.find(({ id }) => id === "K2");
  if (k2?.outcome === "disallowed") {
    return { step: "Closed by robots", evidence: k2.evidence };
  }
  if (
    target.tos.status === "allowed-with-conditions" &&
    /(?:Admin Code|Local Law)/iu.test(target.tos.evidence)
  ) {
    return { step: "Open by law", evidence: target.tos.evidence };
  }
  const d5 = checks.find(({ id }) => id === "D5");
  if (d5?.outcome === "api_or_bulk_endpoint" || target.sideDoor?.url !== undefined) {
    return { step: "Agent lane offered", evidence: d5?.evidence ?? target.sideDoor?.evidence ?? "" };
  }
  return {
    step: "Open with gaps",
    evidence: checks.find(({ id }) => id === "D2" || id === "D3" || id === "D4")?.evidence ??
      "No sampled catalog finding establishes a dedicated agent lane.",
  };
}

export function sideDoorLine(label: string): string {
  return `Front door closed. Side door: ${label}.`;
}
