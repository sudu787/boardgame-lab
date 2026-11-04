// Measures each strategy against the game's field of stock bots.
// Usage: node game/simulate.js --rules runs/rules.current.json [--games 10000] [--seed 1] [--strategies dir] [--json]
// Strategies are files in <strategies>/<game>/, each exporting a default (view, random, legal) => move.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { bots } from './bots.js';
import { applyMoves, isOver, loadGame, newGame, seededRandom, shuffle, winners } from './engine.js';

export const BROKEN_AT = 0.5;

function playOut(game, rules, seats, seed, random) {
  const state = newGame(game, rules, seed);
  const names = seats.map((_, seat) => `seat ${seat + 1}`);
  while (!isOver(game, state)) {
    const moves = [];
    for (const seat of game.toAct(state)) {
      moves[seat] = seats[seat](game.view(state, seat), random, game.legalMoves(state, seat));
    }
    applyMoves(game, state, moves, names);
  }
  return state;
}

// One seat plays the strategy under test, the others are drawn from the stock field.
export function measure(game, strategy, rules, { games = 10000, seed = 1 } = {}) {
  const field = Object.values(game.bots ?? bots);
  const random = seededRandom(seed);
  let wins = 0;
  let points = 0;
  for (let i = 0; i < games; i++) {
    const seats = shuffle(
      [strategy, ...Array.from({ length: rules.players - 1 }, () => field[Math.floor(random() * field.length)])],
      random,
    );
    const tested = seats.indexOf(strategy);
    const state = playOut(game, rules, seats, seed * 1000003 + i, random);
    const won = winners(state);
    if (won.includes(tested)) wins += 1 / won.length;
    points += state.scores[tested];
  }
  const rate = wins / games;
  return {
    winRate: rate,
    margin: 1.96 * Math.sqrt((rate * (1 - rate)) / games),
    avgScore: points / games,
    broken: rate >= BROKEN_AT,
  };
}

// How often each seat wins when everyone plays at random, which shows a first-player advantage.
export function seatShares(game, rules, { games = 10000, seed = 1 } = {}) {
  const random = seededRandom(seed + 1);
  const seats = Array.from({ length: rules.players }, () => bots.gambler);
  const wins = seats.map(() => 0);
  for (let i = 0; i < games; i++) {
    const won = winners(playOut(game, rules, seats, seed * 1000003 + i, random));
    for (const seat of won) wins[seat] += 1 / won.length;
  }
  return wins.map((count) => count / games);
}

export async function loadStrategies(dir) {
  const found = {};
  if (!dir || !existsSync(dir)) return found;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const url = pathToFileURL(resolve(join(dir, file))).href;
    found[file.slice(0, -3)] = (await import(url)).default;
  }
  return found;
}

export function report(game, rules, { games = 10000, seed = 1 } = {}, extra = {}) {
  const options = { games, seed };
  const rows = Object.entries({ ...(game.bots ?? bots), ...extra })
    .map(([name, strategy]) => {
      try {
        return { name, ...measure(game, strategy, rules, options) };
      } catch (error) {
        throw new Error(`Strategy ${name}: ${error.message}`);
      }
    })
    .sort((a, b) => b.winRate - a.winRate);
  return {
    rulesName: rules.name ?? game.name,
    knobs: Object.fromEntries(Object.keys(game.knobs ?? {}).map((knob) => [knob, rules[knob]])),
    games,
    fairShare: 1 / rules.players,
    rows,
    seats: seatShares(game, rules, options),
  };
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;

export function toText(result) {
  const knobs = Object.entries(result.knobs).map(([knob, value]) => `${knob} ${value}`).join(', ');
  return [
    `${result.rulesName}${knobs ? ` (${knobs})` : ''}, ${result.games} games each, fair share ${pct(result.fairShare)}`,
    ...result.rows.map(
      (r) =>
        `${r.name.padEnd(14)} ${pct(r.winRate).padStart(6)} ±${pct(r.margin).padEnd(5)} avg ${r.avgScore.toFixed(1).padStart(4)}${r.broken ? '  BROKEN' : ''}`,
    ),
    `All random, by seat: ${result.seats.map(pct).join(', ')}`,
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { values } = parseArgs({
    options: {
      rules: { type: 'string', default: 'game/rules.v1.json' },
      games: { type: 'string', default: '10000' },
      seed: { type: 'string', default: '1' },
      strategies: { type: 'string', default: 'strategies' },
      json: { type: 'boolean', default: false },
    },
  });
  const rules = JSON.parse(readFileSync(values.rules, 'utf8'));
  const game = await loadGame(rules.game);
  const options = { games: Number(values.games), seed: Number(values.seed) };
  const result = report(game, rules, options, await loadStrategies(join(values.strategies, rules.game)));
  console.log(values.json ? JSON.stringify(result) : toText(result));
}
