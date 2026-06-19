import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3000);
const CLI_HOME = process.env.CLI_HOME || "/opt/cli-tools";
const API_KEY = process.env.CLI_RUNNER_API_KEY || "";
const GO_VERSION = process.env.GO_VERSION || "1.25.0";

const REGISTRY_PATH = path.join(CLI_HOME, "registry.json");
const NPM_PREFIX = path.join(CLI_HOME, "npm-global");

function envForTools() {
  return {
    ...process.env,
    CLI_HOME,
    NPM_CONFIG_PREFIX: NPM_PREFIX,
    npm_config_prefix: NPM_PREFIX,
    PATH: [
      path.join(CLI_HOME, "go", "bin"),
      path.join(CLI_HOME, "bin"),
      path.join(CLI_HOME, ".local", "bin"),
      path.join(CLI_HOME, "npm-global", "bin"),
      process.env.PATH || "",
    ].join(":"),
  };
}

function ensureDirs() {
  fs.mkdirSync(path.join(CLI_HOME, "bin"), { recursive: true });
  fs.mkdirSync(path.join(CLI_HOME, ".local", "bin"), { recursive: true });
  fs.mkdirSync(path.join(CLI_HOME, "npm-global", "bin"), { recursive: true });
  fs.mkdirSync(path.join(CLI_HOME, "npm-global", "lib", "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(CLI_HOME, "npm-global", "share"), { recursive: true });
}

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeRegistry(data) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2));
}

function toolToBinary(tool) {
  return `${tool}-pp-cli`;
}

function json(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function isAuthorized(req) {
  if (!API_KEY) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${API_KEY}`;
}

async function ensureGoInstalled() {
  ensureDirs();
  const goBinary = path.join(CLI_HOME, "go", "bin", "go");
  if (fs.existsSync(goBinary)) return;

  const archMap = { x64: "amd64", arm64: "arm64" };
  const goArch = archMap[process.arch];
  if (!goArch) throw new Error(`Unsupported architecture: ${process.arch}`);

  const url = `https://go.dev/dl/go${GO_VERSION}.linux-${goArch}.tar.gz`;
  const tarPath = "/tmp/go.tar.gz";

  await execFileAsync("curl", ["-fsSL", url, "-o", tarPath], {
    env: envForTools(),
    timeout: 120000,
    maxBuffer: 20 * 1024 * 1024,
  });

  fs.rmSync(path.join(CLI_HOME, "go"), { recursive: true, force: true });

  await execFileAsync("tar", ["-C", CLI_HOME, "-xzf", tarPath], {
    env: envForTools(),
    timeout: 120000,
    maxBuffer: 20 * 1024 * 1024,
  });

  fs.rmSync(tarPath, { force: true });
}

async function installTool(tool) {
  await ensureGoInstalled();

  const env = envForTools();
  const { stdout, stderr } = await execFileAsync(
    "npx",
    ["-y", "@mvanhorn/printing-press-library", "install", tool, "--cli-only"],
    {
      env,
      timeout: 15 * 60 * 1000,
      maxBuffer: 50 * 1024 * 1024,
    },
  );

  const registry = readRegistry();
  registry[tool] = {
    binary: toolToBinary(tool),
    installed_at: new Date().toISOString(),
  };
  writeRegistry(registry);

  return { stdout, stderr, registry: registry[tool] };
}

async function runTool(tool, args) {
  const registry = readRegistry();
  const entry = registry[tool];
  if (!entry) {
    throw new Error(`Tool not installed: ${tool}`);
  }

  if (!Array.isArray(args)) {
    throw new Error("args must be an array of strings");
  }

  for (const a of args) {
    if (typeof a !== "string") {
      throw new Error("All args must be strings");
    }
  }

  const env = envForTools();
  return await execFileAsync(entry.binary, args, {
    env,
    timeout: 5 * 60 * 1000,
    maxBuffer: 50 * 1024 * 1024,
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, {
        ok: true,
        service: "cli-runner",
        has_api_key: Boolean(API_KEY),
        tools: readRegistry(),
        path: process.env.PATH,
      });
    }

    if (!isAuthorized(req)) {
      return json(res, 401, { ok: false, error: "Unauthorized" });
    }

    if (req.method === "POST" && req.url === "/install") {
      const body = await readBody(req);
      const tool = body?.tool;
      if (!tool || typeof tool !== "string") {
        return json(res, 400, { ok: false, error: "tool is required" });
      }

      const result = await installTool(tool);
      return json(res, 200, {
        ok: true,
        tool,
        ...result,
      });
    }

    if (req.method === "POST" && req.url === "/run") {
      const body = await readBody(req);
      const tool = body?.tool;
      const args = body?.args ?? [];
      if (!tool || typeof tool !== "string") {
        return json(res, 400, { ok: false, error: "tool is required" });
      }

      const result = await runTool(tool, args);
      return json(res, 200, {
        ok: true,
        tool,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }

    return json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      error: error?.message || "Unknown error",
      stdout: error?.stdout,
      stderr: error?.stderr,
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`CLI runner listening on :${PORT}`);
});
