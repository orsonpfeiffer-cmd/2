import path from 'node:path';
import { pathToFileURL } from 'node:url';

const toGlobal = (re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
const toSingle = (re) => new RegExp(re.source, re.flags.replace('g', ''));

// Loads sources.config.js (or CAR_RADAR_CONFIG), validates it and precompiles regexes.
export async function loadConfig(file = process.env.CAR_RADAR_CONFIG || 'sources.config.js') {
  const mod = await import(pathToFileURL(path.resolve(file)).href);
  return normalizeConfig(mod);
}

export function normalizeConfig(mod) {
  const brands = (mod.brands || []).map((b) => {
    if (!b.id || !b.name || !b.patterns?.length) throw new Error(`Brand needs id, name and patterns: ${JSON.stringify(b.id)}`);
    return {
      ...b,
      color: b.color || '#888888',
      mention: toGlobal(new RegExp(b.patterns.map((p) => `(?:${p.source})`).join('|'), 'i')),
      ignore: (b.ignore || []).map(toGlobal),
      excludeTitle: (b.excludeTitle || []).map(toSingle),
      officialDomains: b.officialDomains || [],
      aliases: (b.aliases || []).concat(b.name.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean),
    };
  });
  const brandIds = new Set(brands.map((b) => b.id));

  const seen = new Set();
  const sources = (mod.sources || []).filter((s) => s.enabled !== false).map((s) => {
    if (!s.id || !s.url || !s.name) throw new Error(`Source needs id, name and url: ${JSON.stringify(s)}`);
    if (seen.has(s.id)) throw new Error(`Duplicate source id: ${s.id}`);
    seen.add(s.id);
    if (!['official', 'outlet', 'aggregator'].includes(s.type)) throw new Error(`Source ${s.id}: type must be official, outlet or aggregator`);
    for (const b of s.brands || []) if (!brandIds.has(b)) throw new Error(`Source ${s.id}: unknown brand "${b}"`);
    return { brands: [], trustBrand: false, via: s.type === 'aggregator' ? 'Google News' : null, ...s };
  });

  const settings = mod.settings || {};
  return {
    brands,
    sources,
    excludeTitle: (mod.excludeTitle || []).map(toSingle),
    blockedPublishers: (mod.blockedPublishers || []).map((p) => p.toLowerCase()),
    wireServices: mod.wireServices || [],
    rumorRules: (mod.rumorRules || []).map((r) => ({ ...r, pattern: toSingle(r.pattern) })),
    settings: {
      fetchIntervalMinutes: 7,
      retentionDays: 14,
      clientPollSeconds: 120,
      fetchTimeoutMs: 15000,
      fetchConcurrency: 5,
      userAgent: 'Mozilla/5.0 (compatible; CarRadar/1.0; RSS reader)',
      dedupeWindowHours: 72,
      ...settings,
      ai: { model: 'claude-opus-5', effort: 'low', batchSize: 15, concurrency: 3, maxPerCycle: 150, ...(settings.ai || {}) },
    },
  };
}
