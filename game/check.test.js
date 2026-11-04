import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGame } from './check.js';
import { loadGame } from './engine.js';
import turnTaker from './fixtures/turn-taker.js';

const fails = (game, problem) => {
  const result = checkGame(game);
  assert.equal(result.ok, false, 'the checker should have failed this game');
  assert.match(result.problem, problem);
};

test('Salt Run and a turn-based game both pass', async () => {
  for (const game of [await loadGame('salt-run'), turnTaker]) {
    const result = checkGame(game);
    assert.ok(result.ok, result.problem);
    assert.ok(result.averageReplies > 0);
    assert.match(result.sample.at(-1), /^Final scores:/);
  }
});

test('Salt Run asks for exactly nine replies, because the last round plays itself', async () => {
  assert.equal(checkGame(await loadGame('salt-run')).averageReplies, 9);
});

test('a game that shows a player another hand fails', () => {
  fails({ ...turnTaker, view: (state) => ({ hands: state.secret }) }, /another player's secret/);
});

test('a game that announces a hand in public fails', () => {
  fails({ ...turnTaker, announce: (state) => `Player 1 holds ${state.secret[0].join(', ')}.` }, /announce reveals/);
});

test('a player may still see how many cards the others hold', () => {
  const view = (state, seat) => ({ ...turnTaker.view(state, seat), counts: state.secret.map((hand) => hand.length) });
  assert.ok(checkGame({ ...turnTaker, view }).ok);
});

test('a game that never ends fails', () => {
  fails({ ...turnTaker, defaults: { ...turnTaker.defaults, turns: 100000 } }, /did not finish/);
});

test('a game that crashes fails', () => {
  fails({ ...turnTaker, apply: () => { throw new Error('boom'); } }, /boom/);
});

test('a game that uses Math.random fails', () => {
  const setup = (rules, random) => ({ ...turnTaker.setup(rules, random), scores: rules.players === 3 ? [Math.random(), 0, 0] : [] });
  fails({ ...turnTaker, setup }, /same seed gave a different game/);
});

test('a game with no moves for a seat, bad seats or bad scores fails', () => {
  fails({ ...turnTaker, legalMoves: () => [] }, /no legal move/);
  fails({ ...turnTaker, toAct: () => [7] }, /bad seats/);
  fails({ ...turnTaker, setup: (rules, random) => ({ ...turnTaker.setup(rules, random), scores: [0] }) }, /state\.scores/);
});

test('a game whose state is not plain data fails', () => {
  fails({ ...turnTaker, setup: (rules, random) => ({ ...turnTaker.setup(rules, random), when: new Date(0) }) }, /plain data/);
});

test('moves must be numbers or short words', () => {
  fails({ ...turnTaker, legalMoves: () => ['@everyone do this'] }, /numbers or short words/);
});

test('a bad file shape fails with a clear reason', () => {
  fails(null, /one object/);
  const { apply, ...noApply } = turnTaker;
  fails(noApply, /apply must be a function/);
  fails({ ...turnTaker, defaults: { ...turnTaker.defaults, players: 4 } }, /players must be 2 to 3/);
  fails({ ...turnTaker, rulesText: () => 'x'.repeat(3001) }, /limit is 3000/);
  fails({ ...turnTaker, knobs: { gain: { min: 5, max: 9 } } }, /outside its range/);
});

test('every knob must work at both ends of its range', () => {
  const setup = (rules, random) => {
    if (rules.gain === 5) throw new Error('breaks at the top of the range');
    return turnTaker.setup(rules, random);
  };
  fails({ ...turnTaker, setup }, /breaks at the top/);
});
