// Local memory-manager server: JSON API + static SPA. Binds loopback only; no auth by design.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { bad, HttpError, Router } from "./http";
import { registerObservationRoutes } from "./routes/observations";
import { registerOtherRoutes } from "./routes/other";

const STATIC_DIR = join(import.meta.dir, "static");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

function staticFile(rel: string): Response {
  if (rel.split(/[\\/]/).includes("..")) return new Response("not found", { status: 404 });
  const full = normalize(join(STATIC_DIR, rel));
  if (!full.startsWith(STATIC_DIR + sep) || !existsSync(full)) return new Response("not found", { status: 404 });
  const ext = rel.slice(rel.lastIndexOf("."));
  return new Response(Bun.file(full), { headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-cache" } });
}

export function buildRouter(): Router {
  const r = new Router();
  r.get("/", () => staticFile("index.html"));
  r.get("/static/:path", ({ params }) => staticFile(params.path));
  r.get("/static/:dir/:path", ({ params }) => staticFile(join(params.dir, params.path)));
  registerObservationRoutes(r);
  registerOtherRoutes(r);
  return r;
}

export function startUi(db: Database, port: number): { port: number; stop: () => void } {
  const router = buildRouter();
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      try {
        return await router.handle(db, req);
      } catch (e) {
        if (e instanceof HttpError) return bad(e.message, e.status);
        return bad((e as Error).message, 500);
      }
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}
