# PAC-PARTY 👾

Real-time multiplayer Pac-Man for up to 6 players. Create a room, share the
4-letter code, everyone plays in the same maze at the same time.

**Gameplay:** everyone is a Pac-Man racing to eat pellets (10 pts). Grab a
power pellet (50 pts) and for 8 seconds you can chomp other players (+200) — and you move 30% faster while powered. Power pellets respawn 20s after being eaten, so hunting never stops.
Every player has **3 lives (♥♥♥)** — get chomped three times and you're
eliminated (you spectate the rest of the round). Round ends when pellets run
out, 2 minutes pass, or only one pac is left standing.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000 in two browser tabs to test
```

## Play with friends over the internet

The quickest way (no deployment): run locally and tunnel with ngrok —

```bash
npm start
ngrok http 3000     # share the https URL it prints
```

For a permanent link, deploy to **Railway**, **Render**, or **Fly.io**
(all support WebSockets — Vercel serverless does NOT). On Railway:
push this folder to GitHub → New Project → Deploy from repo. Done —
it reads `npm start` and `process.env.PORT` automatically.

## How it works (code tour)

```
server.js            ← ALL game logic lives here (authoritative server)
  MAZE / SPAWNS      maze layout as strings; # wall, . pellet, o power
  createRoom/join    Socket.io rooms keyed by 4-letter codes
  startGame → tick() 20Hz loop: move players, eat pellets, collisions
  movePlayer()       classic corridor movement — turns only snap at
                     cell centers, so you glide on "rails"
public/
  client.js          sends inputs, renders whatever state arrives.
                     NO game logic here — that's what stops cheating
                     and keeps every player perfectly in sync.
  index.html/css     lobby screens + CRT arcade skin
```

Key concept: **the server is the single source of truth.** Clients emit
`input("up")`; the server simulates and broadcasts `state` 20×/second;
clients just draw it. Pellet eats and chomps are separate events so the
full pellet map is only sent once at game start.

## Ideas to build next (in rough difficulty order)

- [ ] Sound effects (waka-waka on pellet, siren when powered)
- [ ] Client-side interpolation to smooth movement between ticks
- [ ] Spectator mode for players who join mid-game
- [ ] Server-controlled ghost NPCs that hunt everyone
- [ ] "Pac-Man vs Ghosts" mode: one player is Pac-Man, rest are ghosts
- [ ] Persistent leaderboard (add MongoDB — you know this part!)
