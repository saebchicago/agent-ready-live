# Terms-of-use review (Agent-Ready Live)

Reviewed: Oct 31, 2026. Not legal advice. Rule: if a target's terms prohibit automated access, the agent sends **zero requests**. It stops at the door and shows the finding with a link.

| Alias | Site | Terms finding | Label | Live requests? | Owner action |
|---|---|---|---|---|---|
| michigan | Michigan.gov and State of Michigan portals | Terms of Use (Dec 2021) prohibit access "through any automated means," including scripts and web crawlers | Verified (michigan.gov/som/footer/policies) | **No** | Ask DTMB for written permission. Until then, show as a "door closed by terms" example |
| twitch | twitch.tv | Twitch Terms bar automated access to Twitch resources "for any purpose"; API use falls under the Developer Agreement | Verified (clause quoted on TwitchDev forum; current wording reported similar, May 2026) | **No** | None. Use as an on-stream "the agent won't even knock on Twitch" joke |
| wikipedia | en.wikipedia.org | Robot policy: identify via User-Agent with contact info; honor robots.txt | Verified (wikitech Robot policy) | Yes, 2 max | None |
| boston | data.boston.gov | Default dataset license PDDL; CKAN API published | Verified (Analyze Boston policy page) | Yes, 3 max | None |
| nyc | data.cityofnewyork.us | NYC Admin Code 23-502(d) (Local Law 11 of 2012): public data sets available without registration, license or use restrictions; source and version attribution may be required. NYC.gov Terms of Use have no automated-access clause; Section I bars disrupting servers (read 2026-10-31). | Verified (NYC Admin Code and NYC.gov Terms of Use) | Yes, 3 max | Attribute dataset source and version where required |
| detroit | data.detroitmi.gov | No automation clause found in searched city pages; robots.txt allows with Crawl-delay 60 | Modeled (portal footer terms unread; page is JavaScript-rendered) | Pending | Open the portal in a browser, read footer terms, then set `tosReviewed: true` (2 min) |
| chicago | data.cityofchicago.org | Excerpt reviewed has no automation clause; full terms page did not load | Modeled | Pending | Read the portal terms in a browser (2 min) |
| mischooldata, semcog, a2gov, grandrapids, steam, riot | Not reviewed | n/a | Excluded until reviewed | **No** | Add only after review |

## Disclosure

During research on Oct 31, an AI research tool made a small number of automated fetches of michigan.gov pages (robots.txt, the policies page) before the Terms of Use clause was found. Those fetches have stopped. Treat the earlier michigan.gov robots.txt observations as research context, not as app output, and mention this in the DTMB email.

## Why this matters for the talk (Modeled)

The State publishes open data meant for machine processing, yet its site-wide terms forbid scripts and crawlers outright, with no stated carve-out for open data or APIs. That is exactly the "explain by exception" gap the talk is about.
