import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import { Table, teamOf } from './table.js';
import { loadGame } from '../game/engine.js';
import { report, toText } from '../game/simulate.js';
import turnTaker from '../game/fixtures/turn-taker.js';

const rules = JSON.parse(readFileSync(new URL('../game/rules.v1.json', import.meta.url), 'utf8'));
const saltRun = await loadGame('salt-run');
const players = ['a-hawk', 'a-turtle', 'a-gambler'];
const rooms = { table: 'T', seats: ['S1', 'S2', 'S3'] };
const person = 'priya';

let sent;
let table;
let saved;
let logged;
const said = (room) => sent.filter((m) => m.room === room).map((m) => m.text);
const send = (roomId, sender, body) => table.handle({ roomId, sender, body }, rooms, players);
const hands = () => table.state.secret.map((hand) => [...hand]);

beforeEach(() => {
  sent = [];
  saved = [];
  logged = [];
  table = new Table({
    game: saltRun,
    rules,
    referee: 'ref',
    say: async (room, text) => sent.push({ room, text }),
    isPerson: async (_room, name) => name === person,
    simulate: async (r) => report(table.game, r, { games: 200, seed: 1 }),
    check: async (name) => (name === 'broken' ? { ok: false, output: 'FAIL broken: it crashes' } : { ok: true, output: `PASS ${name}` }),
    loadGame: async () => turnTaker,
    saveRules: async (r) => saved.push(r),
    saveLog: async (text) => logged.push(text),
    toText,
  });
});

async function playWholeGame(seed = 7) {
  await send('T', person, `@ref deal ${seed}`);
  while (!table.finished) {
    for (const seat of [...table.waiting]) {
      await send(rooms.seats[seat], table.players[seat], `@ref play ${table.state.secret[seat][0]}`);
      if (table.finished) break;
    }
  }
}

test('a hand reaches only its own seat room, and no move shows at the table before the reveal', async () => {
  await send('T', person, '@ref deal 7');
  const dealt = hands();
  dealt.forEach((hand, seat) => {
    assert.ok(said(rooms.seats[seat])[0].includes(`Your hand: ${hand.join(', ')}.`));
  });
  assert.ok(!said('T').some((text) => /hand:/i.test(text)));

  await send('S1', players[0], `@ref play ${dealt[0][0]}`);
  assert.ok(!said('T').some((text) => text.includes('bids:')));
  assert.ok(!said('S2').some((text) => text.includes('locked')));
});

test('the first prompt of a game carries the rules, and later prompts do not', async () => {
  await playWholeGame();
  const prompts = said('S1').filter((text) => text.includes('Your hand:'));
  assert.ok(prompts[0].includes('The highest card takes the cargo'));
  assert.ok(!prompts[1].includes('The highest card takes the cargo'));
});

test('a move at the table is refused and not acted on', async () => {
  await send('T', person, '@ref deal 7');
  const card = hands()[0][0];
  await send('T', players[0], `@ref play ${card}`);
  assert.equal(table.moves[0], undefined);
  assert.match(said('T').at(-1), /private seat room/);
});

test('nobody can move for another seat, or play a card they do not hold, or play twice', async () => {
  await send('T', person, '@ref deal 7');
  const dealt = hands();
  await send('S1', players[1], `@ref play ${dealt[0][0]}`);
  assert.equal(table.moves[0], undefined);
  await send('S1', players[0], `@ref play ${dealt[1][0]}`);
  assert.equal(table.moves[0], undefined);
  assert.match(said('S1').at(-1), /cannot play/);
  await send('S1', players[0], `@ref play ${dealt[0][0]}`);
  await send('S1', players[0], `@ref play ${dealt[0][1]}`);
  assert.equal(table.moves[0], dealt[0][0]);
  assert.match(said('S1').at(-1), /already played/);
});

test('the forced last round plays itself and the game ends in notes, then the analyst', async () => {
  await playWholeGame();
  assert.equal(table.state.history.length, rules.rounds);
  assert.match(said('T').find((text) => text.includes('Game 1 over')), /Winner: /);
  for (const player of players) await send('T', player, `@ref note ${player} saw something`);
  const call = said('T').at(-1);
  assert.match(call, /^@balance-analyst /);
  assert.match(call, /a-hawk saw something/);
  assert.match(call, /Round 4 bids/);
  assert.match(logged[0], /a-hawk saw something/);
});

test('a log too long to post goes to a file, and the analyst is told where', async () => {
  await playWholeGame();
  for (const player of players) await send('T', player, `@ref note ${'x'.repeat(2000)}`);
  const call = said('T').at(-1);
  assert.ok(call.length < 300);
  assert.match(call, /runs\/last-game\.txt/);
  assert.ok(logged[0].length > 6000);
});

test('a person can take a seat and play a whole game in place of its agent', async () => {
  await send('T', person, '@ref sit 2');
  await send('T', person, '@ref deal 7');
  assert.deepEqual(table.players, [players[0], person, players[2]]);
  assert.ok(said('S2')[0].startsWith(`@${person} `));
  assert.ok(!said('S2').some((text) => text.includes(`@${players[1]}`)));

  await send('S2', players[1], `@ref play ${table.state.secret[1][0]}`);
  assert.equal(table.moves[1], undefined);

  while (!table.finished) {
    for (const seat of [...table.waiting]) {
      await send(rooms.seats[seat], table.players[seat], `@ref play ${table.state.secret[seat][0]}`);
      if (table.finished) break;
    }
  }
  assert.equal(table.state.history.length, rules.rounds);

  for (const player of table.players) await send('T', player, `@ref note ${player} noticed`);
  assert.match(said('T').at(-1), /priya: priya noticed/);
});

test('the seat goes back to the agent on stand, for the next game', async () => {
  await send('T', person, '@ref sit 1');
  await send('T', person, '@ref stand');
  await send('T', person, '@ref deal 7');
  assert.deepEqual(table.players, players);
});

test('only a person can sit, in a real seat, and not mid game', async () => {
  await send('T', players[0], '@ref sit 2');
  assert.equal(table.sitting, null);
  for (const bad of ['0', '4', 'x', '1.5']) {
    await send('T', person, `@ref sit ${bad}`);
    assert.equal(table.sitting, null);
  }
  await send('T', person, '@ref deal 7');
  await send('T', person, '@ref sit 1');
  assert.equal(table.sitting, null);
  assert.deepEqual(table.players, players);
});

test('agents cannot deal or change the rules, and a person can', async () => {
  await send('T', players[0], '@ref deal');
  assert.equal(table.state, null);
  await send('T', 'analyst', '@ref set finalTide=1');
  assert.equal(table.rules.finalTide, 3);
  assert.match(said('T').at(-1), /Refused/);

  await send('T', person, '@ref set finalTide=1.5');
  assert.equal(table.rules.finalTide, 1.5);
  assert.equal(saved.at(-1).finalTide, 1.5);
  assert.match(said('T').at(-1), /before/);
  assert.match(said('T').at(-1), /by seat, before: [\d.]+%, [\d.]+%, [\d.]+%\n.*by seat, after: +[\d.]+%/);
});

test('an agent mentioning the referee in passing changes nothing and gets no reply', async () => {
  await send('T', 'analyst', 'Your call. To apply it, send "@ref set finalTide=1". I cannot change the rules.');
  await send('T', 'engineer', 'It passed. To approve it, send "@ref load my-game".');
  assert.equal(table.rules.finalTide, 3);
  assert.equal(table.game, saltRun);
  assert.deepEqual(sent, []);
  await send('T', person, '@ref hello');
  assert.match(said('T').at(-1), /I understand/);
});

test('a bad rule value changes nothing, and rules cannot change mid game', async () => {
  for (const bad of ['0', '9', 'lots', 'NaN']) {
    await send('T', person, `@ref set finalTide=${bad}`);
    assert.equal(table.rules.finalTide, 3);
  }
  await send('T', person, '@ref set handSize=9');
  assert.equal(table.rules.handSize, 4);
  assert.match(said('T').at(-1), /no rule called handSize/);
  await send('T', person, '@ref set constructor=2');
  assert.match(said('T').at(-1), /no rule called constructor/);
  await send('T', person, '@ref deal 7');
  await send('T', person, '@ref set finalTide=2');
  assert.equal(table.rules.finalTide, 3);
});

test('only a person can load a game, and an agent is refused', async () => {
  await send('T', 'engineer', '@ref load turn-taker');
  assert.equal(table.game, saltRun);
  assert.match(said('T').at(-1), /Refused/);
  await send('T', person, '@ref load turn-taker');
  assert.equal(table.game, turnTaker);
  assert.equal(table.rules.gain, 2);
  assert.equal(saved.at(-1).game, 'turn-taker');
  assert.match(said('T').at(-1), /priya loaded Turn Taker/);
});

test('a game the checker refuses, or a bad name, is not loaded', async () => {
  await send('T', person, '@ref load broken');
  assert.equal(table.game, saltRun);
  assert.match(said('T').at(-1), /FAIL broken/);
  await send('T', person, '@ref load ../evil');
  assert.equal(table.game, saltRun);
  assert.match(said('T').at(-1), /lowercase/);
  assert.deepEqual(saved, []);
});

test('a game cannot be loaded mid game', async () => {
  await send('T', person, '@ref deal 7');
  await send('T', person, '@ref load turn-taker');
  assert.equal(table.game, saltRun);
  assert.match(said('T').at(-1), /Finish the game/);
});

test('a loaded turn-based game plays from start to finish, one seat at a time', async () => {
  await send('T', person, '@ref load turn-taker');
  await send('T', person, '@ref deal 3');
  assert.deepEqual([...table.waiting], [0]);
  const first = table.state.secret[0][0];
  assert.ok(said('S1').at(-1).includes(`You can play: ${table.state.secret[0].join(', ')}, pass.`));
  assert.deepEqual(said('S2'), []);

  await send('S2', players[1], '@ref play pass');
  assert.match(said('S2').at(-1), /not your turn/);
  await send('S1', players[0], '@ref play banana');
  assert.match(said('S1').at(-1), /cannot play banana/);
  await send('S1', players[0], `@ref play ${first}`);
  assert.ok(table.state.played.includes(first));
  assert.deepEqual([...table.waiting], [1]);

  await send('S2', players[1], '@ref play PASS');
  assert.match(said('T').find((text) => text.includes('passes')), /a-turtle passes/);

  let moves = 0;
  while (!table.finished && moves++ < 20) {
    const seat = [...table.waiting][0];
    await send(rooms.seats[seat], table.players[seat], `@ref play ${table.state.secret[seat][0] ?? 'pass'}`);
  }
  assert.ok(table.finished);
  assert.equal(table.state.turn, turnTaker.defaults.turns);
});

test('a seat with one legal move plays by itself, and a single seat can have that', async () => {
  const forced = { ...turnTaker, legalMoves: (state, seat) => (seat === 1 ? ['pass'] : turnTaker.legalMoves(state, seat)) };
  table.loadGame = async () => forced;
  await send('T', person, '@ref load forced');
  await send('T', person, '@ref deal 3');
  await send('S1', players[0], `@ref play ${table.state.secret[0][0]}`);
  assert.deepEqual(said('S2'), []);
  assert.match(said('T').find((text) => text.includes('passes')), /a-turtle passes/);
  assert.deepEqual([...table.waiting], [2]);
});

test('a generic rule works on a loaded game, including whole-number limits', async () => {
  await send('T', person, '@ref load turn-taker');
  await send('T', person, '@ref set gain=2.5');
  assert.equal(table.rules.gain, 2);
  assert.match(said('T').at(-1), /whole number/);
  await send('T', person, '@ref set gain=4');
  assert.equal(table.rules.gain, 4);
  await send('T', person, '@ref set finalTide=2');
  assert.match(said('T').at(-1), /You can change: gain/);
});

test('a two-player game leaves the third seat out', async () => {
  const twoPlayers = { ...turnTaker, defaults: { ...turnTaker.defaults, players: 2 } };
  table.loadGame = async () => twoPlayers;
  await send('T', person, '@ref sit 3');
  await send('T', person, '@ref load two-players');
  assert.equal(table.sitting, null);
  await send('T', person, '@ref sit 3');
  assert.equal(table.sitting, null);
  await send('T', person, '@ref deal 3');
  assert.deepEqual(table.players, players.slice(0, 2));
});

test('a person can stop a stuck game, and an agent cannot', async () => {
  await send('T', person, '@ref deal 7');
  await send('T', players[0], '@ref stop');
  assert.ok(table.playing);
  await send('T', person, '@ref deal 8');
  assert.match(said('T').at(-1), /already running/);
  await send('T', person, '@ref stop');
  assert.ok(!table.playing);
  await send('T', person, '@ref deal 8');
  assert.ok(table.playing);
});

test('a game running at one table is not disturbed from another', async () => {
  await send('T', person, '@ref deal 7');
  const other = { table: 'T2', seats: ['X1', 'X2', 'X3'] };
  await table.handle({ roomId: 'T2', sender: person, body: '@ref deal 8' }, other, players);
  assert.match(said('T2').at(-1), /another playtest/);
  assert.equal(table.rooms.table, 'T');
});

test('room names give the playtest they belong to', () => {
  assert.equal(teamOf('lab-table'), 'lab');
  assert.equal(teamOf('my-lab-seat-2'), 'my-lab');
  assert.equal(teamOf('Mattermost: Town Square'), null);
});
