// Ember Line: a 3-player card game of climbing a shared Line. game/check.js describes the format.
import { shuffle } from '../game/engine.js';

const seatsWithCards = (state) => state.secret.map((hand, seat) => (hand.length ? seat : -1)).filter((s) => s >= 0);

export default {
  name: 'Ember Line',
  defaults: {
    players: 3,
    deckSize: 12,
    handSize: 3,
    holds: 1, // holds each player may use per game
    penalty: 3, // points the previous player scores when you play lower
    selfPenalty: 0, // 1 = you give yourself the penalty when you go lower than your own card
    openingScores: 0, // 1 = the first card on the empty Line scores its own value
  },
  knobs: {
    deckSize: { min: 9, max: 24, integer: true },
    handSize: { min: 1, max: 8, integer: true },
    holds: { min: 0, max: 3, integer: true },
    penalty: { min: 0, max: 12, integer: true },
    selfPenalty: { min: 0, max: 1, integer: true },
    openingScores: { min: 0, max: 1, integer: true },
  },
  bots: {
    // Plays the lowest card that still beats the Line, otherwise holds, otherwise dumps its lowest card.
    climber: (view, random, legal) => {
      const cards = legal.filter((m) => m !== 'hold');
      const beats = cards.filter((c) => c > view.last);
      if (beats.length) return Math.min(...beats);
      return legal.includes('hold') ? 'hold' : Math.min(...cards);
    },
    // Always plays its highest card.
    hawk: (view, random, legal) => Math.max(...legal.filter((m) => m !== 'hold')),
    // Plays anything.
    gambler: (view, random, legal) => legal[Math.floor(random() * legal.length)],
  },

  rulesText: (rules) =>
    `Ember Line is a card game for ${rules.players} players. The cards ${1} to ${rules.deckSize} are shuffled. Each player is dealt ${rules.handSize} cards, kept secret, and the rest are set aside unseen. The Line starts empty. Seat 1 goes first, then play passes in seat order, skipping anyone with no cards left. On your turn, play one card from your hand face up onto the Line, or say "hold". Each player may hold ${rules.holds} time(s) per game; a hold passes your turn and the Line does not change. If your card is higher than the last card on the Line, you score points equal to your card. If it is lower, the player who played the last card scores ${rules.penalty} points instead${rules.selfPenalty ? ', even if that was you' : '; if that was you, nobody scores'}. ${rules.openingScores ? 'The first card on the empty Line scores its own value.' : 'The first card on the empty Line scores nothing.'} The game ends when every player has played all their cards. Most points wins, and a tie for the most is a shared win.`,

  setup(rules, random) {
    const deck = shuffle(Array.from({ length: rules.deckSize }, (_, i) => i + 1), random);
    const secret = Array.from({ length: rules.players }, (_, seat) =>
      deck.slice(seat * rules.handSize, (seat + 1) * rules.handSize).sort((a, b) => a - b),
    );
    return {
      rules,
      secret,
      aside: deck.slice(rules.players * rules.handSize), // never shown to anyone
      line: [],
      holdsLeft: secret.map(() => rules.holds),
      turn: 0,
      scores: secret.map(() => 0),
    };
  },

  toAct: (state) => (seatsWithCards(state).length ? [state.turn] : []),

  legalMoves: (state, seat) => [...state.secret[seat], ...(state.holdsLeft[seat] > 0 ? ['hold'] : [])],

  view: (state, seat) => ({
    seat,
    hand: [...state.secret[seat]],
    line: state.line.map((p) => ({ ...p })),
    last: state.line.length ? state.line[state.line.length - 1].card : 0,
    turn: state.turn,
    holdsLeft: [...state.holdsLeft],
    cardsLeft: state.secret.map((hand) => hand.length),
    scores: [...state.scores],
  }),

  announce(state) {
    const last = state.line[state.line.length - 1];
    const line = last ? `The last card on the Line is ${last.card}, played by seat ${last.seat + 1}.` : 'The Line is empty.';
    return `Seat ${state.turn + 1} to move. ${line}`;
  },

  prompt: (view) =>
    `${view.line.length ? `The last card on the Line is ${view.last}.` : 'The Line is empty.'} Your hand: ${view.hand.join(', ')}. ` +
    `${view.holdsLeft[view.seat] > 0 ? `You may play a card or hold (${view.holdsLeft[view.seat]} left).` : 'You have no holds left, so play a card.'}`,

  apply(state, moves, names) {
    const seat = state.turn;
    const move = moves[seat];
    const { penalty, selfPenalty, openingScores } = state.rules;
    let result;
    if (move === 'hold') {
      state.holdsLeft[seat]--;
      result = `${names[seat]} holds.`;
    } else {
      const last = state.line[state.line.length - 1];
      state.secret[seat] = state.secret[seat].filter((c) => c !== move);
      if (!last) {
        const gain = openingScores ? move : 0;
        state.scores[seat] += gain;
        result = `${names[seat]} opens the Line with ${move}${gain ? ` and scores ${gain}` : ''}.`;
      } else if (move > last.card) {
        state.scores[seat] += move;
        result = `${names[seat]} plays ${move}, above ${last.card}, and scores ${move}.`;
      } else if (last.seat === seat && !selfPenalty) {
        result = `${names[seat]} plays ${move}, below their own ${last.card}. Nobody scores.`;
      } else {
        state.scores[last.seat] += penalty;
        result = `${names[seat]} plays ${move}, below ${last.card}. ${names[last.seat]} scores ${penalty}.`;
      }
      state.line.push({ seat, card: move });
    }
    // Next seat that still has cards.
    for (let i = 1; i <= state.secret.length; i++) {
      const next = (seat + i) % state.secret.length;
      if (state.secret[next].length) {
        state.turn = next;
        break;
      }
    }
    if (!seatsWithCards(state).length) {
      const top = Math.max(...state.scores);
      const winners = names.filter((_, s) => state.scores[s] === top);
      result += ` Game over. ${winners.join(' and ')} ${winners.length > 1 ? 'share the win' : 'wins'} with ${top}.`;
    }
    return result;
  },
};
