import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mainConfig from '../sources.config.js';
import { normalizeConfig } from '../server/config.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const UNIT = { m: 60e3, h: 3600e3, d: 864e5 };

// Replaces {{rfc:40m}} / {{iso:2h}} with dates that many minutes/hours/days ago, and {{BASE}} with the server URL.
export function renderFixture(name, base, now = Date.now()) {
  return fs
    .readFileSync(path.join(FIXTURES, name), 'utf8')
    .replace(/\{\{(rfc|iso):(\d+)([mhd])\}\}/g, (_, kind, n, u) => {
      const d = new Date(now - Number(n) * UNIT[u]);
      return kind === 'rfc' ? d.toUTCString() : d.toISOString();
    })
    .replaceAll('{{BASE}}', base);
}

// Local feed server. `routes` maps path → fixture file name, or a function (req, res).
export async function startFeedServer(routes) {
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const route = routes[req.url.split('?')[0]];
    if (typeof route === 'function') return route(req, res);
    if (typeof route === 'string') {
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      return res.end(renderFixture(route, base));
    }
    if (req.url.startsWith('/img/')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#345"/></svg>');
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

// The real config (brands, rules, settings) with test sources.
export function testConfig(sources = [], settings = {}) {
  return normalizeConfig({
    ...mainConfig,
    sources,
    settings: { ...mainConfig.settings, fetchTimeoutMs: 3000, ...settings },
  });
}

export const quietLog = { info() {}, warn() {}, error() {} };
