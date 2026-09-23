import Anthropic from '@anthropic-ai/sdk';
import { domainMatches } from './util.js';

export const LABELS = ['OFFICIAL', 'CONFIRMED', 'RUMOR'];
const PREFIX = { OFFICIAL: 'Official', CONFIRMED: 'Confirmed', RUMOR: 'Rumor' };

// True when the article comes from the automaker itself.
export function isOfficialPublisher(article, source, config) {
  if (source.type === 'official') return true;
  return config.brands.some((b) => article.brands.includes(b.id) && domainMatches(article.publisherHost, b.officialDomains));
}

const isWire = (article, config) => domainMatches(article.publisherHost, config.wireServices);

// ─── Keyword fallback ────────────────────────────────────────────────────────
export function rulesLabel(article, source, config) {
  if (isOfficialPublisher(article, source, config)) {
    return { label: 'OFFICIAL', reason: `Official: press release from ${article.publisher}` };
  }
  for (const text of [article.title, article.summary]) {
    if (!text) continue;
    for (const rule of config.rumorRules) {
      if (rule.pattern.test(text)) return { label: 'RUMOR', reason: `Rumor: ${rule.reason}` };
    }
  }
  return { label: 'CONFIRMED', reason: 'Confirmed: factual report, no speculative language' };
}

export function withPrefix(label, reason) {
  const body = String(reason || '')
    .replace(/^\s*(official|confirmed|rumou?r)\s*[:\-–—]\s*/i, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 140);
  return `${PREFIX[label]}: ${body || 'no reason given'}`;
}

// ─── Claude classifier ───────────────────────────────────────────────────────
function systemPrompt(config) {
  const names = config.brands.map((b) => b.name).join(', ');
  return `You label car news for a reader who follows these brands: ${names}. Each article comes with its headline, a short summary (sometimes empty), the publisher, and the brands that keyword matching found.

For every article return:

label, exactly one of:
- OFFICIAL: the publisher is the automaker itself (its newsroom or press site), or it is the automaker's own press release on a wire service (PR Newswire, Business Wire, GlobeNewswire). A news outlet reporting on an announcement is never OFFICIAL.
- RUMOR: the story rests on unverified information, such as spy shots, leaks, patent filings, unnamed sources or insiders, "reportedly", unofficial renderings, or speculation about what a brand could or might do.
- CONFIRMED: a news outlet reporting established facts, such as announced models, prices, specs, official statements, sales figures, recalls, reviews or first drives.

reason: one short sentence (under 12 words) that starts with "Official:", "Confirmed:" or "Rumor:" and says what the label rests on, for example "Rumor: based on spy shots of a camouflaged prototype".

brands: the candidate brands the article is really about. Leave out brands that are only mentioned in passing or as a comparison.

relevant: false when the article is not road-car news about any candidate brand. That covers motorsport results, sports events or venues named after a sponsor, trucks, buses or construction equipment from Volvo Group, Porsche SE holding-company or stock-market news, and articles where the brand only appears in passing. Otherwise true.`;
}

function outputSchema(brandIds) {
  return {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            i: { type: 'integer' },
            label: { type: 'string', enum: LABELS },
            reason: { type: 'string' },
            brands: { type: 'array', items: { type: 'string', enum: brandIds } },
            relevant: { type: 'boolean' },
          },
          required: ['i', 'label', 'reason', 'brands', 'relevant'],
          additionalProperties: false,
        },
      },
    },
    required: ['results'],
    additionalProperties: false,
  };
}

// Haiku 4.5 and older models reject `effort`; server-side fallbacks exist on Opus 5+ and Fable.
const supportsEffort = (model) => !/haiku|claude-3|sonnet-4-5|opus-4-5|opus-4-1/.test(model);
const supportsFallbacks = (model) => /^claude-(opus-5|fable-5|mythos-5)/.test(model);

/**
 * Returns null when no API key is configured, so callers fall back to keyword rules.
 * `client` can be injected for tests.
 */
export function createAiClassifier(config, { client, apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.CLAUDE_MODEL } = {}) {
  if (!client && !apiKey) return null;
  const ai = config.settings.ai;
  const useModel = model || ai.model;
  const api = client || new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  const brandIds = config.brands.map((b) => b.id);
  const schema = outputSchema(brandIds);
  const system = systemPrompt(config);

  /**
   * items: [{ article, source }] with article.brands set by keyword matching.
   * Resolves to one entry per item: { label, reason, brands, relevant } or null when
   * Claude gave no usable answer for that item. Throws if the whole call fails.
   */
  async function classifyBatch(items) {
    const payload = items.map(({ article, source }, i) => ({
      i,
      headline: article.title,
      summary: article.summary || '',
      publisher: article.publisherHost ? `${article.publisher} (${article.publisherHost})` : article.publisher,
      publisher_type: source.type === 'official' ? 'automaker newsroom' : source.type === 'aggregator' ? 'Google News result' : 'news outlet',
      candidate_brands: article.brands,
    }));

    const params = {
      model: useModel,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: `Label these ${items.length} articles.\n\n${JSON.stringify(payload, null, 1)}` }],
      output_config: { format: { type: 'json_schema', schema } },
    };
    if (supportsEffort(useModel)) params.output_config.effort = ai.effort;
    if (supportsFallbacks(useModel)) {
      // If a safety classifier declines, the API retries on Anthropic's recommended fallback model.
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }

    const res = await api.beta.messages.create(params);
    if (res.stop_reason === 'refusal') throw new Error(`Claude declined (${res.stop_details?.category || 'no category'})`);
    if (res.stop_reason === 'max_tokens') throw new Error('Claude response was cut off');
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const data = JSON.parse(text);

    const out = new Array(items.length).fill(null);
    for (const r of data.results || []) {
      if (!Number.isInteger(r.i) || r.i < 0 || r.i >= items.length || !LABELS.includes(r.label)) continue;
      const { article, source } = items[r.i];
      let label = r.label;
      let reason = r.reason;
      if (isOfficialPublisher(article, source, config)) {
        // The newsroom decides OFFICIAL, not the model.
        if (label !== 'OFFICIAL') reason = `press release from ${article.publisher}`;
        label = 'OFFICIAL';
      } else if (label === 'OFFICIAL' && !isWire(article, config)) {
        label = 'CONFIRMED';
        reason = `${article.publisher} reporting an official announcement`;
      }
      out[r.i] = {
        label,
        reason: withPrefix(label, reason),
        brands: (r.brands || []).filter((b) => article.brands.includes(b)),
        relevant: r.relevant !== false,
      };
    }
    return out;
  }

  return { model: useModel, classifyBatch };
}
