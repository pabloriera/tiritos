import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Builder, By, Key, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

const webDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rootDir = resolve(webDir, "..");
const serverPort = process.env.E2E_SERVER_PORT ?? "18080";
const webPort = process.env.E2E_WEB_PORT ?? "15173";
const baseUrl = `http://127.0.0.1:${webPort}`;
const tempDir = resolve(webDir, ".tmp", "selenium-two-player");

const chromePath =
  process.env.SELENIUM_CHROME_BINARY ?? findBrowserBinary("chrome", "chrome");
const driverPath =
  process.env.SELENIUM_CHROMEDRIVER_BINARY ??
  findBrowserBinary("chromedriver", "chromedriver");

mkdirSync(tempDir, { recursive: true });

assertExecutable(chromePath, "Chrome");
assertExecutable(driverPath, "ChromeDriver");

const server = spawnManaged(
  "cargo",
  ["run", "--manifest-path", join(rootDir, "server", "Cargo.toml")],
  rootDir,
  {
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: serverPort,
    CUSTOM_MAP_DIR: join(tempDir, "maps"),
  },
);
const web = spawnManaged(
  "npm",
  [
    "--prefix",
    "web",
    "run",
    "dev",
    "--",
    "--host",
    "127.0.0.1",
    "--port",
    webPort,
  ],
  rootDir,
  { SERVER_PORT: serverPort },
);

let playerOne;
let playerTwo;

try {
  await waitForUrl(`http://127.0.0.1:${serverPort}/api/maps`);
  await waitForUrl(baseUrl);

  playerOne = await createDriver("player-one");
  playerTwo = await createDriver("player-two");

  await playerOne.get(baseUrl);
  await waitForElement(playerOne, "#map-canvas");
  await playerOne.wait(
    async () => {
      const state = await playerOne.executeScript(
        "return window.__paintArenaDebug?.getState()",
      );
      return state?.mode === "selectingMap" && state.vehicle.x === 249;
    },
    10_000,
    "Timed out waiting for the map preview player",
  );
  const previewBefore = await playerOne.executeScript(
    "return window.__paintArenaDebug.getState().vehicle",
  );
  await holdKey(playerOne, "w", 300);
  const previewAfter = await playerOne.executeScript(
    "return window.__paintArenaDebug.getState().vehicle",
  );
  if (distance(previewBefore, previewAfter) < 1) {
    throw new Error("WASD did not move the map preview player");
  }

  await playerOne.actions().keyDown(Key.SPACE).perform();
  await playerOne.wait(
    async () => playerOne.executeScript(
      "return window.__paintArenaDebug.getState().renderBullets.some((bullet) => bullet.kind === 'bullet')",
    ),
    2_000,
    "Sandbox gun did not create a bullet",
  );
  await playerOne.actions().keyUp(Key.SPACE).perform();

  await playerOne.actions().keyDown("g").perform();
  await playerOne.wait(
    async () => playerOne.executeScript(
      "return window.__paintArenaDebug.getState().renderBullets.some((bullet) => bullet.kind === 'grenade')",
    ),
    2_000,
    "Sandbox grenade was not created",
  );
  await playerOne.actions().keyUp("g").perform();
  await playerOne.wait(
    async () => playerOne.executeScript(
      "return window.__paintArenaDebug.getState().blastEffects.length > 0",
    ),
    3_000,
    "Sandbox grenade did not produce a blast",
  );

  await playerOne.findElement(By.css("#designer-button")).click();
  await waitForDebugState(playerOne, (state) => state.mode === "designingMap");
  await playerOne.executeScript(`
    const input = document.querySelector('#designer-name');
    input.value = 'Selenium Brushworks';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await playerOne.findElement(By.css('[data-tool="wall"]')).click();
  await drawDesignerGesture(playerOne, [[0.43, 0.5], [0.57, 0.5]]);
  await playerOne.findElement(By.css('[data-tool="spawn"]')).click();
  await drawDesignerGesture(playerOne, [[0.5, 0.2]]);
  await playerOne.findElement(By.css('[data-tool="metro"]')).click();
  await drawDesignerGesture(playerOne, [[0.3, 0.3]]);
  await drawDesignerGesture(playerOne, [[0.7, 0.7]]);
  await playerOne.findElement(By.css("#designer-save")).click();
  await playerOne.sleep(2_000);
  const designerResult = await playerOne.executeScript(`return {
    mode: window.__paintArenaDebug?.getState().mode,
    message: document.querySelector('#designer-message')?.textContent,
    mapText: document.querySelector('#map-line')?.textContent,
  }`);
  if (designerResult.mode !== "selectingMap") {
    throw new Error(`Designer save failed: ${JSON.stringify(designerResult)}`);
  }
  await waitForDebugState(playerOne, (state) => state.mode === "selectingMap");
  if (!designerResult.mapText?.includes("Selenium Brushworks")) {
    throw new Error(`Unexpected saved map: ${JSON.stringify(designerResult)}`);
  }
  await waitForText(playerOne, "#map-line", "Selenium Brushworks");

  const designedMapText = await playerOne.findElement(By.css("#map-line")).getText();
  await pressKey(playerOne, Key.TAB);
  await playerOne.wait(
    async () => {
      const nextMapName = await playerOne.findElement(By.css("#map-line")).getText();
      return nextMapName !== designedMapText;
    },
    10_000,
    "Tab did not change the sandbox map",
  );
  await playerOne.actions().keyDown(Key.SHIFT).sendKeys(Key.TAB).keyUp(Key.SHIFT).perform();
  await waitForText(playerOne, "#map-line", "Selenium Brushworks");
  await pressKey(playerOne, Key.ENTER);
  await playerOne.wait(until.urlMatches(/\/game\/[A-Z0-9]+$/), 10_000);
  const inviteUrl = await playerOne.getCurrentUrl();
  const roomId = inviteUrl.match(/\/game\/([A-Z0-9]+)$/)?.[1];

  if (!roomId) {
    throw new Error(`Could not parse room id from ${inviteUrl}`);
  }

  await waitForText(playerOne, "#player-list", "Player1");

  await playerTwo.get(inviteUrl);
  await waitForText(playerTwo, "#mode-line", "Playing");
  await waitForText(playerTwo, "#player-list", "Player2");
  await waitForText(playerOne, "#player-list", "Player2");

  const initialRoom = await waitForRoom(
    playerOne,
    roomId,
    (room) => room.players.length === 2,
  );
  const initialPlayerOne = initialRoom.players.find(
    (player) => player.slot === 1,
  );
  const initialPlayerTwo = initialRoom.players.find(
    (player) => player.slot === 2,
  );

  if (!hasCoordinates(initialPlayerOne) || !hasCoordinates(initialPlayerTwo)) {
    throw new Error(
      "Server snapshot did not include coordinates for both players",
    );
  }

  await holdKey(playerOne, Key.ARROW_UP, 650);
  await waitForRoom(
    playerOne,
    roomId,
    (room) => {
      const movedPlayer = room.players.find((player) => player.slot === 1);
      return (
        hasCoordinates(movedPlayer) &&
        distance(movedPlayer, initialPlayerOne) > 2
      );
    },
    "Timed out waiting for Player 1 server position to change",
  );

  await holdKey(playerOne, Key.ARROW_DOWN, 150);
  await waitForRoom(
    playerOne,
    roomId,
    (room) => room.bullets.some((bullet) => bullet.kind === "grenade"),
    "Timed out waiting for a server-created grenade",
  );
  await waitForRoom(
    playerOne,
    roomId,
    (room) => room.blasts.length > 0 && room.wallCraters.length > 0,
    "Timed out waiting for the grenade blast and crater",
  );

  await holdKey(playerOne, Key.SPACE, 300);
  await waitForRoom(
    playerTwo,
    roomId,
    (room) => room.bullets.length > 0,
    "Timed out waiting for server-created bullets",
  );

  await playerTwo.wait(
    async () =>
      playerTwo.executeScript(
        "return window.__paintArenaDebug.getState().renderBullets.length > 0",
      ),
    10_000,
    "Timed out waiting for a rendered bullet",
  );
  const bulletFrameDistance = await playerTwo.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    requestAnimationFrame(() => {
      const first = window.__paintArenaDebug.getState().renderBullets[0];
      requestAnimationFrame(() => {
        const second = window.__paintArenaDebug.getState().renderBullets.find(
          (bullet) => bullet.id === first?.id,
        );
        done(first && second ? Math.hypot(second.x - first.x, second.y - first.y) : 0);
      });
    });
  `);

  if (bulletFrameDistance < 1) {
    throw new Error(
      `Rendered bullet did not move smoothly between frames: ${bulletFrameDistance}`,
    );
  }

  console.log(`Two-player Selenium e2e passed: ${inviteUrl}`);
} finally {
  await playerTwo?.quit();
  await playerOne?.quit();
  stopProcess(web);
  stopProcess(server);
  rmSync(tempDir, { recursive: true, force: true });
}

async function waitForDebugState(driver, predicate) {
  await driver.wait(async () => {
    const state = await driver.executeScript(
      "return window.__paintArenaDebug?.getState()",
    );
    return predicate(state);
  }, 10_000);
}

async function drawDesignerGesture(driver, points) {
  await driver.executeScript((gesturePoints) => {
    const canvas = document.querySelector("#map-canvas");
    const bounds = canvas.getBoundingClientRect();
    const dispatch = (type, point, buttons) => {
      canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        button: 0,
        buttons,
        pointerId: 17,
        clientX: bounds.left + bounds.width * point[0],
        clientY: bounds.top + bounds.height * point[1],
      }));
    };
    dispatch("pointerdown", gesturePoints[0], 1);
    for (const point of gesturePoints.slice(1)) {
      dispatch("pointermove", point, 1);
    }
    dispatch("pointerup", gesturePoints.at(-1), 0);
  }, points);
}

function findBrowserBinary(product, binaryName) {
  const productDir = resolve(webDir, ".browsers", product);
  const matches = findFiles(productDir, binaryName).sort().reverse();

  if (matches[0]) {
    return matches[0];
  }

  throw new Error(
    `No ${product} binary found in ${productDir}. Run: npx @puppeteer/browsers install ${product}@stable --path .browsers`,
  );
}

function findFiles(directory, fileName) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return findFiles(path, fileName);
    }

    return entry.name === fileName ? [path] : [];
  });
}

function assertExecutable(path, label) {
  const result = spawnSync(path, ["--version"], { encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(
      `${label} is present but cannot start. ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

function spawnManaged(command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) =>
    process.stdout.write(`[${command}] ${chunk}`),
  );
  child.stderr.on("data", (chunk) =>
    process.stderr.write(`[${command}] ${chunk}`),
  );

  return child;
}

async function createDriver(label) {
  const service = new chrome.ServiceBuilder(driverPath);
  const options = new chrome.Options()
    .setChromeBinaryPath(chromePath)
    .addArguments(
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--user-data-dir=${join(tempDir, label)}`,
    );

  return new Builder()
    .forBrowser("chrome")
    .setChromeOptions(options)
    .setChromeService(service)
    .build();
}

async function pressKey(driver, key) {
  await driver.actions().sendKeys(key).perform();
}

async function waitForElement(driver, selector) {
  await driver.wait(until.elementLocated(By.css(selector)), 10_000);
}

async function holdKey(driver, key, milliseconds) {
  await driver.actions().keyDown(key).pause(milliseconds).keyUp(key).perform();
}

async function waitForText(driver, selector, expectedText) {
  const expected = expectedText.toLowerCase();

  await driver.wait(
    async () => {
      try {
        const element = await driver.findElement(By.css(selector));
        const text = await element.getText();
        return text.toLowerCase().includes(expected);
      } catch {
        return false;
      }
    },
    10_000,
    `Timed out waiting for ${selector} to include ${expectedText}`,
  );
}

async function waitForRoom(
  driver,
  roomId,
  predicate,
  timeoutMessage = "Timed out waiting for room state",
) {
  let latestRoom = null;

  await driver.wait(
    async () => {
      latestRoom = await driver.executeScript(
        "return fetch(arguments[0]).then((response) => response.json())",
        `/api/rooms/${roomId}`,
      );

      return latestRoom !== null && predicate(latestRoom);
    },
    10_000,
    timeoutMessage,
  );

  return latestRoom;
}

function hasCoordinates(player) {
  return (
    player !== undefined &&
    Number.isFinite(player.x) &&
    Number.isFinite(player.y) &&
    Number.isFinite(player.heading)
  );
}

function distance(player, previousPlayer) {
  return Math.hypot(player.x - previousPlayer.x, player.y - previousPlayer.y);
}

async function waitForUrl(url) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function stopProcess(child) {
  if (child.pid && !child.killed) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}
