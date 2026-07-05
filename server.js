// ============================================================
// PAC-PARTY — multiplayer Pac-Man server
// Node + Express + Socket.io
// The server is AUTHORITATIVE: it runs the whole game and
// broadcasts state. Clients only send inputs and render.
// ============================================================
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
// maxHttpBufferSize raised so short recorded voice messages (base64 data URLs)
// fit through the socket — default is 1MB which a 5-8s clip can exceed.
const io = new Server(server, { maxHttpBufferSize: 6 * 1024 * 1024 });

app.use(express.static(path.join(__dirname, "public")));

// ---------- Maze ----------
// # wall   . pellet   o power pellet   S spawn   (space) empty corridor
const MAZE = [
  "###################",
  "#........#........#",
  "#o##.###.#.###.##o#",
  "#.................#",
  "#.##.#.#####.#.##.#",
  "#....#...#...#....#",
  "####.###.#.###.####",
  "####.#.......#.####",
  "####.#.## ##.#.####",
  "#......#SSS#......#",
  "####.#.#####.#.####",
  "####.#.......#.####",
  "#....#.#####.#....#",
  "#.##.....#.....##.#",
  "#o.#.###.#.###.#.o#",
  "#..#.#.......#.#..#",
  "##.#.#.#####.#.#.##",
  "#....#...#...#....#",
  "#.######.#.######.#",
  "#.................#",
  "###################",
];
const ROWS = MAZE.length;
const COLS = MAZE[0].length;

// Spawn points: the four corners + two side corridors (max 6 players).
// (The walled 'S' box in the maze center is left as a decorative ghost house.)
const SPAWNS = [
  { r: 1, c: 1 }, { r: 1, c: 17 },
  { r: 19, c: 17 }, { r: 19, c: 1 },
  { r: 9, c: 1 }, { r: 9, c: 17 },
];

const isWall = (r, c) =>
  r < 0 || r >= ROWS || c < 0 || c >= COLS || MAZE[r][c] === "#";

// ---------- Game constants ----------
const TICK_MS = 50;            // 20 updates per second
const SPEED = 4.2;             // cells per second
const POWER_SPEED = 1.3;       // powered players move 30% faster (hunts can land)
const POWER_MS = +process.env.POWER_MS || 8000;   // power pellet duration
const POWER_RESPAWN_MS = +process.env.POWER_RESPAWN_MS || 20000; // power pellet comeback
const DEFAULT_GAME_SECONDS = 120;   // round length (default, host can change)
const MIN_GAME_SECONDS = 30;        // shortest round the host can set
const MAX_GAME_SECONDS = 600;       // longest round the host can set (10 min)
const LIVES = 3;               // chomps you can survive
const RESPAWN_FREEZE_MS = +process.env.RESPAWN_FREEZE_MS || 1500;
const COLORS = ["#ffdd00", "#00e5ff", "#ff5fa2", "#ff9f1c", "#7CFF6B", "#b388ff"];
const DIRS = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };

// ---------- Speed presets ----------
// Multiplies SPEED / POWER_SPEED. Host picks one from the lobby (or the
// pre-game settings modal on the home screen).
const SPEED_PRESETS = [
  { id: "slow", name: "SLOW", mult: 0.75 },
  { id: "normal", name: "NORMAL", mult: 1 },
  { id: "fast", name: "FAST", mult: 1.3 },
  { id: "turbo", name: "TURBO", mult: 1.6 },
];
const DEFAULT_SPEED_ID = "normal";

// ---------- Music ----------
// 5 selectable tracks. Drop your mp3/ogg files into /public/music/ using
// these exact filenames (or edit the "file" paths below to match yours),
// then rename "name" to whatever you want shown in the lobby UI.
const MUSIC_TRACKS = [
  { id: 1, name: "Bargad", file: "/music/bargad - SouthMelody.mp3" },
  { id: 2, name: "Dai Dai Shakira", file: "/music/Dai Dai Shakira Burna Boy - SouthMelody.mp3" },
  { id: 3, name: "Kavkaz", file: "/music/Kavkaz - SouthMelody.mp3" },
  { id: 4, name: "Oye Hoye Kya Scene Hai", file: "/music/Oye Hoye Kya Scene Hai - SouthMelody.mp3" },
  { id: 5, name: "Udi Udi", file: "/music/Udi Udi - SouthMelody.mp3" },
];

// ---------- Chat / voice message limits ----------
const MAX_CHAT_LEN = 200;
const CHAT_COOLDOWN_MS = 500;      // basic flood protection
const VOICE_COOLDOWN_MS = 2000;    // voice clips are heavier, throttle harder
const MAX_VOICE_DATAURL_LEN = 6 * 1024 * 1024; // ~6MB base64 string ceiling

// ---------- Rooms ----------
const rooms = new Map(); // code -> room

function makeCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += chars[(Math.random() * chars.length) | 0];
  } while (rooms.has(code));
  return code;
}

function freshPellets() {
  // pellets stored as "r,c" -> 1 (normal) or 2 (power)
  const p = new Map();
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      if (MAZE[r][c] === ".") p.set(`${r},${c}`, 1);
      if (MAZE[r][c] === "o") p.set(`${r},${c}`, 2);
    }
  return p;
}

function createRoom(hostId) {
  const code = makeCode();
  const room = {
    code,
    hostId,
    phase: "lobby", // lobby | playing | over
    players: new Map(),
    pellets: null,
    powerRespawns: [],  // [{ key, at }] — power pellets waiting to come back
    dotsLeft: 0,        // normal pellets remaining (win condition counts only these)
    endsAt: 0,
    interval: null,
    settings: {
      gameSeconds: DEFAULT_GAME_SECONDS,
      musicTrackId: null, // null = no music
      speedId: DEFAULT_SPEED_ID,
    },
  };
  rooms.set(code, room);
  return room;
}

function addPlayer(room, socket, name) {
  const idx = room.players.size;
  const spawn = SPAWNS[idx % SPAWNS.length];
  room.players.set(socket.id, {
    id: socket.id,
    name: String(name || "Player").slice(0, 12),
    color: COLORS[idx % COLORS.length],
    r: spawn.r, c: spawn.c,       // float position in cell units
    spawn,
    dir: null,                     // current direction key
    want: null,                    // queued direction key
    score: 0,
    lives: 3,
    dead: false,
    poweredUntil: 0,
    frozenUntil: 0,
    lastChatAt: 0,
    lastVoiceAt: 0,
  });
}

function lobbySnapshot(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    palette: COLORS,
    tracks: MUSIC_TRACKS,
    speeds: SPEED_PRESETS,
    settings: room.settings,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color,
    })),
  };
}

// ---------- Game loop ----------
function startGame(room) {
  room.phase = "playing";
  room.pellets = freshPellets();
  room.powerRespawns = [];
  room.dotsLeft = [...room.pellets.values()].filter(k => k === 1).length;
  const gameSeconds = room.settings.gameSeconds || DEFAULT_GAME_SECONDS;
  room.endsAt = Date.now() + gameSeconds * 1000;
  let i = 0;
  for (const p of room.players.values()) {
    const spawn = SPAWNS[i % SPAWNS.length];
    Object.assign(p, {
      r: spawn.r, c: spawn.c, spawn,
      dir: null, want: null, score: 0, lives: 3, dead: false,
      poweredUntil: 0, frozenUntil: 0,
    });
    i++;
  }
  const track = MUSIC_TRACKS.find(t => t.id === room.settings.musicTrackId) || null;
  io.to(room.code).emit("gameStart", {
    maze: MAZE,
    pellets: [...room.pellets.entries()],
    endsAt: room.endsAt,
    startedAt: Date.now(),
    music: track,
  });
  room.interval = setInterval(() => tick(room), TICK_MS);
}

function tick(room) {
  const now = Date.now();
  const dt = TICK_MS / 1000;
  const speedMult = (SPEED_PRESETS.find(s => s.id === room.settings.speedId) || {}).mult || 1;

  for (const p of room.players.values()) {
    if (p.dead || now < p.frozenUntil) continue;
    const boost = now < p.poweredUntil ? POWER_SPEED : 1;
    movePlayer(p, SPEED * boost * speedMult * dt);
    eatPellets(room, p, now);
  }
  handleCollisions(room, now);

  // bring eaten power pellets back after their cooldown
  while (room.powerRespawns.length && room.powerRespawns[0].at <= now) {
    const { key } = room.powerRespawns.shift();
    room.pellets.set(key, 2);
    io.to(room.code).emit("pelletSpawned", { key, kind: 2 });
  }

  io.to(room.code).emit("state", {
    now,
    players: [...room.players.values()].map(p => ({
      id: p.id, r: +p.r.toFixed(3), c: +p.c.toFixed(3),
      dir: p.dir, score: p.score,
      lives: p.lives, dead: p.dead,
      powered: now < p.poweredUntil,
      frozen: now < p.frozenUntil,
    })),
  });

  // End when: all normal dots eaten, time up, or last pac standing
  const alive = [...room.players.values()].filter(p => !p.dead).length;
  const lastStanding = room.players.size > 1 && alive <= 1;
  if (room.dotsLeft === 0 || now >= room.endsAt || lastStanding) endGame(room);
}

// Classic corridor movement: turn only when aligned with a cell center
function movePlayer(p, step) {
  const nearCenter =
    Math.abs(p.r - Math.round(p.r)) < 0.18 &&
    Math.abs(p.c - Math.round(p.c)) < 0.18;

  if (p.want && nearCenter) {
    const [dr, dc] = DIRS[p.want];
    if (!isWall(Math.round(p.r) + dr, Math.round(p.c) + dc)) {
      p.r = Math.round(p.r); p.c = Math.round(p.c); // snap onto the rail
      p.dir = p.want; p.want = null;
    }
  }
  if (!p.dir) return;

  const [dr, dc] = DIRS[p.dir];
  const nr = p.r + dr * step;
  const nc = p.c + dc * step;
  // Cell we'd be entering at the leading edge
  const edgeR = Math.round(nr + dr * 0.45);
  const edgeC = Math.round(nc + dc * 0.45);
  if (isWall(edgeR, edgeC)) {
    p.r = Math.round(p.r); p.c = Math.round(p.c); // stop flush at the wall
    p.dir = null;
  } else {
    p.r = nr; p.c = nc;
  }
}

function eatPellets(room, p, now) {
  const key = `${Math.round(p.r)},${Math.round(p.c)}`;
  const kind = room.pellets.get(key);
  if (!kind) return;
  room.pellets.delete(key);
  if (kind === 1) {
    p.score += 10;
    room.dotsLeft--;
  } else {
    p.score += 50;
    p.poweredUntil = now + POWER_MS;
    room.powerRespawns.push({ key, at: now + POWER_RESPAWN_MS }); // it'll be back
  }
  io.to(room.code).emit("pelletEaten", { key, by: p.id, kind });
}

function handleCollisions(room, now) {
  const ps = [...room.players.values()];
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      if (a.dead || b.dead) continue;
      if (now < a.frozenUntil || now < b.frozenUntil) continue;
      const close = Math.abs(a.r - b.r) < 0.6 && Math.abs(a.c - b.c) < 0.6;
      if (!close) continue;
      const aPow = now < a.poweredUntil, bPow = now < b.poweredUntil;
      if (aPow === bPow) continue;            // both or neither powered: pass through
      const [hunter, prey] = aPow ? [a, b] : [b, a];
      hunter.score += 200;
      prey.lives--;
      if (prey.lives <= 0) {
        prey.dead = true;
        prey.dir = prey.want = null;
        io.to(room.code).emit("eliminated", {
          hunter: hunter.id, prey: prey.id,
        });
      } else {
        prey.r = prey.spawn.r; prey.c = prey.spawn.c;
        prey.dir = prey.want = null;
        prey.frozenUntil = now + RESPAWN_FREEZE_MS;
      }
      io.to(room.code).emit("chomp", {
        hunter: hunter.id, prey: prey.id, livesLeft: prey.lives,
      });
    }
}

function endGame(room) {
  clearInterval(room.interval);
  room.interval = null;
  room.phase = "over";
  const ranking = [...room.players.values()]
    .sort((a, b) => (a.dead - b.dead) || (b.score - a.score)) // alive first, then score
    .map(p => ({
      id: p.id, name: p.name, color: p.color,
      score: p.score, dead: p.dead, lives: p.lives,
    }));
  io.to(room.code).emit("gameOver", { ranking });
}

// Validates + applies a partial settings patch onto a room. Shared by
// createRoom (initial settings from the home-screen modal) and the
// in-lobby updateSettings handler.
function applySettings(room, { gameSeconds, musicTrackId, speedId } = {}) {
  if (gameSeconds !== undefined) {
    const n = Math.round(Number(gameSeconds));
    if (Number.isFinite(n)) {
      room.settings.gameSeconds = Math.min(MAX_GAME_SECONDS, Math.max(MIN_GAME_SECONDS, n));
    }
  }
  if (musicTrackId !== undefined) {
    room.settings.musicTrackId =
      musicTrackId === null ? null : (MUSIC_TRACKS.find(t => t.id === musicTrackId)?.id ?? room.settings.musicTrackId);
  }
  if (speedId !== undefined) {
    room.settings.speedId = SPEED_PRESETS.find(s => s.id === speedId)?.id ?? room.settings.speedId;
  }
}

// ---------- Socket wiring ----------
io.on("connection", (socket) => {
  let joined = null; // room code this socket is in

  // Lets the home-screen settings modal show track/speed options before
  // a room even exists.
  socket.emit("musicTracks", MUSIC_TRACKS);
  socket.emit("speedPresets", SPEED_PRESETS);

  socket.on("createRoom", ({ name, settings } = {}, cb) => {
    const room = createRoom(socket.id);
    applySettings(room, settings);
    addPlayer(room, socket, name);
    socket.join(room.code);
    joined = room.code;
    cb({ ok: true, room: lobbySnapshot(room) });
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    const room = rooms.get(String(code || "").toUpperCase().trim());
    if (!room) return cb({ ok: false, error: "Room not found. Check the code." });
    if (room.phase !== "lobby") return cb({ ok: false, error: "Game already in progress." });
    if (room.players.size >= 6) return cb({ ok: false, error: "Room is full (6 max)." });
    addPlayer(room, socket, name);
    socket.join(room.code);
    joined = room.code;
    io.to(room.code).emit("lobbyUpdate", lobbySnapshot(room));
    cb({ ok: true, room: lobbySnapshot(room) });
  });

  socket.on("rename", (name) => {
    const room = rooms.get(joined);
    if (!room || room.phase !== "lobby") return;
    const p = room.players.get(socket.id);
    const clean = String(name || "").trim().slice(0, 12);
    if (!p || !clean) return;
    p.name = clean;
    io.to(room.code).emit("lobbyUpdate", lobbySnapshot(room));
  });

  socket.on("pickColor", (color) => {
    const room = rooms.get(joined);
    if (!room || room.phase !== "lobby") return;
    const p = room.players.get(socket.id);
    if (!p || !COLORS.includes(color)) return;
    const taken = [...room.players.values()].some(o => o.id !== socket.id && o.color === color);
    if (taken) return;
    p.color = color;
    io.to(room.code).emit("lobbyUpdate", lobbySnapshot(room));
  });

  socket.on("updateSettings", (patch) => {
    const room = rooms.get(joined);
    if (!room || room.hostId !== socket.id || room.phase !== "lobby") return;
    applySettings(room, patch);
    io.to(room.code).emit("lobbyUpdate", lobbySnapshot(room));
  });

  socket.on("startGame", () => {
    const room = rooms.get(joined);
    if (room && room.hostId === socket.id && room.phase === "lobby" && room.players.size >= 1)
      startGame(room);
  });

  socket.on("input", (dir) => {
    const room = rooms.get(joined);
    if (!room || room.phase !== "playing") return;
    const p = room.players.get(socket.id);
    if (p && DIRS[dir]) p.want = dir;
  });

  // ---- text chat: works in lobby, in-game, and post-game ----
  socket.on("chatMessage", (text) => {
    const room = rooms.get(joined);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const now = Date.now();
    if (now - p.lastChatAt < CHAT_COOLDOWN_MS) return; // throttle spam
    const clean = String(text ?? "").trim().slice(0, MAX_CHAT_LEN);
    if (!clean) return;
    p.lastChatAt = now;
    io.to(room.code).emit("chatMessage", {
      id: socket.id, name: p.name, color: p.color, text: clean, ts: now,
    });
  });

  // ---- voice message: client records a short clip and sends it as a
  // base64 data URL; the server just validates + rebroadcasts it (VoIP-lite,
  // no live streaming — a "walkie-talkie clip" broadcast to the room). ----
  socket.on("voiceMessage", (audioDataUrl) => {
    const room = rooms.get(joined);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const now = Date.now();
    if (now - p.lastVoiceAt < VOICE_COOLDOWN_MS) return; // throttle spam
    if (typeof audioDataUrl !== "string" || !audioDataUrl.startsWith("data:audio/")) return;
    if (audioDataUrl.length > MAX_VOICE_DATAURL_LEN) return; // reject oversized clips
    p.lastVoiceAt = now;
    io.to(room.code).emit("voiceMessage", {
      id: socket.id, name: p.name, color: p.color, audio: audioDataUrl, ts: now,
    });
  });

  socket.on("playAgain", () => {
    const room = rooms.get(joined);
    if (room && room.hostId === socket.id && room.phase === "over") {
      room.phase = "lobby";
      io.to(room.code).emit("lobbyUpdate", lobbySnapshot(room));
      startGame(room);
    }
  });

  socket.on("disconnect", () => {
    const room = rooms.get(joined);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) {
      if (room.interval) clearInterval(room.interval);
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
    io.to(room.code).emit("lobbyUpdate", lobbySnapshot(room));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PAC-PARTY running → http://localhost:${PORT}`));
