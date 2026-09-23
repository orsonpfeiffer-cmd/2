import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulesLabel, createAiClassifier, withPrefix } from '../server/classifier.js';
import { testConfig } from './helpers.js';

const config = testConfig();
const outlet = { id: 'o', type: 'outlet' };
const art = (title, summary = '', extra = {}) => ({ title, summary, publisher: 'Autocar', publisherHost: 'autocar.co.uk', brands: ['audi'], ...extra });

test('official newsroom → OFFICIAL', () => {
  const r = rulesLabel(art('Audi Q3 launched'), { id: 'a', type: 'official' }, config);
  assert.equal(r.label, 'OFFICIAL');
  assert.match(r.reason, /^Official: press release from Autocar/);
});

test('Google News item from an official domain → OFFICIAL', () => {
  const a = art('Zeekr announces Q3 deliveries', '', { brands: ['zeekr'], publisher: 'Zeekr Newsroom', publisherHost: 'zeekrgroup.com' });
  assert.equal(rulesLabel(a, { id: 'gn', type: 'aggregator' }, config).label, 'OFFICIAL');
});

test('rumor keywords → RUMOR with a specific reason', () => {
  const cases = [
    ['Spy shots: next BMW iX5 caught testing', 'Rumor: based on spy shots'],
    ['BMW M3 spied at the Nürburgring', 'Rumor: based on spy shots'],
    ['Leaked images show the Audi A8', 'Rumor: based on leaked information'],
    ['Porsche patent hints at a rotary engine', 'Rumor: based on a patent filing'],
    ['Audi R8 EV rumoured for 2028', 'Rumor: unconfirmed rumor'],
    ['Audi reportedly planning a new R8', 'Rumor: based on unnamed sources'],
    ['Audi could revive the R8', 'Rumor: speculative language ("could" / "might")'],
  ];
  for (const [title, reason] of cases) {
    const r = rulesLabel(art(title), outlet, config);
    assert.equal(r.label, 'RUMOR', title);
    assert.equal(r.reason, reason, title);
  }
});

test('headline keywords win over summary keywords', () => {
  const r = rulesLabel(art('Audi A6 leaked', 'Sources say it could arrive soon'), outlet, config);
  assert.equal(r.reason, 'Rumor: based on leaked information');
});

test('plain facts from an outlet → CONFIRMED', () => {
  const r = rulesLabel(art('Audi Q6 e-tron priced from £60,000'), outlet, config);
  assert.equal(r.label, 'CONFIRMED');
  assert.equal(r.reason, 'Confirmed: factual report, no speculative language');
});

test('withPrefix normalizes the reason prefix', () => {
  assert.equal(withPrefix('RUMOR', 'rumour - based on spy shots'), 'Rumor: based on spy shots');
  assert.equal(withPrefix('CONFIRMED', 'Official: price list'), 'Confirmed: price list');
});

test('no API key → no AI classifier', () => {
  assert.equal(createAiClassifier(config, { apiKey: '' }), null);
});

function fakeClient(respond) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (params) => (calls.push(params), respond(params)) } },
  };
}
const textResponse = (obj) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });

test('AI results are validated, clamped to candidates and OFFICIAL is guarded', async () => {
  const client = fakeClient(() =>
    textResponse({
      results: [
        { i: 0, label: 'RUMOR', reason: 'based on spy shots', brands: ['bmw', 'audi'], relevant: true },
        { i: 1, label: 'OFFICIAL', reason: 'Official: Audi announced it', brands: ['audi'], relevant: true },
        { i: 2, label: 'CONFIRMED', reason: 'Confirmed: sales data', brands: ['volvo'], relevant: true },
        { i: 3, label: 'CONFIRMED', reason: 'Confirmed: race result', brands: [], relevant: false },
        { i: 9, label: 'RUMOR', reason: 'out of range', brands: [], relevant: true },
      ],
    }),
  );
  const ai = createAiClassifier(config, { client, model: 'claude-opus-5' });
  const items = [
    { article: art('BMW iX5 spied', '', { brands: ['bmw'] }), source: outlet },
    { article: art('Audi announces new A4'), source: outlet },
    { article: art('Record month', '', { brands: ['volvo'], publisher: 'Volvo Cars Global Newsroom' }), source: { id: 'v', type: 'official' } },
    { article: art('Audi F1 wins'), source: outlet },
  ];
  const out = await ai.classifyBatch(items);

  assert.deepEqual(out[0], { label: 'RUMOR', reason: 'Rumor: based on spy shots', brands: ['bmw'], relevant: true });
  assert.equal(out[1].label, 'CONFIRMED', 'an outlet can never be OFFICIAL');
  assert.equal(out[1].reason, 'Confirmed: Autocar reporting an official announcement');
  assert.equal(out[2].label, 'OFFICIAL', 'a newsroom is always OFFICIAL');
  assert.equal(out[2].reason, 'Official: press release from Volvo Cars Global Newsroom');
  assert.equal(out[3].relevant, false);

  const params = client.calls[0];
  assert.equal(params.model, 'claude-opus-5');
  assert.equal(params.output_config.format.type, 'json_schema');
  assert.equal(params.output_config.effort, 'low');
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.match(params.messages[0].content, /BMW iX5 spied/);
});

test('Haiku gets no effort or fallbacks params', async () => {
  const client = fakeClient(() => textResponse({ results: [] }));
  const ai = createAiClassifier(config, { client, model: 'claude-haiku-4-5' });
  const out = await ai.classifyBatch([{ article: art('Audi A4'), source: outlet }]);
  assert.deepEqual(out, [null]);
  assert.equal(client.calls[0].output_config.effort, undefined);
  assert.equal(client.calls[0].fallbacks, undefined);
});

test('refusals and truncation throw so the caller falls back to rules', async () => {
  for (const stop of ['refusal', 'max_tokens']) {
    const ai = createAiClassifier(config, { client: fakeClient(() => ({ stop_reason: stop, content: [] })) });
    await assert.rejects(ai.classifyBatch([{ article: art('Audi A4'), source: outlet }]));
  }
});
