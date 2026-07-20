# Paint Arena Architecture

Paint Arena is a Rust-authoritative multiplayer shooter with a vanilla TypeScript Canvas 2D client. The server owns movement, collision, portals, projectiles, damage, death, respawn, scoring, and match transitions. The browser predicts local movement for responsiveness but reconciles every room snapshot to server state.

## Repository Boundaries

- `server/` owns the HTTP API, player sessions, room lifecycle, map compilation, and the 30 Hz simulation.
- `web/` owns keyboard input, local prediction, reconciliation, interpolation, the HUD, and Canvas rendering.
- `maps/builtin/` stores the three supported map packages.
- `maps/custom/` stores server-validated maps created with the browser designer (or `CUSTOM_MAP_DIR` when configured).
- `protocol/palette.v2.json` defines the exact semantic colors shared by every map.

## Level 1 Map Language

`level1.png` is the semantic source baseline. Source maps use exact, flat colors:

- `#808000`: traversable floor
- `#800000`: collidable wall
- `#0080FF`: metro station square; all stations share one network
- `#FF00FF`, `#80FFFF`, `#4000FF`: player spawn circles

The built-in order is Level 1, Switchback Basin, then Clover Junction. Each `map.json` declares `numberOfPlayers`, every player's slot/color/spawn locations, and every metro station's ID/color/location. The server uses this manifest directly, so maps may contain any number of declared spawns or stations. At startup, Rust expands indexed PNG data, rejects unknown colors, compiles wall occupancy, and re-renders the served image through the same raster renderer used by designer maps. The presentation palette is electric-blue floor (`#2430BE`), neon-magenta wall (`#F230BC`), and cyan metro (`#23E8EC`). This keeps visible built-in wall pixels identical to their authoritative collision masks while decoupling source semantics from presentation.

## Authoritative Tick

Clients send only authenticated, sequenced controls: accelerate, brake, turn left, turn right, and fire. Every playing-room tick performs:

1. Respawn due players.
2. Apply swept player movement against a 24-sample collision shell. A pixel-derived proximity field dissipates speed near walls, and axis-separated steps allow sliding without tunneling.
3. Move players entering a metro square to the next station. Arrival closes a per-player latch, which only rearms after leaving all metro regions, so remaining on the destination cannot trigger another trip.
4. Create fire-rate-limited bullets and cooldown-limited grenades.
5. Sweep bullets along their traveled path for wall/player impacts. Bullet impacts clear circular regions from the room's authoritative raster wall mask and append matching damage operations for clients; grenades ignore walls in flight and clear a larger region plus radial damage when their fuse expires. Regular bullets have no mid-air timer and remain in flight until they hit a wall or player, or leave the arena.
6. Apply damage, deaths, kills, respawn timers, and the death-limit win condition.

The room lifecycle is `lobby → countdown → playing → ended`. A rematch returns an ended room to countdown with fresh scores and positions.

The client advances bullet and grenade circles on every animation frame using the same kind-specific speed and heading as the server. Periodic snapshots reconcile accumulated error without leaving projectiles frozen between room polls. Authoritative crater snapshots update a cached map canvas and its collision pixels only when the crater list changes.

Before room creation, the client runs a local sandbox over the selected map. Tab changes map packages, the arrow keys use the same swept vehicle, wall, and metro physics, and Space fires without creating server state.

## Map Designer

The HUD occupies a fixed strip above the canvas, so gameplay and map-selection information never overlays the arena. It changes priorities by stage: map browsing and match creation during selection; invite and readiness during lobby/countdown; player health, score, events, and exit during play; rematch/map actions after results; and a Paint-style ribbon during design. From map selection, the designer starts with a blank 1200×675 raster floor and no implicit markers. Wall and eraser brushes modify the raster directly, while spawn and metro stamp tools maintain semantic markers separately so player colors can be freely selected without weakening collision-color detection. The ribbon groups map commands, tools, size, spawn color, and preview/save actions; it also exposes marker counts, limited undo history, and a clear action that can be undone.

Preview mode becomes available after the user places at least two spawns and completes or removes any unpaired metro station. It builds the unsaved raster and markers in memory, then runs the normal local vehicle, metro, projectile, and destructible-wall simulation without changing the editable source. Saving applies the same readiness rules and sends a compact base64 wall mask plus spawn/metro metadata to the server. The server validates dimensions, open spawn/metro locations, player counts, and metro pairing; builds the same `ValidatedMap` collision raster used by built-in rooms; renders a PNG; and persists the source record. The returned map is immediately selected and can be sandbox-tested or passed to normal room creation. Custom maps are recompiled from their persisted records on server startup.

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
