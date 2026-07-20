import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Builder, By, Key, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

const webDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rootDir = resolve(webDir, "..");
const serverPort = process.env.E2E_SERVER_PORT ?? "18081";
const webPort = process.env.E2E_WEB_PORT ?? "15174";
const baseUrl = `http://127.0.0.1:${webPort}`;
const tempDir = resolve(webDir, ".tmp", "selenium-fluidity");
const sampleDurationMs = 1600;

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
  { SERVER_HOST: "127.0.0.1", SERVER_PORT: serverPort },
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

  playerOne = await createDriver("fluidity-player-one");
  playerTwo = await createDriver("fluidity-player-two");

  const roomId = await createTwoPlayerRoom(playerOne, playerTwo);
  await waitForDebugState(playerOne, (state) => state.mode === "playing");
  await waitForDebugState(playerTwo, (state) => state.mode === "playing");

  const monitorBefore = await getMonitor(playerOne);
  await playerOne.executeScript("window.__paintArenaDebug.resetFrameSamples()");
  await holdKey(playerOne, Key.ARROW_UP, sampleDurationMs);
  const monitorAfter = await getMonitor(playerOne);
  const playerOneState = await getDebugState(playerOne);
  const playerTwoState = await getDebugState(playerTwo);
  const report = buildFluidityReport(playerOneState.frameSamples);
  const monitorDelta = {
    roomGets: monitorAfter.roomGets - monitorBefore.roomGets,
    inputPosts: monitorAfter.inputPosts - monitorBefore.inputPosts,
    ticks: monitorAfter.ticks - monitorBefore.ticks,
  };

  assertFluidity(report);
  assertEfficiency(monitorAfter, monitorDelta);

  const remotePlayer = playerTwoState.renderPlayers.find(
    (player) => player.slot === 1,
  );

  if (!remotePlayer || remotePlayer.speed <= 0) {
    throw new Error("Remote client did not receive Player 1 movement state");
  }

  console.log(
    [
      `Fluidity Selenium e2e passed: ${baseUrl}/game/${roomId}`,
      `frames=${report.frames}`,
      `avg_delta_ms=${report.averageDeltaMs.toFixed(2)}`,
      `p95_delta_ms=${report.p95DeltaMs.toFixed(2)}`,
      `max_delta_ms=${report.maxDeltaMs.toFixed(2)}`,
      `movement_samples=${report.movingSamples}`,
      `distance=${report.distance.toFixed(2)}`,
      `room_gets_delta=${monitorDelta.roomGets}`,
      `input_posts_delta=${monitorDelta.inputPosts}`,
      `ticks_delta=${monitorDelta.ticks}`,
      `last_tick_ms=${monitorAfter.lastTickMs.toFixed(3)}`,
      `max_tick_ms=${monitorAfter.maxTickMs.toFixed(3)}`,
    ].join("\n"),
  );
} finally {
  await playerTwo?.quit();
  await playerOne?.quit();
  stopProcess(web);
  stopProcess(server);
  rmSync(tempDir, { recursive: true, force: true });
}

async function createTwoPlayerRoom(playerOne, playerTwo) {
  await playerOne.get(baseUrl);
  await waitForElement(playerOne, "#map-canvas");
  await pressKey(playerOne, Key.ENTER);
  await playerOne.wait(until.urlMatches(/\/game\/[A-Z0-9]+$/), 10_000);
  const inviteUrl = await playerOne.getCurrentUrl();
  const roomId = inviteUrl.match(/\/game\/([A-Z0-9]+)$/)?.[1];

  if (!roomId) {
    throw new Error(`Could not parse room id from ${inviteUrl}`);
  }

  await playerTwo.get(inviteUrl);
  await waitForText(playerTwo, "#mode-line", "Match live");
  await waitForText(playerOne, "#player-list", "Player2");

  return roomId;
}

function buildFluidityReport(samples) {
  const usableSamples = samples.filter(
    (sample) => sample.deltaMs > 0 && sample.deltaMs < 1000,
  );
  const deltas = usableSamples
    .map((sample) => sample.deltaMs)
    .sort((a, b) => a - b);
  const first = usableSamples[0];
  const last = usableSamples.at(-1);
  const distance =
    first && last ? Math.hypot(last.x - first.x, last.y - first.y) : 0;
  const movingSamples = usableSamples.filter(
    (sample) => sample.speed > 1,
  ).length;

  return {
    frames: usableSamples.length,
    averageDeltaMs: average(deltas),
    p95DeltaMs: percentile(deltas, 0.95),
    maxDeltaMs: deltas.at(-1) ?? 0,
    movingSamples,
    distance,
  };
}

function assertFluidity(report) {
  if (report.frames < 45) {
    throw new Error(`Too few rendered frames during sample: ${report.frames}`);
  }

  if (report.averageDeltaMs > 28) {
    throw new Error(
      `Average frame delta too high: ${report.averageDeltaMs.toFixed(2)}ms`,
    );
  }

  if (report.p95DeltaMs > 45) {
    throw new Error(
      `p95 frame delta too high: ${report.p95DeltaMs.toFixed(2)}ms`,
    );
  }

  if (report.maxDeltaMs > 90) {
    throw new Error(
      `Max frame delta too high: ${report.maxDeltaMs.toFixed(2)}ms`,
    );
  }

  if (report.movingSamples < 20 || report.distance < 12) {
    throw new Error(
      `Movement did not look continuous enough: moving=${report.movingSamples} distance=${report.distance.toFixed(2)}`,
    );
  }
}

function assertEfficiency(monitor, delta) {
  if (monitor.lastTickMs > 5 || monitor.maxTickMs > 20) {
    throw new Error(
      `Server tick too slow: last=${monitor.lastTickMs.toFixed(3)} max=${monitor.maxTickMs.toFixed(3)}`,
    );
  }

  if (delta.inputPosts < 8 || delta.inputPosts > 60) {
    throw new Error(
      `Unexpected input post count during sample: ${delta.inputPosts}`,
    );
  }

  if (delta.roomGets > 60) {
    throw new Error(
      `Too many room snapshot GETs during sample: ${delta.roomGets}`,
    );
  }

  if (delta.ticks < 35) {
    throw new Error(`Server tick loop did not advance enough: ${delta.ticks}`);
  }
}

function average(values) {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return 0;
  }

  return values[
    Math.min(values.length - 1, Math.floor(values.length * percentileValue))
  ];
}

async function getMonitor(driver) {
  return driver.executeScript(
    "return fetch('/api/monitor').then((response) => response.json())",
  );
}

async function getDebugState(driver) {
  return driver.executeScript("return window.__paintArenaDebug.getState()");
}

async function waitForDebugState(driver, predicate) {
  await driver.wait(async () => predicate(await getDebugState(driver)), 10_000);
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
        const text = await driver.executeScript(
          "return document.querySelector(arguments[0])?.textContent ?? ''",
          selector,
        );
        return text.toLowerCase().includes(expected);
      } catch {
        return false;
      }
    },
    10_000,
    `Timed out waiting for ${selector} to include ${expectedText}`,
  );
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
