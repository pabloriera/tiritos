# Paint Arena Architecture

Paint Arena is a Rust-authoritative multiplayer shooter with a vanilla TypeScript Canvas 2D client. The server owns movement, collision, portals, projectiles, damage, death, respawn, scoring, and match transitions. The browser predicts local movement for responsiveness but reconciles every room snapshot to server state.

## Repository Boundaries

- `server/` owns the HTTP API, player sessions, room lifecycle, map compilation, and the 30 Hz simulation.
- `web/` owns keyboard input, local prediction, reconciliation, interpolation, the HUD, and Canvas rendering.
- `maps/builtin/` stores the three supported map packages.
- `protocol/palette.v2.json` defines the exact semantic colors shared by every map.

## Level 1 Map Language

`level1.png` is the visual and semantic baseline. Maps use exact, flat colors:

- `#808000`: traversable floor
- `#800000`: collidable wall
- `#0080FF`: metro station square; all stations share one network
- `#FF00FF`, `#80FFFF`, `#4000FF`: player spawn circles

The built-in order is Level 1, Switchback Basin, then Clover Junction. Each `map.json` declares `numberOfPlayers`, every player's slot/color/spawn locations, and every metro station's ID/color/location. The server uses this manifest directly, so maps may contain any number of declared spawns or stations. At startup, Rust expands indexed PNG data, rejects unknown colors, and compiles wall occupancy only.

## Authoritative Tick

Clients send only authenticated, sequenced controls: accelerate, brake, turn left, turn right, and fire. Every playing-room tick performs:

1. Respawn due players.
2. Apply swept player movement against a 24-sample collision shell. A pixel-derived proximity field dissipates speed near walls, and axis-separated steps allow sliding without tunneling.
3. Move players entering a metro square to the next station, with a cooldown.
4. Create fire-rate-limited bullets and cooldown-limited grenades.
5. Sweep bullets along their traveled path for wall/player impacts. Bullet impacts append small authoritative wall craters; grenades ignore walls in flight and append a larger crater plus radial damage when their fuse expires.
6. Apply damage, deaths, kills, respawn timers, and the death-limit win condition.

The room lifecycle is `lobby → countdown → playing → ended`. A rematch returns an ended room to countdown with fresh scores and positions.

The client advances bullet and grenade circles on every animation frame using the same kind-specific speed and heading as the server. Periodic snapshots reconcile accumulated error without leaving projectiles frozen between room polls. Authoritative crater snapshots update a cached map canvas and its collision pixels only when the crater list changes.

Before room creation, the client runs a local sandbox over the selected map. Tab changes map packages, WASD predicts the same swept vehicle physics, and Space/G exercise local bullet, grenade, crater, and blast behavior without creating server state.

## Death Rules

- Three 34-damage hits eliminate a full-health player.
- Eliminated players cannot move or fire.
- Respawn occurs after two seconds at a server-selected spawn.
- Respawned players receive one second of protection.
- Reaching the configured death limit ends the match and identifies the opponent as winner.

## Networking and Rendering

Room creation and join return unpredictable per-player session tokens. Input, start, and rematch operations require the appropriate token, and old or duplicate input sequence numbers are ignored.

Active rooms publish authoritative snapshots over a latest-value WebSocket stream at the 30 Hz simulation rate. HTTP polling runs once per second only as recovery fallback. The local vehicle is predicted and drawn every animation frame; remote players and bullets are dead-reckoned every frame, then gently reconciled to snapshots. Large errors snap immediately rather than drifting through walls.

An alive-to-respawning transition creates a 650 ms expanding-ring and particle death effect at the last rendered position. The player entity remains hidden until the authoritative respawn.
