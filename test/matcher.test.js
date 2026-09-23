import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchBrands } from '../server/matcher.js';
import { testConfig } from './helpers.js';

const config = testConfig();
const outlet = { id: 'o', type: 'outlet', brands: [] };
const m = (title, summary = '', source = outlet) => matchBrands({ title, summary }, source, config);

test('brand in the headline counts', () => {
  assert.deepEqual(m('Polestar 7 revealed'), ['polestar']);
  assert.deepEqual(m('BMW and Mercedes-Benz team up on charging'), ['bmw', 'mercedes']);
  assert.deepEqual(m('Mercedes-AMG GT 63 review'), ['mercedes']);
});

test('a single passing mention in the summary does not count', () => {
  assert.deepEqual(m('Tesla Model Y gets a new trim', 'The Polestar 4 remains a rival.'), []);
});

test('two summary mentions count', () => {
  assert.deepEqual(m('Swedish EV maker cuts prices', 'Polestar cut prices today. Polestar says demand is strong.'), ['polestar']);
});

test('Volvo Trucks, Volvo Group and buses are not Volvo Cars', () => {
  assert.deepEqual(m('Volvo Trucks unveils new electric FH Aero'), []);
  assert.deepEqual(m('AB Volvo profit rises'), []);
  assert.deepEqual(m('Volvo Group to cut 800 jobs'), []);
  assert.deepEqual(m('Volvo unveils new electric bus for Europe'), []);
  assert.deepEqual(m('Volvo EX30 gets a price cut'), ['volvo']);
  assert.deepEqual(m('Volvo Cars and Volvo Trucks share a charging network'), ['volvo']);
});

test('Porsche SE holding company news is excluded, Porsche cars are not', () => {
  assert.deepEqual(m('Porsche SE shares fall after VW writedown'), []);
  assert.deepEqual(m('Porsche Automobil Holding cuts forecast'), []);
  assert.deepEqual(m('Porsche 911 Turbo S revealed'), ['porsche']);
});

test('sports sponsorships and F1 are excluded', () => {
  assert.deepEqual(m('Rory McIlroy wins the BMW PGA Championship'), []);
  assert.deepEqual(m('Falcons fans pack Mercedes-Benz Stadium'), []);
  assert.deepEqual(m('Russell takes pole for Mercedes at the Singapore Grand Prix'), []);
  assert.deepEqual(m('Audi F1 team confirms 2027 driver line-up'), []);
  assert.deepEqual(m('Polestar Pilates opens a new studio'), []);
});

test('BMW motorcycles and MINI-only news are excluded', () => {
  assert.deepEqual(m('BMW R 1300 GS motorcycle review'), []);
  const bmwGroup = { id: 'bmw-pressclub', type: 'official', brands: ['bmw'] };
  assert.deepEqual(m('The new MINI Cooper Convertible', 'A BMW Group brand.', bmwGroup), []);
  assert.deepEqual(m('BMW and MINI announce new plant', '', bmwGroup), ['bmw']);
});

test('brand-dedicated sources need one mention; trusted ones need none', () => {
  const pressclub = { id: 'p', type: 'official', brands: ['bmw'] };
  assert.deepEqual(m('New iX3 production begins', 'BMW starts series production in Debrecen.', pressclub), ['bmw']);
  assert.deepEqual(m('New iX3 production begins', 'Series production starts in Debrecen.', pressclub), []);
  const volvo = { id: 'v', type: 'official', brands: ['volvo'], trustBrand: true };
  assert.deepEqual(m('EX60 production to start at Torslanda', '', volvo), ['volvo']);
});

test('word boundaries: Saudi is not Audi', () => {
  assert.deepEqual(m('Saudi Arabia plans a new EV plant'), []);
});
