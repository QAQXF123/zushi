import test from 'node:test';
import assert from 'node:assert/strict';
import { bundledChampions, championDisplayName, championMatchesSearch, championPositions, POSITION_OPTIONS } from '../src/lib/championFilters.ts';

test('Chinese names, titles, aliases and English variants match the same champion', () => {
  for (const query of ['阿狸', '九尾妖狐', '狐狸', ' AHRI ']) assert.ok(championMatchesSearch('Ahri', query));
  for (const query of ['李青', '盲僧', '瞎子', 'Lee Sin']) assert.ok(championMatchesSearch('Lee Sin', query));
  assert.ok(championMatchesSearch('Nunu & Willump', 'nunu willump'));
  assert.ok(!championMatchesSearch('Ahri', '李青'));
  assert.equal(championDisplayName('Ahri'), '阿狸');
  assert.equal(championDisplayName('Unknown'), 'Unknown');
});

test('all bundled champions have valid lanes and support combining lane with Chinese search', () => {
  const valid = new Set(POSITION_OPTIONS.filter(p => p.id !== 'all').map(p => p.id));
  assert.equal(bundledChampions.length, 173);
  for (const champion of bundledChampions) {
    const positions = championPositions(champion);
    assert.ok(positions.length > 0, champion.name);
    assert.ok(positions.every(p => valid.has(p)), champion.name);
    assert.equal(positions.length, new Set(positions).size);
  }
  for (const [hero, lane] of [['Darius','top'],['Lee Sin','jungle'],['Ahri','mid'],['Jinx','bot'],['Leona','support']]) {
    assert.ok(championPositions(hero).includes(lane), hero);
  }
  assert.ok(championPositions('Lux').includes('mid'));
  assert.ok(championPositions('Lux').includes('support'));
  const matched = bundledChampions.filter(c => championMatchesSearch(c, '阿狸') && championPositions(c).includes('mid'));
  assert.deepEqual(matched.map(c => c.id), ['Ahri']);
  assert.deepEqual(championPositions('Unknown'), []);
});
