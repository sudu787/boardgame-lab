// The generic game runner. A game is one file in games/: game/check.js describes the format and
// games/salt-run.js is the worked example. Apart from loadGame these are pure functions, so the
// same rules and seed always give the same game.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const GAMES = join(import.meta.dirname, '..', 'games');
export const GAME_NAME = /^[a-z0-9-]+$/;

export function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(list, random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// The version in the address makes Node read the file again after it has been edited.
export async function loadGame(name) {
  if (!GAME_NAME.test(name)) throw new Error(`Game names use lowercase letters, digits and hyphens, not "${name}".`);
  const file = join(GAMES, `${name}.js`);
  if (!existsSync(file)) throw new Error(`There is no game file games/${name}.js.`);
  return (await import(`${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}`)).default;
}

export const newGame = (game, rules, seed) => game.setup(rules, seededRandom(seed));

export const isOver = (game, state) => game.toAct(state).length === 0;

// Every move is checked against the game's own list before the game sees any of them.
export function applyMoves(game, state, moves, names) {
  for (const seat of game.toAct(state)) {
    if (!game.legalMoves(state, seat).includes(moves[seat])) {
      throw new Error(`seat ${seat + 1} cannot play ${moves[seat]}`);
    }
  }
  return game.apply(state, moves, names);
}

export function winners(state) {
  const best = Math.max(...state.scores);
  return state.scores.flatMap((score, seat) => (score === best ? [seat] : []));
}
