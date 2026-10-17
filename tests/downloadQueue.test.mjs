import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadQueue } from '../src/lib/downloadQueue.ts';

const item = (name) => ({ url: name, championName: 'Ahri', skinName: name });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

test('accepts new downloads while active, removes duplicates and runs serially', async () => {
  const gate = deferred();
  const calls = [];
  const states = [];
  const queue = createDownloadQueue(async (i) => {
    calls.push(i.skinName);
    if (i.skinName === 'A') await gate.promise;
  }, (active, pending) => states.push({ active, pending }), assert.fail, async () => {}, 1);
  const drained = queue.enqueue([item('A')]);
  const appended = queue.enqueue([item('A'), item('B'), item('B')]);
  assert.deepEqual(calls, ['A']);
  assert.equal(states.at(-1).pending.length, 2);
  gate.resolve();
  await Promise.all([drained, appended]);
  assert.deepEqual(calls, ['A', 'B']);
  assert.deepEqual(states.at(-1), { active: null, pending: [] });
});

test('a failed transfer releases its state, continues the queue, and allows retry', async () => {
  const calls = [];
  const errors = [];
  let fail = true;
  let state;
  const queue = createDownloadQueue(async (i) => {
    calls.push(i.skinName);
    if (i.skinName === 'A' && fail) throw new Error('timeout');
  }, (active, pending) => state = { active, pending }, e => errors.push(e), async () => {});
  await queue.enqueue([item('A'), item('B')]);
  assert.deepEqual(calls, ['A', 'B']);
  assert.match(errors[0], /timeout/);
  assert.deepEqual(state, { active: null, pending: [] });
  fail = false;
  await queue.enqueue([item('A')]);
  assert.deepEqual(calls, ['A', 'B', 'A']);
});


test('starts ten requests together, deduplicates repeated Download All, and refills each free slot', async () => {
  const items = Array.from({ length: 23 }, (_, i) => item(`Skin ${i}`));
  const gates = new Map(items.map(i => [i.skinName, deferred()]));
  const calls = [];
  let peak = 0;
  let active = 0;
  let state;
  const queue = createDownloadQueue(async (i) => {
    calls.push(i.skinName);
    active++;
    peak = Math.max(peak, active);
    await gates.get(i.skinName).promise;
    active--;
  }, (first, pending, count) => state = { first, pending, count }, assert.fail, async () => {});
  const drained = queue.enqueue(items);
  const repeated = queue.enqueue(items);
  assert.equal(calls.length, 10);
  assert.equal(state.pending.length, 23);
  assert.equal(state.count, 10);
  gates.get('Skin 3').resolve();
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 11);
  assert.equal(calls.at(-1), 'Skin 10');
  assert.equal(state.count, 10);
  for (const gate of gates.values()) gate.resolve();
  await Promise.all([drained, repeated]);
  assert.equal(calls.length, 23);
  assert.equal(new Set(calls).size, 23);
  assert.equal(peak, 10);
  assert.equal(state.count, 0);
  assert.equal(state.pending.length, 0);
});

test('new downloads use spare slots immediately while another request is slow', async () => {
  const gate = deferred();
  const calls = [];
  const queue = createDownloadQueue(async (i) => {
    calls.push(i.skinName);
    if (i.skinName === 'A') await gate.promise;
  }, () => {}, assert.fail, async () => {});
  const first = queue.enqueue([item('A')]);
  const appended = queue.enqueue([item('B')]);
  assert.deepEqual(calls, ['A', 'B']);
  gate.resolve();
  await Promise.all([first, appended]);
});
