import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createPipeline } from '../server/pipeline.js';
import { createApp } from '../server/app.js';
import { startFeedServer, testConfig, quietLog } from './helpers.js';

let srv;
let sources;
before(async () => {
  srv = await startFeedServer({
    '/volvo': 'volvo-newsroom.xml',
    '/porsche': 'porsche-atom.xml',
    '/electrek': 'electrek.xml',
    '/autocar': 'autocar.xml',
    '/gn': 'google-news.xml',
    '/sloppy': 'sloppy.xml',
    '/broken': (req, res) => res.writeHead(500).end('boom'),
    '/html': (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>not a feed</body></html>'),
    '/garbage': (req, res) => res.writeHead(200, { 'content-type': 'application/xml' }).end('<<<not xml at all'),
    '/slow': () => {}, // never answers
  });
  const u = (p) => srv.base + p;
  sources = [
    { id: 'volvo-media', name: 'Volvo Cars Global Newsroom', type: 'official', brands: ['volvo'], trustBrand: true, url: u('/volvo') },
    { id: 'porsche-newsroom', name: 'Porsche Newsroom', type: 'official', brands: ['porsche'], trustBrand: true, url: u('/porsche') },
    { id: 'electrek', name: 'Electrek', type: 'outlet', url: u('/electrek') },
    { id: 'autocar', name: 'Autocar', type: 'outlet', url: u('/autocar') },
    { id: 'gn-zeekr', name: 'Google News: Zeekr', type: 'aggregator', brands: ['zeekr'], url: u('/gn') },
    { id: 'sloppy', name: 'Sloppy Motors', type: 'outlet', url: u('/sloppy') },
    { id: 'broken', name: 'Broken', type: 'outlet', url: u('/broken') },
    { id: 'html', name: 'HTML page', type: 'outlet', url: u('/html') },
    { id: 'garbage', name: 'Garbage', type: 'outlet', url: u('/garbage') },
    { id: 'slow', name: 'Slow', type: 'outlet', url: u('/slow') },
    { id: 'nohost', name: 'No such host', type: 'outlet', url: 'http://127.0.0.1:1/feed' },
  ];
});
after(() => srv.close());

async function withApi(db, config, fn) {
  const app = createApp({ db, config, ai: null, scheduler: null });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await fetch(base + p)).json();
  try {
    await fn(get);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('full cycle with keyword rules: matching, labels, clusters, failures, API', async () => {
  const config = testConfig(sources, { fetchTimeoutMs: 1500 });
  const db = openDb(':memory:');
  const pipeline = createPipeline({ db, config, log: quietLog });
  const stats = await pipeline.runCycle();

  assert.equal(stats.sourcesOk, 6);
  assert.equal(stats.sourcesFailed, 5);
  assert.equal(stats.added, 14);
  assert.equal(stats.rulesLabeled, 14);

  await withApi(db, config, async (get) => {
    const all = await get('/api/articles?limit=50');
    const titles = all.items.map((i) => i.title);
    assert.equal(all.items.length, 12, titles.join('\n'));

    // Sorted newest first
    const times = all.items.map((i) => i.publishedAt);
    assert.deepEqual(times, [...times].sort((a, b) => b - a));

    // False matches never made it in
    for (const bad of ['Tesla', 'Volvo Trucks', 'Porsche SE', 'Grand Prix', 'Pilates', 'MarketBeat', 'soaring', 'XC60']) {
      assert.ok(!titles.some((t) => t.includes(bad)), `should not contain "${bad}"`);
    }

    // Polestar 7: three reports merged into one story led by the earliest outlet article with an image
    const p7 = all.items.find((i) => i.title.startsWith('Polestar 7'));
    assert.equal(p7.publisher, 'Electrek');
    assert.equal(p7.via, null);
    // Autocar counts; Electrek's own article via Google News does not.
    assert.deepEqual(p7.related.map((r) => r.publisher), ['Autocar']);
    assert.match(p7.image, /polestar\.svg$/);

    const by = (start) => all.items.find((i) => i.title.startsWith(start));
    assert.equal(by('Volvo Cars reports').label, 'OFFICIAL');
    assert.equal(by('Volvo Cars reports').reason, 'Official: press release from Volvo Cars Global Newsroom');
    assert.equal(by('EX60 production').label, 'OFFICIAL');
    assert.deepEqual(by('EX60 production').brands, ['volvo']);
    assert.equal(by('The new 911 Turbo S').label, 'OFFICIAL');
    assert.equal(by('Zeekr announces Q3').label, 'OFFICIAL', 'official domain via Google News');
    assert.equal(by('Zeekr announces Q3').via, 'Google News');
    assert.equal(by('Spy shots').label, 'RUMOR');
    assert.equal(by('Spy shots').reason, 'Rumor: based on spy shots');
    assert.equal(by('Audi could revive').reason, 'Rumor: based on unnamed sources');
    assert.equal(by('Zeekr 9X patent').reason, 'Rumor: based on a patent filing');
    assert.equal(by('Mercedes-AMG GT 63').label, 'CONFIRMED');
    assert.equal(by('Zeekr 7X').publisher, 'CarNewsChina');

    // Filters
    const rumors = await get('/api/articles?label=RUMOR');
    assert.equal(rumors.items.length, 3);
    const zeekr = await get('/api/articles?brands=zeekr');
    assert.equal(zeekr.items.length, 3);
    const two = await get('/api/articles?brands=zeekr,porsche&label=OFFICIAL');
    assert.equal(two.items.length, 3);
    const search = await get('/api/articles?q=turbo');
    assert.equal(search.items.length, 1);
    const pct = await get('/api/articles?q=%25');
    assert.equal(pct.items.length, 0, 'LIKE wildcards are escaped');
    const recent = await get(`/api/articles?from=${Date.now() - 60 * 60e3}`);
    assert.ok(recent.items.every((i) => i.publishedAt >= Date.now() - 61 * 60e3));
    assert.ok(recent.items.length >= 4);

    // Pagination has no gaps or repeats
    const seen = [];
    let cursor = '';
    for (let n = 0; n < 5; n++) {
      const page = await get(`/api/articles?limit=5${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen, all.items.map((i) => i.id));

    // Newer-than count for the banner
    const top = all.items[0].publishedAt;
    assert.equal((await get(`/api/articles/newer?since=${top}`)).count, 0);
    assert.equal((await get(`/api/articles/newer?since=${top - 1}`)).count, 1);

    // Sources page
    const src = await get('/api/sources');
    const s = Object.fromEntries(src.sources.map((x) => [x.id, x]));
    assert.ok(s.electrek.lastSuccessAt && !s.electrek.lastError);
    assert.equal(s.electrek.itemCount, 4);
    assert.equal(s.electrek.newCount, 2);
    assert.match(s.broken.lastError, /HTTP 500/);
    assert.match(s.html.lastError, /web page/);
    assert.match(s.garbage.lastError, /parse/i);
    assert.match(s.slow.lastError, /Timed out/);
    assert.ok(s.nohost.lastError);
    assert.equal(src.counts.stories, 12);
    assert.equal(src.lastCycle.added, 14);
    assert.equal(src.ai.enabled, false);

    const cfg = await get('/api/config');
    assert.equal(cfg.brands.length, 7);
    assert.equal(cfg.ai.enabled, false);
  });

  // Second cycle: nothing new, nothing duplicated
  const again = await pipeline.runCycle();
  assert.equal(again.added, 0);
  assert.equal(db.counts().visible, 14);
  db.close();
});

test('AI labels, hides irrelevant stories, and a failed batch falls back to rules', async () => {
  const config = testConfig(sources.slice(0, 6), { ai: { ...testConfig().settings.ai, batchSize: 4, concurrency: 1 } });
  const db = openDb(':memory:');
  let calls = 0;
  const ai = {
    model: 'fake',
    async classifyBatch(items) {
      calls++;
      if (calls === 2) throw new Error('overloaded');
      return items.map(({ article }) => ({
        label: /spy/i.test(article.title) ? 'RUMOR' : 'CONFIRMED',
        reason: 'Confirmed: fake AI',
        brands: article.brands,
        relevant: !/Mercedes/.test(article.title),
      }));
    },
  };
  const pipeline = createPipeline({ db, config, ai, log: quietLog });
  const stats = await pipeline.runCycle();

  assert.equal(calls, 4); // 14 candidates in batches of 4
  assert.equal(stats.aiErrors.length, 1);
  assert.equal(stats.rulesLabeled, 4, 'the failed batch used keyword rules');
  assert.equal(stats.hidden, 1, 'the AMG review was marked irrelevant');
  const rows = db.raw.prepare('SELECT title, label_by, hidden FROM articles').all();
  assert.ok(rows.some((r) => r.label_by === 'ai'));
  assert.ok(rows.find((r) => r.title.startsWith('Mercedes-AMG')).hidden === 1);

  // Hidden articles are remembered, so they are not sent to the AI again
  calls = 0;
  await pipeline.runCycle();
  assert.equal(calls, 0);
  db.close();
});

test('retention deletes old articles and promotes a new primary when the old one expires', async () => {
  const config = testConfig([]);
  const db = openDb(':memory:');
  const now = Date.now();
  const base = { url: 'https://x', summary: '', image: null, source_id: 's', publisher: 'P', via: null, inserted_at: now,
    brands: ['bmw'], label: 'CONFIRMED', label_reason: 'r', label_by: 'rules', hidden: 0, cluster_id: 'old', title_key: 'k' };
  db.insert({ ...base, id: 'old', title: 'Old', source_type: 'official', published_at: now - 15 * 864e5, is_primary: 1 });
  db.insert({ ...base, id: 'new', title: 'New', source_type: 'outlet', published_at: now - 2 * 864e5, is_primary: 0 });

  const stats = await createPipeline({ db, config, log: quietLog }).runCycle();
  assert.equal(stats.removed, 1);
  const rows = db.raw.prepare('SELECT id, is_primary FROM articles').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ id: 'new', is_primary: 1 }]);
  db.close();
});

test('overlapping cycles share one run', async () => {
  const config = testConfig(sources.slice(0, 2));
  const db = openDb(':memory:');
  const pipeline = createPipeline({ db, config, log: quietLog });
  const [a, b] = await Promise.all([pipeline.runCycle(), pipeline.runCycle()]);
  assert.equal(a, b);
  db.close();
});
