import crypto from 'node:crypto';
import { decodeHTML } from 'entities';

export const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function domainMatches(host, domains) {
  if (!host) return false;
  return domains.some((d) => host === d || host.endsWith('.' + d));
}

// Only http(s) URLs ever reach the browser.
export function safeUrl(url, base) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim(), base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

// Stable id for an article: the URL without tracking params, fragment or trailing slash.
export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|cmpid|ncid|guccounter)/i.test(key)) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    return u.href.replace(/\/$/, '');
  } catch {
    return url;
  }
}

// HTML → plain text: drop tags, decode entities, collapse whitespace.
export function htmlToText(html) {
  if (!html) return '';
  let s = String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  // Feeds often double-encode (&amp;#8217;), so decode twice.
  s = decodeHTML(decodeHTML(s));
  return s.replace(/\s+/g, ' ').trim();
}

export function truncate(s, max) {
  if (!s || s.length <= max) return s || '';
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:–—-]+$/, '') + '…';
}

// Runs fn over items with at most `limit` in flight. Never rejects; failed items resolve to undefined.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        console.error('[mapLimit]', err);
        results[i] = undefined;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};
