# Paint Arena

Paint Arena is a server-authoritative multiplayer 2D arena shooter. Level 1 is the default map; Switchback Basin and Clover Junction use the same hand-drawn semantic style.

Controls:

- Arrow Up: accelerate
- Arrow Down: brake and throw a grenade (2-second cooldown)
- Arrow Left/Right: steer
- Space: fire
- G: throw a grenade
- Escape: return to map selection

The map-selection screen is a local sandbox. Use Tab/Shift+Tab to change maps, WASD to drive, Space to fire, and G to throw grenades before creating the game with Enter. Wall damage and blast effects work in the sandbox without starting a room.

Walls create a strong friction/dissipation field as players approach them. Regular bullets chip small holes into walls; grenades travel through walls, then damage nearby players and carve a larger opening when they detonate.

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

Run all validations:

```bash
bash scripts/check.sh
```

Test the production containers:

```bash
docker compose up --build
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
