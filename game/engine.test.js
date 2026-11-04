import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyMoves, isOver, loadGame, newGame, winners } from './engine.js';
import { BROKEN_AT, measure, report, seatShares } from './simulate.js';
import turnTaker from './fixtures/turn-taker.js';

const load = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const v1 = load('./rules.v1.json');
const v2 = load('./rules.v2.json');
const game = await loadGame('salt-run');
const names = ['a', 'b', 'c'];
// Every card must be played, so playing lowest first saves the best card for the Final Tide.
const saver = (view) => Math.min(...view.hand);

test('the same seed deals the same game', () => {
  assert.deepEqual(newGame(game, v1, 42), newGame(game, v1, 42));
  assert.notDeepEqual(newGame(game, v1, 42).secret, newGame(game, v1, 43).secret);
});

test('hands never share a card', () => {
  const cards = newGame(game, v1, 1).secret.flat();
  assert.equal(new Set(cards).size, v1.players * v1.handSize);
});

test("a view holds only that seat's hand", () => {
  const state = newGame(game, v1, 1);
  const view = game.view(state, 0);
  assert.deepEqual(view.hand, state.secret[0]);
  assert.ok(!('secret' in view));
  for (const card of state.secret.slice(1).flat()) assert.ok(!view.hand.includes(card));
});

test('a card not in hand is refused and changes nothing', () => {
  const state = newGame(game, v1, 1);
  const before = structuredClone(state);
  assert.throws(() => applyMoves(game, state, [state.secret[1][0], state.secret[1][0], state.secret[2][0]], names), /cannot play/);
  assert.deepEqual(state, before);
});

test('the highest bid takes the cargo, and only the last lot is multiplied', () => {
  const state = newGame(game, { ...v1, cargo: [4, 4, 4, 4] }, 1);
  while (!isOver(game, state)) {
    const bids = state.secret.map((hand) => hand[0]);
    applyMoves(game, state, bids, names);
    const { winner } = state.history.at(-1);
    assert.equal(bids[winner], Math.max(...bids));
  }
  assert.deepEqual(state.history.map((h) => h.cargo), [4, 4, 4, 12]);
  assert.equal(state.scores.reduce((a, b) => a + b, 0), 24);
  assert.ok(winners(state).length >= 1);
});

test('saving the best card is broken under v1 and no strategy is under v2', () => {
  const options = { games: 5000, seed: 3 };
  assert.ok(measure(game, saver, v1, options).winRate >= BROKEN_AT);
  const fixed = report(game, v2, options, { saver });
  assert.deepEqual(fixed.rows.filter((row) => row.broken), []);
});

test("Salt Run's measured numbers have not drifted", () => {
  const options = { games: 2000, seed: 3 };
  const expected = [
    [v1, { saver: 0.652, hawk: 0.14725, turtle: 0.44775, gambler: 0.36975 }],
    [v2, { saver: 0.4644166666666667, hawk: 0.22891666666666666, turtle: 0.4195833333333333, gambler: 0.3416666666666666 }],
  ];
  for (const [rules, rates] of expected) {
    const strategies = { saver, ...game.bots };
    for (const [name, rate] of Object.entries(rates)) {
      assert.ok(Math.abs(measure(game, strategies[name], rules, options).winRate - rate) < 1e-9, `${rules.name} ${name}`);
    }
  }
});

test('the stock bots and the seat shares work on a game with word moves', () => {
  const rules = turnTaker.defaults;
  const result = report(turnTaker, rules, { games: 200 });
  assert.deepEqual(result.rows.map((row) => row.name).sort(), ['gambler', 'hawk']);
  const shares = seatShares(turnTaker, rules, { games: 200 });
  assert.equal(shares.length, rules.players);
  assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('seat shares show a first-player advantage', () => {
  const firstAlwaysWins = { ...turnTaker, apply(state, moves, names_) {
    const line = turnTaker.apply(state, moves, names_);
    state.scores[0] += 100;
    return line;
  } };
  assert.equal(seatShares(firstAlwaysWins, turnTaker.defaults, { games: 50 })[0], 1);
});

test('a bad game name is refused before any file is read', async () => {
  for (const bad of ['../evil', 'a/b', 'A', '', 'x.js']) await assert.rejects(loadGame(bad), /lowercase/);
  await assert.rejects(loadGame('no-such-game'), /no game file/);
});
