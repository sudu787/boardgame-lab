// The referee: a Switch agent made of plain code, with no LLM. It connects over
// Switch's agent protocol and runs the game in table.js.
//   node --env-file-if-exists=.env referee/referee.js register
//   node --env-file-if-exists=.env referee/referee.js
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, promisify } from 'node:util';
import { loadGame } from '../game/engine.js';
import { toText } from '../game/simulate.js';
import { Table, teamOf } from './table.js';

// Where Switch Console keeps the local server it runs.
function localServerDir() {
  const base =
    process.platform === 'win32' ? process.env.APPDATA
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  return join(base, 'switchdash', 'local-switch-server');
}

function localApiUrl() {
  const ports = join(localServerDir(), 'ports.json');
  if (!existsSync(ports)) {
    throw new Error('No local Switch server found. In Switch Console, choose "Run a server on this computer" first. For another server, set SWITCH_URL in .env.');
  }
  return `http://127.0.0.1:${JSON.parse(readFileSync(ports, 'utf8')).api}`;
}

const ROOT = join(import.meta.dirname, '..');
const BASE = (process.env.SWITCH_URL ?? localApiUrl()).replace(/\/$/, '');
const NAME = process.env.REFEREE_NAME ?? 'boardgame-referee';
const IDENTITY = join(ROOT, '.referee.json');
const CURRENT_RULES = join(ROOT, 'runs', 'rules.current.json');
const LAST_GAME = join(ROOT, 'runs', 'last-game.txt');
const SIMULATE_TIMEOUT_MS = 60000;
const CHECK_TIMEOUT_MS = 60000;
const RECONNECT_MS = 2000;
const REQUEST_TIMEOUT_MS = 30000;
const WATCHDOG_MS = 5000;
const STALL_MS = 15000; // the server pings every 2 seconds

async function request(token, method, path, body) {
  // The timeout stops one stuck call from holding up every message queued behind it.
  const response = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// A server Console runs has no dashboard, so no API Keys page. This signs in with the admin
// login Console generated for that server and makes the call the page would. It keeps
// neither the login nor the key: only the referee's own key is saved.
async function registrationKey() {
  if (process.env.SWITCH_REGISTRATION_KEY) return process.env.SWITCH_REGISTRATION_KEY;
  const settings = join(localServerDir(), 'native', 'run', 'switch-core.env');
  if (!existsSync(settings)) {
    throw new Error('No local server settings found. Set SWITCH_REGISTRATION_KEY in .env (Gateway, API Keys).');
  }
  const { GATEWAY_ADMIN_EMAIL: email, GATEWAY_ADMIN_PASSWORD: password } = parseEnv(readFileSync(settings, 'utf8'));
  const headers = { 'Content-Type': 'application/json' };
  const login = await fetch(`${BASE}/gateway/auth/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`Signing in to the local server failed: ${login.status}`);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const created = await fetch(`${BASE}/gateway/api-keys`, {
    method: 'POST',
    headers: { ...headers, Cookie: cookie },
    body: JSON.stringify({ label: `${NAME} registration` }),
  });
  if (!created.ok) throw new Error(`Creating a registration key failed: ${created.status}`);
  return (await created.json()).key;
}

async function register() {
  if (existsSync(IDENTITY)) throw new Error(`${IDENTITY} exists, so ${NAME} is already registered.`);
  const { id, api_key } = await request(await registrationKey(), 'POST', '/agents', {
    name: NAME,
    display_name: 'Referee',
    description: 'Plain code that runs the game, enforces its rules and runs the simulator.',
    connector_type: 'boardgame-lab',
    integration_profile: {
      connection_model: 'always_on',
      message_exchange: true,
      pre_invocation_mediation: [],
      post_invocation_mediation: [],
      event_reporting: [],
    },
  });
  // A new agent already answers its owner and the owner's other agents, which is what the referee needs.
  writeFileSync(IDENTITY, JSON.stringify({ id, api_key, connection_id: randomUUID() }, null, 2));
  console.log(`Registered ${NAME}. Its key is in ${IDENTITY}.`);
}

async function run() {
  if (!existsSync(IDENTITY)) throw new Error('Run `npm run referee:register` first.');
  const { id, api_key: key, connection_id: connectionId } = JSON.parse(readFileSync(IDENTITY, 'utf8'));

  const say = (roomId, content) => request(key, 'POST', `/agents/${id}/message`, { room_id: roomId, content });
  const participants = async (roomId) =>
    (await request(key, 'GET', `/agents/rooms/${roomId}/participants`)).participants;

  // An agent's sender_name is always its fixed identifier, so it cannot pose as a person.
  const isPerson = async (roomId, senderName) => {
    const everyone = await participants(roomId);
    return (
      everyone.some((p) => p.type === 'user' && p.name === senderName) &&
      !everyone.some((p) => p.type === 'agent' && p.name === senderName)
    );
  };

  const saveRules = (rules) => {
    mkdirSync(join(ROOT, 'runs'), { recursive: true });
    writeFileSync(CURRENT_RULES, JSON.stringify(rules, null, 2));
  };

  const saveLog = (text) => {
    mkdirSync(join(ROOT, 'runs'), { recursive: true });
    writeFileSync(LAST_GAME, text);
  };

  const runFile = promisify(execFile);

  // Child processes, because strategies/ and games/ hold code an agent wrote, which may hang or crash.
  const simulate = async () => {
    const { stdout } = await runFile(
      process.execPath,
      ['game/simulate.js', '--rules', CURRENT_RULES, '--strategies', 'strategies', '--json'],
      { cwd: ROOT, timeout: SIMULATE_TIMEOUT_MS },
    );
    return JSON.parse(stdout);
  };

  const check = async (name) => {
    try {
      const { stdout } = await runFile(process.execPath, ['game/check.js', name], { cwd: ROOT, timeout: CHECK_TIMEOUT_MS });
      return { ok: true, output: stdout.trim() };
    } catch (error) {
      const output = error.killed ? 'The check timed out, so the game may be stuck in a loop.' : error.stdout?.trim() || error.message;
      return { ok: false, output };
    }
  };

  const rules = JSON.parse(readFileSync(process.env.RULES_FILE ?? join(ROOT, 'game', 'rules.v1.json'), 'utf8'));
  saveRules(rules);
  const table = new Table({
    game: await loadGame(rules.game),
    rules,
    referee: NAME,
    say,
    isPerson,
    simulate,
    check,
    loadGame,
    saveRules,
    saveLog,
    toText,
  });

  // The playtest comes from the room the message arrived in, so several can exist side by side.
  async function findRooms(roomId) {
    const { result } = await request(key, 'POST', `/agents/${id}/ops/list_rooms`, {});
    const team = teamOf(result.find((room) => room.room_id === roomId)?.name ?? '');
    if (!team) return null;
    const tableRoom = result.find((room) => room.name === `${team}-table`)?.room_id;
    const seats = [1, 2, 3].map((n) => result.find((room) => room.name === `${team}-seat-${n}`)?.room_id);
    if (!tableRoom || seats.includes(undefined)) throw new Error(`Some of the rooms for ${team} are missing.`);
    return { table: tableRoom, seats };
  }

  async function findPlayers(rooms) {
    return Promise.all(
      rooms.seats.map(async (roomId) => {
        const agents = (await participants(roomId)).filter((p) => p.type === 'agent' && p.name !== NAME);
        if (agents.length !== 1) throw new Error(`Seat room ${roomId} needs exactly one player agent.`);
        return agents[0].name;
      }),
    );
  }

  // Events run one at a time, in order. Pings are answered outside this queue.
  let queue = Promise.resolve();
  let cursor = null;
  let generation = null;
  let current = null;

  async function onMessage(data) {
    const { sender_name: sender, body } = data.payload;
    if (sender === NAME || !data.payload.addressed) return;
    console.log(`[${data.room_id}] ${sender}: ${body}`);
    try {
      const rooms = await findRooms(data.room_id);
      if (!rooms) return await say(data.room_id, 'I only run games in a playtest. Talk to me in a room ending in -table.');
      await table.handle({ roomId: data.room_id, sender, body }, rooms, await findPlayers(rooms));
    } catch (error) {
      console.error(error);
      await say(data.room_id, `Referee error: ${error.message}`).catch(console.error);
    }
  }

  function connect() {
    const query = new URLSearchParams({
      connection_id: connectionId,
      scope: 'all',
      filter: 'addressed',
      client: 'boardgame-lab-referee',
    });
    if (cursor !== null) query.set('start_from', String(cursor));
    if (generation !== null) query.set('expected_generation', String(generation));
    const socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}/agents/${id}/connection/ws?${query}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    current = socket;

    // A connection can go silent without closing, for example after the computer sleeps.
    let lastFrame = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastFrame < STALL_MS) return;
      console.log('No word from the server, so reconnecting.');
      clearInterval(watchdog);
      current = null;
      setTimeout(connect, RECONNECT_MS);
      socket.close();
    }, WATCHDOG_MS);

    let final = false;
    socket.onmessage = ({ data: raw }) => {
      if (socket !== current) return; // a replaced socket's last frames, such as its eviction
      lastFrame = Date.now();
      const frame = JSON.parse(raw);
      if (frame.event === 'ping') return socket.send(JSON.stringify({ type: 'pong', cursor: cursor ?? 0 }));
      if (frame.event === 'connection_state') {
        generation = frame.data.generation;
        cursor = cursor ?? frame.data.cursor;
        return console.log(`Connected as ${NAME}, covering ${frame.data.rooms.length} room(s).`);
      }
      if (frame.event === 'evicted' && frame.data.code === 'taken_over') {
        final = true;
        return console.error('Another referee took over this connection, so this one is stopping.');
      }
      if (frame.event === 'refused') return console.error(`Refused: ${frame.data.status} ${JSON.stringify(frame.data.detail)}`);
      if (frame.event === 'message') {
        queue = queue.then(() => onMessage(frame.data)).then(() => { cursor = frame.id; });
      }
    };
    socket.onerror = (event) => {
      if (socket === current) console.error('Socket error:', event.message ?? event.type);
    };
    socket.onclose = ({ code }) => {
      clearInterval(watchdog);
      if (socket !== current) return;
      if (final || code === 4401) {
        console.error(`Stopped, close code ${code}.`);
        process.exit(1);
      }
      // A refused generation would be refused again on every retry, so take the connection back outright.
      if (code === 4409) generation = null;
      console.log(`Socket closed (${code}), reconnecting.`);
      setTimeout(connect, RECONNECT_MS);
    };
  }

  connect();
}

await (process.argv[2] === 'register' ? register() : run());
