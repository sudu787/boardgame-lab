// A small turn-based game for the tests, with hidden hands. Moves are numbers or the word "pass".
import { shuffle } from '../engine.js';

export default {
  name: 'Turn Taker',
  defaults: { players: 3, turns: 7, gain: 2 },
  knobs: { gain: { min: 1, max: 5, integer: true } },

  rulesText: (rules) =>
    `Take turns playing a card for its value plus ${rules.gain}, or passing. After ${rules.turns} turns, most points wins.`,

  setup(rules, random) {
    const deck = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9], random);
    return {
      rules,
      turn: 0,
      scores: Array.from({ length: rules.players }, () => 0),
      secret: Array.from({ length: rules.players }, (_, seat) => deck.slice(seat * 2, seat * 2 + 2)),
      played: [],
    };
  },

  toAct: (state) => (state.turn < state.rules.turns ? [state.turn % state.rules.players] : []),

  legalMoves: (state, seat) => [...state.secret[seat], 'pass'],

  view: (state, seat) => ({
    hand: [...state.secret[seat]],
    turn: state.turn,
    scores: [...state.scores],
    played: [...state.played],
  }),

  announce: (state) => `Turn ${state.turn + 1}.`,

  prompt: (view) => `Your hand: ${view.hand.join(', ') || 'empty'}.`,

  apply(state, moves, names) {
    const seat = state.turn % state.rules.players;
    const move = moves[seat];
    state.turn++;
    if (move === 'pass') return `${names[seat]} passes.`;
    state.secret[seat] = state.secret[seat].filter((card) => card !== move);
    state.scores[seat] += move + state.rules.gain;
    state.played.push(move);
    return `${names[seat]} plays ${move}.`;
  },
};
