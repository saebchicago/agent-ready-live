import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { GameStateStore } from "./state.js";

const DEFAULT_PORT = 3000;
const LOOPBACK_HOST = "127.0.0.1";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface OverlayServerOptions {
  store: GameStateStore;
  assetRoot: string;
  port?: number;
}

export function expectedOrigin(port: number): string {
  return `http://${LOOPBACK_HOST}:${port}`;
}

export function originAllowed(origin: string | undefined, port: number, required: boolean): boolean {
  if (origin === undefined) return true;
  return origin === expectedOrigin(port);
}

function contentSecurityPolicy(port: number): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' ws://${LOOPBACK_HOST}:${port}`,
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function safeAssetPath(assetRoot: string, requestPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath.split("?", 1)[0] ?? "/");
  } catch {
    return undefined;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const root = resolve(assetRoot);
  const path = resolve(root, relative);
  return path === root || path.startsWith(`${root}${sep}`) ? path : undefined;
}

export class OverlayServer {
  private readonly port: number;
  private readonly websocket = new WebSocketServer({ noServer: true });
  private readonly server;
  private unsubscribe: (() => void) | undefined;
  private pruneTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: OverlayServerOptions) {
    this.port = options.port ?? DEFAULT_PORT;
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    this.server.on("upgrade", (request, socket, head) => {
      if (
        request.url !== "/ws" ||
        !originAllowed(request.headers.origin, this.port, true)
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.websocket.handleUpgrade(request, socket, head, (client) => {
        this.websocket.emit("connection", client, request);
      });
    });
    this.websocket.on("connection", (client) => {
      client.send(JSON.stringify({ type: "snapshot", state: this.options.store.getState() }));
    });
  }

  async start(): Promise<string> {
    if (this.unsubscribe !== undefined) throw new Error("Overlay server is already running");
    this.unsubscribe = this.options.store.subscribe((state) => {
      const payload = JSON.stringify({ type: "snapshot", state });
      for (const client of this.websocket.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      }
    });
    this.pruneTimer = setInterval(() => {
      this.options.store.dispatch({ type: "PRUNE", now: Date.now() });
    }, 60_000);
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => rejectListen(error);
      this.server.once("error", onError);
      this.server.listen(this.port, LOOPBACK_HOST, () => {
        this.server.off("error", onError);
        resolveListen();
      });
    });
    return expectedOrigin(this.port);
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.pruneTimer !== undefined) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
    for (const client of this.websocket.clients) client.close();
    await new Promise<void>((resolveClose) => {
      this.server.close(() => resolveClose());
    });
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const finish = (status: number, body: string): void => {
      response.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "content-security-policy": contentSecurityPolicy(this.port),
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      response.end(body);
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      finish(405, "Method not allowed");
      return;
    }
    if (!originAllowed(request.headers.origin, this.port, false)) {
      finish(403, "Origin not allowed");
      return;
    }
    if (request.headers.origin === undefined) {
      const host = request.headers.host;
      if (host !== `127.0.0.1:${this.port}`) {
        finish(403, "Host not allowed");
        return;
      }
    }
    const path = safeAssetPath(this.options.assetRoot, request.url ?? "/");
    if (path === undefined) {
      finish(400, "Invalid path");
      return;
    }
    try {
      const body = await readFile(path);
      response.writeHead(200, {
        "content-type": MIME_TYPES[extname(path)] ?? "application/octet-stream",
        "content-security-policy": contentSecurityPolicy(this.port),
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      finish(404, "Not found");
    }
  }
}
