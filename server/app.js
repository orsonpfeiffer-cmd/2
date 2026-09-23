import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { LABELS } from './classifier.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ db, config, ai, scheduler }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(compression());

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' https: http: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    next();
  });

  const brandIds = new Set(config.brands.map((b) => b.id));

  function parseFilters(query) {
    const brands = String(query.brands || '')
      .split(',')
      .map((b) => b.trim())
      .filter((b) => brandIds.has(b));
    const label = LABELS.includes(String(query.label || '').toUpperCase()) ? String(query.label).toUpperCase() : null;
    const from = Number(query.from) > 0 ? Number(query.from) : null;
    const q = String(query.q || '').trim().slice(0, 100) || null;
    return { brands, label, from, q };
  }

  function encodeCursor(row) {
    return Buffer.from(`${row.published_at}:${row.id}`).toString('base64url');
  }
  function decodeCursor(s) {
    if (!s) return null;
    const [t, id] = Buffer.from(String(s), 'base64url').toString().split(':');
    return Number(t) > 0 && id ? { t: Number(t), id } : null;
  }

  function toStories(rows) {
    const related = db.related(rows.map((r) => r.cluster_id));
    const byCluster = new Map();
    for (const r of related) {
      if (!byCluster.has(r.cluster_id)) byCluster.set(r.cluster_id, []);
      byCluster.get(r.cluster_id).push(r);
    }
    return rows.map((r) => {
      const members = byCluster.get(r.cluster_id) || [];
      const brands = new Set(JSON.parse(r.brands));
      for (const o of members) for (const b of JSON.parse(o.brands)) brands.add(b);
      // "Also reported by" lists other publishers once each (the same outlet via Google News doesn't count).
      const publishers = new Set([r.publisher.toLowerCase()]);
      const others = members.filter((o) => {
        const key = o.publisher.toLowerCase();
        if (publishers.has(key)) return false;
        publishers.add(key);
        return true;
      });
      return {
        id: r.id,
        title: r.title,
        url: r.url,
        image: r.image,
        summary: r.summary,
        publisher: r.publisher,
        via: r.via,
        sourceType: r.source_type,
        publishedAt: r.published_at,
        insertedAt: r.inserted_at,
        brands: config.brands.map((b) => b.id).filter((id) => brands.has(id)),
        label: r.label,
        reason: r.label_reason,
        labelBy: r.label_by,
        related: others.map((o) => ({
          id: o.id,
          title: o.title,
          url: o.url,
          publisher: o.publisher,
          via: o.via,
          publishedAt: o.published_at,
          label: o.label,
        })),
      };
    });
  }

  const api = express.Router();
  api.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  api.get('/config', (req, res) => {
    res.json({
      brands: config.brands.map((b) => ({ id: b.id, name: b.name, color: b.color })),
      labels: LABELS,
      clientPollSeconds: Number(process.env.CLIENT_POLL_SECONDS) || config.settings.clientPollSeconds,
      retentionDays: config.settings.retentionDays,
      ai: ai ? { enabled: true, model: ai.model } : { enabled: false },
    });
  });

  api.get('/articles', (req, res) => {
    const filters = parseFilters(req.query);
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 50);
    const rows = db.feed({ ...filters, cursor: decodeCursor(req.query.cursor), limit: limit + 1 });
    const page = rows.slice(0, limit);
    res.json({
      items: toStories(page),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
      serverTime: Date.now(),
    });
  });

  // Number of stories newer than the one at the top of the user's feed.
  api.get('/articles/newer', (req, res) => {
    const filters = parseFilters(req.query);
    const since = Number(req.query.since) || 0;
    res.json({ count: since > 0 ? db.countNewer(filters, since) : 0, serverTime: Date.now() });
  });

  api.get('/sources', (req, res) => {
    const status = new Map(db.allSources().map((s) => [s.id, s]));
    res.json({
      sources: config.sources.map((s) => {
        const st = status.get(s.id) || {};
        const failing = !!st.last_error && (!st.last_success_at || st.last_attempt_at > st.last_success_at);
        return {
          id: s.id,
          name: s.name,
          type: s.type,
          via: s.via,
          brands: s.brands,
          url: s.url,
          lastAttemptAt: st.last_attempt_at || null,
          lastSuccessAt: st.last_success_at || null,
          lastError: failing ? st.last_error : null,
          failures: st.failures || 0,
          itemCount: st.last_item_count ?? null,
          newCount: st.last_new_count ?? null,
        };
      }),
      lastCycle: db.getMeta('lastCycle'),
      nextCycleAt: scheduler?.nextRunAt() ?? null,
      running: scheduler?.isRunning() ?? false,
      intervalMinutes: scheduler?.intervalMinutes ?? null,
      ai: ai ? { enabled: true, model: ai.model } : { enabled: false },
      counts: db.counts(),
      serverTime: Date.now(),
    });
  });

  app.use('/api', api);
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use(
    express.static(PUBLIC_DIR, {
      setHeaders(res, file) {
        // HTML always revalidates so deploys show up; assets can be cached briefly.
        res.setHeader('Cache-Control', file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
      },
    }),
  );

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[http]', err);
    res.status(500).json({ error: 'Server error' });
  });
  return app;
}
