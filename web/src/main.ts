import "./style.css";

type MapSummary = {
  id: string;
  name: string;
  imageUrl: string;
  width: number;
  height: number;
  numberOfPlayers: number;
  previewSpawnX: number;
  previewSpawnY: number;
  previewPlayerColor: string;
  metroStations: MapLocation[];
};

type MapLocation = {
  x: number;
  y: number;
};

type RoomPhase = "lobby" | "countdown" | "playing" | "ended";
type PlayerState = "alive" | "respawning";

type PlayerSummary = {
  id: string;
  nickname: string;
  slot: number;
  color: string;
  kills: number;
  deaths: number;
  host: boolean;
  x: number;
  y: number;
  heading: number;
  speed: number;
  health: number;
  state: PlayerState;
  respawnAtTick: number | null;
  invulnerableUntilTick: number;
};

type RenderPlayer = PlayerSummary;

type BulletSummary = {
  id: number;
  ownerSlot: number;
  x: number;
  y: number;
  heading: number;
  radius: number;
  kind: "bullet" | "grenade";
};

type RenderBullet = BulletSummary;

type SandboxProjectile = BulletSummary & {
  lifetime: number;
};

type Room = {
  id: string;
  mapId: string;
  deathLimit: number;
  playerLimit: number;
  phase: RoomPhase;
  phaseEndsAtTick: number | null;
  winnerSlot: number | null;
  tick: number;
  players: PlayerSummary[];
  bullets: BulletSummary[];
  wallCraters: WallCrater[];
  blasts: BlastSummary[];
  feed: string[];
};

type WallCrater = {
  x: number;
  y: number;
  radius: number;
};

type BlastSummary = WallCrater & {
  id: number;
  startedAtTick: number;
  endsAtTick: number;
};

type CreateRoomResponse = {
  room: Room;
  invitePath: string;
  sessionToken: string;
  slot: number;
};

type JoinRoomResponse = {
  room: Room;
  sessionToken: string;
  slot: number;
};

type ClientMode =
  | "selectingMap"
  | "designingMap"
  | "previewingDesign"
  | "creatingRoom"
  | "waiting"
  | "playing"
  | "ended"
  | "missing";

type Vehicle = {
  x: number;
  y: number;
  heading: number;
  speed: number;
};

type DesignerTool = "wall" | "erase" | "spawn" | "metro";

type DesignerSpawn = MapLocation & {
  color: string;
};

type DesignerSnapshot = {
  pixels: ImageData;
  spawns: DesignerSpawn[];
  metros: MapLocation[];
};

type DesignerState = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  name: string;
  tool: DesignerTool;
  brushSize: number;
  color: string;
  spawns: DesignerSpawn[];
  metros: MapLocation[];
  drawing: boolean;
  lastPoint: MapLocation | null;
  saving: boolean;
  message: string;
  history: DesignerSnapshot[];
};

type MapFit = {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
};

type FrameSample = {
  timestamp: number;
  deltaMs: number;
  x: number;
  y: number;
  speed: number;
};

type DeathEffect = {
  slot: number;
  x: number;
  y: number;
  color: string;
  startedAt: number;
};

type BlastEffect = WallCrater & {
  id: number;
  startedAt: number;
};

type PaintArenaDebug = {
  getState: () => {
    mode: ClientMode;
    roomId: string | null;
    vehicle: Vehicle;
    renderPlayers: RenderPlayer[];
    renderBullets: RenderBullet[];
    wallCraters: WallCrater[];
    blastEffects: BlastEffect[];
    frameSamples: FrameSample[];
  };
  resetFrameSamples: () => void;
};

declare global {
  interface Window {
    __paintArenaDebug?: PaintArenaDebug;
  }
}

const DEFAULT_MAP_WIDTH = 1552;
const DEFAULT_MAP_HEIGHT = 783;
const DESIGNER_MAP_WIDTH = 1200;
const DESIGNER_MAP_HEIGHT = 675;
const FLOOR_COLOR = "#2430be";
const WALL_COLOR = "#f230bc";
const METRO_COLOR = "#23e8ec";
const FLOOR_RGB = [36, 48, 190] as const;
const WALL_RGB = [242, 48, 188] as const;
const PLAYER_RADIUS = 10;
const MAX_SPEED = 165;
const ACCELERATION = 300;
const BRAKING = 360;
const FRICTION = 114.75;
const TURN_SPEED = 3.4;
const BULLET_SPEED = 440;
const FIRE_COOLDOWN_SECONDS = 0.14;
const BULLET_CRATER_RADIUS = 5;
const GRENADE_SPEED = 285;
const GRENADE_LIFETIME_SECONDS = 1.15;
const GRENADE_COOLDOWN_SECONDS = 2;
const GRENADE_CRATER_RADIUS = 46;
const GRENADE_BLAST_RADIUS = 72;
const WALL_FIELD_RADIUS = 38;
const MIN_BLOCKING_WALL_COMPONENT_PIXELS = 12;
const BLAST_EFFECT_DURATION_MS = 500;
const INPUT_SEND_INTERVAL_MS = 100;
const ROOM_POLL_INTERVAL_MS = 1000;
const REMOTE_RECONCILIATION_FACTOR = 0.28;
const BULLET_RECONCILIATION_FACTOR = 0.22;
const DEATH_EFFECT_DURATION_MS = 650;
const PLAYER_COLORS = [
  "#ff0000",
  "#0066ff",
  "#00cc44",
  "#ffcc00",
  "#aa00ff",
  "#ff7700",
  "#00cccc",
  "#ff66aa",
];

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app element");
}

const root = app;
let maps = await fetchJson<MapSummary[]>("/api/maps");
const currentRoomId = roomIdFromPath(window.location.pathname);

let selectedMapIndex = 0;
let activeMap: MapSummary | null = maps[0] ?? null;
let activeRoom: Room | null = null;
let activeMode: ClientMode = currentRoomId ? "waiting" : "selectingMap";
let activeMapRequest = 0;
let mapImage: HTMLImageElement | null = null;
let mapPixels: ImageData | null = null;
let dynamicMapCanvas: HTMLCanvasElement | null = null;
let dynamicMapPixels: ImageData | null = null;
let appliedWallCraters: WallCrater[] = [];
let roomPollTimer: number | undefined;
let socket: WebSocket | null = null;
let socketRoomId: string | null = null;
let socketReconnectTimer: number | undefined;
let inviteUrl: string | null = null;
let inviteVisible = false;
let creatingRoom = false;
let vehicleSlot: number | null = null;
let lastFrameTime = performance.now();

const activeKeys = new Set<string>();
let vehicle: Vehicle = createVehicle();
let lastInputSentAt = 0;
let lastControlsSignature = "";
let inputSequence = 0;
let renderPlayers: RenderPlayer[] = [];
let renderBullets: RenderBullet[] = [];
let frameSamples: FrameSample[] = [];
let deathEffects: DeathEffect[] = [];
let blastEffects: BlastEffect[] = [];
let sandboxProjectiles: SandboxProjectile[] = [];
let sandboxCraters: WallCrater[] = [];
let sandboxNextProjectileId = -1;
let sandboxNextBlastId = -1;
let sandboxFireCooldown = 0;
let sandboxGrenadeCooldown = 0;
let localMetroArmed = true;
let designerState: DesignerState | null = null;

renderGameShell();

const canvasElement = document.querySelector<HTMLCanvasElement>("#map-canvas");

if (!canvasElement) {
  throw new Error("Missing #map-canvas element");
}

const canvas = canvasElement;
const renderingContext = canvas.getContext("2d");

if (!renderingContext) {
  throw new Error("Canvas 2D context is not available");
}

const canvasContext = renderingContext;

installKeyboardControls();
installHudControls();
installDesignerControls();
resizeCanvas();
window.addEventListener("resize", resizeCanvas);
connectStatusSocket();
installDebugSurface();
void setActiveMap(activeMap);
requestAnimationFrame(renderFrame);

if (currentRoomId) {
  await renderRoomPage(currentRoomId);
} else {
  renderLandingPage();
}

function renderGameShell() {
  root.innerHTML = `
    <main class="game-screen">
      <canvas id="map-canvas" width="960" height="540" aria-label="Paint Arena map"></canvas>
      <section id="hud" class="hud" aria-live="polite">
        <div class="game-mark" aria-label="Paint Arena"><span>Paint</span><strong>Arena</strong></div>
        <div class="stage-copy">
          <p id="mode-line" class="mode-line"></p>
          <p id="map-line" class="map-line"></p>
        </div>
        <div id="selection-controls" class="selection-controls" hidden>
          <button id="map-previous" class="hud-button icon-button" type="button" aria-label="Previous map">◀</button>
          <button id="map-next" class="hud-button icon-button" type="button" aria-label="Next map">▶</button>
          <button id="create-match" class="hud-button primary" type="button">Create match</button>
          <button id="designer-button" class="hud-button" type="button">Design map</button>
        </div>
        <ol id="player-list" class="player-list"></ol>
        <ol id="event-feed" class="event-feed"></ol>
        <p id="control-hint" class="control-hint"></p>
        <div id="room-controls" class="room-controls" hidden>
          <button id="copy-invite" class="hud-button primary" type="button" hidden>Copy invite</button>
          <button id="rematch-button" class="hud-button primary" type="button" hidden>Rematch</button>
          <button id="leave-button" class="hud-button" type="button">Maps</button>
        </div>
        <p id="ws-status" class="connection-line"></p>
        <div id="designer-controls" class="designer-controls" hidden>
          <div class="ribbon-group map-tools">
            <input id="designer-name" class="designer-name" maxlength="40" value="Untitled Arena" aria-label="Map name">
            <button id="designer-undo" class="ribbon-button compact" type="button" title="Undo last change" disabled><span aria-hidden="true">↶</span> Undo</button>
            <button id="designer-clear" class="ribbon-button compact" type="button" title="Clear the canvas"><span aria-hidden="true">▱</span> Clear</button>
            <span class="ribbon-label">Map</span>
          </div>
          <div class="ribbon-group tool-group" role="group" aria-label="Map tools">
            <button type="button" class="tool-button" data-tool="wall" title="Paint solid walls"><span class="tool-glyph" aria-hidden="true">▰</span><span>Wall</span></button>
            <button type="button" class="tool-button" data-tool="erase" title="Erase walls and markers"><span class="tool-glyph eraser-glyph" aria-hidden="true">▱</span><span>Eraser</span></button>
            <button type="button" class="tool-button" data-tool="spawn" title="Place a player spawn"><span class="tool-glyph spawn-glyph" aria-hidden="true">●</span><span>Spawn</span></button>
            <button type="button" class="tool-button" data-tool="metro" title="Place paired metro stations"><span class="tool-glyph metro-glyph" aria-hidden="true">M</span><span>Metro</span></button>
            <span class="ribbon-label">Tools</span>
          </div>
          <div class="ribbon-group size-tools">
            <label class="brush-control" for="designer-brush">Brush</label>
            <select id="designer-brush" aria-label="Brush size">
              <option value="8">8 px</option>
              <option value="16">16 px</option>
              <option value="24" selected>24 px</option>
              <option value="40">40 px</option>
              <option value="64">64 px</option>
              <option value="80">80 px</option>
            </select>
            <span class="brush-preview" aria-hidden="true"></span>
            <span class="ribbon-label">Size</span>
          </div>
          <div class="ribbon-group color-tools">
            <input id="designer-color" type="color" aria-label="Spawn color" title="Choose spawn color">
            <div class="color-swatches" role="group" aria-label="Spawn color presets">
              <button type="button" class="color-swatch" data-designer-color="#23e8ec" style="--swatch: #23e8ec" aria-label="Cyan spawn"></button>
              <button type="button" class="color-swatch" data-designer-color="#ff4ccf" style="--swatch: #ff4ccf" aria-label="Magenta spawn"></button>
              <button type="button" class="color-swatch" data-designer-color="#f5e642" style="--swatch: #f5e642" aria-label="Yellow spawn"></button>
              <button type="button" class="color-swatch" data-designer-color="#47ef75" style="--swatch: #47ef75" aria-label="Green spawn"></button>
            </div>
            <button id="designer-random-color" class="ribbon-button compact" type="button" title="Pick a random spawn color">Random</button>
            <span class="ribbon-label">Spawn color</span>
          </div>
          <div class="ribbon-group play-tools">
            <button id="designer-preview" class="ribbon-button preview" type="button"><span aria-hidden="true">▶</span> Preview</button>
            <button id="designer-save" class="ribbon-button primary" type="button"><span aria-hidden="true">▣</span> Save</button>
            <button id="designer-cancel" class="ribbon-button" type="button">Maps</button>
            <span class="ribbon-label">Play &amp; save</span>
          </div>
          <div class="designer-status" role="status">
            <strong id="designer-counts">Spawns 0/8 · Metro 0/16</strong>
            <span id="designer-message" class="designer-message"></span>
          </div>
        </div>
      </section>
    </main>
  `;
}

function renderLandingPage() {
  activeMode = "selectingMap";
  activeRoom = null;
  inviteVisible = false;
  updateHud();
}

async function renderRoomPage(
  roomId: string,
  options: { skipAutoJoin?: boolean } = {},
) {
  activeMode = "waiting";
  updateHud();

  if (roomPollTimer !== undefined) {
    window.clearInterval(roomPollTimer);
  }

  await refreshRoom(roomId, { autoJoin: !options.skipAutoJoin });
  connectRoomSocket(roomId);
  roomPollTimer = window.setInterval(() => {
    void refreshRoom(roomId);
  }, ROOM_POLL_INTERVAL_MS);
}

function installKeyboardControls() {
  window.addEventListener("keydown", (event) => {
    if (
      activeMode === "designingMap"
      && (event.ctrlKey || event.metaKey)
      && event.key.toLowerCase() === "z"
      && !(document.activeElement instanceof HTMLInputElement)
    ) {
      event.preventDefault();
      undoDesignerChange();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      if (activeMode === "previewingDesign") {
        stopDesignerPreview();
        return;
      }
      if (activeMode === "designingMap") {
        exitDesignerMode();
        return;
      }
      resetToMapSelection();
      return;
    }

    if (activeMode === "selectingMap") {
      if (event.key === "Tab") {
        event.preventDefault();
        selectRelativeMap(event.shiftKey ? -1 : 1);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        void createRoomFromSelection();
        return;
      }

      const previewInputKey = normalizeInputKey(event.key);
      if (previewInputKey) {
        event.preventDefault();
        activeKeys.add(previewInputKey);
      }

      return;
    }

    if (activeMode === "ended" && event.key === "Enter") {
      event.preventDefault();
      void requestRematch();
      return;
    }

    const inputKey = normalizeInputKey(event.key);
    if (inputKey) {
      event.preventDefault();
      activeKeys.add(inputKey);
    }
  });

  window.addEventListener("keyup", (event) => {
    const inputKey = normalizeInputKey(event.key);
    if (inputKey) {
      event.preventDefault();
      activeKeys.delete(inputKey);
    }
  });
}

function installHudControls() {
  document.querySelector<HTMLButtonElement>("#map-previous")
    ?.addEventListener("click", () => selectRelativeMap(-1));
  document.querySelector<HTMLButtonElement>("#map-next")
    ?.addEventListener("click", () => selectRelativeMap(1));
  document.querySelector<HTMLButtonElement>("#create-match")
    ?.addEventListener("click", () => void createRoomFromSelection());
  document.querySelector<HTMLButtonElement>("#leave-button")
    ?.addEventListener("click", resetToMapSelection);
  document.querySelector<HTMLButtonElement>("#rematch-button")
    ?.addEventListener("click", () => void requestRematch());
  document.querySelector<HTMLButtonElement>("#copy-invite")
    ?.addEventListener("click", async (event) => {
      if (!inviteUrl) {
        return;
      }
      await copyInviteToClipboard(inviteUrl);
      const button = event.currentTarget as HTMLButtonElement;
      button.textContent = "Copied!";
      window.setTimeout(() => {
        button.textContent = "Copy invite";
      }, 1400);
    });
}

function installDesignerControls() {
  const designerButton = document.querySelector<HTMLButtonElement>("#designer-button");
  const controls = document.querySelector<HTMLElement>("#designer-controls");
  const nameInput = document.querySelector<HTMLInputElement>("#designer-name");
  const brushInput = document.querySelector<HTMLSelectElement>("#designer-brush");
  const colorInput = document.querySelector<HTMLInputElement>("#designer-color");
  const randomButton = document.querySelector<HTMLButtonElement>("#designer-random-color");
  const undoButton = document.querySelector<HTMLButtonElement>("#designer-undo");
  const clearButton = document.querySelector<HTMLButtonElement>("#designer-clear");
  const previewButton = document.querySelector<HTMLButtonElement>("#designer-preview");
  const saveButton = document.querySelector<HTMLButtonElement>("#designer-save");
  const cancelButton = document.querySelector<HTMLButtonElement>("#designer-cancel");

  designerButton?.addEventListener("click", enterDesignerMode);
  cancelButton?.addEventListener("click", exitDesignerMode);
  saveButton?.addEventListener("click", () => void saveDesignedMap());
  previewButton?.addEventListener("click", toggleDesignerPreview);
  undoButton?.addEventListener("click", undoDesignerChange);
  clearButton?.addEventListener("click", clearDesignerMap);
  randomButton?.addEventListener("click", () => {
    if (!designerState || !colorInput) {
      return;
    }
    designerState.color = randomPlayerColor();
    colorInput.value = designerState.color;
  });
  nameInput?.addEventListener("input", () => {
    if (designerState) {
      designerState.name = nameInput.value;
    }
  });
  brushInput?.addEventListener("input", () => {
    if (designerState) {
      designerState.brushSize = Number(brushInput.value);
    }
  });
  colorInput?.addEventListener("input", () => {
    if (designerState) {
      designerState.color = colorInput.value;
    }
  });
  controls?.addEventListener("click", (event) => {
    const colorButton = (event.target as HTMLElement)
      .closest<HTMLButtonElement>("[data-designer-color]");
    if (designerState && colorInput && colorButton?.dataset.designerColor) {
      designerState.color = colorButton.dataset.designerColor;
      colorInput.value = designerState.color;
      updateHud();
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-tool]");
    const tool = button?.dataset.tool as DesignerTool | undefined;
    if (designerState && tool) {
      designerState.tool = tool;
      updateHud();
    }
  });

  canvas.addEventListener("contextmenu", (event) => {
    if (activeMode === "designingMap") {
      event.preventDefault();
    }
  });
  canvas.addEventListener("pointerdown", handleDesignerPointerDown);
  canvas.addEventListener("pointermove", handleDesignerPointerMove);
  window.addEventListener("pointerup", () => {
    if (designerState) {
      const finishedStroke = designerState.drawing;
      designerState.drawing = false;
      designerState.lastPoint = null;
      if (finishedStroke) {
        updateHud();
      }
    }
  });
}

function enterDesignerMode() {
  if (activeMode !== "selectingMap") {
    return;
  }
  const designCanvas = document.createElement("canvas");
  designCanvas.width = DESIGNER_MAP_WIDTH;
  designCanvas.height = DESIGNER_MAP_HEIGHT;
  const context = designCanvas.getContext("2d");
  if (!context) {
    return;
  }
  context.imageSmoothingEnabled = false;
  context.fillStyle = FLOOR_COLOR;
  context.fillRect(0, 0, designCanvas.width, designCanvas.height);
  const firstColor = randomPlayerColor();
  designerState = {
    canvas: designCanvas,
    context,
    width: designCanvas.width,
    height: designCanvas.height,
    name: "Untitled Arena",
    tool: "wall",
    brushSize: 24,
    color: firstColor,
    spawns: [],
    metros: [],
    drawing: false,
    lastPoint: null,
    saving: false,
    message: "Blank canvas — paint walls, then place at least 2 spawns.",
    history: [],
  };
  resetSandbox();
  activeMode = "designingMap";
  resizeCanvas();
  updateHud();
}

function exitDesignerMode() {
  if (activeMode !== "designingMap" && activeMode !== "previewingDesign") {
    return;
  }
  designerState = null;
  activeMode = "selectingMap";
  resizeCanvas();
  void setActiveMap(maps[selectedMapIndex] ?? null);
  updateHud();
}

function toggleDesignerPreview() {
  if (activeMode === "previewingDesign") {
    stopDesignerPreview();
  } else if (activeMode === "designingMap") {
    startDesignerPreview();
  }
}

function startDesignerPreview() {
  if (!designerState || designerState.spawns.length < 2) {
    if (designerState) {
      designerState.message = "Preview needs at least 2 player spawns.";
      updateHud();
    }
    return;
  }
  if (designerState.metros.length === 1) {
    designerState.message = "A metro needs a destination; place a second station.";
    updateHud();
    return;
  }
  const previewCanvas = buildDesignerPreviewCanvas(designerState);
  const context = previewCanvas.getContext("2d");
  if (!context) {
    return;
  }
  mapImage = null;
  mapPixels = context.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
  dynamicMapCanvas = document.createElement("canvas");
  dynamicMapCanvas.width = previewCanvas.width;
  dynamicMapCanvas.height = previewCanvas.height;
  const dynamicContext = dynamicMapCanvas.getContext("2d");
  if (!dynamicContext) {
    dynamicMapCanvas = null;
    return;
  }
  dynamicContext.imageSmoothingEnabled = false;
  dynamicContext.drawImage(previewCanvas, 0, 0);
  dynamicMapPixels = dynamicContext.getImageData(
    0,
    0,
    previewCanvas.width,
    previewCanvas.height,
  );
  appliedWallCraters = [];
  resetSandbox();
  const spawn = designerState.spawns[0];
  if (!spawn) {
    return;
  }
  vehicle = { x: spawn.x, y: spawn.y, heading: 0, speed: 0 };
  designerState.message = "Previewing unsaved map · Arrow keys · Space fire";
  activeMode = "previewingDesign";
  localMetroArmed = localMetroStationIndex() < 0;
  resizeCanvas();
  updateHud();
}

function stopDesignerPreview() {
  if (activeMode !== "previewingDesign" || !designerState) {
    return;
  }
  resetSandbox();
  designerState.message = "Editing again — use Eraser to remove walls or markers.";
  activeMode = "designingMap";
  resizeCanvas();
  updateHud();
}

function buildDesignerPreviewCanvas(state: DesignerState) {
  const preview = document.createElement("canvas");
  preview.width = state.width;
  preview.height = state.height;
  const context = preview.getContext("2d");
  if (!context) {
    return preview;
  }
  context.imageSmoothingEnabled = false;
  context.drawImage(state.canvas, 0, 0);
  context.fillStyle = METRO_COLOR;
  for (const metro of state.metros) {
    context.fillRect(Math.round(metro.x) - 12, Math.round(metro.y) - 12, 25, 25);
  }
  for (const spawn of state.spawns) {
    context.fillStyle = spawn.color;
    context.beginPath();
    context.arc(Math.round(spawn.x), Math.round(spawn.y), 9, 0, Math.PI * 2);
    context.fill();
  }
  return preview;
}

function handleDesignerPointerDown(event: PointerEvent) {
  if (activeMode !== "designingMap" || !designerState || designerState.saving) {
    return;
  }
  const point = designerPointFromEvent(event);
  if (!point) {
    return;
  }
  event.preventDefault();
  if (event.button === 2) {
    removeDesignerMarker(point);
    return;
  }
  if (designerState.tool === "wall" || designerState.tool === "erase") {
    pushDesignerHistory();
    designerState.drawing = true;
    designerState.lastPoint = point;
    paintDesignerStroke(point, point);
    if (event.isTrusted) {
      canvas.setPointerCapture(event.pointerId);
    }
    return;
  }
  if (designerState.tool === "spawn") {
    const existing = nearestPointIndex(designerState.spawns, point, 20);
    if (existing >= 0) {
      const spawn = designerState.spawns[existing];
      if (spawn && spawn.color !== designerState.color) {
        pushDesignerHistory();
        spawn.color = designerState.color;
        designerState.message = "Spawn color updated.";
      }
    } else if (designerState.spawns.length < 8) {
      pushDesignerHistory();
      designerState.spawns.push({ ...point, color: designerState.color });
      designerState.color = randomPlayerColor();
      designerState.message = designerState.spawns.length < 2
        ? "Add one more spawn to make the map playable."
        : "Spawn added with a random color. Preview is now available.";
    } else {
      designerState.message = "A map can have at most 8 spawns.";
    }
  } else if (designerState.metros.length < 16) {
    pushDesignerHistory();
    designerState.metros.push(point);
    designerState.message = designerState.metros.length % 2 === 0
      ? "Metro pair completed."
      : "Place another metro station to complete the pair.";
  } else {
    designerState.message = "A map can have at most 16 metro stations.";
  }
  updateHud();
}

function handleDesignerPointerMove(event: PointerEvent) {
  if (!designerState?.drawing || activeMode !== "designingMap") {
    return;
  }
  const point = designerPointFromEvent(event);
  if (!point) {
    return;
  }
  paintDesignerStroke(designerState.lastPoint ?? point, point);
  designerState.lastPoint = point;
}

function designerPointFromEvent(event: PointerEvent): MapLocation | null {
  if (!designerState) {
    return null;
  }
  const bounds = canvas.getBoundingClientRect();
  const fit = getMapFit();
  const canvasX = (event.clientX - bounds.left) * canvas.width / bounds.width;
  const canvasY = (event.clientY - bounds.top) * canvas.height / bounds.height;
  const x = (canvasX - fit.x) / fit.scale;
  const y = (canvasY - fit.y) / fit.scale;
  if (x < 0 || y < 0 || x >= designerState.width || y >= designerState.height) {
    return null;
  }
  return { x, y };
}

function paintDesignerStroke(from: MapLocation, to: MapLocation) {
  if (!designerState) {
    return;
  }
  const context = designerState.context;
  context.strokeStyle = designerState.tool === "wall" ? WALL_COLOR : FLOOR_COLOR;
  context.lineWidth = designerState.brushSize;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x + 0.01, to.y + 0.01);
  context.stroke();
  if (designerState.tool === "erase") {
    eraseDesignerMarkers(from, to, designerState.brushSize / 2 + 8);
  }
}

function removeDesignerMarker(point: MapLocation) {
  if (!designerState) {
    return;
  }
  const spawnIndex = nearestPointIndex(designerState.spawns, point, 24);
  if (spawnIndex >= 0) {
    pushDesignerHistory();
    designerState.spawns.splice(spawnIndex, 1);
    designerState.message = "Spawn removed.";
  } else {
    const metroIndex = nearestPointIndex(designerState.metros, point, 28);
    if (metroIndex >= 0) {
      pushDesignerHistory();
      designerState.metros.splice(metroIndex, 1);
      designerState.message = "Metro station removed.";
    }
  }
  updateHud();
}

function pushDesignerHistory() {
  if (!designerState) {
    return;
  }
  designerState.history.push({
    pixels: designerState.context.getImageData(
      0,
      0,
      designerState.width,
      designerState.height,
    ),
    spawns: designerState.spawns.map((spawn) => ({ ...spawn })),
    metros: designerState.metros.map((metro) => ({ ...metro })),
  });
  if (designerState.history.length > 10) {
    designerState.history.shift();
  }
}

function undoDesignerChange() {
  if (!designerState || activeMode !== "designingMap") {
    return;
  }
  const snapshot = designerState.history.pop();
  if (!snapshot) {
    designerState.message = "Nothing to undo yet.";
    updateHud();
    return;
  }
  designerState.context.putImageData(snapshot.pixels, 0, 0);
  designerState.spawns = snapshot.spawns;
  designerState.metros = snapshot.metros;
  designerState.message = "Last change undone.";
  updateHud();
}

function clearDesignerMap() {
  if (!designerState || activeMode !== "designingMap") {
    return;
  }
  pushDesignerHistory();
  designerState.context.fillStyle = FLOOR_COLOR;
  designerState.context.fillRect(0, 0, designerState.width, designerState.height);
  designerState.spawns = [];
  designerState.metros = [];
  designerState.message = "Canvas cleared. Undo restores the previous design.";
  updateHud();
}

function eraseDesignerMarkers(from: MapLocation, to: MapLocation, radius: number) {
  if (!designerState) {
    return;
  }
  designerState.spawns = designerState.spawns.filter(
    (spawn) => distanceFromSegment(spawn, from, to) > radius,
  );
  designerState.metros = designerState.metros.filter(
    (metro) => distanceFromSegment(metro, from, to) > radius,
  );
}

function distanceFromSegment(point: MapLocation, from: MapLocation, to: MapLocation) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - from.x, point.y - from.y);
  }
  const amount = Math.max(
    0,
    Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (from.x + amount * dx), point.y - (from.y + amount * dy));
}

function nearestPointIndex(points: MapLocation[], target: MapLocation, radius: number) {
  return points.findIndex(
    (point) => (point.x - target.x) ** 2 + (point.y - target.y) ** 2 <= radius ** 2,
  );
}

async function saveDesignedMap() {
  if (!designerState || designerState.saving) {
    return;
  }
  if (designerState.spawns.length < 2) {
    designerState.message = "Add at least two spawn points before saving.";
    updateHud();
    return;
  }
  if (designerState.metros.length === 1) {
    designerState.message = "Metro stations need a destination; add another or remove it.";
    updateHud();
    return;
  }

  designerState.saving = true;
  designerState.message = "Saving…";
  updateHud();
  const state = designerState;
  try {
    const pixels = state.context.getImageData(0, 0, state.width, state.height);
    const wallMask = new Uint8Array(state.width * state.height);
    for (let pixel = 0; pixel < wallMask.length; pixel += 1) {
      wallMask[pixel] = isWallPixelIndex(pixels, pixel) ? 1 : 0;
    }
    const saved = await fetchJson<MapSummary>("/api/maps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: state.name,
        width: state.width,
        height: state.height,
        wallMask: bytesToBase64(wallMask),
        players: state.spawns.map((spawn) => ({
          color: spawn.color,
          location: { x: Math.round(spawn.x), y: Math.round(spawn.y) },
        })),
        metroStations: state.metros.map((metro) => ({
          x: Math.round(metro.x),
          y: Math.round(metro.y),
        })),
      }),
    });
    maps = await fetchJson<MapSummary[]>("/api/maps");
    selectedMapIndex = Math.max(0, maps.findIndex((map) => map.id === saved.id));
    designerState = null;
    activeMode = "selectingMap";
    resizeCanvas();
    await setActiveMap(maps[selectedMapIndex] ?? saved);
    updateHud();
  } catch (error) {
    console.error(error);
    state.saving = false;
    state.message = "Could not save. Keep spawns and metros clear of walls.";
    updateHud();
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function randomPlayerColor() {
  const channel = () => Math.floor(80 + Math.random() * 176)
    .toString(16)
    .padStart(2, "0");
  let color = `#${channel()}${channel()}${channel()}`;
  if (color.toLowerCase() === WALL_COLOR) {
    color = "#ff00ff";
  }
  return color;
}

function selectRelativeMap(offset: number) {
  if (maps.length === 0) {
    return;
  }

  selectedMapIndex = (selectedMapIndex + offset + maps.length) % maps.length;
  void setActiveMap(maps[selectedMapIndex] ?? null);
  updateHud();
}

async function createRoomFromSelection() {
  const selectedMap = maps[selectedMapIndex];

  if (!selectedMap || creatingRoom) {
    return;
  }

  creatingRoom = true;
  activeMode = "creatingRoom";
  updateHud();

  try {
    const response = await fetchJson<CreateRoomResponse>("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nickname: "Player 1",
        deathLimit: 10,
        mapId: selectedMap.id,
      }),
    });

    markJoined(
      response.room.id,
      "host",
      response.slot,
      response.sessionToken,
    );
    activeRoom = response.room;
    inviteUrl = new URL(response.invitePath, window.location.origin).href;
    inviteVisible = true;
    window.history.pushState({}, "", response.invitePath);
    await copyInviteToClipboard(inviteUrl);
    await renderRoomPage(response.room.id, { skipAutoJoin: true });
  } catch (error) {
    console.error(error);
    activeMode = "selectingMap";
    updateHud();
  } finally {
    creatingRoom = false;
  }
}

async function refreshRoom(
  roomId: string,
  options: { autoJoin?: boolean } = {},
) {
  try {
    let room = await fetchJson<Room>(`/api/rooms/${roomId}`);

    if ((options.autoJoin ?? true) && shouldAutoJoin(roomId, room)) {
      const joinedRoom = await joinRoom(roomId);
      room = joinedRoom;
    }

    applyRoomSnapshot(room);
  } catch (error) {
    console.error(error);
    if (error instanceof HttpError && error.status === 404) {
      activeRoom = null;
      activeMode = "missing";
      inviteVisible = false;
      stopRoomPolling();
      updateHud();
    }
  }
}

function applyRoomSnapshot(room: Room) {
  captureDeathEffects(activeRoom, room);
  captureBlastEffects(activeRoom, room);
  activeRoom = room;
  activeMode =
    room.phase === "playing"
      ? "playing"
      : room.phase === "ended"
        ? "ended"
        : "waiting";
  inviteVisible = inviteVisible && room.phase !== "playing";

  const roomMap = maps.find((map) => map.id === room.mapId) ?? activeMap;
  if (roomMap && roomMap.id !== activeMap?.id) {
    void setActiveMap(roomMap);
  } else {
    syncWallCraters(room.wallCraters);
  }

  syncVehicleSlot();
  syncRenderSnapshot(room);
  updateHud();
}

function captureBlastEffects(previousRoom: Room | null, nextRoom: Room) {
  const previousIds = new Set(
    previousRoom?.id === nextRoom.id
      ? previousRoom.blasts.map((blast) => blast.id)
      : [],
  );
  for (const blast of nextRoom.blasts) {
    if (!previousIds.has(blast.id) && !blastEffects.some((effect) => effect.id === blast.id)) {
      blastEffects.push({
        id: blast.id,
        x: blast.x,
        y: blast.y,
        radius: blast.radius,
        startedAt: performance.now(),
      });
    }
  }
}

function captureDeathEffects(previousRoom: Room | null, nextRoom: Room) {
  if (!previousRoom || previousRoom.id !== nextRoom.id) {
    return;
  }
  for (const player of nextRoom.players) {
    const previous = previousRoom.players.find(
      (candidate) => candidate.slot === player.slot,
    );
    if (previous?.state === "alive" && player.state === "respawning") {
      const rendered = renderPlayers.find(
        (candidate) => candidate.slot === player.slot,
      );
      deathEffects.push({
        slot: player.slot,
        x: rendered?.x ?? previous.x,
        y: rendered?.y ?? previous.y,
        color: player.color,
        startedAt: performance.now(),
      });
    }
  }
}

function stopRoomPolling() {
  if (roomPollTimer !== undefined) {
    window.clearInterval(roomPollTimer);
    roomPollTimer = undefined;
  }
}

function resetToMapSelection() {
  if (activeRoom) {
    leaveCurrentRoom(activeRoom.id);
    sessionStorage.removeItem(joinedKey(activeRoom.id));
    sessionStorage.removeItem(slotKey(activeRoom.id));
    sessionStorage.removeItem(tokenKey(activeRoom.id));
  }

  stopRoomPolling();
  socketRoomId = null;
  socket?.close();
  socket = null;
  if (socketReconnectTimer !== undefined) {
    window.clearTimeout(socketReconnectTimer);
    socketReconnectTimer = undefined;
  }
  activeKeys.clear();
  activeRoom = null;
  activeMode = "selectingMap";
  inviteVisible = false;
  inviteUrl = null;
  vehicleSlot = null;
  vehicle = createVehicle();
  renderPlayers = [];
  renderBullets = [];
  deathEffects = [];
  blastEffects = [];
  lastControlsSignature = "";
  inputSequence = 0;
  window.history.pushState({}, "", "/");
  void setActiveMap(maps[selectedMapIndex] ?? null);
  updateHud();
}

function leaveCurrentRoom(roomId: string) {
  const slot = getJoinedSlot(roomId);
  const token = getSessionToken(roomId);
  if (slot === null || token === null) {
    return;
  }

  void fetch(`/api/rooms/${roomId}/players/${slot}/leave`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    keepalive: true,
  }).catch((error: unknown) => console.error(error));
}

async function requestRematch() {
  if (!activeRoom || sessionStorage.getItem(joinedKey(activeRoom.id)) !== "host") {
    return;
  }
  const token = getSessionToken(activeRoom.id);
  if (!token) {
    return;
  }
  activeRoom = await fetchJson<Room>(`/api/rooms/${activeRoom.id}/rematch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  activeMode = "waiting";
  syncRenderSnapshot(activeRoom);
  updateHud();
}

function shouldAutoJoin(roomId: string, room: Room) {
  return (
    !hasJoined(roomId) &&
    (room.phase === "lobby" || room.phase === "countdown") &&
    room.players.length < room.playerLimit
  );
}

async function joinRoom(roomId: string) {
  const response = await fetchJson<JoinRoomResponse>(`/api/rooms/${roomId}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nickname: "Player 2" }),
  });

  markJoined(roomId, "guest", response.slot, response.sessionToken);
  return response.room;
}

async function copyInviteToClipboard(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Clipboard permission is optional; the modal still shows the link.
  }
}

function markJoined(
  roomId: string,
  role: "host" | "guest",
  slot: number,
  token: string,
) {
  sessionStorage.setItem(joinedKey(roomId), role);
  sessionStorage.setItem(slotKey(roomId), String(slot));
  sessionStorage.setItem(tokenKey(roomId), token);
}

function hasJoined(roomId: string) {
  return sessionStorage.getItem(joinedKey(roomId)) !== null;
}

function joinedKey(roomId: string) {
  return `paint-arena:joined:${roomId}`;
}

function slotKey(roomId: string) {
  return `paint-arena:slot:${roomId}`;
}

function tokenKey(roomId: string) {
  return `paint-arena:token:${roomId}`;
}

function getJoinedSlot(roomId: string) {
  const slot = Number(sessionStorage.getItem(slotKey(roomId)));
  return Number.isInteger(slot) && slot > 0 ? slot : null;
}

function getSessionToken(roomId: string) {
  return sessionStorage.getItem(tokenKey(roomId));
}

async function setActiveMap(map: MapSummary | null) {
  activeMap = map;
  if (activeMode === "selectingMap") {
    resetSandbox();
  }
  updateHud();

  if (!map) {
    mapImage = null;
    mapPixels = null;
    dynamicMapCanvas = null;
    dynamicMapPixels = null;
    appliedWallCraters = [];
    return;
  }

  const requestId = ++activeMapRequest;
  const image = await loadImage(map.imageUrl);

  if (requestId !== activeMapRequest) {
    return;
  }

  mapImage = image;
  mapPixels = extractMapPixels(image);
  resetDynamicMap();
  syncWallCraters(activeRoom?.mapId === map.id ? activeRoom.wallCraters : []);
  vehicleSlot = null;
  if (activeMode === "selectingMap") {
    vehicle = {
      x: map.previewSpawnX,
      y: map.previewSpawnY,
      heading: 0,
      speed: 0,
    };
    localMetroArmed = localMetroStationIndex() < 0;
  } else {
    syncVehicleSlot();
  }
}

function resetSandbox() {
  activeKeys.clear();
  sandboxProjectiles = [];
  sandboxCraters = [];
  sandboxFireCooldown = 0;
  sandboxGrenadeCooldown = 0;
  localMetroArmed = true;
  blastEffects = [];
}

function syncVehicleSlot() {
  if (!activeRoom) {
    return;
  }

  const slot = getJoinedSlot(activeRoom.id);
  if (slot === null || slot === vehicleSlot) {
    return;
  }

  const serverPlayer = activeRoom.players.find((player) => player.slot === slot);
  const mapWidth = mapImage?.naturalWidth ?? DEFAULT_MAP_WIDTH;
  const mapHeight = mapImage?.naturalHeight ?? DEFAULT_MAP_HEIGHT;

  vehicle = {
    x: serverPlayer?.x ?? mapWidth / 2,
    y: serverPlayer?.y ?? mapHeight / 2,
    heading: serverPlayer?.heading ?? -Math.PI / 2,
    speed: serverPlayer?.speed ?? 0,
  };
  vehicleSlot = slot;
  localMetroArmed = localMetroStationIndex() < 0;
}

function syncRenderSnapshot(room: Room) {
  const localSlot = getJoinedSlot(room.id);

  renderPlayers = room.players.map((player) => {
    if (player.slot === localSlot) {
      const correctionDistance = Math.hypot(
        player.x - vehicle.x,
        player.y - vehicle.y,
      );
      const snapToServer =
        player.state !== "alive" ||
        correctionDistance > 45 ||
        activeRoom?.phase !== "playing";
      const correctionFactor = snapToServer ? 1 : 0.08;
      vehicle.x = blendNumber(vehicle.x, player.x, correctionFactor);
      vehicle.y = blendNumber(vehicle.y, player.y, correctionFactor);
      vehicle.heading = blendAngle(
        vehicle.heading,
        player.heading,
        correctionFactor,
      );
      vehicle.speed = blendNumber(vehicle.speed, player.speed, correctionFactor);

      return {
        ...player,
        x: vehicle.x,
        y: vehicle.y,
        heading: vehicle.heading,
        speed: vehicle.speed,
      };
    }

    const previousPlayer = renderPlayers.find(
      (renderPlayer) => renderPlayer.slot === player.slot,
    );

    if (!previousPlayer) {
      return player;
    }

    const correctionDistance = Math.hypot(
      player.x - previousPlayer.x,
      player.y - previousPlayer.y,
    );
    const correctionFactor =
      correctionDistance > 80 ? 1 : REMOTE_RECONCILIATION_FACTOR;
    return {
      ...player,
      x: blendNumber(previousPlayer.x, player.x, correctionFactor),
      y: blendNumber(previousPlayer.y, player.y, correctionFactor),
      heading: blendAngle(
        previousPlayer.heading,
        player.heading,
        correctionFactor,
      ),
      speed: blendNumber(
        previousPlayer.speed,
        player.speed,
        correctionFactor,
      ),
    };
  });

  renderBullets = room.bullets.map((bullet) => {
    const previousBullet = renderBullets.find(
      (renderBullet) => renderBullet.id === bullet.id,
    );

    if (!previousBullet) {
      return bullet;
    }

    const correctionDistance = Math.hypot(
      bullet.x - previousBullet.x,
      bullet.y - previousBullet.y,
    );
    const correctionFactor =
      correctionDistance > 40 ? 1 : BULLET_RECONCILIATION_FACTOR;
    return {
      ...bullet,
      x: blendNumber(previousBullet.x, bullet.x, correctionFactor),
      y: blendNumber(previousBullet.y, bullet.y, correctionFactor),
      heading: bullet.heading,
    };
  });
}

function extractMapPixels(image: HTMLImageElement) {
  const pixelCanvas = document.createElement("canvas");
  pixelCanvas.width = image.naturalWidth;
  pixelCanvas.height = image.naturalHeight;
  const pixelContext = pixelCanvas.getContext("2d");

  if (!pixelContext) {
    return null;
  }

  pixelContext.imageSmoothingEnabled = false;
  pixelContext.drawImage(image, 0, 0);
  return pixelContext.getImageData(0, 0, pixelCanvas.width, pixelCanvas.height);
}

function resetDynamicMap() {
  if (!mapImage) {
    dynamicMapCanvas = null;
    dynamicMapPixels = null;
    appliedWallCraters = [];
    return;
  }

  const nextCanvas = document.createElement("canvas");
  nextCanvas.width = mapImage.naturalWidth;
  nextCanvas.height = mapImage.naturalHeight;
  const context = nextCanvas.getContext("2d");
  if (!context) {
    dynamicMapCanvas = null;
    dynamicMapPixels = null;
    return;
  }
  context.imageSmoothingEnabled = false;
  context.drawImage(mapImage, 0, 0);
  dynamicMapCanvas = nextCanvas;
  dynamicMapPixels = context.getImageData(0, 0, nextCanvas.width, nextCanvas.height);
  appliedWallCraters = [];
}

function syncWallCraters(craters: WallCrater[]) {
  if (!mapPixels) {
    return;
  }

  const isPrefix = appliedWallCraters.every((applied, index) => {
    const current = craters[index];
    return current !== undefined &&
      applied.x === current.x &&
      applied.y === current.y &&
      applied.radius === current.radius;
  });
  if (!isPrefix || craters.length < appliedWallCraters.length) {
    resetDynamicMap();
  }
  if (!dynamicMapCanvas || !dynamicMapPixels) {
    return;
  }

  const newCraters = craters.slice(appliedWallCraters.length);
  if (newCraters.length === 0) {
    return;
  }

  for (const crater of newCraters) {
    const minimumX = Math.max(0, Math.floor(crater.x - crater.radius));
    const maximumX = Math.min(mapPixels.width - 1, Math.ceil(crater.x + crater.radius));
    const minimumY = Math.max(0, Math.floor(crater.y - crater.radius));
    const maximumY = Math.min(mapPixels.height - 1, Math.ceil(crater.y + crater.radius));
    const radiusSquared = crater.radius * crater.radius;
    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let x = minimumX; x <= maximumX; x += 1) {
        const deltaX = x - crater.x;
        const deltaY = y - crater.y;
        if (deltaX * deltaX + deltaY * deltaY > radiusSquared) {
          continue;
        }
        const index = (y * mapPixels.width + x) * 4;
        if (
          mapPixels.data[index] === WALL_RGB[0] &&
          mapPixels.data[index + 1] === WALL_RGB[1] &&
          mapPixels.data[index + 2] === WALL_RGB[2]
        ) {
          dynamicMapPixels.data[index] = FLOOR_RGB[0];
          dynamicMapPixels.data[index + 1] = FLOOR_RGB[1];
          dynamicMapPixels.data[index + 2] = FLOOR_RGB[2];
        }
      }
    }
  }
  dynamicMapCanvas.getContext("2d")?.putImageData(dynamicMapPixels, 0, 0);
  appliedWallCraters = craters.map((crater) => ({ ...crater }));
}

function renderFrame(timestamp: number) {
  const deltaSeconds = Math.min((timestamp - lastFrameTime) / 1000, 0.05);
  const deltaMs = timestamp - lastFrameTime;
  lastFrameTime = timestamp;
  updateVehicle(deltaSeconds);
  updateSandbox(deltaSeconds);
  updateRenderPlayers(deltaSeconds);
  updateRenderBullets(deltaSeconds);
  recordFrameSample(timestamp, deltaMs);
  drawArena();
  requestAnimationFrame(renderFrame);
}

function updateRenderPlayers(deltaSeconds: number) {
  if (!activeRoom) {
    return;
  }
  const localSlot = getJoinedSlot(activeRoom.id);
  for (const player of renderPlayers) {
    if (player.slot === localSlot) {
      player.x = vehicle.x;
      player.y = vehicle.y;
      player.heading = vehicle.heading;
      player.speed = vehicle.speed;
    } else if (activeMode === "playing" && player.state === "alive") {
      player.x += Math.cos(player.heading) * player.speed * deltaSeconds;
      player.y += Math.sin(player.heading) * player.speed * deltaSeconds;
    }
  }
}

function updateRenderBullets(deltaSeconds: number) {
  if (activeMode !== "playing") {
    return;
  }
  for (const bullet of renderBullets) {
    const speed = bullet.kind === "grenade" ? GRENADE_SPEED : BULLET_SPEED;
    bullet.x += Math.cos(bullet.heading) * speed * deltaSeconds;
    bullet.y += Math.sin(bullet.heading) * speed * deltaSeconds;
  }
}

function updateSandbox(deltaSeconds: number) {
  if (!isSandboxMode()) {
    return;
  }

  sandboxFireCooldown = Math.max(0, sandboxFireCooldown - deltaSeconds);
  sandboxGrenadeCooldown = Math.max(0, sandboxGrenadeCooldown - deltaSeconds);
  if (activeKeys.has("Space") && sandboxFireCooldown <= 0) {
    spawnSandboxProjectile("bullet");
    sandboxFireCooldown = FIRE_COOLDOWN_SECONDS;
  }
  if (
    activeKeys.has("ArrowDown") &&
    sandboxGrenadeCooldown <= 0
  ) {
    spawnSandboxProjectile("grenade");
    sandboxGrenadeCooldown = GRENADE_COOLDOWN_SECONDS;
  }

  const remaining: SandboxProjectile[] = [];
  for (const projectile of sandboxProjectiles) {
    const speed = projectile.kind === "grenade" ? GRENADE_SPEED : BULLET_SPEED;
    const distance = speed * deltaSeconds;
    const steps = Math.max(1, Math.ceil(distance / projectile.radius));
    const stepX = Math.cos(projectile.heading) * distance / steps;
    const stepY = Math.sin(projectile.heading) * distance / steps;
    let consumed = false;
    for (let step = 0; step < steps; step += 1) {
      projectile.x += stepX;
      projectile.y += stepY;
      if (isOutsideMap(projectile.x, projectile.y)) {
        consumed = true;
        break;
      }
      if (projectile.kind === "bullet" && isWallPixel(projectile.x, projectile.y)) {
        carveSandboxWall(projectile.x, projectile.y, BULLET_CRATER_RADIUS);
        consumed = true;
        break;
      }
    }

    if (projectile.kind === "grenade") {
      projectile.lifetime -= deltaSeconds;
    }
    if (
      projectile.kind === "grenade" &&
      !consumed &&
      projectile.lifetime <= 0
    ) {
      carveSandboxWall(projectile.x, projectile.y, GRENADE_CRATER_RADIUS);
      blastEffects.push({
        id: sandboxNextBlastId,
        x: projectile.x,
        y: projectile.y,
        radius: GRENADE_BLAST_RADIUS,
        startedAt: performance.now(),
      });
      sandboxNextBlastId -= 1;
      consumed = true;
    }
    if (!consumed) {
      remaining.push(projectile);
    }
  }
  sandboxProjectiles = remaining;
}

function spawnSandboxProjectile(kind: "bullet" | "grenade") {
  const spawnDistance = PLAYER_RADIUS + (kind === "grenade" ? 8 : 6);
  sandboxProjectiles.push({
    id: sandboxNextProjectileId,
    ownerSlot: 1,
    x: vehicle.x + Math.cos(vehicle.heading) * spawnDistance,
    y: vehicle.y + Math.sin(vehicle.heading) * spawnDistance,
    heading: vehicle.heading,
    radius: kind === "grenade" ? 5 : 3,
    kind,
    lifetime: kind === "grenade"
      ? GRENADE_LIFETIME_SECONDS
      : Number.POSITIVE_INFINITY,
  });
  sandboxNextProjectileId -= 1;
}

function carveSandboxWall(x: number, y: number, radius: number) {
  sandboxCraters.push({ x, y, radius });
  syncWallCraters(sandboxCraters);
}

function isOutsideMap(x: number, y: number) {
  const { width, height } = getCurrentMapDimensions();
  return x < 0 || y < 0 || x >= width || y >= height;
}

function recordFrameSample(timestamp: number, deltaMs: number) {
  frameSamples.push({
    timestamp,
    deltaMs,
    x: vehicle.x,
    y: vehicle.y,
    speed: vehicle.speed,
  });

  if (frameSamples.length > 240) {
    frameSamples = frameSamples.slice(-240);
  }
}

function updateVehicle(deltaSeconds: number) {
  if (isSandboxMode()) {
    simulateClientVehicle(deltaSeconds);
    return;
  }

  if (activeMode !== "playing" || !activeRoom) {
    return;
  }

  const localSlot = getJoinedSlot(activeRoom.id);
  const localPlayer = activeRoom.players.find(
    (player) => player.slot === localSlot,
  );
  if (!localPlayer || localPlayer.state !== "alive") {
    vehicle.speed = 0;
    sendCurrentInput();
    return;
  }

  simulateClientVehicle(deltaSeconds);
  sendCurrentInput();
}

function simulateClientVehicle(deltaSeconds: number) {
  const turnInput =
    Number(activeKeys.has("ArrowRight")) - Number(activeKeys.has("ArrowLeft"));
  const movingFactor =
    0.35 + Math.min(Math.abs(vehicle.speed) / MAX_SPEED, 1) * 0.65;
  vehicle.heading += turnInput * movingFactor * TURN_SPEED * deltaSeconds;

  if (activeKeys.has("ArrowUp")) {
    vehicle.speed = Math.min(
      vehicle.speed + ACCELERATION * deltaSeconds,
      MAX_SPEED,
    );
  } else if (activeKeys.has("ArrowDown")) {
    vehicle.speed = Math.max(vehicle.speed - BRAKING * deltaSeconds, 0);
  } else {
    vehicle.speed = Math.max(vehicle.speed - FRICTION * deltaSeconds, 0);
  }

  const clearance = wallClearance(vehicle.x, vehicle.y, WALL_FIELD_RADIUS);
  const fieldStrength = Math.max(
    0,
    Math.min((clearance - PLAYER_RADIUS) / (WALL_FIELD_RADIUS - PLAYER_RADIUS), 1),
  );
  const dissipation =
    1 - (1 - fieldStrength) ** 2 * Math.min(deltaSeconds * 18, 0.85);
  vehicle.speed *= dissipation;

  const distance = vehicle.speed * deltaSeconds;
  const steps = Math.max(1, Math.ceil(distance / 2));
  const stepX = Math.cos(vehicle.heading) * distance / steps;
  const stepY = Math.sin(vehicle.heading) * distance / steps;
  let collided = false;
  for (let step = 0; step < steps; step += 1) {
    if (canOccupy(vehicle.x + stepX, vehicle.y)) {
      vehicle.x += stepX;
    } else {
      collided = true;
    }
    if (canOccupy(vehicle.x, vehicle.y + stepY)) {
      vehicle.y += stepY;
    } else {
      collided = true;
    }
  }
  if (collided) {
    vehicle.speed *= 0.18;
  }

  const stations = localMetroStations();
  const sourceIndex = localMetroStationIndex(stations);
  if (sourceIndex < 0) {
    localMetroArmed = true;
  } else if (localMetroArmed && stations.length >= 2) {
    const destination = stations[(sourceIndex + 1) % stations.length];
    if (destination) {
      vehicle.x = destination.x;
      vehicle.y = destination.y;
      vehicle.speed = 0;
      localMetroArmed = false;
    }
  }
}

function localMetroStations() {
  return activeMode === "previewingDesign"
    ? designerState?.metros ?? []
    : activeMap?.metroStations ?? [];
}

function localMetroStationIndex(stations = localMetroStations()) {
  if (stations.length < 2) {
    return -1;
  }
  return stations.findIndex(
    (station) =>
      (station.x - vehicle.x) ** 2 + (station.y - vehicle.y) ** 2 <=
      (PLAYER_RADIUS + 18) ** 2,
  );
}

function canOccupy(x: number, y: number) {
  const { width: mapWidth, height: mapHeight } = getCurrentMapDimensions();

  if (
    x < PLAYER_RADIUS ||
    y < PLAYER_RADIUS ||
    x > mapWidth - PLAYER_RADIUS ||
    y > mapHeight - PLAYER_RADIUS
  ) {
    return false;
  }

  if (!mapPixels) {
    return true;
  }

  if (isPlayerBlockingWallPixel(x, y)) {
    return false;
  }
  for (let sample = 0; sample < 24; sample += 1) {
    const angle = sample * Math.PI * 2 / 24;
    if (isPlayerBlockingWallPixel(
      x + Math.cos(angle) * PLAYER_RADIUS,
      y + Math.sin(angle) * PLAYER_RADIUS,
    )) {
      return false;
    }
  }
  return true;
}

function wallClearance(x: number, y: number, maximum: number) {
  for (let distance = 0; distance <= maximum; distance += 2) {
    for (let ray = 0; ray < 24; ray += 1) {
      const angle = ray * Math.PI * 2 / 24;
      if (isPlayerBlockingWallPixel(
        x + Math.cos(angle) * distance,
        y + Math.sin(angle) * distance,
      )) {
        return distance;
      }
    }
  }
  return maximum;
}

function isWallPixel(x: number, y: number) {
  const collisionPixels = dynamicMapPixels ?? mapPixels;
  if (!collisionPixels) {
    return false;
  }

  const pixelX = Math.floor(x);
  const pixelY = Math.floor(y);

  if (
    pixelX < 0 ||
    pixelY < 0 ||
    pixelX >= collisionPixels.width ||
    pixelY >= collisionPixels.height
  ) {
    return true;
  }

  const index = (pixelY * collisionPixels.width + pixelX) * 4;
  return (
    collisionPixels.data[index] === WALL_RGB[0] &&
    collisionPixels.data[index + 1] === WALL_RGB[1] &&
    collisionPixels.data[index + 2] === WALL_RGB[2]
  );
}

function isPlayerBlockingWallPixel(x: number, y: number) {
  const collisionPixels = dynamicMapPixels ?? mapPixels;
  if (!collisionPixels) {
    return false;
  }
  const startX = Math.floor(x);
  const startY = Math.floor(y);
  if (
    startX < 0 ||
    startY < 0 ||
    startX >= collisionPixels.width ||
    startY >= collisionPixels.height
  ) {
    return true;
  }
  const startIndex = startY * collisionPixels.width + startX;
  if (!isWallPixelIndex(collisionPixels, startIndex)) {
    return false;
  }

  const connected = [startIndex];
  const visited = new Set(connected);
  for (let cursor = 0; cursor < connected.length; cursor += 1) {
    const pixel = connected[cursor];
    if (pixel === undefined) {
      continue;
    }
    const pixelX = pixel % collisionPixels.width;
    const pixelY = Math.floor(pixel / collisionPixels.width);
    for (let neighborY = Math.max(0, pixelY - 1);
      neighborY <= Math.min(collisionPixels.height - 1, pixelY + 1);
      neighborY += 1) {
      for (let neighborX = Math.max(0, pixelX - 1);
        neighborX <= Math.min(collisionPixels.width - 1, pixelX + 1);
        neighborX += 1) {
        const neighbor = neighborY * collisionPixels.width + neighborX;
        if (visited.has(neighbor) || !isWallPixelIndex(collisionPixels, neighbor)) {
          continue;
        }
        visited.add(neighbor);
        connected.push(neighbor);
        if (connected.length >= MIN_BLOCKING_WALL_COMPONENT_PIXELS) {
          return true;
        }
      }
    }
  }
  return false;
}

function isWallPixelIndex(pixels: ImageData, pixel: number) {
  const index = pixel * 4;
  return (
    pixels.data[index] === WALL_RGB[0] &&
    pixels.data[index + 1] === WALL_RGB[1] &&
    pixels.data[index + 2] === WALL_RGB[2]
  );
}

function drawArena() {
  canvasContext.imageSmoothingEnabled = false;
  canvasContext.fillStyle = "#000000";
  canvasContext.fillRect(0, 0, canvas.width, canvas.height);

  const fit = getMapFit();

  if (activeMode === "designingMap" && designerState) {
    drawDesignerArena(fit, designerState);
    return;
  }

  const drawableMap = dynamicMapCanvas ?? mapImage;
  if (drawableMap) {
    canvasContext.drawImage(drawableMap, fit.x, fit.y, fit.width, fit.height);
  }

  if (
    activeMode === "selectingMap" ||
    activeMode === "previewingDesign" ||
    activeMode === "waiting" ||
    activeMode === "playing" ||
    activeMode === "ended"
  ) {
    if (activeRoom) {
      drawServerEntities(fit, activeRoom);
    } else {
      for (const projectile of sandboxProjectiles) {
        drawBullet(fit, projectile);
      }
      drawBlastEffects(fit);
      drawVehicle(fit);
    }
  }
}

function drawDesignerArena(fit: MapFit, state: DesignerState) {
  canvasContext.drawImage(state.canvas, fit.x, fit.y, fit.width, fit.height);
  for (const [index, metro] of state.metros.entries()) {
    const x = fit.x + metro.x * fit.scale;
    const y = fit.y + metro.y * fit.scale;
    const size = Math.max(10 * getDeviceScale(), 24 * fit.scale);
    canvasContext.fillStyle = METRO_COLOR;
    canvasContext.fillRect(x - size / 2, y - size / 2, size, size);
    canvasContext.fillStyle = "#ffffff";
    canvasContext.font = `${Math.max(9 * getDeviceScale(), 12 * fit.scale)}px monospace`;
    canvasContext.textAlign = "center";
    canvasContext.textBaseline = "middle";
    canvasContext.fillText(`M${index + 1}`, x, y);
  }
  for (const [index, spawn] of state.spawns.entries()) {
    const x = fit.x + spawn.x * fit.scale;
    const y = fit.y + spawn.y * fit.scale;
    const radius = Math.max(7 * getDeviceScale(), 10 * fit.scale);
    canvasContext.fillStyle = spawn.color;
    canvasContext.strokeStyle = "#ffffff";
    canvasContext.lineWidth = Math.max(1.5 * getDeviceScale(), fit.scale);
    canvasContext.beginPath();
    canvasContext.arc(x, y, radius, 0, Math.PI * 2);
    canvasContext.fill();
    canvasContext.stroke();
    canvasContext.fillStyle = "#111111";
    canvasContext.font = `${Math.max(8 * getDeviceScale(), 10 * fit.scale)}px monospace`;
    canvasContext.textAlign = "center";
    canvasContext.textBaseline = "middle";
    canvasContext.fillText(String(index + 1), x, y);
  }
}

function drawServerEntities(fit: MapFit, room: Room) {
  const players = renderPlayers.length > 0 ? renderPlayers : room.players;
  const bullets = renderBullets.length > 0 ? renderBullets : room.bullets;

  for (const bullet of bullets) {
    drawBullet(fit, bullet);
  }

  drawBlastEffects(fit);
  drawDeathEffects(fit);

  for (const player of players) {
    if (player.state === "alive") {
      drawPlayer(fit, player);
    }
  }
}

function drawBlastEffects(fit: MapFit) {
  const now = performance.now();
  blastEffects = blastEffects.filter((effect) => {
    const progress = (now - effect.startedAt) / BLAST_EFFECT_DURATION_MS;
    if (progress >= 1) {
      return false;
    }
    const screenX = fit.x + effect.x * fit.scale;
    const screenY = fit.y + effect.y * fit.scale;
    const radius = effect.radius * fit.scale * (0.25 + progress * 0.75);
    const gradient = canvasContext.createRadialGradient(
      screenX,
      screenY,
      0,
      screenX,
      screenY,
      Math.max(radius, 1),
    );
    gradient.addColorStop(0, `rgb(255 255 180 / ${0.8 * (1 - progress)})`);
    gradient.addColorStop(0.45, `rgb(255 128 0 / ${0.65 * (1 - progress)})`);
    gradient.addColorStop(1, "rgb(128 0 0 / 0%)");
    canvasContext.fillStyle = gradient;
    canvasContext.beginPath();
    canvasContext.arc(screenX, screenY, radius, 0, Math.PI * 2);
    canvasContext.fill();
    return true;
  });
}

function drawDeathEffects(fit: MapFit) {
  const now = performance.now();
  deathEffects = deathEffects.filter((effect) => {
    const progress = (now - effect.startedAt) / DEATH_EFFECT_DURATION_MS;
    if (progress >= 1) {
      return false;
    }

    const screenX = fit.x + effect.x * fit.scale;
    const screenY = fit.y + effect.y * fit.scale;
    const alpha = 1 - progress;
    const baseRadius = Math.max(6 * getDeviceScale(), PLAYER_RADIUS * fit.scale);
    canvasContext.save();
    canvasContext.globalAlpha = alpha;
    canvasContext.strokeStyle = effect.color;
    canvasContext.lineWidth = Math.max(2 * getDeviceScale(), fit.scale * 2);
    canvasContext.beginPath();
    canvasContext.arc(
      screenX,
      screenY,
      baseRadius * (1 + progress * 2.5),
      0,
      Math.PI * 2,
    );
    canvasContext.stroke();

    canvasContext.fillStyle = effect.color;
    for (let particle = 0; particle < 10; particle += 1) {
      const angle = (particle / 10) * Math.PI * 2 + effect.slot;
      const distance = baseRadius * (0.7 + progress * 3.2);
      canvasContext.beginPath();
      canvasContext.arc(
        screenX + Math.cos(angle) * distance,
        screenY + Math.sin(angle) * distance,
        Math.max(1.5 * getDeviceScale(), baseRadius * 0.2 * alpha),
        0,
        Math.PI * 2,
      );
      canvasContext.fill();
    }
    canvasContext.restore();
    return true;
  });
}

function drawPlayer(fit: MapFit, player: PlayerSummary) {
  const screenX = fit.x + player.x * fit.scale;
  const screenY = fit.y + player.y * fit.scale;
  const radius = Math.max(6 * getDeviceScale(), PLAYER_RADIUS * fit.scale);
  const color = player.color || PLAYER_COLORS[player.slot - 1] || PLAYER_COLORS[0];

  canvasContext.save();
  canvasContext.translate(screenX, screenY);
  canvasContext.rotate(player.heading);
  canvasContext.fillStyle = color;
  canvasContext.strokeStyle = "#111111";
  canvasContext.lineWidth = Math.max(2 * getDeviceScale(), fit.scale);
  canvasContext.beginPath();
  canvasContext.arc(0, 0, radius, 0, Math.PI * 2);
  canvasContext.fill();
  canvasContext.stroke();
  canvasContext.beginPath();
  canvasContext.moveTo(0, 0);
  canvasContext.lineTo(radius * 1.45, 0);
  canvasContext.stroke();
  canvasContext.restore();

  if (activeRoom && activeRoom.tick < player.invulnerableUntilTick) {
    canvasContext.strokeStyle = "#ffffff";
    canvasContext.lineWidth = Math.max(2 * getDeviceScale(), fit.scale);
    canvasContext.beginPath();
    canvasContext.arc(screenX, screenY, radius * 1.45, 0, Math.PI * 2);
    canvasContext.stroke();
  }

  const healthWidth = radius * 2;
  const healthRatio = Math.max(0, Math.min(player.health / 100, 1));
  canvasContext.fillStyle = "#111111";
  canvasContext.fillRect(
    screenX - radius,
    screenY - radius - 8,
    healthWidth,
    3,
  );
  canvasContext.fillStyle = "#00cc44";
  canvasContext.fillRect(
    screenX - radius,
    screenY - radius - 8,
    healthWidth * healthRatio,
    3,
  );
}

function drawBullet(fit: MapFit, bullet: BulletSummary) {
  const screenX = fit.x + bullet.x * fit.scale;
  const screenY = fit.y + bullet.y * fit.scale;
  const radius = Math.max(2 * getDeviceScale(), bullet.radius * fit.scale);

  const isGrenade = bullet.kind === "grenade";
  const trailDistance = radius * (isGrenade ? 1.5 : 2.4);
  canvasContext.fillStyle = isGrenade
    ? "rgb(255 128 0 / 35%)"
    : "rgb(17 17 17 / 35%)";
  canvasContext.beginPath();
  canvasContext.arc(
    screenX - Math.cos(bullet.heading) * trailDistance,
    screenY - Math.sin(bullet.heading) * trailDistance,
    radius * 0.65,
    0,
    Math.PI * 2,
  );
  canvasContext.fill();

  canvasContext.fillStyle = isGrenade ? "#314f22" : "#111111";
  canvasContext.beginPath();
  canvasContext.arc(screenX, screenY, radius, 0, Math.PI * 2);
  canvasContext.fill();
  if (isGrenade) {
    canvasContext.strokeStyle = "#ff9800";
    canvasContext.lineWidth = Math.max(1.5 * getDeviceScale(), fit.scale);
    canvasContext.stroke();
  }
}

function drawVehicle(fit: MapFit) {
  const screenX = fit.x + vehicle.x * fit.scale;
  const screenY = fit.y + vehicle.y * fit.scale;
  const radius = Math.max(6 * getDeviceScale(), PLAYER_RADIUS * fit.scale);
  const color = isSandboxMode()
    ? activeMode === "previewingDesign"
      ? designerState?.spawns[0]?.color ?? PLAYER_COLORS[0]
      : activeMap?.previewPlayerColor ?? PLAYER_COLORS[0]
    : activeRoom?.players.find((player) => player.slot === vehicleSlot)?.color ??
      PLAYER_COLORS[(vehicleSlot ?? 1) - 1] ?? PLAYER_COLORS[0];

  canvasContext.save();
  canvasContext.translate(screenX, screenY);
  canvasContext.rotate(vehicle.heading);
  canvasContext.fillStyle = color;
  canvasContext.strokeStyle = "#111111";
  canvasContext.lineWidth = Math.max(2 * getDeviceScale(), fit.scale);
  canvasContext.beginPath();
  canvasContext.arc(0, 0, radius, 0, Math.PI * 2);
  canvasContext.fill();
  canvasContext.stroke();
  canvasContext.beginPath();
  canvasContext.moveTo(0, 0);
  canvasContext.lineTo(radius * 1.45, 0);
  canvasContext.stroke();
  canvasContext.restore();
}

function getMapFit(): MapFit {
  const mapWidth = (activeMode === "designingMap" || activeMode === "previewingDesign") && designerState
    ? designerState.width
    : mapImage?.naturalWidth ?? DEFAULT_MAP_WIDTH;
  const mapHeight = (activeMode === "designingMap" || activeMode === "previewingDesign") && designerState
    ? designerState.height
    : mapImage?.naturalHeight ?? DEFAULT_MAP_HEIGHT;
  const scale = Math.min(canvas.width / mapWidth, canvas.height / mapHeight);
  const width = mapWidth * scale;
  const height = mapHeight * scale;

  return {
    x: (canvas.width - width) / 2,
    y: (canvas.height - height) / 2,
    width,
    height,
    scale,
  };
}

function isSandboxMode() {
  return activeMode === "selectingMap" || activeMode === "previewingDesign";
}

function getCurrentMapDimensions() {
  if (activeMode === "previewingDesign" && designerState) {
    return { width: designerState.width, height: designerState.height };
  }
  return {
    width: mapImage?.naturalWidth ?? DEFAULT_MAP_WIDTH,
    height: mapImage?.naturalHeight ?? DEFAULT_MAP_HEIGHT,
  };
}

function resizeCanvas() {
  const deviceScale = getDeviceScale();
  const width = Math.max(1, Math.floor(canvas.clientWidth * deviceScale));
  const height = Math.max(1, Math.floor(canvas.clientHeight * deviceScale));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function getDeviceScale() {
  return Math.min(window.devicePixelRatio || 1, 2);
}

function updateHud() {
  const hud = document.querySelector<HTMLElement>("#hud");
  const modeLine = document.querySelector<HTMLParagraphElement>("#mode-line");
  const mapLine = document.querySelector<HTMLParagraphElement>("#map-line");
  const playerList = document.querySelector<HTMLOListElement>("#player-list");
  const eventFeed = document.querySelector<HTMLOListElement>("#event-feed");
  const controlHint = document.querySelector<HTMLParagraphElement>("#control-hint");
  const selectionControls = document.querySelector<HTMLElement>("#selection-controls");
  const roomControls = document.querySelector<HTMLElement>("#room-controls");
  const copyInvite = document.querySelector<HTMLButtonElement>("#copy-invite");
  const rematchButton = document.querySelector<HTMLButtonElement>("#rematch-button");
  const leaveButton = document.querySelector<HTMLButtonElement>("#leave-button");
  const designerButton = document.querySelector<HTMLButtonElement>("#designer-button");
  const designerControls = document.querySelector<HTMLElement>("#designer-controls");
  const designerName = document.querySelector<HTMLInputElement>("#designer-name");
  const designerBrush = document.querySelector<HTMLSelectElement>("#designer-brush");
  const designerColor = document.querySelector<HTMLInputElement>("#designer-color");
  const designerUndo = document.querySelector<HTMLButtonElement>("#designer-undo");
  const designerPreview = document.querySelector<HTMLButtonElement>("#designer-preview");
  const designerSave = document.querySelector<HTMLButtonElement>("#designer-save");
  const designerCounts = document.querySelector<HTMLElement>("#designer-counts");
  const designerMessage = document.querySelector<HTMLElement>("#designer-message");

  const designerVisible = activeMode === "designingMap" || activeMode === "previewingDesign";
  const previewVisible = activeMode === "previewingDesign";
  const designerLayoutChanged = document.documentElement.classList.contains("designer-mode")
    !== designerVisible;
  document.documentElement.classList.toggle("designer-mode", designerVisible);
  document.documentElement.classList.toggle("designer-preview-mode", previewVisible);
  if (designerLayoutChanged) {
    window.requestAnimationFrame(resizeCanvas);
  }
  if (hud) {
    hud.dataset.stage = getHudStage();
  }
  hud?.classList.toggle("designer-active", designerVisible);
  hud?.classList.toggle("preview-active", previewVisible);
  hud?.style.setProperty(
    "--brush-preview-size",
    `${Math.max(6, Math.min(22, designerState?.brushSize ?? 24))}px`,
  );

  if (modeLine) {
    setTextIfChanged(modeLine, getModeText());
  }

  if (mapLine) {
    setInnerHtmlIfChanged(mapLine, getMapText());
  }

  if (playerList) {
    setInnerHtmlIfChanged(playerList, getPlayerListHtml());
  }

  if (eventFeed) {
    setInnerHtmlIfChanged(eventFeed, getEventFeedHtml());
  }
  if (controlHint) {
    setTextIfChanged(controlHint, getControlHint());
  }

  const selecting = activeMode === "selectingMap";
  const isHost = activeRoom
    ? sessionStorage.getItem(joinedKey(activeRoom.id)) === "host"
    : false;
  if (selectionControls) {
    selectionControls.hidden = !selecting;
  }
  if (roomControls) {
    roomControls.hidden = activeRoom === null && activeMode !== "missing";
  }
  if (copyInvite) {
    copyInvite.hidden = !(
      isHost &&
      inviteVisible &&
      inviteUrl &&
      activeRoom &&
      (activeRoom.phase === "lobby" || activeRoom.phase === "countdown")
    );
  }
  if (rematchButton) {
    rematchButton.hidden = !(isHost && activeRoom?.phase === "ended");
  }
  if (leaveButton) {
    leaveButton.textContent = activeMode === "missing" ? "Choose a map" : "Maps";
  }

  if (designerButton) {
    designerButton.hidden = activeMode !== "selectingMap";
  }
  if (designerControls) {
    designerControls.hidden = !designerVisible;
  }
  if (designerState && designerVisible) {
    if (designerName && document.activeElement !== designerName) {
      designerName.value = designerState.name;
    }
    if (designerBrush) {
      designerBrush.value = String(designerState.brushSize);
    }
    if (designerColor) {
      designerColor.value = designerState.color;
    }
    if (designerUndo) {
      designerUndo.disabled = designerState.history.length === 0
        || previewVisible;
    }
    if (designerSave) {
      designerSave.disabled = designerState.saving
        || designerState.spawns.length < 2
        || designerState.metros.length === 1;
      designerSave.innerHTML = designerState.saving
        ? "Saving…"
        : "<span aria-hidden=\"true\">▣</span> Save";
    }
    if (designerPreview) {
      designerPreview.disabled = !previewVisible && (
        designerState.spawns.length < 2 || designerState.metros.length === 1
      );
      designerPreview.innerHTML = activeMode === "previewingDesign"
        ? "<span aria-hidden=\"true\">↶</span> Back to edit"
        : "<span aria-hidden=\"true\">▶</span> Preview";
    }
    if (designerCounts) {
      setTextIfChanged(
        designerCounts,
        `Spawns ${designerState.spawns.length}/8 · Metro ${designerState.metros.length}/16`,
      );
    }
    if (designerMessage) {
      setTextIfChanged(designerMessage, designerState.message);
    }
    for (const toolButton of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      toolButton.classList.toggle("active", toolButton.dataset.tool === designerState.tool);
    }
    for (const swatch of document.querySelectorAll<HTMLButtonElement>("[data-designer-color]")) {
      swatch.classList.toggle(
        "active",
        swatch.dataset.designerColor?.toLowerCase() === designerState.color.toLowerCase(),
      );
    }
  }

}

function getHudStage() {
  if (activeMode === "designingMap" || activeMode === "previewingDesign") {
    return "designer";
  }
  if (activeMode === "selectingMap" || activeMode === "creatingRoom") {
    return "selection";
  }
  if (activeMode === "ended") {
    return "results";
  }
  if (activeMode === "playing") {
    return "playing";
  }
  return "lobby";
}

function getModeText() {
  if (activeMode === "previewingDesign") {
    return "Test drive";
  }
  if (activeMode === "designingMap") {
    return "Map studio";
  }
  if (activeMode === "creatingRoom") {
    return "Creating match";
  }

  if (activeMode === "missing") {
    return "Room not found";
  }

  if (activeRoom) {
    if (activeRoom.phase === "playing") {
      return "Match live";
    }
    if (activeRoom.phase === "countdown") {
      const ticks = Math.max(
        0,
        (activeRoom.phaseEndsAtTick ?? activeRoom.tick) - activeRoom.tick,
      );
      return `Starting in ${Math.max(1, Math.ceil(ticks / 30))}`;
    }
    if (activeRoom.phase === "ended") {
      const winner = activeRoom.players.find(
        (player) => player.slot === activeRoom?.winnerSlot,
      );
      return winner
        ? `${winner.nickname} wins`
        : "Match ended";
    }
    return "Waiting for rival";
  }

  if (activeMode === "waiting") {
    return "Loading";
  }

  if (activeMode === "selectingMap") {
    return "Choose arena";
  }

  return "Create game";
}

function getMapText() {
  if (activeMode === "previewingDesign") {
    return designerState ? escapeHtml(designerState.name) : "Unsaved map";
  }
  if (activeMode === "designingMap") {
    return designerState ? escapeHtml(designerState.name) : "Untitled arena";
  }
  if (!activeMap) {
    return "No maps";
  }

  if (activeMode === "selectingMap") {
    return `<strong>${escapeHtml(activeMap.name)}</strong><span>${selectedMapIndex + 1}/${maps.length} · ${activeMap.numberOfPlayers} players</span>`;
  }

  if (activeRoom) {
    return `<strong>${escapeHtml(activeMap.name)}</strong><span>Room ${escapeHtml(activeRoom.id)}</span>`;
  }

  return escapeHtml(activeMap.name);
}

function getPlayerListHtml() {
  if (!activeRoom) {
    return "";
  }

  const room = activeRoom;
  const localSlot = getJoinedSlot(room.id);
  return room.players
    .map((player) => {
      const color = player.color || PLAYER_COLORS[player.slot - 1] || PLAYER_COLORS[0];
      let status = player.host ? "Host" : "Ready";
      if (room.phase === "playing") {
        status = player.state === "respawning"
          ? `Back in ${Math.max(0, Math.ceil(((player.respawnAtTick ?? room.tick) - room.tick) / 30))}s`
          : `${player.health} HP · ${player.kills} KO`;
      } else if (room.phase === "ended") {
        status = `${player.kills} KO · ${player.deaths}/${room.deathLimit}`;
      }
      const localClass = player.slot === localSlot ? " class=\"local-player\"" : "";
      return `<li${localClass}><span class="player-dot" style="--player-color: ${color}"></span><span>${escapeHtml(player.nickname)}</span><span class="player-status">${status}</span></li>`;
    })
    .join("");
}

function getControlHint() {
  if (activeMode === "selectingMap") {
    return "Tab switches maps · Enter creates match";
  }
  if (activeMode === "designingMap") {
    return "Paint, place, preview, then save";
  }
  if (activeMode === "previewingDesign") {
    return "Arrow keys move · Space fires";
  }
  if (activeRoom?.phase === "lobby") {
    return "Share the invite to start";
  }
  if (activeRoom?.phase === "countdown") {
    return "Get ready";
  }
  if (activeRoom?.phase === "playing") {
    return "Arrow keys move · Space fires";
  }
  if (activeRoom?.phase === "ended") {
    return "Play again or choose another arena";
  }
  return "";
}

function getEventFeedHtml() {
  return (activeRoom?.feed ?? [])
    .slice(-4)
    .reverse()
    .map((message) => `<li>${escapeHtml(message)}</li>`)
    .join("");
}

function connectStatusSocket() {
  socket?.close();
  const wsStatus = document.querySelector<HTMLParagraphElement>("#ws-status");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

  socket.addEventListener("message", (event) => {
    if (wsStatus) {
      setTextIfChanged(wsStatus, String(event.data));
    }
  });
}

function connectRoomSocket(roomId: string) {
  socketRoomId = roomId;
  socket?.close();
  if (socketReconnectTimer !== undefined) {
    window.clearTimeout(socketReconnectTimer);
    socketReconnectTimer = undefined;
  }

  const wsStatus = document.querySelector<HTMLParagraphElement>("#ws-status");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const roomSocket = new WebSocket(
    `${protocol}//${window.location.host}/ws/rooms/${roomId}`,
  );
  socket = roomSocket;

  roomSocket.addEventListener("open", () => {
    if (wsStatus) {
      setTextIfChanged(wsStatus, "realtime · 30 Hz");
    }
  });
  roomSocket.addEventListener("message", (event) => {
    try {
      const room = JSON.parse(String(event.data)) as Room;
      if (room.id === roomId && activeRoom?.id === roomId) {
        applyRoomSnapshot(room);
      }
    } catch (error) {
      console.error("Invalid room snapshot", error);
    }
  });
  roomSocket.addEventListener("close", () => {
    if (socket !== roomSocket || socketRoomId !== roomId) {
      return;
    }
    if (wsStatus) {
      setTextIfChanged(wsStatus, "reconnecting…");
    }
    socketReconnectTimer = window.setTimeout(() => {
      if (socketRoomId === roomId && activeRoom?.id === roomId) {
        connectRoomSocket(roomId);
      }
    }, 750);
  });
}

function installDebugSurface() {
  window.__paintArenaDebug = {
    getState: () => ({
      mode: activeMode,
      roomId: activeRoom?.id ?? null,
      vehicle: { ...vehicle },
      renderPlayers: renderPlayers.map((player) => ({ ...player })),
      renderBullets: (isSandboxMode()
        ? sandboxProjectiles
        : renderBullets
      ).map((bullet) => ({ ...bullet })),
      wallCraters: (isSandboxMode()
        ? sandboxCraters
        : activeRoom?.wallCraters ?? []
      ).map((crater) => ({ ...crater })),
      blastEffects: blastEffects.map((effect) => ({ ...effect })),
      frameSamples: frameSamples.map((sample) => ({ ...sample })),
    }),
    resetFrameSamples: () => {
      frameSamples = [];
    },
  };
}

function sendCurrentInput() {
  if (!activeRoom || activeMode !== "playing") {
    return;
  }

  const slot = getJoinedSlot(activeRoom.id);
  const token = getSessionToken(activeRoom.id);
  const now = performance.now();
  const inputPayload = {
    token,
    sequence: inputSequence + 1,
    accelerate: activeKeys.has("ArrowUp"),
    brake: activeKeys.has("ArrowDown"),
    turnLeft: activeKeys.has("ArrowLeft"),
    turnRight: activeKeys.has("ArrowRight"),
    fire: activeKeys.has("Space"),
    grenade: activeKeys.has("ArrowDown"),
  };
  const controlsSignature = JSON.stringify({
    accelerate: inputPayload.accelerate,
    brake: inputPayload.brake,
    turnLeft: inputPayload.turnLeft,
    turnRight: inputPayload.turnRight,
    fire: inputPayload.fire,
    grenade: inputPayload.grenade,
  });

  if (
    slot === null ||
    token === null ||
    (controlsSignature === lastControlsSignature &&
      now - lastInputSentAt < INPUT_SEND_INTERVAL_MS)
  ) {
    return;
  }

  lastInputSentAt = now;
  lastControlsSignature = controlsSignature;
  inputSequence += 1;
  inputPayload.sequence = inputSequence;

  void fetch(`/api/rooms/${activeRoom.id}/players/${slot}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inputPayload),
    }).then((response) => {
      if (!response.ok) {
        throw new HttpError(response.status, `Input rejected: ${response.status}`);
      }
    }).catch((error: unknown) => console.error(error));
}

function blendNumber(from: number, to: number, factor: number) {
  return from + (to - from) * factor;
}

function blendAngle(from: number, to: number, factor: number) {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * factor;
}

function createVehicle(): Vehicle {
  return {
    x: DEFAULT_MAP_WIDTH / 2,
    y: DEFAULT_MAP_HEIGHT / 2,
    heading: -Math.PI / 2,
    speed: 0,
  };
}

function normalizeInputKey(key: string) {
  if (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight"
  ) {
    return key;
  }

  if (key === " " || key === "Spacebar") {
    return "Space";
  }

  return null;
}

function loadImage(imageUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error(`Failed to load ${imageUrl}`)),
      {
        once: true,
      },
    );
    image.src = imageUrl;
  });
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);

  if (!response.ok) {
    throw new HttpError(response.status, `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function roomIdFromPath(path: string) {
  const match = path.match(/\/game\/([A-Z0-9]+)/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setTextIfChanged(element: HTMLElement, text: string) {
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

function setInnerHtmlIfChanged(element: HTMLElement, html: string) {
  if (element.innerHTML !== html) {
    element.innerHTML = html;
  }
}
