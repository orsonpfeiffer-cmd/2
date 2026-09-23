import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleKey, sameStory, pickPrimary, makeStopwords } from '../server/dedupe.js';
import { testConfig } from './helpers.js';

const stop = makeStopwords(testConfig());
const same = (a, b) => sameStory(titleKey(a, stop), titleKey(b, stop));

test('same story from different outlets is merged', () => {
  assert.ok(same('Polestar 7 revealed with 600-mile range', 'New Polestar 7 SUV debuts with 600 miles of range'));
  assert.ok(same('Polestar 7 revealed with 600-mile range and 800V charging', 'Polestar 7 revealed with 600-mile range and 800V charging'));
  assert.ok(same('Volvo EX60 priced from $52,900 in the US', 'Volvo EX60 US pricing: $52,900 to start'));
});

test('different stories about the same model stay apart', () => {
  assert.ok(!same('New BMW M3 CS revealed', 'BMW M3 CS Touring spied testing'));
  assert.ok(!same('Porsche 911 Turbo S review', 'Porsche 911 GT3 RS recall announced'));
  assert.ok(!same('Zeekr 7X launches in Europe', 'Zeekr 001 facelift launches in China'));
});

test('primary: newsroom beats outlet beats Google News, then image, then earliest', () => {
  const a = { id: 'a', source_type: 'aggregator', image: null, published_at: 1 };
  const b = { id: 'b', source_type: 'outlet', image: null, published_at: 3 };
  const c = { id: 'c', source_type: 'outlet', image: 'x', published_at: 5 };
  const d = { id: 'd', source_type: 'official', image: null, published_at: 9 };
  assert.equal(pickPrimary([a, b]).id, 'b');
  assert.equal(pickPrimary([a, b, c]).id, 'c');
  assert.equal(pickPrimary([a, b, c, d]).id, 'd');
});
