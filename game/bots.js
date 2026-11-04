// The stock playtesters, which work on any game. A bot is (view, random, legal) => move.
export const bots = {
  // Always takes the highest number on offer, and otherwise the first move listed.
  hawk: (view, random, legal) => {
    const numbers = legal.filter((move) => typeof move === 'number');
    return numbers.length ? Math.max(...numbers) : legal[0];
  },
  // Plays anything.
  gambler: (view, random, legal) => legal[Math.floor(random() * legal.length)],
};
