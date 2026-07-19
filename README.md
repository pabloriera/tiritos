# Paint Arena

Paint Arena is a server-authoritative multiplayer 2D arena shooter. Level 1 is the default map; Switchback Basin and Clover Junction use the same hand-drawn semantic style.

Controls:

- Arrow Up: accelerate
- Arrow Down: brake and throw a grenade (2-second cooldown)
- Arrow Left/Right: steer
- Space: fire
- Escape: return to map selection

The map-selection screen is a local sandbox. Use Tab/Shift+Tab to change maps, the arrow keys to drive, and Space to fire before creating the game with Enter. Wall damage and blast effects work in the sandbox without starting a room.

The thin toolbar above the arena includes **Design map**. The designer provides wall and erase brushes, spawn and metro placement, adjustable brush size, and selectable/random player colors. Right-click a spawn or metro marker to remove it. Use **Preview** to drive, fire, use metros, and test destructible collision before saving. A playable map needs at least two spawns; metro stations must be omitted or placed in groups of two or more. Saving returns directly to the new map in the selection sandbox, where it can be tested and used to create a multiplayer room.

Walls create a strong friction/dissipation field as players approach them. Regular bullets keep flying until they hit a player or wall, or leave the arena. Wall impacts erase pixels from both the visible map and its collision raster, so repeated shots can open a passage. Grenades travel through walls, then damage nearby players and carve a larger opening when they detonate.

Create a room with Enter, then share the invite URL with the second player. A match starts after a three-second countdown. The first player to reach the configured death limit loses.

## Development with VS Code Dev Containers

Requirements:

- Docker.
- Visual Studio Code.
- The VS Code Dev Containers extension.

Open the repository in VS Code and run:

1. `Dev Containers: Rebuild and Reopen in Container`
2. Wait for `.devcontainer/post-create.sh` to finish.
3. Run the `Paint Arena: Develop` task.

Services:

- Web client: http://localhost:5173
- Rust server: http://localhost:8080

Custom maps are stored as JSON raster records under `maps/custom` by default. Set `CUSTOM_MAP_DIR` to a mounted persistent directory in deployed environments.

Run all validations:

```bash
bash scripts/check.sh
```

## Northflank deployment

The Northflank image includes the web client, API, and WebSocket server. Configure Northflank with:

- Dockerfile: `/Dockerfile.northflank`
- Build context: `/`
- Public HTTP port: `8080`
- Health check: `/api/monitor`

Build and test the production image locally:

```bash
docker build --file Dockerfile.northflank --tag paint-arena .
docker run --rm --publish 8080:8080 paint-arena
```

### Docker Socket Security

The `docker-outside-of-docker` Dev Container Feature gives the container access to the host Docker daemon. Treat this Dev Container as a trusted development environment, and do not run unknown repositories or untrusted code inside it.

Do not mount `/var/run/docker.sock` manually when the official Feature has already configured host Docker access.

### Docker Rootless Compatibility

After the Dev Container is built, verify Docker access from the container:

```bash
docker context show
docker version
docker info
```

If you use Docker rootless and `docker info` fails:

1. Verify on the host that Docker rootless is active.
2. Verify the selected Docker context.
3. Verify the value of `DOCKER_HOST`.
4. Do not change the Dev Container to run Docker as root.
5. Do not use `chmod 666` on the Docker socket as a permanent fix.

This setup works with traditional Docker on Linux, Docker Desktop, and Docker rootless when the daemon is accessible to the user who starts VS Code.
# tiritos
