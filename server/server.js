// Servidor minimo de salas para Kingdom Hearts Tactics.
// Solo reparte mensajes entre los jugadores de una sala; no guarda nada en disco.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_HUMANS = 4;          // jugadores humanos por sala (la partida online usa 2 de momento)
const ROOM_IDLE_MS = 30 * 60 * 1000;

const server = http.createServer((req, res) => {
  // Render hace peticiones HTTP a "/" para comprobar que el servicio vive
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('KH Tactics relay OK  salas=' + rooms.size + '\n');
});
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

const rooms = new Map();       // codigo -> { code, hostId, clients: Map(id -> ws), names: Map(id -> nombre), started, last }
let nextId = 1;

function newCode() {
  for (let i = 0; i < 200; i++) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return null;
}
function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function lobbyOf(room) {
  const players = [];
  for (const [id, name] of room.names) players.push({ id, name, host: id === room.hostId });
  return { t: 'lobby', code: room.code, host: room.hostId, started: room.started, players };
}
function broadcast(room, obj) {
  for (const ws of room.clients.values()) send(ws, obj);
}
function cleanName(n) {
  n = String(n || 'Jugador').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return n || 'Jugador';
}
function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients.delete(ws.id);
  room.names.delete(ws.id);
  ws.room = null;
  if (room.clients.size === 0) { rooms.delete(room.code); return; }
  if (ws.id === room.hostId) {
    // el anfitrion se fue: la sala se cierra para todos
    broadcast(room, { t: 'closed', reason: 'host_left' });
    for (const c of room.clients.values()) c.room = null;
    rooms.delete(room.code);
    return;
  }
  broadcast(room, { t: 'left', id: ws.id });
  broadcast(room, lobbyOf(room));
}

wss.on('connection', (ws) => {
  ws.id = nextId++;
  ws.room = null;
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  send(ws, { t: 'hello', id: ws.id });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'ping') { send(ws, { t: 'pong', n: m.n }); return; }

    if (m.t === 'create') {
      if (ws.room) leave(ws);
      const code = newCode();
      if (!code) { send(ws, { t: 'err', code: 'busy' }); return; }
      const room = { code, hostId: ws.id, clients: new Map(), names: new Map(), started: false, last: Date.now() };
      room.clients.set(ws.id, ws);
      room.names.set(ws.id, cleanName(m.name));
      ws.room = room;
      rooms.set(code, room);
      send(ws, { t: 'joined', id: ws.id, code });
      broadcast(room, lobbyOf(room));
      return;
    }

    if (m.t === 'join') {
      if (ws.room) leave(ws);
      const room = rooms.get(String(m.code || '').trim());
      if (!room) { send(ws, { t: 'err', code: 'no_room' }); return; }
      if (room.started) { send(ws, { t: 'err', code: 'started' }); return; }
      if (room.clients.size >= MAX_HUMANS) { send(ws, { t: 'err', code: 'full' }); return; }
      let name = cleanName(m.name);
      const taken = new Set(room.names.values());
      if (taken.has(name)) { let k = 2; while (taken.has(name + ' ' + k)) k++; name = name + ' ' + k; }
      room.clients.set(ws.id, ws);
      room.names.set(ws.id, name);
      ws.room = room;
      room.last = Date.now();
      send(ws, { t: 'joined', id: ws.id, code: room.code });
      broadcast(room, lobbyOf(room));
      return;
    }

    const room = ws.room;
    if (!room) return;
    room.last = Date.now();

    if (m.t === 'leave') { leave(ws); send(ws, { t: 'left_room' }); return; }

    if (m.t === 'start') {
      if (ws.id !== room.hostId) return;
      room.started = true;
      const seed = Math.floor(Math.random() * 2147483647);
      broadcast(room, { t: 'start', seed, mode: m.mode || '', ranked: false, players: lobbyOf(room).players });
      return;
    }

    // mensaje libre entre jugadores (se usara en las fases siguientes)
    if (m.t === 'relay') {
      const out = { t: 'relay', from: ws.id, d: m.d };
      if (m.to === 'all' || m.to === undefined) {
        for (const [id, c] of room.clients) if (id !== ws.id) send(c, out);
      } else {
        const c = room.clients.get(Number(m.to));
        if (c) send(c, out);
      }
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// latidos: cierra conexiones muertas y limpia salas abandonadas
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch {}
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.last > ROOM_IDLE_MS) {
      broadcast(room, { t: 'closed', reason: 'idle' });
      rooms.delete(code);
    }
  }
}, 30000);

server.listen(PORT, () => console.log('KH Tactics relay escuchando en puerto ' + PORT));
