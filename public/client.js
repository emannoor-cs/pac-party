// ============================================================
// PAC-PARTY client
// Sends inputs → renders whatever state the server broadcasts.
// No game logic lives here (server is authoritative).
// ============================================================
const socket = io();

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
const show = (id) => {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $(id).classList.add("active");
};

let me = null;            // my socket id
let roomInfo = null;      // { code, hostId, players[] }
let maze = [];
let pellets = new Map();  // "r,c" -> 1|2
let players = [];         // latest server state
let playerMeta = new Map(); // id -> { name, color }
let endsAt = 0;

// preset time-limit chips shown in the lobby (seconds)
const TIME_PRESETS = [60, 120, 180, 300];

// populated by the server right after connecting (so the home-screen
// settings modal has something to show before a room even exists)
let availableTracks = [];
let availableSpeeds = [];

// settings picked from the home-screen gear modal, applied when creating
// a room; persisted locally so they stick between visits
function loadPendingSettings() {
  try { return JSON.parse(localStorage.getItem("pacparty-pending-settings")) || {}; }
  catch { return {}; }
}
let pendingSettings = Object.assign({ musicTrackId: null, speedId: "normal" }, loadPendingSettings());
function savePendingSettings() {
  localStorage.setItem("pacparty-pending-settings", JSON.stringify(pendingSettings));
}

socket.on("connect", () => { me = socket.id; });
socket.on("musicTracks", (tracks) => { availableTracks = tracks; renderPreGameModal(); });
socket.on("speedPresets", (speeds) => { availableSpeeds = speeds; renderPreGameModal(); });

// ============================================================
// HOME SCREEN INTRO — scattered wandering Pac-Men behind the
// big animated logo. Purely cosmetic, runs only while the home
// screen is showing (stops itself once you leave it).
// ============================================================
(function initHomeIntro() {
  const cvs = $("intro-canvas");
  const ctx = cvs.getContext("2d");
  const homeScreen = $("screen-home");
  const PAC_COLORS = ["#ffdd00", "#00e5ff", "#ff5fa2", "#ff9f1c", "#7CFF6B", "#b388ff"];
  let pacs = [];

  function sizeCanvas() {
    cvs.width = homeScreen.clientWidth;
    cvs.height = homeScreen.clientHeight;
  }

  function spawnPacs() {
    const count = window.innerWidth < 480 ? 7 : 12;
    pacs = Array.from({ length: count }, (_, i) => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 55; // px/sec
      return {
        x: Math.random() * cvs.width,
        y: Math.random() * cvs.height,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: 13 + Math.random() * 13,
        color: PAC_COLORS[i % PAC_COLORS.length],
        mouthPhase: Math.random() * 10,
      };
    });
  }

  let lastTs = 0;
  function loop(ts) {
    if (!homeScreen.classList.contains("active")) { lastTs = 0; return; } // stop once we leave home
    requestAnimationFrame(loop);
    const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.05) : 0;
    lastTs = ts;

    ctx.clearRect(0, 0, cvs.width, cvs.height);
    for (const p of pacs) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < p.r || p.x > cvs.width - p.r) {
        p.vx *= -1;
        p.x = Math.max(p.r, Math.min(cvs.width - p.r, p.x));
      }
      if (p.y < p.r || p.y > cvs.height - p.r) {
        p.vy *= -1;
        p.y = Math.max(p.r, Math.min(cvs.height - p.r, p.y));
      }
      p.mouthPhase += dt * 6;
      const mouthOpen = Math.abs(Math.sin(p.mouthPhase)) * 0.6 + 0.08;
      const angle = Math.atan2(p.vy, p.vx);

      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.arc(p.x, p.y, p.r, angle + mouthOpen, angle - mouthOpen + Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  sizeCanvas();
  spawnPacs();
  window.addEventListener("resize", () => { sizeCanvas(); });
  requestAnimationFrame(loop);
})();

// ---------- HOME ----------
function getName() {
  const n = $("name").value.trim();
  if (!n) {
    $("home-error").textContent = "Enter your nickname first!";
    $("name").focus();
    return null;
  }
  $("home-error").textContent = "";
  return n;
}
$("btn-create").onclick = () => {
  const name = getName();
  if (!name) return;
  socket.emit("createRoom", { name, settings: pendingSettings }, (res) => {
    if (res.ok) enterLobby(res.room);
  });
};
$("btn-join").onclick = () => {
  const name = getName();
  if (!name) return;
  socket.emit("joinRoom", { code: $("code").value, name }, (res) => {
    if (res.ok) enterLobby(res.room);
    else $("home-error").textContent = res.error;
  });
};
$("code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-join").click(); });
// Enter in the name field: join if a code is filled in, otherwise create
$("name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") ($("code").value.trim() ? $("btn-join") : $("btn-create")).click();
});

// ---------- HOME-SCREEN SETTINGS MODAL (music + speed, pre-game) ----------
const settingsModal = $("settings-modal");
$("btn-home-settings").onclick = () => { settingsModal.hidden = false; renderPreGameModal(); };
$("settings-modal-close").onclick = () => { settingsModal.hidden = true; };
settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) settingsModal.hidden = true; });

function renderPreGameModal() {
  const noneBtn = `<button class="chip-btn${pendingSettings.musicTrackId === null ? " selected" : ""}"
    data-track="" >NO MUSIC</button>`;
  const trackBtns = availableTracks.map(t => `
    <button class="chip-btn${pendingSettings.musicTrackId === t.id ? " selected" : ""}"
      data-track="${t.id}">🎵 ${escapeHtml(t.name)}</button>`).join("");
  $("pre-music-options").innerHTML = noneBtn + trackBtns;
  $("pre-music-options").querySelectorAll(".chip-btn").forEach(btn => {
    btn.onclick = () => {
      pendingSettings.musicTrackId = btn.dataset.track ? Number(btn.dataset.track) : null;
      savePendingSettings();
      renderPreGameModal();
    };
  });

  $("pre-speed-options").innerHTML = availableSpeeds.map(s => `
    <button class="chip-btn${pendingSettings.speedId === s.id ? " selected" : ""}"
      data-speed="${s.id}">${escapeHtml(s.name)}</button>`).join("");
  $("pre-speed-options").querySelectorAll(".chip-btn").forEach(btn => {
    btn.onclick = () => {
      pendingSettings.speedId = btn.dataset.speed;
      savePendingSettings();
      renderPreGameModal();
    };
  });
}

// Auto-fill room code from an invite link (?room=XXXX)
const urlCode = new URLSearchParams(location.search).get("room");
if (urlCode) $("code").value = urlCode.toUpperCase();

// ---------- LOBBY ----------
function enterLobby(room) {
  roomInfo = room;
  renderLobby();
  show("screen-lobby");
}
socket.on("lobbyUpdate", (room) => {
  roomInfo = room;
  if ($("screen-lobby").classList.contains("active") ||
      $("screen-over").classList.contains("active")) renderLobby();
});
function renderLobby() {
  $("room-code").textContent = roomInfo.code;
  $("player-count").textContent = `(${roomInfo.players.length}/6)`;
  $("player-list").innerHTML = roomInfo.players.map(p => `
    <li>
      <span class="chip" style="background:${p.color};color:${p.color}"></span>
      ${escapeHtml(p.name)}${p.id === me ? " (you)" : ""}
      ${p.id === roomInfo.hostId ? '<span class="host-tag">HOST</span>' : ""}
    </li>`).join("");

  // color picker
  const myColor = roomInfo.players.find(p => p.id === me)?.color;
  $("swatches").innerHTML = (roomInfo.palette || []).map(c => {
    const owner = roomInfo.players.find(p => p.color === c);
    const cls = c === myColor ? "swatch mine" : owner ? "swatch taken" : "swatch";
    return `<button class="${cls}" data-color="${c}" aria-label="pick color"
      style="background:${c};color:${c}" ${owner && c !== myColor ? "disabled" : ""}></button>`;
  }).join("");
  $("swatches").querySelectorAll(".swatch:not(.taken)").forEach(btn => {
    btn.onclick = () => socket.emit("pickColor", btn.dataset.color);
  });

  const isHost = me === roomInfo.hostId;
  $("btn-start").hidden = !isHost;
  $("wait-hint").hidden = isHost;

  renderSettings(isHost);
}

// ---------- LOBBY SETTINGS (time limit + music) ----------
function fmtTime(secs) {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

function renderSettings(isHost) {
  const settings = roomInfo.settings || { gameSeconds: 120, musicTrackId: null, speedId: "normal" };
  const tracks = roomInfo.tracks || [];

  // ---- time limit ----
  const isPreset = TIME_PRESETS.includes(settings.gameSeconds);
  $("time-options").innerHTML = TIME_PRESETS.map(secs => `
    <button class="chip-btn${secs === settings.gameSeconds ? " selected" : ""}"
      data-secs="${secs}" ${isHost ? "" : "disabled"}>${fmtTime(secs)}</button>`).join("");
  $("time-options").querySelectorAll(".chip-btn").forEach(btn => {
    btn.onclick = () => socket.emit("updateSettings", { gameSeconds: Number(btn.dataset.secs) });
  });
  $("time-custom-row").style.display = isHost ? "flex" : "none";
  $("time-custom").placeholder = isPreset ? "CUSTOM SECS" : `${settings.gameSeconds}s (custom)`;
  $("time-readonly").hidden = isHost;
  $("time-readonly").textContent = `time limit: ${fmtTime(settings.gameSeconds)}`;

  // ---- music ----
  const noneBtn = `<button class="chip-btn${settings.musicTrackId === null ? " selected" : ""}"
    data-track="" ${isHost ? "" : "disabled"}>NO MUSIC</button>`;
  const trackBtns = tracks.map(t => `
    <button class="chip-btn${settings.musicTrackId === t.id ? " selected" : ""}"
      data-track="${t.id}" ${isHost ? "" : "disabled"}>🎵 ${escapeHtml(t.name)}</button>`).join("");
  $("music-options").innerHTML = noneBtn + trackBtns;
  $("music-options").querySelectorAll(".chip-btn").forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.track ? Number(btn.dataset.track) : null;
      socket.emit("updateSettings", { musicTrackId: id });
    };
  });
  $("music-readonly").hidden = isHost;
  const chosen = tracks.find(t => t.id === settings.musicTrackId);
  $("music-readonly").textContent = `music: ${chosen ? chosen.name : "none"}`;

  // ---- speed ----
  const speeds = roomInfo.speeds || [];
  $("speed-options").innerHTML = speeds.map(s => `
    <button class="chip-btn${settings.speedId === s.id ? " selected" : ""}"
      data-speed="${s.id}" ${isHost ? "" : "disabled"}>${escapeHtml(s.name)}</button>`).join("");
  $("speed-options").querySelectorAll(".chip-btn").forEach(btn => {
    btn.onclick = () => socket.emit("updateSettings", { speedId: btn.dataset.speed });
  });
  $("speed-readonly").hidden = isHost;
  const chosenSpeed = speeds.find(s => s.id === settings.speedId);
  $("speed-readonly").textContent = `speed: ${chosenSpeed ? chosenSpeed.name : "normal"}`;
}
$("btn-time-custom").onclick = () => {
  const n = Number($("time-custom").value);
  if (!n) return;
  socket.emit("updateSettings", { gameSeconds: n });
  $("time-custom").value = "";
};
$("time-custom").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-time-custom").click(); });
$("room-code").onclick = async () => {
  const link = `${location.origin}?room=${roomInfo.code}`;
  try {
    await navigator.clipboard.writeText(link);
    $("copy-hint").textContent = "invite link copied!";
  } catch {
    $("copy-hint").textContent = link; // clipboard blocked → just show it
  }
};
$("btn-start").onclick = () => socket.emit("startGame");
$("btn-again").onclick = () => socket.emit("playAgain");
$("btn-rename").onclick = () => {
  const n = $("rename").value.trim();
  if (!n) return;
  socket.emit("rename", n);
  $("rename").value = "";
};
$("rename").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-rename").click(); });

// ---------- GAME START ----------
socket.on("gameStart", (data) => {
  maze = data.maze;
  pellets = new Map(data.pellets);
  endsAt = data.endsAt;
  banner = null;
  playerMeta = new Map(roomInfo.players.map(p => [p.id, p]));
  sizeCanvas();
  show("screen-game");
  requestAnimationFrame(draw);
  startMusic(data.music, data.startedAt);
});

socket.on("state", (s) => { players = s.players; });
socket.on("pelletEaten", ({ key }) => pellets.delete(key));
socket.on("pelletSpawned", ({ key, kind }) => pellets.set(key, kind));
socket.on("chomp", ({ prey }) => { if (prey === me) flash = 6; });
socket.on("eliminated", ({ prey }) => {
  const name = playerMeta.get(prey)?.name || "someone";
  banner = prey === me
    ? { text: "YOU'RE OUT — SPECTATING", until: Date.now() + 999999 }
    : { text: `${name} IS OUT!`, until: Date.now() + 2500 };
});

socket.on("gameOver", ({ ranking }) => {
  $("ranking").innerHTML = ranking.map(p => `
    <li${p.dead ? ' class="dead"' : ""}>
      <span class="chip" style="background:${p.color};color:${p.color}"></span>
      ${escapeHtml(p.name)} ${p.dead ? "💀" : ""}
      <span class="pts">${p.score}</span>
    </li>`).join("");
  const isHost = me === roomInfo.hostId;
  $("btn-again").hidden = !isHost;
  $("again-hint").hidden = isHost;
  show("screen-over");
  stopMusic();
});

// ============================================================
// MUSIC — host picks one of 5 tracks in the lobby; when the round
// starts every client loads that track and seeks to the elapsed
// time so everyone's roughly in sync. Volume/mute is a personal,
// per-device preference saved in localStorage.
// ============================================================
const bgm = $("bgm");
const muteBtn = $("btn-mute");
const volumeSlider = $("volume-slider");

function loadVolumePref() {
  const saved = localStorage.getItem("pacparty-volume");
  const muted = localStorage.getItem("pacparty-muted") === "1";
  return { vol: saved !== null ? Number(saved) : 60, muted };
}
let { vol: savedVol, muted: savedMuted } = loadVolumePref();
volumeSlider.value = savedVol;
bgm.volume = savedVol / 100;
bgm.muted = savedMuted;
muteBtn.textContent = savedMuted ? "🔇" : "🔊";

volumeSlider.addEventListener("input", () => {
  bgm.volume = Number(volumeSlider.value) / 100;
  localStorage.setItem("pacparty-volume", volumeSlider.value);
  if (Number(volumeSlider.value) > 0 && bgm.muted) {
    bgm.muted = false;
    muteBtn.textContent = "🔊";
    localStorage.setItem("pacparty-muted", "0");
  }
});
muteBtn.onclick = () => {
  bgm.muted = !bgm.muted;
  muteBtn.textContent = bgm.muted ? "🔇" : "🔊";
  localStorage.setItem("pacparty-muted", bgm.muted ? "1" : "0");
};

function startMusic(track, startedAt) {
  muteBtn.hidden = !track;
  volumeSlider.hidden = !track;
  if (!track) { bgm.pause(); bgm.removeAttribute("src"); return; }
  bgm.src = track.file;
  const elapsed = Math.max(0, (Date.now() - (startedAt || Date.now())) / 1000);
  const playFrom = () => {
    try { bgm.currentTime = elapsed % (bgm.duration || elapsed + 1 || 1); } catch { /* not seekable yet */ }
    bgm.play().catch(() => { /* autoplay blocked — user can hit unmute/volume to nudge it */ });
  };
  if (bgm.readyState >= 1) playFrom();
  else bgm.addEventListener("loadedmetadata", playFrom, { once: true });
}
function stopMusic() {
  bgm.pause();
}

// ---------- INPUT ----------
const KEYMAP = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  w: "up", s: "down", a: "left", d: "right",
  W: "up", S: "down", A: "left", D: "right",
};
document.addEventListener("keydown", (e) => {
  const dir = KEYMAP[e.key];
  if (dir && $("screen-game").classList.contains("active")) {
    e.preventDefault();
    socket.emit("input", dir);
  }
});

// Swipe controls for mobile
let touchStart = null;
const canvas = $("game");
canvas.addEventListener("touchstart", (e) => {
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
canvas.addEventListener("touchend", (e) => {
  if (!touchStart) return;
  const dx = e.changedTouches[0].clientX - touchStart.x;
  const dy = e.changedTouches[0].clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return; // tap, not swipe
  const dir = Math.abs(dx) > Math.abs(dy)
    ? (dx > 0 ? "right" : "left")
    : (dy > 0 ? "down" : "up");
  socket.emit("input", dir);
});

// On-screen D-pad — same "input" event as keyboard/swipe, just tap-driven.
// Shown only on touch/coarse-pointer devices via CSS; wiring is harmless
// to leave active everywhere (a mouse click on it works fine too).
$("dpad").querySelectorAll(".dpad-btn").forEach((btn) => {
  const fire = (e) => {
    e.preventDefault();
    btn.classList.add("pressed");
    socket.emit("input", btn.dataset.dir);
  };
  const release = () => btn.classList.remove("pressed");
  btn.addEventListener("touchstart", fire, { passive: false });
  btn.addEventListener("touchend", release);
  btn.addEventListener("touchcancel", release);
  btn.addEventListener("mousedown", fire);
  btn.addEventListener("mouseup", release);
  btn.addEventListener("mouseleave", release);
});

// ---------- RENDER ----------
const ctx = canvas.getContext("2d");
let CELL = 24;
let flash = 0;   // red flash frames when I get chomped
let banner = null; // { text, until } — elimination announcements

function sizeCanvas() {
  const rows = maze.length, cols = maze[0].length;
  const maxW = Math.min(window.innerWidth * 0.96, 560);
  const maxH = window.innerHeight * 0.7;
  CELL = Math.floor(Math.min(maxW / cols, maxH / rows));
  canvas.width = cols * CELL;
  canvas.height = rows * CELL;
}
window.addEventListener("resize", () => { if (maze.length) sizeCanvas(); });

let mouth = 0; // animated mouth angle
function draw() {
  if (!$("screen-game").classList.contains("active")) return;
  requestAnimationFrame(draw);
  mouth += 0.15;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // walls — classic maze blue with a neon glow
  ctx.strokeStyle = "#1b1bd6";
  ctx.lineWidth = Math.max(2, CELL * 0.14);
  ctx.shadowColor = "#1b1bd6";
  ctx.shadowBlur = 8;
  for (let r = 0; r < maze.length; r++)
    for (let c = 0; c < maze[0].length; c++)
      if (maze[r][c] === "#")
        ctx.strokeRect(c * CELL + 2, r * CELL + 2, CELL - 4, CELL - 4);
  ctx.shadowBlur = 0;

  // pellets
  for (const [key, kind] of pellets) {
    const [r, c] = key.split(",").map(Number);
    const x = c * CELL + CELL / 2, y = r * CELL + CELL / 2;
    if (kind === 1) {
      ctx.fillStyle = "#ffd7a8";
      ctx.beginPath(); ctx.arc(x, y, CELL * 0.1, 0, Math.PI * 2); ctx.fill();
    } else {
      const pulse = 0.22 + Math.sin(mouth * 2) * 0.05;
      ctx.fillStyle = "#00e5ff";
      ctx.shadowColor = "#00e5ff"; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(x, y, CELL * pulse, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // players — pac-man wedges facing their direction
  const ANGLES = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };
  for (const p of players) {
    if (p.dead) continue; // eliminated — they spectate
    const meta = playerMeta.get(p.id) || { color: "#fff", name: "?" };
    const x = p.c * CELL + CELL / 2, y = p.r * CELL + CELL / 2;
    const base = ANGLES[p.dir] ?? 0;
    const open = p.dir ? Math.abs(Math.sin(mouth * 3)) * 0.7 + 0.08 : 0.35;

    if (p.frozen && Math.floor(mouth * 4) % 2) continue; // blink while respawning

    ctx.save();
    if (p.powered) { ctx.shadowColor = "#00e5ff"; ctx.shadowBlur = 16; }
    ctx.fillStyle = meta.color;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, CELL * 0.42, base + open, base - open + Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // name tag — in the player's color, with a dark halo so it reads over walls
    ctx.font = `${Math.max(9, CELL * 0.38)}px VT323`;
    ctx.textAlign = "center";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeText(meta.name, x, y - CELL * 0.6);
    ctx.fillStyle = meta.color;
    ctx.fillText(meta.name, x, y - CELL * 0.6);
    if (p.id === me) {
      ctx.fillStyle = "#ffffff";
      ctx.font = `${Math.max(7, CELL * 0.26)}px VT323`;
      ctx.fillText("▲ YOU", x, y + CELL * 0.85);
    }
  }

  // got-chomped flash
  if (flash > 0) {
    ctx.fillStyle = `rgba(255, 95, 162, ${flash * 0.06})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    flash--;
  }

  // elimination banner
  if (banner && Date.now() < banner.until) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, canvas.height / 2 - CELL, canvas.width, CELL * 2);
    ctx.fillStyle = "#ff5fa2";
    ctx.font = `${CELL * 0.9}px "Press Start 2P"`;
    ctx.textAlign = "center";
    ctx.fillText(banner.text, canvas.width / 2, canvas.height / 2 + CELL * 0.3);
  }

  // HUD
  updateHud();
}

function updateHud() {
  const remain = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  $("timer").textContent = `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, "0")}`;
  const sorted = [...players].sort((a, b) => (a.dead - b.dead) || (b.score - a.score));
  $("scoreboard").innerHTML = sorted.map(p => {
    const meta = playerMeta.get(p.id) || { color: "#fff", name: "?" };
    const hearts = p.dead
      ? '<span class="out">OUT</span>'
      : '<span class="hearts">' + "♥".repeat(p.lives) + "</span>";
    return `<li${p.dead ? ' class="dead"' : ""}>
      <span class="chip" style="background:${meta.color};color:${meta.color}"></span>
      ${escapeHtml(meta.name)} ${p.score} ${hearts}</li>`;
  }).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ============================================================
// CHAT + VOICE MESSAGES — floats over every screen, works in
// lobby, mid-game, and post-game alike.
// ============================================================
const chatLog = $("chat-log");
const chatPanel = $("chat-panel");
const chatBadge = $("chat-badge");
let chatOpen = false;
let unread = 0;

$("chat-toggle").onclick = () => {
  chatOpen = !chatOpen;
  chatPanel.hidden = !chatOpen;
  if (chatOpen) {
    unread = 0;
    updateChatBadge();
    chatLog.scrollTop = chatLog.scrollHeight;
    $("chat-input").focus();
  }
};
$("chat-close").onclick = () => { chatOpen = false; chatPanel.hidden = true; };

function updateChatBadge() {
  chatBadge.hidden = unread === 0;
  chatBadge.textContent = unread > 9 ? "9+" : String(unread);
}

function timeLabel(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function appendChatEl(el) {
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  if (!chatOpen) { unread++; updateChatBadge(); }
}

socket.on("chatMessage", ({ id, name, color, text, ts }) => {
  const li = document.createElement("li");
  li.innerHTML = `<span class="cname" style="color:${color}">${escapeHtml(name)}${id === me ? " (you)" : ""}:</span>` +
    `${escapeHtml(text)}<span class="ctime">${timeLabel(ts)}</span>`;
  appendChatEl(li);
});

socket.on("voiceMessage", ({ id, name, color, audio, ts }) => {
  const li = document.createElement("li");
  li.className = "voice-msg";
  const label = document.createElement("span");
  label.className = "cname";
  label.style.color = color;
  label.textContent = `${name}${id === me ? " (you)" : ""}:`;
  const audioEl = document.createElement("audio");
  audioEl.controls = true;
  audioEl.src = audio;
  const t = document.createElement("span");
  t.className = "ctime";
  t.textContent = timeLabel(ts);
  li.append(label, audioEl, t);
  appendChatEl(li);
});

function sysMessage(text) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="sys">${escapeHtml(text)}</span>`;
  appendChatEl(li);
}

function sendChat() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("chatMessage", text);
  input.value = "";
}
$("chat-send").onclick = sendChat;
$("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

// ---- voice messages: hold the mic button to record, release to send ----
const micBtn = $("chat-mic");
const micHint = $("chat-mic-hint");
const MAX_RECORD_MS = 8000; // auto-stop long holds so clips stay small
let mediaRecorder = null;
let chunks = [];
let recordTimer = null;

async function startRecording() {
  if (mediaRecorder) return; // already recording
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    sysMessage("voice messages aren't supported on this browser");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
      mediaRecorder = null;
      if (blob.size < 300) return; // essentially silent/instant tap — skip
      const reader = new FileReader();
      reader.onload = () => socket.emit("voiceMessage", reader.result);
      reader.readAsDataURL(blob);
    };
    mediaRecorder.start();
    micBtn.classList.add("recording");
    micHint.hidden = false;
    recordTimer = setTimeout(stopRecording, MAX_RECORD_MS);
  } catch {
    sysMessage("mic permission denied — allow mic access to send voice messages");
  }
}
function stopRecording() {
  clearTimeout(recordTimer);
  micBtn.classList.remove("recording");
  micHint.hidden = true;
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
}
micBtn.addEventListener("mousedown", startRecording);
micBtn.addEventListener("mouseleave", stopRecording);
micBtn.addEventListener("mouseup", stopRecording);
micBtn.addEventListener("touchstart", (e) => { e.preventDefault(); startRecording(); }, { passive: false });
micBtn.addEventListener("touchend", (e) => { e.preventDefault(); stopRecording(); });
