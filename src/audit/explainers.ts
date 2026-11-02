import type { CheckResult } from "./checks.js";

export interface ExplainerCard {
  checkId: CheckResult["id"];
  outcome: string;
  what: string;
  fix: string;
  standard: string;
}

type CardCopy = Pick<ExplainerCard, "what" | "fix" | "standard">;

export const EXPLAINERS: Readonly<Record<CheckResult["id"], Readonly<Record<string, CardCopy>>>> = {
  T0: {
    TERMS_GATE_OPEN: { what: "Treating reviewed terms as permission for every path.", fix: "Continue with the robots and path checks.", standard: "Commerce: Generative AI and Open Data: Guidelines and Best Practices (Jan 2025)" },
    DOOR_CLOSED_BY_TERMS: { what: "Treating a published data file as an override to its terms.", fix: "Stop before sending requests and show the terms source.", standard: "Commerce: Generative AI and Open Data: Guidelines and Best Practices (Jan 2025)" },
    TERMS_NOT_REVIEWED: { what: "Treating an incomplete terms review as permission.", fix: "Complete the terms review before any request.", standard: "Commerce: Generative AI and Open Data: Guidelines and Best Practices (Jan 2025)" },
  },
  K1: {
    present: { what: "Assuming a present robots file allows every path.", fix: "Check the matching rule for each planned path.", standard: "RFC 9309 (robots.txt)" },
    not_found: { what: "Treating a 4xx robots response as a path rule.", fix: "Apply RFC 9309 4xx handling, then check terms.", standard: "RFC 9309 (robots.txt)" },
    server_error: { what: "Assuming a server error means paths are open.", fix: "Stop and treat the robots policy as full disallow.", standard: "RFC 9309 (robots.txt)" },
    unreachable: { what: "Assuming an unreachable robots file grants access.", fix: "Stop and treat the robots policy as full disallow.", standard: "RFC 9309 (robots.txt)" },
    BLOCKED_BY_WAF: { what: "Treating a firewall response as a robots rule.", fix: "Stop and preserve the distinct WAF outcome.", standard: "RFC 9309 (robots.txt)" },
  },
  K2: {
    allowed: { what: "Assuming one allowed path means all paths are allowed.", fix: "Check only the configured path before requesting it.", standard: "RFC 9309 (robots.txt)" },
    allowed_with_limits: { what: "Ignoring a matching path limit or crawl delay.", fix: "Respect the rule and wait for the declared delay.", standard: "RFC 9309 (robots.txt)" },
    disallowed: { what: "Requesting a path that the robots file disallows.", fix: "Do not request it; show the matching rule.", standard: "RFC 9309 (robots.txt)" },
  },
  K3: {
    stated: { what: "Reading an AI-use statement as permission for all use.", fix: "Keep the statement separate from terms and path checks.", standard: "Commerce: Generative AI and Open Data: Guidelines and Best Practices (Jan 2025)" },
    partial: { what: "Reading one agent rule as a complete AI-use policy.", fix: "Show the rule as partial and keep its scope narrow.", standard: "RFC 9309 (robots.txt)" },
    silent: { what: "Treating silence as either permission or refusal.", fix: "Report silence as informational, not as a failure.", standard: "Commerce: Generative AI and Open Data: Guidelines and Best Practices (Jan 2025)" },
  },
  K4: {
    none: { what: "Inventing a wait when no crawl delay was declared.", fix: "Make no delay claim for this sample.", standard: "RFC 9309 (robots.txt)" },
    declared_and_honored: { what: "Treating crawl delay as an error to work around.", fix: "Wait for the declared interval before the next request.", standard: "RFC 9309 (robots.txt)" },
  },
  D1: {
    reachable: { what: "Assuming a reachable catalog proves every record is usable.", fix: "Inspect only the sampled catalog entries.", standard: "DCAT-US 3.0" },
    not_found_in_sample: { what: "Assuming a missing catalog in this sample does not exist.", fix: "Report not found in sample; do not guess another path.", standard: "DCAT-US 3.0" },
  },
  D2: {
    url_or_spdx: { what: "Assuming a machine-readable license grants every use.", fix: "Read the license terms before using the data.", standard: "Project Open Data metadata schema v1.1" },
    prose: { what: "Assuming prose can be parsed as a license identifier.", fix: "Add the publisher's license URL or SPDX identifier.", standard: "Project Open Data metadata schema v1.1" },
    empty_or_tbd: { what: "Treating an empty or TBD license as a license.", fix: "Fill in the portal's actual license URL or identifier.", standard: "Project Open Data metadata schema v1.1" },
    not_found_in_sample: { what: "Assuming missing license fields have no restrictions.", fix: "Report not found in sample; do not infer a license.", standard: "Project Open Data metadata schema v1.1" },
  },
  D3: {
    present: { what: "Assuming a present description answers every user question.", fix: "Keep the sampled description attached to its record.", standard: "Project Open Data metadata schema v1.1" },
    short: { what: "Assuming a short description is enough context.", fix: "Describe the record's contents and scope.", standard: "Project Open Data metadata schema v1.1" },
    empty_or_template: { what: "Treating an empty or template field as a description.", fix: "Replace it with the publisher's dataset description.", standard: "Project Open Data metadata schema v1.1" },
    not_found_in_sample: { what: "Assuming missing descriptions are blank everywhere.", fix: "Report not found in sample; do not generalize.", standard: "Project Open Data metadata schema v1.1" },
  },
  D4: {
    sane: { what: "Assuming a plausible date proves the data is current.", fix: "Report only the date field found in the sample.", standard: "Project Open Data metadata schema v1.1" },
    stale: { what: "Treating an old date as the current update date.", fix: "Publish the actual update date from the source record.", standard: "Project Open Data metadata schema v1.1" },
    impossible: { what: "Treating an impossible date as a valid timestamp.", fix: "Correct it using the publisher's actual record date.", standard: "Project Open Data metadata schema v1.1" },
    not_found_in_sample: { what: "Assuming a missing date is a current date.", fix: "Report not found in sample; do not invent a date.", standard: "Project Open Data metadata schema v1.1" },
  },
  D5: {
    api_or_bulk_endpoint: { what: "Assuming one responding distribution covers all data.", fix: "Describe only the sampled endpoint response.", standard: "DCAT-US 3.0" },
    landing_page_only: { what: "Treating an HTML landing page as a data response.", fix: "Publish an actual API or bulk distribution URL.", standard: "DCAT-US 3.0" },
    not_found_in_sample: { what: "Assuming a missing distribution has a hidden endpoint.", fix: "Report not found in sample; do not guess a URL.", standard: "DCAT-US 3.0" },
  },
};

export function getExplainer(checkId: CheckResult["id"], outcome: string): ExplainerCard {
  const copy = EXPLAINERS[checkId][outcome];
  if (copy === undefined) throw new Error(`No explainer for ${checkId} outcome ${outcome}`);
  return { checkId, outcome, ...copy };
}

export function formatExplainer(card: ExplainerCard): string {
  return `${card.checkId}: What an agent gets wrong: ${card.what} The fix: ${card.fix} Standard: ${card.standard}`;
}
