// The referee's game logic, with no network code. Everything it does goes through the
// functions it is given, so the rules of the room can be tested without a server.
import { applyMoves, GAME_NAME, isOver, newGame, winners } from '../game/engine.js';

const ANALYST_ROLE = 'balance-analyst';
const LOG_FILE = 'runs/last-game.txt';
const MAX_POST = 3500; // Mattermost cuts a post at 4000 characters

const pct = (n) => `${(n * 100).toFixed(1)}%`;

export function beforeAfter(before, after) {
  const rows = after.rows.map((row) => {
    const old = before.rows.find((r) => r.name === row.name);
    return `${row.name.padEnd(12)} ${(old ? pct(old.winRate) : '-').padStart(6)} ${pct(row.winRate).padStart(6)}${row.broken ? '  BROKEN' : ''}`;
  });
  const seats = (result) => result.seats.map(pct).join(', ');
  return [
    '```',
    `${'strategy'.padEnd(12)} ${'before'.padStart(6)} ${'after'.padStart(6)}`,
    ...rows,
    '',
    `All random, by seat, before: ${seats(before)}`,
    `All random, by seat, after:  ${seats(after)}`,
    '```',
  ].join('\n');
}

// A playtest's rooms share a prefix: <team>-table, <team>-seat-1 and so on.
export const teamOf = (roomName) => roomName.match(/^(.+)-(?:table|seat-\d+)$/)?.[1] ?? null;

// ponytail: one referee runs one game at a time, across all playtests, with its state in memory
// only, which also keeps hands off the disk where player agents could read them. Game files run
// in this process once the checker has passed, so one that hangs on an unusual move hangs the
// referee. Running games in a child process would fix both, if a game ever needs it.
export class Table {
  constructor({ game, rules, referee, say, isPerson, simulate, check, loadGame, saveRules, saveLog, toText }) {
    Object.assign(this, { game, rules, referee, say, isPerson, simulate, check, loadGame, saveRules, saveLog, toText });
    this.state = null;
    this.finished = false;
    this.number = 0;
    this.lastReport = null;
    this.sitting = null;
  }

  get playing() {
    return this.state !== null && !isOver(this.game, this.state);
  }

  // rooms: { table, seats: [roomId, ...] }, players: [agentName, ...] by seat.
  async handle({ roomId, sender, body }, rooms, players) {
    if ((this.playing || this.finished) && rooms.table !== this.rooms.table) {
      return this.say(roomId, 'A game is running in another playtest. Finish it first, or send `stop` there.');
    }
    this.rooms = rooms;
    const text = body.replace(/@[\w.-]+/g, '').trim();
    const reply = (message) => this.say(roomId, message);
    const fromPerson = () => this.isPerson(roomId, sender);
    const atTable = roomId === rooms.table;
    let match;

    if ((match = text.match(/^play\s+(.+)/i))) return this.play(roomId, sender, match[1].trim());
    if ((match = text.match(/^note\b[:\s]*(.*)$/is))) {
      return atTable ? this.note(sender, match[1].trim()) : reply('Notes go at the table.');
    }
    if (!atTable) return reply('Only moves belong in a seat room: `play <move>`.');
    if (/^rules\b/i.test(text)) return reply(this.describeRules());
    if (/^simulate\b/i.test(text)) return this.runSimulation();

    if ((match = text.match(/^deal(?:\s+(\d+))?\s*$/i))) {
      if (!(await fromPerson())) return reply(`Only a person can start a game, ${sender}.`);
      return this.deal(players, match[1] === undefined ? Date.now() % 1000000 : Number(match[1]));
    }
    if ((match = text.match(/^sit\s+(\S+)\s*$/i)) || /^stand\s*$/i.test(text)) {
      if (!(await fromPerson())) return reply(`Only a person can change who plays, ${sender}.`);
      if (this.playing) return reply('Finish the game before changing who plays.');
      if (!match) {
        this.sitting = null;
        return reply('The agents hold every seat again.');
      }
      const seat = Number(match[1]) - 1;
      if (!players[seat] || seat >= this.rules.players) return reply(`Pick a seat from 1 to ${this.rules.players}.`);
      this.sitting = { seat, name: sender };
      return reply(`${sender} takes seat ${seat + 1} from ${players[seat]} for the next game. Your hand and moves go in that seat's room.`);
    }
    if ((match = text.match(/^set\s+(\w+)\s*=?\s*(\S+)\s*$/i))) {
      if (!(await fromPerson())) {
        return reply(`Refused: only the designer can change the rules, ${sender}. Propose it to them instead.`);
      }
      return this.setKnob(sender, match[1], match[2]);
    }
    if ((match = text.match(/^load\s+(\S+)\s*$/i))) {
      if (!(await fromPerson())) {
        return reply(`Refused: only the designer can load a game, ${sender}. Ask them to read the sample game first.`);
      }
      return this.load(sender, match[1]);
    }
    if (/^stop\s*$/i.test(text)) {
      if (!(await fromPerson())) return reply(`Only a person can stop a game, ${sender}.`);
      this.state = null;
      this.finished = false;
      return reply('Game stopped.');
    }
    if (/^analy[sz]e\b/i.test(text) && this.finished) {
      if (!(await fromPerson())) return reply('Only a person can skip the notes.');
      return this.callAnalyst();
    }
    // Agents often mention the referee in passing, as the analyst does when it tells the designer what to send.
    if (await fromPerson()) {
      return reply('I understand: `load <game>`, `sit <seat>`, `stand`, `deal`, `stop`, `rules`, `simulate`, `set <rule>=<number>`, `analyze`, `note <text>`.');
    }
  }

  describeRules() {
    return `${this.rules.name ?? this.game.name}: ${this.game.rulesText(this.rules)}`;
  }

  async deal(players, seed) {
    if (this.playing) return this.say(this.rooms.table, 'A game is already running. To end it, send `stop`.');
    this.players = players
      .slice(0, this.rules.players)
      .map((player, seat) => (this.sitting?.seat === seat ? this.sitting.name : player));
    this.state = newGame(this.game, this.rules, seed);
    this.finished = false;
    this.notes = new Map();
    this.log = [];
    this.briefed = new Set();
    this.number++;
    await this.say(this.rooms.table, `Game ${this.number} (seed ${seed}). ${this.describeRules()}`);
    return this.startStep();
  }

  async startStep() {
    const { game, state } = this;
    this.moves = [];
    this.waiting = new Set();
    const announced = game.announce(state);
    if (announced) {
      this.log.push(announced);
      await this.say(this.rooms.table, announced);
    }
    // A seat with one legal move has no decision to make, so it plays by itself.
    for (const seat of game.toAct(state)) {
      const legal = game.legalMoves(state, seat);
      if (legal.length === 1) this.moves[seat] = legal[0];
      else this.waiting.add(seat);
    }
    if (this.waiting.size === 0) return this.resolve();
    await Promise.all([...this.waiting].map((seat) => this.prompt(seat)));
  }

  prompt(seat) {
    const { game, state } = this;
    const rules = this.briefed.has(seat) ? '' : `${game.rulesText(this.rules)}\n\n`;
    this.briefed.add(seat);
    return this.say(
      this.rooms.seats[seat],
      `@${this.players[seat]} ${rules}${game.prompt(game.view(state, seat))} You can play: ${game.legalMoves(state, seat).join(', ')}. Scores: ${this.scoreLine()}. Reply with exactly: @${this.referee} play <move>`,
    );
  }

  scoreLine() {
    return this.players.map((player, seat) => `${player} ${this.state.scores[seat]}`).join(', ');
  }

  async play(roomId, sender, raw) {
    const seat = this.rooms.seats.indexOf(roomId);
    // Refused at the table so that a mistaken move is not repeated in the open.
    if (seat < 0) return this.say(roomId, 'Moves go in your private seat room.');
    if (!this.playing) return this.say(roomId, 'No round is waiting for a move.');
    if (sender !== this.players[seat]) return this.say(roomId, `This seat belongs to ${this.players[seat] ?? 'nobody in this game'}.`);
    if (!this.waiting.has(seat)) {
      const played = this.moves[seat];
      return this.say(roomId, played === undefined ? 'It is not your turn.' : `You already played ${played} this round.`);
    }
    const legal = this.game.legalMoves(this.state, seat);
    const move = legal.find((option) => String(option).toLowerCase() === raw.toLowerCase());
    if (move === undefined) {
      return this.say(roomId, `@${sender} You cannot play ${raw}. You can play: ${legal.join(', ')}. Reply with exactly: @${this.referee} play <move>`);
    }
    this.moves[seat] = move;
    this.waiting.delete(seat);
    await this.say(roomId, `Move ${move} locked in.`);
    if (this.waiting.size === 0) return this.resolve();
  }

  async resolve() {
    const line = applyMoves(this.game, this.state, this.moves, this.players);
    this.log.push(line);
    await this.say(this.rooms.table, `${line} Scores: ${this.scoreLine()}.`);
    return isOver(this.game, this.state) ? this.finish() : this.startStep();
  }

  async finish() {
    this.finished = true;
    const champions = winners(this.state).map((seat) => this.players[seat]).join(' and ');
    const result = `Game ${this.number} over. Winner: ${champions}. Final scores: ${this.scoreLine()}.`;
    this.log.push(result);
    await this.say(this.rooms.table, result);
    const mentions = this.players.map((player) => `@${player}`).join(' ');
    await this.say(
      this.rooms.table,
      `${mentions} One line each, here at the table, in the form "@${this.referee} note <text>": what decided this game, and how would you play differently?`,
    );
  }

  async note(sender, text) {
    if (!this.finished) return this.say(this.rooms.table, 'Notes come after the game.');
    if (!this.players.includes(sender)) return this.say(this.rooms.table, 'Only the players leave notes.');
    this.notes.set(sender, text);
    if (this.notes.size === this.players.length) return this.callAnalyst();
  }

  async callAnalyst() {
    this.finished = false;
    const notes = [...this.notes].map(([player, text]) => `${player}: ${text}`);
    const log = [...this.log, ...notes].join('\n');
    await this.saveLog(log);
    const lead = `@${ANALYST_ROLE} Game ${this.number} is finished. Look for a strategy that beats the field.`;
    const post = `${lead}\n${log}`;
    return this.say(this.rooms.table, post.length <= MAX_POST ? post : `${lead} The log and notes are too long to post, so read ${LOG_FILE}.`);
  }

  async runSimulation() {
    this.lastReport = await this.simulate(this.rules);
    return this.say(this.rooms.table, ['```', this.toText(this.lastReport), '```'].join('\n'));
  }

  async setKnob(sender, name, raw) {
    const table = this.rooms.table;
    const knobs = this.game.knobs ?? {};
    if (!Object.hasOwn(knobs, name)) {
      return this.say(table, `${this.game.name} has no rule called ${name}. You can change: ${Object.keys(knobs).join(', ') || 'nothing yet'}.`);
    }
    const { min, max, integer } = knobs[name];
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      return this.say(table, `${name} must be a${integer ? ' whole' : ''} number from ${min} to ${max}.`);
    }
    if (this.playing) return this.say(table, 'Finish the game before changing the rules.');
    const before = this.lastReport ?? (await this.simulate(this.rules));
    const was = this.rules[name];
    this.rules = { ...this.rules, name: `${this.game.name} (designer edit)`, [name]: value };
    await this.saveRules(this.rules);
    this.lastReport = await this.simulate(this.rules);
    return this.say(table, [`Rule changed by ${sender}: ${name} ${was} is now ${value}.`, beforeAfter(before, this.lastReport)].join('\n'));
  }

  async load(sender, name) {
    const table = this.rooms.table;
    if (this.playing) return this.say(table, 'Finish the game before loading another.');
    if (!GAME_NAME.test(name)) return this.say(table, 'Game names use lowercase letters, digits and hyphens.');
    const { ok, output } = await this.check(name);
    if (!ok) return this.say(table, `Not loaded, because the checker refused it:\n${output}`);
    this.game = await this.loadGame(name);
    this.rules = { game: name, ...this.game.defaults };
    this.state = null;
    this.finished = false;
    this.lastReport = null;
    if (this.sitting?.seat >= this.rules.players) this.sitting = null;
    await this.saveRules(this.rules);
    return this.say(table, `${sender} loaded ${this.game.name}.\n${output}`);
  }
}
