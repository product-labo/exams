import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret } from './agent.js';

const opts = ['Paris', 'Rome', 'Madrid'];
test('letters and option words', () => {
  assert.deepEqual(interpret('Option B', opts), { intent: 'answer', letter: 'B' });
  assert.deepEqual(interpret('b', opts), { intent: 'answer', letter: 'B' });
  assert.deepEqual(interpret('bee', opts), { intent: 'answer', letter: 'B' });
  assert.deepEqual(interpret('I think it is Paris', opts), { intent: 'answer', letter: 'A' });
});
test('repeat intent beats stray letters', () => {
  assert.equal(interpret("I don't understand a thing", opts).intent, 'repeat');
  assert.equal(interpret('please repeat', opts).intent, 'repeat');
});
test('unknown', () => {
  assert.equal(interpret('', opts).intent, 'unknown');
  assert.equal(interpret('umm let me think about it', opts).intent, 'unknown');
  assert.equal(interpret('option d', opts).intent, 'unknown');
});

import { pickInterpretation } from './agent.js';

test('real words and ordinals work as well as letters', () => {
  for (const [said, letter] of [['alpha', 'A'], ['Bravo', 'B'], ['charlie', 'C'], ['the first one', 'A'], ['second', 'B'], ['option two', 'B'], ['option 3', 'C'],
    ['option bee', 'B'], ['the answer is charlie', 'C'], ['I choose bravo', 'B'], ['option see', 'C'], ['answer be', 'B'], ['option to', 'B']]) {
    const r = interpret(said, ['x1', 'y1', 'z1', 'w1']);
    assert.deepEqual([said, r.letter], [said, letter]);
  }
});
test('ordinary sentences are not mistaken for answers', () => {
  for (const said of ['it is for sure', 'its a good question', 'I say hello', 'umm let me think', 'to be honest', 'for you', 'two']) {
    assert.equal(interpret(said, ['x1', 'y1', 'z1', 'w1']).intent, 'unknown', said);
  }
});
test('numbers: a spoken or typed number matches the option text, but "option two" means the position', () => {
  assert.equal(interpret('two', ['1', '2', '3']).letter, 'B');
  assert.equal(interpret('two', ['5', '9', '2']).letter, 'C');          // value, not position
  assert.equal(interpret('2', ['5', '9', '2']).letter, 'C');
  assert.equal(interpret('option two', ['2', '5', '9']).letter, 'B');    // explicit lead-in names the position
  assert.equal(interpret('twenty', ['5', '20', '9']).letter, 'B');
  assert.equal(interpret('the answer is 15', ['5', '15', '9']).letter, 'B');
});
test('pickInterpretation uses the first alternative that makes sense', () => {
  const opts = ['Paris', 'Rome', 'Madrid'];
  assert.equal(pickInterpretation(['uh huh', 'option bee', 'option P'], opts).letter, 'B');
  assert.equal(pickInterpretation(['', 'I dont understand'], opts).intent, 'repeat');
  assert.equal(pickInterpretation(['mumble', 'grumble'], opts).intent, 'unknown');
  assert.equal(pickInterpretation([], opts).intent, 'unknown');
});
