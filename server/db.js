import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS articles (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  image         TEXT,
  source_id     TEXT NOT NULL,
  publisher     TEXT NOT NULL,
  source_type   TEXT NOT NULL,          -- official | outlet | aggregator
  via           TEXT,
  published_at  INTEGER NOT NULL,       -- ms since epoch
  inserted_at   INTEGER NOT NULL,
  brands        TEXT NOT NULL,          -- JSON array of brand ids
  label         TEXT NOT NULL,          -- OFFICIAL | CONFIRMED | RUMOR
  label_reason  TEXT NOT NULL,
  label_by      TEXT NOT NULL,          -- ai | rules
  hidden        INTEGER NOT NULL DEFAULT 0,
  hidden_reason TEXT,
  cluster_id    TEXT NOT NULL,
  is_primary    INTEGER NOT NULL DEFAULT 1,
  title_key     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_feed ON articles(hidden, is_primary, published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_cluster ON articles(cluster_id);
CREATE INDEX IF NOT EXISTS idx_published ON articles(published_at);

CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error      TEXT,
  last_item_count INTEGER,
  last_new_count  INTEGER,
  etag            TEXT,
  last_modified   TEXT,
  failures        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export function openDb(file = process.env.DB_PATH || path.join(process.env.DATA_DIR || 'data', 'car-radar.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return wrap(db);
}

function buildWhere({ brands, label, from, q: search }) {
  const where = ['a.hidden = 0', 'a.is_primary = 1'];
  const params = [];
  if (from) {
    where.push('a.published_at >= ?');
    params.push(from);
  }
  if (label) {
    where.push('a.label = ?');
    params.push(label);
  }
  if (brands?.length) {
    // A story matches if any article in its cluster is tagged with one of the brands.
    where.push(`EXISTS (SELECT 1 FROM articles m, json_each(m.brands) j
      WHERE m.cluster_id = a.cluster_id AND m.hidden = 0 AND j.value IN (${brands.map(() => '?').join(',')}))`);
    params.push(...brands);
  }
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    where.push("(a.title LIKE ? ESCAPE '\\' OR a.summary LIKE ? ESCAPE '\\' OR a.publisher LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  return { where, params };
}

function wrap(db) {
  const q = {
    exists: db.prepare('SELECT 1 FROM articles WHERE id = ?'),
    insert: db.prepare(`INSERT OR IGNORE INTO articles
      (id, url, title, summary, image, source_id, publisher, source_type, via, published_at, inserted_at,
       brands, label, label_reason, label_by, hidden, hidden_reason, cluster_id, is_primary, title_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    recent: db.prepare(`SELECT id, cluster_id, title_key, brands, published_at FROM articles
      WHERE hidden = 0 AND published_at >= ?`),
    clusterMembers: db.prepare(`SELECT id, source_type, image, published_at FROM articles
      WHERE cluster_id = ? AND hidden = 0`),
    setPrimary: db.prepare('UPDATE articles SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE cluster_id = ?'),
    deleteOld: db.prepare('DELETE FROM articles WHERE published_at < ?'),
    orphanClusters: db.prepare(`SELECT DISTINCT cluster_id FROM articles a WHERE hidden = 0 AND NOT EXISTS
      (SELECT 1 FROM articles p WHERE p.cluster_id = a.cluster_id AND p.is_primary = 1 AND p.hidden = 0)`),
    getSource: db.prepare('SELECT * FROM sources WHERE id = ?'),
    allSources: db.prepare('SELECT * FROM sources'),
    sourceOk: db.prepare(`INSERT INTO sources (id, last_attempt_at, last_success_at, last_error, last_item_count, last_new_count, etag, last_modified, failures)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at,
        last_error = NULL, last_item_count = COALESCE(excluded.last_item_count, sources.last_item_count),
        last_new_count = excluded.last_new_count, etag = excluded.etag, last_modified = excluded.last_modified, failures = 0`),
    sourceFail: db.prepare(`INSERT INTO sources (id, last_attempt_at, last_error, failures) VALUES (?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
        failures = sources.failures + 1`),
    setNewCount: db.prepare('UPDATE sources SET last_new_count = ? WHERE id = ?'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    counts: db.prepare(`SELECT
      SUM(hidden = 0 AND is_primary = 1) AS stories, SUM(hidden = 0) AS visible, COUNT(*) AS total,
      SUM(hidden = 0 AND label_by = 'ai') AS by_ai, SUM(hidden = 0 AND label_by = 'rules') AS by_rules FROM articles`),
  };

  const api = {
    raw: db,
    exists: (id) => !!q.exists.get(id),
    insert(a) {
      q.insert.run(a.id, a.url, a.title, a.summary, a.image, a.source_id, a.publisher, a.source_type, a.via,
        a.published_at, a.inserted_at, JSON.stringify(a.brands), a.label, a.label_reason, a.label_by,
        a.hidden ? 1 : 0, a.hidden_reason || null, a.cluster_id, a.is_primary ? 1 : 0, a.title_key || '');
    },
    recentForDedupe: (since) => q.recent.all(since).map((r) => ({ ...r, brands: JSON.parse(r.brands) })),
    clusterMembers: (clusterId) => q.clusterMembers.all(clusterId),
    setPrimary: (id, clusterId) => q.setPrimary.run(id, clusterId),
    deleteOlderThan: (ts) => Number(q.deleteOld.run(ts).changes),
    orphanClusters: () => q.orphanClusters.all().map((r) => r.cluster_id),
    getSource: (id) => q.getSource.get(id),
    allSources: () => q.allSources.all(),
    sourceOk: (id, { at, itemCount, newCount, etag, lastModified }) =>
      q.sourceOk.run(id, at, at, itemCount ?? null, newCount ?? 0, etag || null, lastModified || null),
    sourceFail: (id, at, error) => q.sourceFail.run(id, at, String(error).slice(0, 300)),
    setNewCount: (id, n) => q.setNewCount.run(n, id),
    getMeta: (key) => {
      const row = q.getMeta.get(key);
      return row ? JSON.parse(row.value) : null;
    },
    setMeta: (key, value) => q.setMeta.run(key, JSON.stringify(value)),
    counts: () => q.counts.get(),
    transaction(fn) {
      db.exec('BEGIN');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    // Feed query: one row per story (cluster primary), newest first, keyset-paginated.
    feed(filters) {
      const { where, params } = buildWhere(filters);
      if (filters.cursor) {
        where.push('(a.published_at < ? OR (a.published_at = ? AND a.id < ?))');
        params.push(filters.cursor.t, filters.cursor.t, filters.cursor.id);
      }
      return db
        .prepare(`SELECT a.* FROM articles a WHERE ${where.join(' AND ')} ORDER BY a.published_at DESC, a.id DESC LIMIT ?`)
        .all(...params, filters.limit || 25);
    },

    // How many stories match the filters and were published after `newerThan`.
    countNewer(filters, newerThan) {
      const { where, params } = buildWhere(filters);
      where.push('a.published_at > ?');
      params.push(newerThan);
      return db.prepare(`SELECT COUNT(*) AS n FROM articles a WHERE ${where.join(' AND ')}`).get(...params).n;
    },

    related(clusterIds) {
      if (!clusterIds.length) return [];
      return db
        .prepare(`SELECT id, cluster_id, url, title, publisher, via, published_at, label, brands FROM articles
          WHERE hidden = 0 AND is_primary = 0 AND cluster_id IN (${clusterIds.map(() => '?').join(',')})
          ORDER BY published_at ASC`)
        .all(...clusterIds);
    },

    close: () => db.close(),
  };
  return api;
}
