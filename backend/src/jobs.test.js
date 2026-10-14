import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from './jobs.js';

test('chunkText splits on paragraphs and respects size', () => {
  const text = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} ` + 'x'.repeat(900)).join('\n\n');
  const chunks = chunkText(text, 3000);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.length <= 4500));
  assert.equal(chunks.join('\n\n').replace(/\s/g, '').length, text.replace(/\s/g, '').length);
});
test('chunkText handles one huge paragraph', () => {
  const chunks = chunkText('y'.repeat(10000), 3000);
  assert.ok(chunks.every((c) => c.length <= 4500));
});

import { shuffleOptions } from './jobs.js';

test('shuffleOptions keeps the right answer attached to the right text', () => {
  for (let n = 0; n < 200; n++) {
    const x = { question: 'q', options: ['red', 'green', 'blue'], correct: 'B' }; // green
    const s = shuffleOptions(x);
    assert.equal(s.options['ABC'.indexOf(s.correct)], 'green');
    assert.deepEqual([...s.options].sort(), ['blue', 'green', 'red']);
  }
});
test('shuffleOptions spreads the correct letter around', () => {
  const counts = { A: 0, B: 0, C: 0 };
  for (let n = 0; n < 600; n++) counts[shuffleOptions({ question: 'q', options: ['a', 'b', 'c'], correct: 'A' }).correct]++;
  for (const l of 'ABC') assert.ok(counts[l] > 140, `letter ${l} only ${counts[l]}/600`);
});
test('shuffleOptions leaves "all of the above" style options in place', () => {
  const x = { question: 'q', options: ['one', 'two', 'All of the above'], correct: 'C' };
  assert.deepEqual(shuffleOptions(x), x);
  const y = { question: 'q', options: ['Both A and B', 'x', 'y'], correct: 'A' };
  assert.deepEqual(shuffleOptions(y), y);
});
test('shuffleOptions works with 2 and 4 options', () => {
  const two = shuffleOptions({ question: 'q', options: ['yes', 'no'], correct: 'B' });
  assert.equal(two.options['AB'.indexOf(two.correct)], 'no');
  const four = shuffleOptions({ question: 'q', options: ['w', 'x', 'y', 'z'], correct: 'D' });
  assert.equal(four.options['ABCD'.indexOf(four.correct)], 'z');
});
