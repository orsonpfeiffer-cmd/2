import Anthropic from '@anthropic-ai/sdk';
import { hostOf } from './util.js';

// Below this much feed text, Claude reads the article on the web instead.
const MIN_TEXT = 700;
const MAX_CONTINUATIONS = 3;

const SYSTEM = `You write quick overviews of car news for someone reading on their phone. Base every statement on the article text given to you or on pages you read with your tools, never on memory. If you couldn't get the article, summarize only what the headline and feed text say.

Format: the first line is one plain sentence that sums up the story. Then 2 to 5 lines that each start with "- " and give the key facts, such as models, prices, specs, dates, markets, and what is confirmed versus speculation. Keep each line under 25 words. No headings, no intro, no links, and no markdown besides the dashes.`;

// Web tool versions with dynamic filtering exist on newer models only.
const modernTools = (model) => /claude-(opus-(4-6|4-7|4-8|5)|sonnet-(4-6|5)|fable|mythos)/.test(model);
const supportsEffort = (model) => !/haiku|claude-3|sonnet-4-5|opus-4-5|opus-4-1/.test(model);
const supportsFallbacks = (model) => /^claude-(opus-5|fable-5|mythos-5)/.test(model);

function webTools(model) {
  return modernTools(model)
    ? [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 1 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 2, max_content_tokens: 8000 },
      ]
    : [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }];
}

// First plain line → tldr, "- " lines → points.
export function parseOverview(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.replace(/\*\*|__|^#+\s*/g, '').trim())
    .filter(Boolean);
  let tldr = '';
  const points = [];
  for (const line of lines) {
    const bullet = /^[-•*–]\s+(.+)$/.exec(line);
    if (bullet) points.push(bullet[1].trim());
    else if (!tldr) tldr = line;
  }
  if (!tldr && points.length) tldr = points.shift();
  if (!tldr) throw new Error('Claude returned an empty overview');
  return { tldr: tldr.slice(0, 400), points: points.slice(0, 6).map((p) => p.slice(0, 300)) };
}

const isToolResult = (b) => typeof b?.type === 'string' && b.type.endsWith('_tool_result');
const isToolError = (b) => {
  const c = b.content;
  if (!c || Array.isArray(c)) return false; // search results are an array on success
  return typeof c.type === 'string' && c.type.endsWith('_error');
};

/**
 * Makes one AI overview per article, on demand, and stores it.
 * Returns null without an API key. `client` can be injected for tests.
 */
export function createOverviewer(config, db, { client, apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.CLAUDE_MODEL, log = console, now = () => Date.now() } = {}) {
  if (!client && !apiKey) return null;
  const api = client || new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  const useModel = model || config.settings.ai.model;
  const perDay = config.settings.ai.overviewsPerDay ?? 100;
  const inflight = new Map();

  function takeQuota() {
    const day = new Date(now()).toISOString().slice(0, 10);
    const q = db.getMeta('overviewQuota');
    const count = q?.day === day ? q.count : 0;
    if (count >= perDay) return false;
    db.setMeta('overviewQuota', { day, count: count + 1 });
    return true;
  }

  async function generate(row) {
    const others = db.related([row.cluster_id]).filter((r) => r.id !== row.id).slice(0, 5);
    const text = (row.content || row.summary || '').trim();
    const useWeb = text.length < MIN_TEXT;
    const googleLink = hostOf(row.url) === 'news.google.com';

    const lines = [
      `Headline: ${row.title}`,
      `Publisher: ${row.publisher}`,
      `Published: ${new Date(row.published_at).toUTCString()}`,
      `URL: ${row.url}`,
    ];
    if (others.length) lines.push(`Other outlets on the same story: ${others.map((o) => `${o.publisher}: "${o.title}"`).join('; ')}`);
    if (text) lines.push('', 'Article text from the feed:', text);
    lines.push(
      '',
      !useWeb
        ? 'Write the overview from the article text above.'
        : googleLink
          ? "The feed gave little text and the URL is a Google News redirect that can't be fetched. Search the web for this headline from this publisher, read the article, and write the overview from it."
          : 'The feed gave little text. Fetch the URL to read the full article (search for the headline if that fails), then write the overview from it.',
    );

    const params = {
      model: useModel,
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: 'user', content: lines.join('\n') }],
    };
    if (useWeb) params.tools = webTools(useModel);
    if (supportsEffort(useModel)) params.output_config = { effort: config.settings.ai.effort };
    if (supportsFallbacks(useModel)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }

    // Server-side web tools can pause a long turn; send it back to let it finish.
    const blocks = [];
    let res;
    for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
      res = await api.beta.messages.create(params);
      blocks.push(...res.content);
      if (res.stop_reason !== 'pause_turn') break;
      params.messages = [...params.messages, { role: 'assistant', content: res.content }];
    }
    if (res.stop_reason === 'refusal') throw new Error(`Claude declined (${res.stop_details?.category || 'no category'})`);
    if (res.stop_reason === 'pause_turn') throw new Error('Claude did not finish reading the article');

    // Only the text after the last tool result is the answer (earlier text is "let me search...").
    let lastTool = -1;
    blocks.forEach((b, i) => isToolResult(b) && (lastTool = i));
    const answer = blocks.slice(lastTool + 1).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const overview = parseOverview(answer);

    const readWeb = blocks.some((b) => isToolResult(b) && !isToolError(b));
    return {
      ...overview,
      basis: !useWeb ? 'feed' : readWeb ? 'web' : 'headline',
      model: res.model || useModel,
      createdAt: now(),
    };
  }

  /** Resolves to { status: 'ready', ...overview } or { status: 'unavailable' | 'not_found', reason }. */
  function get(id) {
    const row = db.getArticle(id);
    if (!row || row.hidden) return Promise.resolve({ status: 'not_found' });
    if (row.overview) return Promise.resolve({ status: 'ready', ...JSON.parse(row.overview) });
    if (inflight.has(id)) return inflight.get(id);
    if (!takeQuota()) return Promise.resolve({ status: 'unavailable', reason: 'limit' });

    const job = generate(row)
      .then((overview) => {
        db.setOverview(id, overview);
        return { status: 'ready', ...overview };
      })
      .catch((err) => {
        log.warn?.(`[overview] ${id}: ${err.message}`);
        return { status: 'unavailable', reason: 'error' };
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, job);
    return job;
  }

  return { model: useModel, get };
}
