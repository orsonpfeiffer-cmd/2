import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';
import { createOverviewer, parseOverview } from '../server/overview.js';
import { normalizeItem } from '../server/feeds.js';
import { createApp } from '../server/app.js';
import { testConfig, quietLog } from './helpers.js';

const config = testConfig();
const LONG = 'The new Polestar 7 is a large electric SUV. '.repeat(30);

function seed(db, overrides = {}) {
  const now = Date.now();
  const row = {
    id: 'a1', url: 'https://electrek.co/polestar-7', title: 'Polestar 7 revealed', summary: 'Short summary.', content: LONG,
    image: null, source_id: 'electrek', publisher: 'Electrek', source_type: 'outlet', via: null, published_at: now - 60e3,
    inserted_at: now, brands: ['polestar'], label: 'CONFIRMED', label_reason: 'Confirmed: x', label_by: 'rules',
    hidden: 0, cluster_id: 'a1', is_primary: 1, title_key: 'k', ...overrides,
  };
  db.insert(row);
  return row;
}

const text = (t) => ({ type: 'text', text: t });
function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (params) => {
          calls.push(structuredClone(params));
          const r = responses[Math.min(calls.length - 1, responses.length - 1)];
          if (r instanceof Error) throw r;
          return { model: params.model, stop_reason: 'end_turn', ...r };
        },
      },
    },
  };
}

test('parseOverview: first line is the TL;DR, dashes are points, markdown stripped', () => {
  const r = parseOverview('**Polestar revealed the 7.**\n\n- 600-mile range\n• Launches 2027\n- Priced from $90,000');
  assert.deepEqual(r, { tldr: 'Polestar revealed the 7.', points: ['600-mile range', 'Launches 2027', 'Priced from $90,000'] });
  assert.throws(() => parseOverview('   '));
});

test('long feed text: summarized directly, no web tools, stored and reused', async () => {
  const db = openDb(':memory:');
  seed(db);
  const client = fakeClient([{ content: [text('Polestar showed its biggest SUV.\n- 600-mile range\n- Arrives in 2027')] }]);
  const ov = createOverviewer(config, db, { client, model: 'claude-opus-5', log: quietLog });

  const r = await ov.get('a1');
  assert.equal(r.status, 'ready');
  assert.equal(r.tldr, 'Polestar showed its biggest SUV.');
  assert.deepEqual(r.points, ['600-mile range', 'Arrives in 2027']);
  assert.equal(r.basis, 'feed');
  const p = client.calls[0];
  assert.equal(p.tools, undefined);
  assert.equal(p.output_config.effort, 'low');
  assert.equal(p.fallbacks, 'default');
  assert.match(p.messages[0].content, /Article text from the feed:\nThe new Polestar 7/);

  // Second request comes from the database, not Claude.
  const again = await ov.get('a1');
  assert.equal(again.tldr, r.tldr);
  assert.equal(client.calls.length, 1);
  assert.ok(JSON.parse(db.getArticle('a1').overview).tldr);
  db.close();
});

test('Google News item: web tools, pause_turn resumed, preamble text dropped', async () => {
  const db = openDb(':memory:');
  seed(db, { url: 'https://news.google.com/rss/articles/abc', summary: '', content: '' });
  const client = fakeClient([
    { stop_reason: 'pause_turn', content: [text("I'll search for this article."), { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }] },
    {
      content: [
        { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://electrek.co/x', title: 't' }] },
        text('Let me read it.'),
        { type: 'web_fetch_tool_result', tool_use_id: 'f1', content: { type: 'web_fetch_result', url: 'https://electrek.co/x' } },
        text('Polestar revealed the 7.\n- Big battery'),
      ],
    },
  ]);
  const ov = createOverviewer(config, db, { client, model: 'claude-opus-5', log: quietLog });
  const r = await ov.get('a1');

  assert.equal(r.status, 'ready');
  assert.equal(r.tldr, 'Polestar revealed the 7.');
  assert.deepEqual(r.points, ['Big battery']);
  assert.equal(r.basis, 'web');
  assert.equal(client.calls.length, 2, 'resumed after pause_turn');
  const first = client.calls[0];
  assert.deepEqual(first.tools.map((t) => t.type), ['web_search_20260209', 'web_fetch_20260209']);
  assert.match(first.messages[0].content, /Google News redirect/);
  assert.equal(client.calls[1].messages[1].role, 'assistant', 'paused turn sent back');
  db.close();
});

test('failed web reads are reported as a headline-only overview; older models get basic search', async () => {
  const db = openDb(':memory:');
  seed(db, { summary: '', content: '' });
  const client = fakeClient([{
    content: [
      { type: 'web_fetch_tool_result', tool_use_id: 'f1', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' } },
      text('Polestar has a new SUV, per the headline.'),
    ],
  }]);
  const ov = createOverviewer(config, db, { client, model: 'claude-haiku-4-5', log: quietLog });
  const r = await ov.get('a1');
  assert.equal(r.basis, 'headline');
  assert.deepEqual(client.calls[0].tools.map((t) => t.type), ['web_search_20250305']);
  assert.equal(client.calls[0].output_config, undefined);
  assert.equal(client.calls[0].fallbacks, undefined);
  db.close();
});

test('concurrent requests share one call; errors, refusals and the daily cap degrade gracefully', async () => {
  const db = openDb(':memory:');
  seed(db);
  seed(db, { id: 'a2', cluster_id: 'a2' });
  seed(db, { id: 'a3', cluster_id: 'a3' });
  seed(db, { id: 'gone', cluster_id: 'gone', hidden: 1 });

  const client = fakeClient([{ content: [text('One.\n- Two')] }, new Error('overloaded'), { stop_reason: 'refusal', content: [] }]);
  const ov = createOverviewer(testConfig([], { ai: { ...config.settings.ai, overviewsPerDay: 3 } }), db, { client, log: quietLog });

  const [x, y] = await Promise.all([ov.get('a1'), ov.get('a1')]);
  assert.equal(x.status, 'ready');
  assert.equal(y.tldr, x.tldr);
  assert.equal(client.calls.length, 1);

  assert.deepEqual(await ov.get('a2'), { status: 'unavailable', reason: 'error' });
  assert.deepEqual(await ov.get('a3'), { status: 'unavailable', reason: 'error' });
  assert.deepEqual(await ov.get('a2'), { status: 'unavailable', reason: 'limit' }, 'cap of 3 per day reached');
  assert.equal((await ov.get('a1')).status, 'ready', 'stored overviews still work after the cap');
  assert.deepEqual(await ov.get('gone'), { status: 'not_found' });
  assert.deepEqual(await ov.get('nope'), { status: 'not_found' });
  db.close();
});

test('no API key → no overviewer; the API says so', async () => {
  assert.equal(createOverviewer(config, openDb(':memory:'), { apiKey: '' }), null);
  const db = openDb(':memory:');
  seed(db);
  const server = createApp({ db, config, ai: null, overviewer: null }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/api/articles/a1/overview`)).json(), { status: 'unavailable', reason: 'no_key' });
    const story = await (await fetch(`${base}/api/articles/a1`)).json();
    assert.equal(story.title, 'Polestar 7 revealed');
    assert.equal((await fetch(`${base}/api/articles/nope`)).status, 404);
    assert.equal((await (await fetch(`${base}/api/config`)).json()).overviews, false);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test('feeds keep the full article text when the feed includes it', () => {
  const item = normalizeItem(
    {
      title: 'Polestar 7 revealed',
      link: 'https://electrek.co/p7',
      content: '<p>Short teaser.</p>',
      contentEncoded: `<p>${LONG}</p><p>The post Polestar 7 appeared first on Electrek.</p>`,
    },
    { name: 'Electrek', url: 'https://electrek.co/feed/' },
    'https://electrek.co/feed/',
  );
  assert.equal(item.summary, 'Short teaser.');
  assert.ok(item.content.startsWith('The new Polestar 7'));
  assert.ok(!item.content.includes('appeared first on'));
});

test('an existing database from before this feature is upgraded in place', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE articles (id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
    image TEXT, source_id TEXT NOT NULL, publisher TEXT NOT NULL, source_type TEXT NOT NULL, via TEXT, published_at INTEGER NOT NULL,
    inserted_at INTEGER NOT NULL, brands TEXT NOT NULL, label TEXT NOT NULL, label_reason TEXT NOT NULL, label_by TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0, hidden_reason TEXT, cluster_id TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 1,
    title_key TEXT NOT NULL DEFAULT '')`);
  old.exec(`INSERT INTO articles VALUES ('x','u','Old one','',NULL,'s','P','outlet',NULL,1,1,'["bmw"]','CONFIRMED','r','rules',0,NULL,'x',1,'')`);
  old.close();

  const db = openDb(file);
  const row = db.getArticle('x');
  assert.equal(row.content, '');
  assert.equal(row.overview, null);
  seed(db, { id: 'new', cluster_id: 'new' });
  assert.equal(db.getArticle('new').content, LONG);
  db.close();
});
