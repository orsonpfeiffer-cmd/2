import Parser from 'rss-parser';
import { decodeHTML } from 'entities';
import { htmlToText, truncate, safeUrl, hostOf } from './util.js';

const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
      ['media:group', 'mediaGroup'],
      ['source', 'gnSource', { keepArray: true }], // keepArray preserves the url attribute
      ['content:encoded', 'contentEncoded'],
    ],
  },
});

const MAX_BYTES = 8 * 1024 * 1024;

// Downloads and parses one source. Throws on any failure; the caller records it.
export async function fetchSource(source, prev, settings, fetchImpl = globalThis.fetch) {
  const headers = {
    'user-agent': settings.userAgent,
    accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
  };
  if (prev?.etag) headers['if-none-match'] = prev.etag;
  if (prev?.last_modified) headers['if-modified-since'] = prev.last_modified;

  const res = await fetchImpl(source.url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(settings.fetchTimeoutMs),
  });
  if (res.status === 304) return { notModified: true, items: [], etag: prev?.etag, lastModified: prev?.last_modified };
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('Feed too large');

  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error('Feed too large');
  const text = decodeBody(buf, res.headers.get('content-type'));
  if (/^\s*(<!doctype html|<html)/i.test(text)) throw new Error('Got a web page, not an RSS feed');

  const feed = await parseFeed(text);
  const items = (feed.items || []).map((raw) => normalizeItem(raw, source, res.url || source.url)).filter(Boolean);
  return { notModified: false, items, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
}

function decodeBody(buf, contentType) {
  const bytes = new Uint8Array(buf);
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 200));
  const charset =
    /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1] || /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1] || 'utf-8';
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export async function parseFeed(text) {
  try {
    return await parser.parseString(text);
  } catch (err) {
    // Many feeds use HTML entities (&nbsp;) or bare "&", which strict XML rejects. Repair and retry once.
    try {
      return await parser.parseString(repairXml(text));
    } catch {
      throw new Error(`Could not parse feed: ${String(err.message || err).split('\n')[0]}`);
    }
  }
}

const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
function repairXml(text) {
  return text
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => {
      if (XML_ENTITIES.has(name)) return m;
      const decoded = decodeHTML(m);
      return decoded !== m ? [...decoded].map((c) => `&#${c.codePointAt(0)};`).join('') : `&amp;${name};`;
    })
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
}

const BOILERPLATE = [
  /The post .{1,300}? appeared first on .{1,100}?\.?$/i,
  /\s*(Continue reading|Read more|Read the full story)[\s\S]{0,80}$/i,
  /\s*\[(…|\.\.\.|&#8230;)\]\s*$/,
];

function cleanText(html) {
  let text = htmlToText(html);
  for (const re of BOILERPLATE) text = text.replace(re, '').trim();
  return text;
}

export function normalizeItem(raw, source, feedUrl) {
  const gn = Array.isArray(raw.gnSource) ? raw.gnSource[0] : raw.gnSource;
  const gnName = typeof gn === 'string' ? gn : gn?._;
  const gnUrl = gn?.$?.url;
  let title = htmlToText(raw.title);
  const link = safeUrl(raw.link, feedUrl) || (typeof raw.guid === 'string' ? safeUrl(raw.guid) : null) || safeUrl(raw.id);
  if (!title || !link) return null;
  const isGoogleNews = hostOf(source.url) === 'news.google.com' || hostOf(link) === 'news.google.com';

  const publisher = (gnName && gnName.trim()) || source.name;
  if (gnName && title.endsWith(` - ${gnName}`)) title = title.slice(0, -(gnName.length + 3)).trim();

  let summary = '';
  let content = '';
  if (!isGoogleNews) {
    // Google News descriptions are just the headline plus links, so skip them.
    summary = cleanText(raw.summary || raw.content || raw.contentEncoded || '');
    if (summary.toLowerCase().startsWith(title.toLowerCase()) && summary.length < title.length + 40) summary = '';
    // Many feeds (WordPress, Atom) include the whole article. Keep it for the AI overview.
    const full = cleanText(raw.contentEncoded || raw.content || '');
    if (full.length > summary.length + 200) content = truncate(full, 8000);
    summary = truncate(summary, 400);
  }

  const date = new Date(raw.isoDate || raw.pubDate || raw.date || '');
  return {
    title: truncate(title, 300),
    url: link,
    summary,
    content,
    image: pickImage(raw, link),
    publisher,
    publisherHost: hostOf(gnUrl || (isGoogleNews ? '' : link)),
    publishedAt: Number.isNaN(date.getTime()) ? null : date.getTime(),
  };
}

const JUNK_IMAGE = /feedburner|feeds\.feedblitz|pixel|1x1|spacer|gravatar|s\.w\.org\/images\/core\/emoji|\/emoji\/|doubleclick|\.ico(\?|$)/i;

function pickImage(raw, base) {
  const candidates = [];
  const push = (url, width = 0) => {
    const safe = safeUrl(url, base);
    if (!safe || JUNK_IMAGE.test(safe)) return;
    // Upgrade to https so images load on an https page (loopback stays as-is for local testing).
    const upgraded = /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(safe) ? safe : safe.replace(/^http:/, 'https:');
    candidates.push({ url: upgraded, width: Number(width) || 0 });
  };
  const media = [
    ...(raw.mediaContent || []),
    ...(raw.mediaGroup?.['media:content'] || []),
  ];
  for (const m of media) {
    const a = m?.$ || {};
    if (!a.url) continue;
    const isImage = a.medium === 'image' || (a.type || '').startsWith('image') || (!a.medium && !a.type && /\.(jpe?g|png|webp|avif)(\?|$)/i.test(a.url));
    if (isImage) push(a.url, a.width);
  }
  if (candidates.length) return candidates.sort((x, y) => y.width - x.width)[0].url;

  for (const t of [...(raw.mediaThumbnail || []), ...(raw.mediaGroup?.['media:thumbnail'] || [])]) push(t?.$?.url, t?.$?.width);
  const enc = raw.enclosure;
  if (enc?.url && ((enc.type || '').startsWith('image') || /\.(jpe?g|png|webp|avif)(\?|$)/i.test(enc.url))) push(enc.url);
  if (candidates.length) return candidates.sort((x, y) => y.width - x.width)[0].url;

  for (const html of [raw.contentEncoded, raw.content, raw.summary]) {
    if (!html) continue;
    const re = /<img[^>]+?(?:data-src|src)=["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(html))) {
      push(decodeHTML(m[1]));
      if (candidates.length) return candidates[0].url;
    }
  }
  return null;
}
