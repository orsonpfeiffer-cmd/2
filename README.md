# Car Radar

A mobile-first news feed for **BMW, Audi, Mercedes-Benz, Porsche, Zeekr, Polestar and Volvo Cars**.
Every story gets one big label:

| Label | Meaning |
|---|---|
| 🟢 **OFFICIAL** | From the automaker's own newsroom or press release |
| 🔵 **CONFIRMED** | A news outlet reporting facts, no speculation |
| 🟠 **RUMOR** | Spy shots, leaks, patents, unnamed sources, "could / might" |

A short reason sits under each badge, for example "Rumor: based on spy shots".

## Run it

Needs Node.js 22.13 or newer. There is no build step.

```bash
npm install
cp .env.example .env      # optional: add ANTHROPIC_API_KEY
npm start                 # http://localhost:3000
```

The server fetches every source at startup and then every 7 minutes. The first articles show up about a minute after you start it.

On your phone, open the site and use "Add to Home Screen". It then runs full screen like an app.

## Sources: one file

Everything lives in [`sources.config.js`](sources.config.js):

- **Sources:** official newsrooms, news outlets, and one Google News search per brand. Copy an entry to add one, and delete it or set `enabled: false` to remove one.
- **Brands:** name, color, the words that count as a mention, and the phrases to ignore (Volvo Trucks, Porsche SE, stadium names and so on).
- **Rumor keywords:** used when Claude isn't available.
- **Settings:** refresh interval, 14-day retention, and AI batch size.

Restart the server after editing. The in-app **Sources** page (the RSS icon) shows every source, when it last updated, and why it failed if it did.

**Unverified feeds.** These URLs came from web search, because the build environment couldn't reach the sites. If one shows as failing on the Sources page, open the newsroom in a browser, find its RSS link, and paste it into the config.

- BMW PressClub
- Audi
- Porsche Newsroom
- Polestar Newsroom

Mercedes-Benz and Zeekr publish no public RSS, so the config searches their newsroom domains through Google News. Top Gear works the same way.

## How labels work

1. **An automaker newsroom is always OFFICIAL.** That covers the direct feeds and Google News results from domains listed in `officialDomains`.
2. **Claude labels everything else**, if `ANTHROPIC_API_KEY` is set. Each new article is sent once, in batches of 15, with its headline, summary and publisher. Claude returns the label, a one-sentence reason, which brands the story is really about, and whether it's relevant at all. Irrelevant stories are stored but hidden, so they're never sent again. Examples are F1 results, stadium news, and trucks. The result is stored and never recomputed.
3. **Keyword rules take over** when there's no key, when a call fails, or when Claude declines. Any rumor keyword in the headline or summary makes it RUMOR. Anything else is CONFIRMED.

The model defaults to `claude-opus-5` at low effort, with Anthropic's server-side fallback turned on. Set `CLAUDE_MODEL=claude-haiku-4-5` to cut the cost about 5x. Each refresh sends at most 150 articles to Claude, so a fresh database can't run up a big bill on its first run.

## Matching and duplicates

- A brand counts when it's in the headline, or named at least twice in the summary. A single mention in the summary is treated as passing and ignored.
- Ignore phrases are removed before matching. Volvo Trucks/Group/Buses, Porsche SE, BMW Motorrad, sponsorships and F1 headlines never match.
- Stories are merged when two headlines about the same brand, published within 72 hours, share most of their distinctive words. The newsroom version leads if there is one. The others appear under "Also reported by X sources".

## Deploy

It's one small Node process with a SQLite file, so any host that runs a container with a persistent disk works. Vercel-style serverless functions don't fit, because the app needs a background timer and a disk.

```bash
docker build -t car-radar .
docker run -d -p 3000:3000 -v car-radar-data:/data -e ANTHROPIC_API_KEY=sk-ant-... car-radar
```

- **Railway / Render / Fly.io:** deploy from this repo with the Dockerfile. Mount a volume at `/data` and set `ANTHROPIC_API_KEY`. Without a volume the database resets on every deploy. That still works, but you lose history and pay to relabel.
- **A VPS:** `npm ci --omit=dev && npm start` behind any reverse proxy, with pm2 or systemd keeping it alive.

## API

| Endpoint | What it returns |
|---|---|
| `GET /api/articles?brands=bmw,audi&label=RUMOR&from=<ms>&q=text&cursor=…` | One page of stories, newest first |
| `GET /api/articles/newer?since=<ms>&…` | How many stories are newer than the top of your feed, for the banner |
| `GET /api/sources` | Status of every source and the last refresh |
| `GET /api/config` | Brands, colors, and whether AI labels are on |

## Tests

```bash
npm test
```

The tests cover brand matching and false matches, rumor rules, the Claude response handling with a mocked client, feed parsing (RSS, Atom, Google News, broken XML), duplicate merging, retention, and a full refresh cycle against local fixture feeds that include failing sources.

## Layout

```
sources.config.js     brands, sources, rules, settings (edit this)
server/
  index.js            starts the web server and the refresh timer
  pipeline.js         one refresh: fetch → match → label → merge → clean up
  feeds.js            RSS/Atom download and parsing
  matcher.js          which brands an article is about
  classifier.js       Claude labels + keyword fallback
  dedupe.js           same-story detection
  db.js               SQLite (built into Node, no native modules)
  app.js              HTTP API + static files
public/               the app: plain HTML, CSS and JS
test/                 node:test suites + fixture feeds
```
