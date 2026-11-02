# Terms-of-use review (Agent-Ready Live)

Reviewed: Oct 31, 2026. Not legal advice. Rule: if a target's terms prohibit automated access, the agent sends **zero requests**. It stops at the door and shows the finding with a link.

| Alias | Site | Terms status | Terms finding | Label | Live requests? | Owner action |
|---|---|---|---|---|---|---|
| michigan | Michigan.gov and State of Michigan portals | prohibited | Terms of Use (Dec 2021) prohibit access "through any automated means," including scripts and web crawlers | Verified (michigan.gov/som/footer/policies) | **No** | Ask DTMB for written permission. Until then, show as a "door closed by terms" example |
| twitch | twitch.tv | prohibited | Twitch Terms bar automated access to Twitch resources "for any purpose"; API use falls under the Developer Agreement | Verified (clause quoted on TwitchDev forum; current wording reported similar, May 2026) | **No** | None. Use as an on-stream "the agent won't even knock on Twitch" joke |
| samgov | SAM.gov | prohibited | Terms prohibit automated data gathering and web scraping tools (read 2026-11-01) | Verified (SAM.gov Terms of Use) | **No** | Use T0 only. Do not send requests to SAM.gov |
| datagov | Data.gov National Catalog | allowed-with-conditions | robots.txt has no Disallow rules and sets Crawl-delay 10 (read 2026-11-01). Catalog includes non-federal catalogs harvested from city and state data.json feeds; each dataset carries its own terms. | Verified (data.gov Privacy Policy and configured robots.txt review) | At most 3 requests | Census only, honoring Crawl-delay |
| arcgis-hub | ArcGIS Hub | prohibited | Esri Website Properties Terms (G577, Aug 14 2025) 2.3(e) bar systematic harvesting, including for AI tools; 2.3(a) limits access to a browser or Esri products. Conservative reading (read 2026-11-02). | Verified (Esri Website Properties Terms) | **No** | T0 only. Use each publisher's own DCAT-US feed |
| wikipedia | en.wikipedia.org | allowed-with-conditions | Robot policy: identify via User-Agent with contact info; honor robots.txt | Verified (wikitech Robot policy) | Yes, 2 max | None |
| boston | data.boston.gov | no-prohibition-found | Default dataset license PDDL; CKAN API published | Verified (Analyze Boston policy page) | Yes, 3 max | None |
| nyc | data.cityofnewyork.us | allowed-with-conditions | NYC Admin Code 23-502(d) (Local Law 11 of 2012): public data sets available without registration, license or use restrictions; source and version attribution may be required. NYC.gov Terms of Use have no automated-access clause; Section I bars disrupting servers (read 2026-10-31). | Verified (NYC Admin Code and NYC.gov Terms of Use) | Yes, 3 max | Attribute dataset source and version where required |
| detroit | data.detroitmi.gov | no-prohibition-found | No automation clause found in searched city pages; robots.txt allows with Crawl-delay 60 | Modeled (portal footer terms unread; page is JavaScript-rendered) | Pending | Open the portal in a browser, read footer terms, then set `tosReviewed: true` (2 min) |
| chicago | data.cityofchicago.org | unclear | Excerpt reviewed has no automation clause; full terms page did not load | Modeled | Pending | Read the portal terms in a browser (2 min) |
| mischooldata, semcog, a2gov, grandrapids, steam, riot | Not reviewed | n/a | n/a | Excluded until reviewed | **No** | Add only after review |

## Open questions

Detroit's portal runs on ArcGIS Hub. Our requests used Detroit's public DCAT-US feed, which is published for machine harvesting and is harvested by data.gov. Whether Esri's platform terms also apply to customer portals is unresolved.

## Disclosure

During research on Oct 31, an AI research tool made a small number of automated fetches of michigan.gov pages (robots.txt, the policies page) before the Terms of Use clause was found. Those fetches have stopped. Treat the earlier michigan.gov robots.txt observations as research context, not as app output, and mention this in the DTMB email.

## Why this matters for the talk (Modeled)

The State publishes open data meant for machine processing, yet its site-wide terms forbid scripts and crawlers outright, with no stated carve-out for open data or APIs. That is exactly the "explain by exception" gap the talk is about.
