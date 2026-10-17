import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadedChampionIndex, groupDownloadedSkins } from '../src/lib/downloadedSkins.ts';
const skin = (champion, name) => ({ champion_name: champion, skin_name: name, zip_path: `/skins/${name}.zip` });

test('index separates champions and reuses results without rescanning unchanged downloads', () => {
  const downloads = [skin('Ahri','Fox'), skin('Lee Sin','Dragon'), skin('Ahri','Star')];
  const before = structuredClone(downloads);
  const index = downloadedChampionIndex(downloads);
  assert.equal(downloadedChampionIndex(downloads), index);
  assert.deepEqual(index.get('Ahri').map(s => s.skin_name), ['Fox','Star']);
  assert.deepEqual(groupDownloadedSkins(index.get('Ahri'), () => null).map(g => g.baseSkinName), ['Fox','Star']);
  assert.deepEqual(downloads, before);
  assert.notEqual(downloadedChampionIndex([...downloads]), index);
});

test('groups chromas correctly even when they precede the base or base is absent', () => {
  const downloads = [skin('Ahri','Ruby'), skin('Ahri','Fox'), skin('Ahri','Orphan')];
  const lookup = name => name === 'Ruby' ? {parentName:'Fox',colors:['red']} : name === 'Orphan' ? {parentName:'Missing',colors:[]} : null;
  const groups = groupDownloadedSkins(downloads, lookup);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].base.skin_name, 'Fox');
  assert.equal(groups[0].chromas[0].dl.skin_name, 'Ruby');
  assert.deepEqual(groups[0].chromas[0].colors, ['red']);
  assert.equal(groups[1].base, null);
  assert.equal(groups[1].baseSkinName, 'Missing');
  assert.equal(groups[1].chromas.length, 1);
});
