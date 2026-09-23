// ─────────────────────────────────────────────────────────────────────────────
//  Car Radar config: brands, sources and label rules all live here.
//
//  Add a source:    copy one of the entries in `sources` and change it.
//  Remove a source: delete it, or set `enabled: false`.
//  Changes apply on the next server restart.
// ─────────────────────────────────────────────────────────────────────────────

// Builds a Google News RSS search URL. `when` limits results by age (e.g. '2d').
// We poll every few minutes, so a short window keeps results fresh; the database
// still keeps everything for 14 days.
export const googleNews = (query, when = '2d') =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${when}`)}&hl=en-US&gl=US&ceid=US:en`;

// ─── Brands ──────────────────────────────────────────────────────────────────
//  patterns        what counts as a mention of the brand
//  ignore          phrases removed before matching (Volvo Trucks, Porsche SE, stadiums...)
//  excludeTitle    drop the article for this brand if the headline matches
//  officialDomains publishers that count as the brand's own newsroom (→ OFFICIAL)
//  aliases         extra words stripped when comparing headlines for duplicates
export const brands = [
  {
    id: 'bmw',
    name: 'BMW',
    color: '#1C69D4',
    patterns: [/\bBMW\b/i],
    ignore: [
      /\bBMW (PGA )?Championship\b/i,
      /\bBMW International Open\b/i,
      /\bBMW Open\b/i,
      /\bBMW Berlin[- ]Marathon\b/i,
      /\bBMW Motorrad\b/i,
    ],
    excludeTitle: [
      /\b(motorcycles?|motorbikes?|scooters?)\b/i,
      /^(?!.*\bBMW\b).*\b(MINI|Rolls-Royce)\b/, // MINI / Rolls-Royce news with no BMW in the headline
    ],
    officialDomains: ['press.bmwgroup.com', 'bmwgroup.com', 'bmwusanews.com', 'bmw.com'],
  },
  {
    id: 'audi',
    name: 'Audi',
    color: '#E11D48',
    patterns: [/\bAudi\b/i],
    ignore: [/\bAudi (Field|Dome|Arena)\b/i],
    officialDomains: ['audi-mediacenter.com', 'audi.com', 'media.audiusa.com', 'audiusa.com'],
  },
  {
    id: 'mercedes',
    name: 'Mercedes-Benz',
    color: '#A3AEBB',
    patterns: [/\bMercedes\b/i, /\bAMG\b/, /\bMaybach\b/i],
    ignore: [
      /\bMercedes-Benz (Stadium|Arena|Superdome|Fashion Week)\b/i,
      /\bMercedes-AMG Petronas\b/i,
      /\bMercedes Mon[eé]\b/i,
      /\bDaimler Truck\b/i,
      /\bMercedes-Benz Trucks\b/i,
    ],
    officialDomains: ['group.mercedes-benz.com', 'group-media.mercedes-benz.com', 'media.mbusa.com', 'mercedes-benz.com', 'mbusa.com'],
    aliases: ['mercedes', 'benz', 'amg', 'maybach'],
  },
  {
    id: 'porsche',
    name: 'Porsche',
    color: '#D4A34A',
    patterns: [/\bPorsche\b/i],
    ignore: [
      /\bPorsche (SE|Automobil Holding)\b/i, // the holding company / stock news
      /\bPorsche (Arena|Tennis Grand Prix)\b/i,
    ],
    officialDomains: ['newsroom.porsche.com', 'porsche.com'],
  },
  {
    id: 'zeekr',
    name: 'Zeekr',
    color: '#8B5CF6',
    patterns: [/\bZeekr\b/i, /极氪/],
    officialDomains: ['zeekrgroup.com', 'zeekrlife.com', 'zeekr.eu'],
  },
  {
    id: 'polestar',
    name: 'Polestar',
    color: '#2DD4BF',
    patterns: [/\bPolestar\b/i],
    ignore: [/\bPolestar Pilates\b/i],
    officialDomains: ['media.polestar.com', 'polestar.com'],
  },
  {
    id: 'volvo',
    name: 'Volvo Cars',
    color: '#38BDF8',
    patterns: [/\bVolvo\b/i],
    ignore: [
      /\bAB Volvo\b/i,
      /\bVolvo (Trucks?|Group|Bus(es)?|Penta|CE|Construction Equipment|Financial Services|Autonomous Solutions|Energy)\b/i,
      /\bVolvo (FH|FM|FMX|FE|FL|VNL|VNR|VHD|VAH)\d*\b/i, // truck models
      /\bVolvo Car (Open|Stadium|Arena)\b/i,
      /\bVolvo Ocean Race\b/i,
    ],
    excludeTitle: [
      // Truck / bus / construction stories, unless the headline says "Volvo Cars"
      /^(?!.*\bVolvo Cars\b).*\b(trucks?|lorr(y|ies)|bus(es)?|coach(es)?|excavators?|construction equipment)\b/i,
    ],
    officialDomains: ['media.volvocars.com', 'volvocars.com'],
    aliases: ['volvo', 'cars'],
  },
];

// ─── Sources ─────────────────────────────────────────────────────────────────
//  type: 'official'   the automaker's own newsroom → always labeled OFFICIAL
//        'outlet'     news site → CONFIRMED or RUMOR
//        'aggregator' Google News search → label depends on the real publisher
//  brands:     set for brand-specific sources (the brand then only needs one mention)
//  trustBrand: every article in this feed is about `brands` (skip the mention check)
//  via:        shown next to the publisher name, e.g. "via Google News"
export const sources = [
  // 1) Official newsrooms
  { id: 'bmw-pressclub', name: 'BMW Group PressClub', type: 'official', brands: ['bmw'],
    url: 'https://www.press.bmwgroup.com/global/rss' },
  { id: 'audi-media', name: 'Audi MediaCenter', type: 'official', brands: ['audi'], trustBrand: true,
    url: 'https://www.audi.com/en/feeds/press-releases' },
  { id: 'mercedes-media', name: 'Mercedes-Benz Group Media', type: 'official', brands: ['mercedes'], via: 'Google News',
    // No public RSS feed, so this searches Google News for the newsroom domains.
    url: googleNews('site:group.mercedes-benz.com OR site:media.mbusa.com', '14d') },
  { id: 'porsche-newsroom', name: 'Porsche Newsroom', type: 'official', brands: ['porsche'], trustBrand: true, via: 'Google News',
    // The old RSS address returns 404, so this searches the newsroom through Google News.
    url: googleNews('site:newsroom.porsche.com', '14d') },
  { id: 'zeekr-official', name: 'Zeekr Newsroom', type: 'official', brands: ['zeekr'], trustBrand: true, via: 'Google News',
    url: googleNews('site:zeekrgroup.com OR site:zeekrlife.com OR site:zeekr.eu', '14d') },
  { id: 'polestar-media', name: 'Polestar Media Newsroom', type: 'official', brands: ['polestar'], trustBrand: true, via: 'Google News',
    // No public RSS feed, so this searches the newsroom through Google News.
    url: googleNews('site:media.polestar.com OR site:polestar.com', '14d') },
  { id: 'volvo-media', name: 'Volvo Cars Global Newsroom', type: 'official', brands: ['volvo'], trustBrand: true, via: 'Google News',
    // The direct feed (media.volvocars.com/global/en-gb/rss/pressreleases/feed.rss) blocks servers
    // with HTTP 503, so this searches the newsroom through Google News.
    url: googleNews('site:media.volvocars.com OR site:volvocars.com', '14d') },

  // 2) News outlets
  { id: 'electrek', name: 'Electrek', type: 'outlet', url: 'https://electrek.co/feed/' },
  { id: 'insideevs', name: 'InsideEVs', type: 'outlet', url: 'https://insideevs.com/rss/articles/all/' },
  { id: 'autocar', name: 'Autocar', type: 'outlet', url: 'https://www.autocar.co.uk/rss' },
  { id: 'motor1', name: 'Motor1', type: 'outlet', url: 'https://www.motor1.com/rss/news/all/' },
  { id: 'carscoops', name: 'Carscoops', type: 'outlet', url: 'https://www.carscoops.com/feed/' },
  { id: 'topgear', name: 'Top Gear', type: 'outlet', via: 'Google News',
    // Top Gear has no public RSS feed.
    url: googleNews('site:topgear.com') },
  { id: 'carnewschina', name: 'CarNewsChina', type: 'outlet', url: 'https://carnewschina.com/feed/' },
  { id: 'cnevpost', name: 'CnEVPost', type: 'outlet', url: 'https://cnevpost.com/feed/' },
  { id: 'caranddriver', name: 'Car and Driver', type: 'outlet', url: 'https://www.caranddriver.com/rss/all.xml/' },
  { id: 'electrive', name: 'electrive', type: 'outlet', url: 'https://www.electrive.com/feed/' },
  { id: 'autoevolution', name: 'autoevolution', type: 'outlet', url: 'https://www.autoevolution.com/rss/backend.xml' },
  { id: 'bmwblog', name: 'BMWBLOG', type: 'outlet', brands: ['bmw'], url: 'https://www.bmwblog.com/feed/' },

  // 3) Google News per brand (fallback / catch-all)
  { id: 'gn-bmw', name: 'Google News: BMW', type: 'aggregator', brands: ['bmw'],
    url: googleNews('BMW -golf -championship -motorrad') },
  { id: 'gn-audi', name: 'Google News: Audi', type: 'aggregator', brands: ['audi'],
    url: googleNews('Audi -F1 -"Formula 1"') },
  { id: 'gn-mercedes', name: 'Google News: Mercedes-Benz', type: 'aggregator', brands: ['mercedes'],
    url: googleNews('"Mercedes-Benz" OR "Mercedes-AMG" -F1 -stadium') },
  { id: 'gn-porsche', name: 'Google News: Porsche', type: 'aggregator', brands: ['porsche'],
    url: googleNews('Porsche -"Porsche SE" -F1') },
  { id: 'gn-zeekr', name: 'Google News: Zeekr', type: 'aggregator', brands: ['zeekr'],
    url: googleNews('Zeekr') },
  { id: 'gn-polestar', name: 'Google News: Polestar', type: 'aggregator', brands: ['polestar'],
    url: googleNews('Polestar -pilates') },
  { id: 'gn-volvo', name: 'Google News: Volvo Cars', type: 'aggregator', brands: ['volvo'],
    url: googleNews('Volvo -truck -trucks -bus -penta -"Volvo Group"') },
];

// ─── Filtering ───────────────────────────────────────────────────────────────
// Headlines matching any of these are dropped for every brand.
// Delete the first line if you want Formula 1 news.
export const excludeTitle = [
  /\b(F1|Formula (1|One)|Grand Prix|GP)\b/i,
];

// Publishers (from Google News results) that are never shown.
export const blockedPublishers = [
  'MarketBeat', 'Defense World', 'ETF Daily News', 'Ticker Report', 'Stock Titan',
  'The Enterprise Leader', 'Simply Wall St', 'Zacks', 'Benzinga',
];

// Press-release wire services. Only the AI can tell if a release came from the
// automaker itself, so the keyword fallback labels these CONFIRMED.
export const wireServices = ['prnewswire.com', 'businesswire.com', 'globenewswire.com'];

// ─── Keyword fallback for RUMOR ──────────────────────────────────────────────
// Used when no ANTHROPIC_API_KEY is set or the AI call fails. First match wins,
// headline before summary. `reason` becomes "Rumor: <reason>".
export const rumorRules = [
  { pattern: /\bspy (shots?|photos?|pics?|video)\b|\bspied\b|\bcaught testing\b|\bprototype spotted\b/i, reason: 'based on spy shots' },
  { pattern: /\bleak(s|ed)?\b/i, reason: 'based on leaked information' },
  { pattern: /\bpatent(s|ed)?\b/i, reason: 'based on a patent filing' },
  { pattern: /\brumou?r(s|ed)?\b/i, reason: 'unconfirmed rumor' },
  { pattern: /\breportedly\b|\bsources say\b|\baccording to sources\b|\binsiders?\b/i, reason: 'based on unnamed sources' },
  { pattern: /\ballegedly\b|\balleged\b/i, reason: 'unverified claims' },
  { pattern: /\bcould\b|\bmight\b/i, reason: 'speculative language ("could" / "might")' },
];

// ─── Settings ────────────────────────────────────────────────────────────────
export const settings = {
  fetchIntervalMinutes: 7,  // backend checks every source this often
  retentionDays: 14,        // older articles are deleted
  clientPollSeconds: 120,   // how often the app checks for new articles
  fetchTimeoutMs: 15000,
  fetchConcurrency: 5,
  userAgent: 'Mozilla/5.0 (compatible; CarRadar/1.0; RSS reader)',
  dedupeWindowHours: 72,    // only merge stories published this close together
  ai: {
    model: 'claude-opus-5', // override with CLAUDE_MODEL
    effort: 'low',          // classification is simple; low keeps cost and latency down
    batchSize: 15,          // articles per API call
    concurrency: 3,
    maxPerCycle: 150,       // cap per refresh; extras get keyword labels (protects your bill on first run)
  },
};
