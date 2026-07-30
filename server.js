const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

// Load .env manually for local server
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf8");
    envContent.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const index = trimmed.indexOf("=");
      if (index === -1) return;
      const key = trimmed.slice(0, index).trim();
      const val = trimmed.slice(index + 1).trim();
      const parsedVal = val.replace(/^["']|["']$/g, "");
      if (!process.env[key]) {
        process.env[key] = parsedVal;
      }
    });
  }
} catch (e) {
  console.warn("Failed to load .env file:", e.message);
}

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const API_ROOT = path.join(ROOT, "api-handlers");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (requestUrl.pathname.startsWith("/api/")) {
      return await serveApiRoute(req, res, requestUrl);
    }

    if (req.method === "GET") {
      return serveStatic(requestUrl.pathname, res);
    }

    sendJson(res, 405, { message: "Method not allowed." });
  } catch (error) {
    sendJson(res, 500, { message: error.message || "Internal server error." });
  }
});

server.listen(PORT, () => {
  console.log(`Aurum Quant AI running at http://localhost:${PORT}`);
});

const CLOUDFLARE_BACKEND = process.env.CLOUDFLARE_WORKER_URL || "https://aurum-quant-edge.aurum-quant-ai.workers.dev";

async function serveApiRoute(nodeReq, nodeRes, requestUrl) {
  const relativeRoute = requestUrl.pathname.replace(/^\/api\//, "");
  const targetUrl = `${CLOUDFLARE_BACKEND}/${relativeRoute}${requestUrl.search}`;

  try {
    const headers = { ...nodeReq.headers };
    delete headers.host;

    const body = nodeReq.method !== "GET" && nodeReq.method !== "HEAD"
      ? await readRawBody(nodeReq)
      : undefined;

    const cfRes = await fetch(targetUrl, {
      method: nodeReq.method,
      headers,
      body,
    });

    nodeRes.statusCode = cfRes.status;
    cfRes.headers.forEach((val, key) => {
      if (key.toLowerCase() !== "transfer-encoding") {
        nodeRes.setHeader(key, val);
      }
    });

    const buffer = Buffer.from(await cfRes.arrayBuffer());
    nodeRes.end(buffer);
  } catch (cfErr) {
    // If Cloudflare Worker proxy fails, fall back to local handler if present
    const filePath = path.join(API_ROOT, `${relativeRoute}.js`);
    const normalizedPath = path.normalize(filePath);

    if (!normalizedPath.startsWith(API_ROOT) || !fs.existsSync(normalizedPath)) {
      return sendJson(nodeRes, 502, { message: `Cloudflare Worker unreachable: ${cfErr.message}` });
    }

    delete require.cache[require.resolve(normalizedPath)];
    const handler = require(normalizedPath);

    if (typeof handler !== "function") {
      return sendJson(nodeRes, 500, { message: "Invalid API handler export." });
    }

    nodeReq.query = Object.fromEntries(requestUrl.searchParams.entries());
    nodeReq.body = await readJsonBody(nodeReq);

    const responseAdapter = createResponseAdapter(nodeRes);
    await handler(nodeReq, responseAdapter);

    if (!responseAdapter.finished) {
      responseAdapter.end();
    }
  }
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function createResponseAdapter(nodeRes) {
  let statusCode = 200;
  let finished = false;

  return {
    get finished() {
      return finished;
    },
    status(code) {
      statusCode = Number(code) || 200;
      return this;
    },
    setHeader(name, value) {
      nodeRes.setHeader(name, value);
      return this;
    },
    json(payload) {
      if (finished) return this;
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
      }
      nodeRes.end(JSON.stringify(payload));
      finished = true;
      return this;
    },
    send(payload) {
      if (finished) return this;
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(statusCode);
      }
      nodeRes.end(payload);
      finished = true;
      return this;
    },
    end(payload = "") {
      if (finished) return this;
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(statusCode);
      }
      nodeRes.end(payload);
      finished = true;
      return this;
    },
  };
}

function serveStatic(requestPath, res) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.join(ROOT, safePath);
  const normalizedPath = path.normalize(filePath);

  if (!normalizedPath.startsWith(ROOT)) {
    return sendJson(res, 403, { message: "Forbidden path." });
  }

  if (!fs.existsSync(normalizedPath) || fs.statSync(normalizedPath).isDirectory()) {
    return sendJson(res, 404, { message: "File not found." });
  }

  const extension = path.extname(normalizedPath).toLowerCase();
  const contentType = MIME_TYPES[extension] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(normalizedPath).pipe(res);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  if (req.method === "GET" || req.method === "HEAD") {
    return {};
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}
