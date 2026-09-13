#!/usr/bin/env node
/**
 * Zero-install launcher for the Conditional Liquidity Marketplace demo.
 *
 *   node start.mjs
 *
 * Serves the pre-built frontend in `app/dist/` over HTTP and prints a URL. It imports nothing but
 * Node's own standard library, so there is no `npm install` step and no `node_modules` to ship -
 * which is the whole point: the archive this ships in is a few megabytes rather than a few hundred.
 *
 * The app talks to the LIVE Ethereum Sepolia deployment (see docs/sepolia-deployment.md), so it
 * needs an internet connection but no local blockchain, no Foundry, and no configuration.
 *
 * Port 5173 is not arbitrary: it is Vite's dev port, which is the origin the project's Privy
 * application already allows. Serving from a different port would load fine but break wallet
 * connection, so a busy 5173 is reported as an error rather than silently worked around.
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("./app/dist", import.meta.url)));
const PORT = Number(process.env.PORT ?? 5173);
const HOST = "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

if (!existsSync(join(ROOT, "index.html"))) {
  console.error(
    `\n  No built frontend found at ${ROOT}\n\n` +
      `  This archive should ship with it already built. To rebuild:\n` +
      `      cd app && npm install && npm run build\n`
  );
  process.exit(1);
}

const server = createServer((req, res) => {
  // Strip the query/hash and refuse anything that climbs out of the served directory.
  const requested = decodeURIComponent((req.url ?? "/").split("?")[0].split("#")[0]);
  const candidate = resolve(join(ROOT, normalize(requested)));
  const inRoot = candidate === ROOT || candidate.startsWith(ROOT + "/");

  // The app routes on the URL hash, so any path that is not a real file is the app itself.
  const file =
    inRoot && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(ROOT, "index.html");

  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    // Hashed asset filenames are immutable; index.html must never be cached or a rebuild is invisible.
    "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
  });
  createReadStream(file).pipe(res);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `\n  Port ${PORT} is already in use.\n\n` +
        `  Close whatever is using it and try again. Running on another port would work,\n` +
        `  but wallet connection would fail - the project's Privy app only allows ${PORT}.\n`
    );
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`
  Conditional Liquidity Marketplace

  Open  ->  http://${HOST}:${PORT}

  Live on Ethereum Sepolia (chain 11155111). Needs an internet connection;
  no local chain, no Foundry, no configuration.

  To trade you need a wallet on Sepolia holding DTB or DTA - see START-HERE.md.
  Everything else (liquidity, routes, strategy state) is readable without one.

  Ctrl+C to stop.
`);
});
