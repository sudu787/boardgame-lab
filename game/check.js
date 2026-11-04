// The checker: plain code that decides whether a game file is fit to play.
// Usage: node game/check.js <name>   tests games/<name>.js, and exits with 1 if it fails.
//
// A game file exports one object:
//   name                        the game's name
//   defaults                    { players: 2 or 3, ...the rule values }
//   knobs                       optional { ruleValue: { min, max, integer? } }, numbers a person may change live
//   bots                        optional { name: (view, random, legal) => move }, replacing the stock test strategies
//   rulesText(rules)            the rules for the players, at most 3000 characters
//   setup(rules, random)        the starting state as plain data, with state.scores[] and state.secret[seat].
//                               Use only the random it is given, never Math.random or the clock.
//   toAct(state)                the seats that must move now, empty when the game is over
//   legalMoves(state, seat)     what that seat may play: numbers, or short words. A seat with one legal move
//                               plays it automatically, without being asked.
//   view(state, seat)           everything that seat may know
//   announce(state)             the public line before the moves
//   prompt(view)                the private line to the seat, built only from its view
//   apply(state, moves, names)  changes the state and returns the public result line. moves[seat] is set for
//                               each seat in toAct, and names[seat] is that player's name.
//
// Whatever a player must not see goes in state.secret[seat]. This is what lets the checker test for
// peeking: it changes the other players' secrets, and that player's view must not change.
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { applyMoves, isOver, loadGame, newGame, seededRandom } from './engine.js';
import { report } from './simulate.js';

const GAMES = 300;
const REPEATED_GAMES = 20;
const MAX_STEPS = 500;
const MAX_PLAYERS = 3; // the template has three seat rooms
const MAX_RULES = 3000;
const MAX_SAMPLE = 2400;
const MANY_REPLIES = 30;
const FUNCTIONS = ['rulesText', 'setup', 'toAct', 'legalMoves', 'view', 'announce', 'prompt', 'apply'];
const WORD_MOVE = /^[\w -]{1,30}$/;

function require(condition, problem) {
  if (!condition) throw new Error(problem);
}

// Changes every value and keeps the shape, so counts such as "2 cards left" can stay public.
function scramble(value) {
  if (Array.isArray(value)) return value.map(scramble);
  if (typeof value === 'number') return value + 1000;
  if (typeof value === 'string') return `${value}?`;
  if (typeof value === 'boolean') return !value;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scramble(item)]));
  }
  return value;
}

function checkFormat(game) {
  require(game && typeof game === 'object', 'the file must export one object as its default');
  require(typeof game.name === 'string' && game.name, 'name must be a string');
  for (const name of FUNCTIONS) require(typeof game[name] === 'function', `${name} must be a function`);
  const players = game.defaults?.players;
  require(Number.isInteger(players) && players >= 2 && players <= MAX_PLAYERS, `defaults.players must be 2 to ${MAX_PLAYERS}`);
  const rules = game.rulesText(game.defaults);
  require(typeof rules === 'string' && rules, 'rulesText must return text');
  require(rules.length <= MAX_RULES, `rulesText is ${rules.length} characters, and the limit is ${MAX_RULES}`);
  for (const [knob, { min, max }] of Object.entries(game.knobs ?? {})) {
    const value = game.defaults[knob];
    require(Number.isFinite(min) && Number.isFinite(max) && min <= max, `knob ${knob} needs a min and a max`);
    require(Number.isFinite(value) && value >= min && value <= max, `the default for knob ${knob} is outside its range`);
  }
}

function checkPrivacy(game, state, players) {
  const announced = game.announce(state);
  const hidden = structuredClone(state);
  hidden.secret = hidden.secret.map(scramble);
  require(game.announce(hidden) === announced, "announce reveals a player's secret");
  for (let seat = 0; seat < players; seat++) {
    const others = structuredClone(state);
    others.secret = others.secret.map((secret, s) => (s === seat ? secret : scramble(secret)));
    require(
      JSON.stringify(game.view(others, seat)) === JSON.stringify(game.view(state, seat)),
      `view shows seat ${seat + 1} another player's secret`,
    );
  }
}

function playChecked(game, rules, seed) {
  const { players } = rules;
  const state = newGame(game, rules, seed);
  require(isDeepStrictEqual(JSON.parse(JSON.stringify(state)), state), 'the state must be plain data');
  require(Array.isArray(state.secret) && state.secret.length === players, 'state.secret needs one entry per seat');
  const random = seededRandom(seed + 1);
  const names = Array.from({ length: players }, (_, seat) => `Player ${seat + 1}`);
  const log = [];
  let replies = 0;
  const checkScores = () =>
    require(state.scores?.length === players && state.scores.every(Number.isFinite), 'state.scores must hold one number per seat');
  checkScores();
  for (let step = 0; !isOver(game, state); step++) {
    require(step < MAX_STEPS, `the game did not finish within ${MAX_STEPS} steps`);
    const seats = game.toAct(state);
    require(
      seats.every((seat) => Number.isInteger(seat) && seat >= 0 && seat < players) && new Set(seats).size === seats.length,
      `toAct returned bad seats: ${JSON.stringify(seats)}`,
    );
    checkPrivacy(game, state, players);
    const announced = game.announce(state);
    require(typeof announced === 'string', 'announce must return text');
    if (announced) log.push(announced);
    const moves = [];
    for (const seat of seats) {
      const legal = game.legalMoves(state, seat);
      require(Array.isArray(legal) && legal.length > 0, `seat ${seat + 1} has no legal move`);
      require(
        legal.every((move) => Number.isFinite(move) || (typeof move === 'string' && WORD_MOVE.test(move))),
        `moves must be numbers or short words: ${JSON.stringify(legal)}`,
      );
      const prompt = game.prompt(game.view(state, seat));
      require(typeof prompt === 'string' && prompt, 'prompt must return text');
      if (legal.length > 1) replies++;
      moves[seat] = legal[Math.floor(random() * legal.length)];
    }
    const result = applyMoves(game, state, moves, names);
    require(typeof result === 'string' && result, 'apply must return the public result line');
    log.push(result);
    checkScores();
  }
  require(isDeepStrictEqual(JSON.parse(JSON.stringify(state)), state), 'the state must stay plain data');
  log.push(`Final scores: ${state.scores.map((score, seat) => `${names[seat]} ${score}`).join(', ')}.`);
  return { log, replies, state };
}

function atSeed(seed, run) {
  try {
    return run();
  } catch (error) {
    error.message = `in random game ${seed}: ${error.message}`;
    throw error;
  }
}

export function checkGame(game) {
  try {
    checkFormat(game);
    const rules = { ...game.defaults };
    let replies = 0;
    let sample;
    for (let seed = 1; seed <= GAMES; seed++) {
      const run = atSeed(seed, () => playChecked(game, rules, seed));
      replies += run.replies;
      sample ??= run.log;
    }
    for (let seed = 1; seed <= REPEATED_GAMES; seed++) {
      atSeed(seed, () => {
        const [first, second] = [playChecked(game, rules, seed), playChecked(game, rules, seed)];
        require(isDeepStrictEqual(first, second), 'the same seed gave a different game, so use only the random you are given');
      });
    }
    for (const [knob, { min, max }] of Object.entries(game.knobs ?? {})) {
      for (const value of [min, max]) {
        for (let seed = 1; seed <= REPEATED_GAMES; seed++) {
          atSeed(seed, () => playChecked(game, { ...rules, [knob]: value }, seed));
        }
      }
    }
    report(game, rules, { games: REPEATED_GAMES });
    return { ok: true, averageReplies: replies / GAMES, sample };
  } catch (error) {
    const where = error.stack?.split('\n').find((line) => line.includes('games'))?.trim();
    return { ok: false, problem: where ? `${error.message} (${where})` : error.message };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const name = process.argv[2];
  let result;
  try {
    const game = await loadGame(name ?? '');
    result = { ...checkGame(game), game };
  } catch (error) {
    result = { ok: false, problem: error.message };
  }
  if (result.ok) {
    const replies = Math.round(result.averageReplies);
    const sample = result.sample.join('\n');
    console.log(`PASS ${result.game.name}: ${GAMES} random games finished, and no player's secret showed in what another player sees.`);
    console.log(`Each game needs about ${replies} agent replies.${replies > MANY_REPLIES ? ' That is a lot of Claude usage for one game.' : ''}`);
    console.log(`\nA sample game with random moves:\n${sample.length > MAX_SAMPLE ? `${sample.slice(0, MAX_SAMPLE)}\n...` : sample}`);
  } else {
    console.log(`FAIL ${name ?? '(no game named)'}: ${result.problem}`);
    process.exitCode = 1;
  }
}
