import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.resolve(
  process.env.SITES_RUNTIME_ROOT || path.join(projectRoot, ".sites-runtime"),
);

function parseDuration(value, name) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);
  if (!match) {
    throw new Error(`${name} must be a duration such as 500ms, 10s, or 3m.`);
  }

  const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return Number(match[1]) * multipliers[match[2]];
}

async function requirePath(target, description, mode = constants.F_OK) {
  try {
    await access(target, mode);
  } catch {
    throw new Error(`${description} is unavailable at ${target}.`);
  }
}

const runtimeDirectories = {
  home: path.join(runtimeRoot, "home"),
  npmCache: path.join(runtimeRoot, "npm-cache"),
  xdgConfig: path.join(runtimeRoot, "xdg-config"),
  temp: path.join(runtimeRoot, "tmp"),
  wranglerLogs: path.join(runtimeRoot, "wrangler", "logs"),
};

await Promise.all(
  Object.values(runtimeDirectories).map((directory) =>
    mkdir(directory, { recursive: true }),
  ),
);

const env = {
  ...process.env,
  SITES_ENV_READY: "1",
  SITES_PROJECT_ROOT: projectRoot,
  HOME: runtimeDirectories.home,
  XDG_CONFIG_HOME: runtimeDirectories.xdgConfig,
  TMPDIR: runtimeDirectories.temp,
  WRANGLER_WRITE_LOGS: "false",
  WRANGLER_LOG_PATH: path.join(runtimeDirectories.wranglerLogs, "wrangler.log"),
  MINIFLARE_REGISTRY_PATH: path.join(runtimeRoot, "wrangler", "registry"),
  npm_config_cache: runtimeDirectories.npmCache,
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
};

for (const key of [
  "NPM_CONFIG_CACHE",
  "npm_config_proxy",
  "npm_config_http_proxy",
  "npm_config_https_proxy",
  "NPM_CONFIG_PROXY",
  "NPM_CONFIG_HTTP_PROXY",
  "NPM_CONFIG_HTTPS_PROXY",
]) {
  delete env[key];
}

const vinextCli = path.join(projectRoot, "node_modules", "vinext", "dist", "cli.js");
await requirePath(
  vinextCli,
  "Vinext CLI; run npm run install:ci and wait for it to finish before building",
  constants.R_OK,
);

const buildTimeout = parseDuration(
  process.env.SITES_BUILD_TIMEOUT || "3m",
  "SITES_BUILD_TIMEOUT",
);
const killAfter = parseDuration(
  process.env.SITES_BUILD_KILL_AFTER || "10s",
  "SITES_BUILD_KILL_AFTER",
);

console.log("Running bounded vinext build...");

const child = spawn(process.execPath, [vinextCli, "build"], {
  cwd: projectRoot,
  detached: process.platform !== "win32",
  env,
  stdio: "inherit",
});

function signalPosixProcessGroup(signal) {
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function killWindowsProcessTree() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (taskkillFailed) => {
      if (settled) return;
      settled = true;
      if (taskkillFailed) child.kill("SIGKILL");
      resolve();
    };
    const taskkill = spawn(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    taskkill.once("error", () => finish(true));
    taskkill.once("exit", (code) => finish(code !== 0));
  });
}

let timedOut = false;
let forceKillTimer;
let resolveTimeoutCleanup;
let timeoutCleanup = Promise.resolve();
const timeoutTimer = setTimeout(() => {
  timedOut = true;
  console.error(`Vinext build exceeded ${process.env.SITES_BUILD_TIMEOUT || "3m"}; terminating.`);

  if (process.platform === "win32") {
    // Windows has no POSIX process-group signals. taskkill /T /F is required
    // to prevent compiler or worker descendants from surviving the CLI.
    timeoutCleanup = killWindowsProcessTree();
  } else {
    signalPosixProcessGroup("SIGTERM");
    timeoutCleanup = new Promise((resolve) => {
      resolveTimeoutCleanup = resolve;
      forceKillTimer = setTimeout(() => {
        signalPosixProcessGroup("SIGKILL");
        resolve();
      }, killAfter);
    });
  }
}, buildTimeout);
timeoutTimer.unref();

const result = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

clearTimeout(timeoutTimer);

if (timedOut) {
  if (process.platform !== "win32" && !signalPosixProcessGroup(0)) {
    clearTimeout(forceKillTimer);
    resolveTimeoutCleanup();
  }
  await timeoutCleanup;
  process.exitCode = 124;
} else if (result.code !== 0) {
  throw new Error(
    `Vinext build failed${result.signal ? ` with signal ${result.signal}` : ` with exit code ${result.code}`}.`,
  );
} else {
  const expectedOutputs = [
    [path.join(projectRoot, "dist", "server", "index.js"), "Vinext server output"],
    [path.join(projectRoot, "dist", ".openai", "hosting.json"), "Sites hosting metadata"],
  ];

  for (const [output, description] of expectedOutputs) {
    await requirePath(output, description, constants.R_OK);
  }

  console.log("Vinext build passed and deployable output was verified.");
}
