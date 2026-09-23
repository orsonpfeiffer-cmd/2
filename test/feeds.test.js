import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSource } from '../server/feeds.js';
import { startFeedServer, testConfig } from './helpers.js';

let srv;
const settings = testConfig().settings;
before(async () => {
  srv = await startFeedServer({
    '/electrek': 'electrek.xml',
    '/gn': 'google-news.xml',
    '/porsche': 'porsche-atom.xml',
    '/sloppy': 'sloppy.xml',
    '/html': (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><body>Hi</body></html>'),
    '/latin1': (req, res) => {
      const xml = '<?xml version="1.0" encoding="ISO-8859-1"?><rss version="2.0"><channel><item><title>Größte Überraschung: Audi &amp; Porsche</title><link>https://x.example/a</link></item></channel></rss>';
      res.writeHead(200, { 'content-type': 'application/xml' }).end(Buffer.from(xml, 'latin1'));
    },
    '/etag': (req, res) => {
      if (req.headers['if-none-match'] === '"v1"') return res.writeHead(304).end();
      res.writeHead(200, { etag: '"v1"', 'content-type': 'application/rss+xml' }).end('<rss version="2.0"><channel><item><title>Audi A5</title><link>https://x.example/a5</link></item></channel></rss>');
    },
  });
});
after(() => srv.close());

const get = (path, source = {}) => fetchSource({ id: 't', name: 'Test', url: srv.base + path, ...source }, null, settings);

test('WordPress feed: summary cleaned, biggest media:content image, tracking params kept out of text', async () => {
  const { items } = await get('/electrek');
  assert.equal(items.length, 4);
  const p7 = items[0];
  assert.equal(p7.title, 'Polestar 7 revealed with 600-mile range and 800V charging');
  assert.equal(p7.summary, 'Polestar has finally shown the Polestar 7, a large electric SUV with a claimed 600-mile range.');
  assert.equal(p7.image, `${srv.base}/img/polestar.svg`);
  assert.equal(p7.publisher, 'Test');
  assert.equal(p7.publisherHost, 'electrek.co');
  assert.ok(Math.abs(p7.publishedAt - (Date.now() - 25 * 60e3)) < 5000);
  // Double-encoded entities are decoded
  assert.match(items[2].summary, /Arctic Circle — here’s what we see\./);
});

test('Google News: publisher from <source>, suffix stripped, summary dropped', async () => {
  const { items } = await get('/gn');
  const z = items[0];
  assert.equal(z.title, 'Zeekr 7X launches in Europe with 800V charging');
  assert.equal(z.publisher, 'CarNewsChina');
  assert.equal(z.publisherHost, 'carnewschina.com');
  assert.equal(z.summary, '');
  assert.equal(z.image, null);
});

test('Atom feed: title entities, published/updated dates, media:thumbnail', async () => {
  const { items } = await get('/porsche');
  assert.equal(items[0].title, 'The new 911 Turbo S: 711 PS & a T-Hybrid');
  assert.equal(items[0].summary, 'Porsche presents the most powerful 911 Turbo S ever.');
  assert.match(items[0].image, /porsche\.svg$/);
  assert.equal(items[1].title, 'Taycan wins Golden Steering Wheel award');
  assert.equal(items[1].summary, 'Readers voted the Taycan the best electric car of the year — again.');
  assert.ok(items[1].publishedAt > Date.now() - 8 * 3600e3);
});

test('sloppy XML with HTML entities and bare & is repaired', async () => {
  const { items } = await get('/sloppy');
  assert.equal(items[0].title, 'Audi A6 e-tron Avant tested – the best Audi wagon yet? Q&A inside');
  assert.equal(items[0].summary, 'Range, charging & more: we test the Audi.');
});

test('declared ISO-8859-1 encoding is honored', async () => {
  const { items } = await get('/latin1');
  assert.equal(items[0].title, 'Größte Überraschung: Audi & Porsche');
});

test('HTML pages and HTTP errors throw clear errors', async () => {
  await assert.rejects(get('/html'), /web page, not an RSS feed/);
  await assert.rejects(get('/missing'), /HTTP 404/);
});

test('conditional GET: 304 returns no items', async () => {
  const first = await get('/etag');
  assert.equal(first.items.length, 1);
  assert.equal(first.etag, '"v1"');
  const second = await fetchSource({ id: 't', name: 'T', url: srv.base + '/etag' }, { etag: '"v1"' }, settings);
  assert.equal(second.notModified, true);
  assert.equal(second.items.length, 0);
});
