import { fetchSource } from './feeds.js';
import { matchBrands } from './matcher.js';
import { rulesLabel } from './classifier.js';
import { titleKey, sameStory, pickPrimary, makeStopwords } from './dedupe.js';
import { hash, canonicalUrl, mapLimit, chunk } from './util.js';

const DAY = 24 * 60 * 60 * 1000;

function describeError(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'Timed out';
  const cause = err?.cause;
  if (cause?.code) return `${err.message} (${cause.code})`;
  return err?.message || String(err);
}

/**
 * One refresh cycle: fetch every source, keep new articles about our brands,
 * label them (Claude, or keyword rules), group duplicates, delete old ones.
 * A failing source is recorded and skipped; it never stops the cycle.
 */
export function createPipeline({ db, config, ai = null, fetchImpl, now = () => Date.now(), log = console }) {
  const stop = makeStopwords(config);
  const s = config.settings;
  const windowMs = s.dedupeWindowHours * 60 * 60 * 1000;
  let running = null;

  function runCycle() {
    if (!running) {
      running = cycle().finally(() => {
        running = null;
      });
    }
    return running;
  }

  async function cycle() {
    const startedAt = now();
    const cutoff = startedAt - s.retentionDays * DAY;
    const stats = { startedAt, sourcesOk: 0, sourcesFailed: 0, candidates: 0, added: 0, hidden: 0, aiLabeled: 0, rulesLabeled: 0, aiErrors: [] };

    // 1) Fetch
    const results = await mapLimit(config.sources, s.fetchConcurrency, async (source) => {
      try {
        const r = await fetchSource(source, db.getSource(source.id), s, fetchImpl);
        return { source, ok: true, ...r };
      } catch (err) {
        const msg = describeError(err);
        db.sourceFail(source.id, now(), msg);
        log.warn?.(`[fetch] ${source.id}: ${msg}`);
        return { source, ok: false, items: [] };
      }
    });

    // 2) Filter to new, recent articles about our brands
    const seen = new Set();
    const fresh = [];
    for (const r of results) {
      if (!r?.ok) {
        stats.sourcesFailed++;
        continue;
      }
      stats.sourcesOk++;
      let newCount = 0;
      for (const item of r.items) {
        const id = hash(canonicalUrl(item.url));
        if (seen.has(id) || db.exists(id)) continue;
        seen.add(id);
        const publishedAt = Math.min(item.publishedAt ?? startedAt, startedAt);
        if (publishedAt < cutoff) continue;
        if (config.blockedPublishers.includes(item.publisher.toLowerCase())) continue;
        const article = { ...item, id, publishedAt };
        article.brands = matchBrands(article, r.source, config);
        if (!article.brands.length) continue;
        fresh.push({ article, source: r.source });
        newCount++;
      }
      db.sourceOk(r.source.id, {
        at: now(),
        itemCount: r.notModified ? null : r.items.length,
        newCount,
        etag: r.etag,
        lastModified: r.lastModified,
      });
    }
    stats.candidates = fresh.length;
    fresh.sort((a, b) => b.article.publishedAt - a.article.publishedAt);

    // Articles from the last few days, for duplicate detection.
    const oldest = fresh.length ? fresh[fresh.length - 1].article.publishedAt : startedAt;
    const recent = db.recentForDedupe(oldest - windowMs);

    const save = (entries) =>
      db.transaction(() => {
        for (const e of entries) insertOne(e, recent, stats);
      });

    // 3) Label. Claude handles the newest `maxPerCycle`; the rest (or all, without a key) use keyword rules.
    const aiItems = ai ? fresh.slice(0, s.ai.maxPerCycle) : [];
    const rulesItems = fresh.slice(aiItems.length);
    save(rulesItems.map((e) => ({ ...e, result: fromRules(e) })));

    await mapLimit(chunk(aiItems, s.ai.batchSize), s.ai.concurrency, async (batch) => {
      let res = [];
      try {
        res = await ai.classifyBatch(batch);
      } catch (err) {
        const msg = describeError(err);
        stats.aiErrors.push(msg);
        log.warn?.(`[ai] batch of ${batch.length} failed, using keyword rules: ${msg}`);
      }
      save(batch.map((e, i) => ({ ...e, result: res[i] ? { ...res[i], by: 'ai' } : fromRules(e) })));
    });

    // 4) Retention
    const removed = db.deleteOlderThan(cutoff);
    if (removed) {
      db.transaction(() => {
        for (const clusterId of db.orphanClusters()) {
          const p = pickPrimary(db.clusterMembers(clusterId));
          if (p) db.setPrimary(p.id, clusterId);
        }
      });
    }

    const summary = { ...stats, removed, finishedAt: now(), durationMs: now() - startedAt, aiErrors: stats.aiErrors.slice(0, 3) };
    db.setMeta('lastCycle', summary);
    log.info?.(
      `[cycle] ${summary.sourcesOk} ok, ${summary.sourcesFailed} failed, +${summary.added} new (${summary.aiLabeled} AI, ${summary.rulesLabeled} rules), ${summary.hidden} hidden, ${removed} expired, ${summary.durationMs} ms`,
    );
    return summary;
  }

  function fromRules({ article, source }) {
    return { ...rulesLabel(article, source, config), brands: article.brands, relevant: true, by: 'rules' };
  }

  function insertOne({ article, source, result }, recent, stats) {
    const brands = result.brands?.length ? result.brands : [];
    const hidden = !result.relevant || !brands.length;
    const key = titleKey(article.title, stop);

    let clusterId = article.id;
    if (!hidden) {
      const match = recent.find(
        (r) =>
          Math.abs(r.published_at - article.publishedAt) <= windowMs &&
          r.brands.some((b) => brands.includes(b)) &&
          sameStory(r.title_key, key),
      );
      if (match) clusterId = match.cluster_id;
    }

    db.insert({
      id: article.id,
      url: article.url,
      title: article.title,
      summary: article.summary || '',
      content: article.content || '',
      image: article.image,
      source_id: source.id,
      publisher: article.publisher,
      source_type: result.label === 'OFFICIAL' && source.type !== 'official' ? 'official' : source.type,
      via: source.via || null,
      published_at: article.publishedAt,
      inserted_at: now(),
      brands,
      label: result.label,
      label_reason: result.reason,
      label_by: result.by,
      hidden,
      hidden_reason: hidden ? (result.by === 'ai' ? 'AI: not about a tracked brand' : 'no brand') : null,
      cluster_id: clusterId,
      is_primary: clusterId === article.id,
      title_key: key,
    });

    if (hidden) {
      stats.hidden++;
      return;
    }
    stats.added++;
    if (result.by === 'ai') stats.aiLabeled++;
    else stats.rulesLabeled++;
    recent.push({ id: article.id, cluster_id: clusterId, title_key: key, brands, published_at: article.publishedAt });
    if (clusterId !== article.id) {
      const p = pickPrimary(db.clusterMembers(clusterId));
      if (p) db.setPrimary(p.id, clusterId);
    }
  }

  return { runCycle, isRunning: () => !!running };
}
