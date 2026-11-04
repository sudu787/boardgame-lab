// Salt Run, and the worked example of a game file. game/check.js describes the format.
import { bots as stock } from '../game/bots.js';
import { shuffle } from '../game/engine.js';

export default {
  name: 'Salt Run',
  defaults: {
    players: 3,
    rounds: 4,
    deckSize: 15,
    handSize: 4,
    cargo: [2, 3, 3, 4, 4, 5, 5, 6],
    finalTide: 3,
  },
  knobs: { finalTide: { min: 1, max: 5 } },
  bots: {
    // Fights for every lot.
    hawk: stock.hawk,
    // Saves strong cards for rich lots.
    turtle: (view, random, legal) => (view.cargo >= 5 ? Math.max(...legal) : Math.min(...legal)),
    // Plays anything.
    gambler: stock.gambler,
  },

  rulesText: (rules) =>
    `A secret-bid card game for ${rules.players} players, over ${rules.rounds} rounds. Each player is dealt ${rules.handSize} cards from a deck of 1 to ${rules.deckSize}, which nobody else sees. Each round one cargo lot is revealed, worth some salt, and every player secretly bids one card. The highest card takes the cargo. Every card gets played exactly once, so the last round plays itself. The last lot is multiplied by the Final Tide, currently ×${rules.finalTide}, for a dramatic finish. Most salt wins.`,

  setup(rules, random) {
    const deck = shuffle(Array.from({ length: rules.deckSize }, (_, i) => i + 1), random);
    const secret = Array.from({ length: rules.players }, (_, seat) =>
      deck.slice(seat * rules.handSize, (seat + 1) * rules.handSize).sort((a, b) => a - b),
    );
    // The Final Tide: the last lot is multiplied.
    const cargo = shuffle(rules.cargo, random)
      .slice(0, rules.rounds)
      .map((value, i) => (i === rules.rounds - 1 ? value * rules.finalTide : value));
    return { rules, secret, cargo, round: 0, scores: secret.map(() => 0), history: [] };
  },

  toAct: (state) => (state.round < state.rules.rounds ? state.secret.map((_, seat) => seat) : []),

  legalMoves: (state, seat) => [...state.secret[seat]],

  view: (state, seat) => ({
    seat,
    hand: [...state.secret[seat]],
    cargo: state.cargo[state.round],
    round: state.round + 1,
    rounds: state.rules.rounds,
    finalTide: state.rules.finalTide,
    scores: [...state.scores],
    history: state.history.map((h) => ({ ...h, bids: [...h.bids] })),
  }),

  announce(state) {
    const round = state.round + 1;
    const tide = round === state.rules.rounds ? ` That is the Final Tide, ×${state.rules.finalTide}.` : '';
    return `Round ${round}/${state.rules.rounds}: cargo worth ${state.cargo[state.round]} salt.${tide} Bids are secret.`;
  },

  prompt: (view) => `Round ${view.round}/${view.rounds}. Cargo: ${view.cargo} salt. Your hand: ${view.hand.join(', ')}.`,

  // Cards are unique, so there are never ties: the highest bid takes the cargo.
  apply(state, moves, names) {
    const cargo = state.cargo[state.round];
    const winner = moves.indexOf(Math.max(...moves));
    moves.forEach((card, seat) => {
      state.secret[seat] = state.secret[seat].filter((c) => c !== card);
    });
    state.scores[winner] += cargo;
    state.round++;
    state.history.push({ round: state.round, cargo, bids: [...moves], winner });
    const shown = moves.map((card, seat) => `${names[seat]} ${card}`).join(', ');
    return `Round ${state.round} bids: ${shown}. ${names[winner]} takes ${cargo} salt.`;
  },
};
