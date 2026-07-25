#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, normalize, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./lib/cli.mjs";

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".glb", "model/gltf-binary"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".webp", "image/webp"],
]);

export function createViewerServer(rootDirectory) {
  const root = resolve(rootDirectory);
  return createServer(async (request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method || "GET")) {
        response.writeHead(405, {
          Allow: "GET, HEAD",
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("Method not allowed");
        return;
      }
      if ((request.url || "").length > 2048) {
        response.writeHead(414, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("URI too long");
        return;
      }
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const decodedPath = decodeURIComponent(url.pathname);
      const requestPath =
        decodedPath === "/"
          ? "index.html"
          : decodedPath.replace(/^\/+/, "");
      if (requestPath.split("/").some((segment) => segment.startsWith("."))) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const target = resolve(root, normalize(requestPath));
      const relativePath = relative(root, target);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const [realRoot, realTarget] = await Promise.all([
        realpath(root),
        realpath(target),
      ]);
      const actualRelative = relative(realRoot, realTarget);
      if (actualRelative.startsWith("..") || isAbsolute(actualRelative)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      if (
        actualRelative.split(/[\\/]/u).some((segment) => segment.startsWith("."))
        || resolve(realRoot, relativePath) !== realTarget
      ) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const fileStat = await stat(realTarget);
      if (!fileStat.isFile()) throw new Error("Not a file");
      response.writeHead(200, {
        "Content-Type": MIME_TYPES.get(extname(target).toLowerCase()) ||
          "application/octet-stream",
        "Cache-Control": "no-cache",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'sha256-dYVe1nKHqze8AgOhimSbxHqEp7ZLX7PeZ1W2tTkN//k='; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), xr-spatial-tracking=(self)",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      });
      if (request.method === "HEAD") {
        response.end();
      } else {
        const stream = createReadStream(realTarget);
        stream.on("error", () => response.destroy());
        stream.pipe(response);
      }
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    directory: { type: "string", required: true },
    port: { type: "string", default: "4173" },
    help: { type: "boolean" },
  });
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/serve-viewer.mjs --directory runs/project-001 [--port 4173]\n",
    );
    return;
  }
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535.");
  }
  const server = createViewerServer(options.directory);
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`Viewer: http://127.0.0.1:${port}\n`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
