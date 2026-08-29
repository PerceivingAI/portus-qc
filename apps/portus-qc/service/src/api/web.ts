import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

interface WebAsset {
  path: URL;
  contentType: string;
  csp?: boolean;
}

const assets = new Map<string, WebAsset>([
  ["/", { path: new URL("../../../web/index.html", import.meta.url), contentType: "text/html; charset=utf-8", csp: true }],
  ["/assets/app.css", { path: new URL("../../../web/app.css", import.meta.url), contentType: "text/css; charset=utf-8" }],
  ["/assets/api.js", { path: new URL("../../../web/api.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/assets/camera-discovery.js", { path: new URL("../../../web/camera-discovery.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/assets/icons.js", { path: new URL("../../../web/icons.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/assets/lifecycle.js", { path: new URL("../../../web/lifecycle.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/assets/schedules.js", { path: new URL("../../../web/schedules.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/assets/settings.js", { path: new URL("../../../web/settings.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/assets/ui.js", { path: new URL("../../../web/ui.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/assets/video.js", { path: new URL("../../../web/video.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/assets/viewer.js", { path: new URL("../../../web/viewer.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/assets/app.js", { path: new URL("../../../web/app.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }]
]);

const cache = new Map<string, Promise<Buffer>>();

function assetBytes(asset: WebAsset): Promise<Buffer> {
  const key = asset.path.href;
  let value = cache.get(key);
  if (!value) {
    value = readFile(asset.path);
    cache.set(key, value);
  }
  return value;
}

export async function routeWeb(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  const asset = assets.get(pathname);
  if (!asset) return false;
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    const payload = JSON.stringify({ error: { code: "method_not_allowed", message: "Allowed methods: GET, HEAD." } });
    response.writeHead(405, { "cache-control": "no-store", "content-length": Buffer.byteLength(payload), "content-type": "application/json; charset=utf-8" });
    response.end(method === "HEAD" ? undefined : payload);
    return true;
  }

  const bytes = await assetBytes(asset);
  const headers: Record<string, string | number> = {
    "cache-control": "no-store",
    "content-length": bytes.byteLength,
    "content-type": asset.contentType,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  };
  if (asset.csp) {
    headers["content-security-policy"] = "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  }
  response.writeHead(200, headers);
  response.end(method === "HEAD" ? undefined : bytes);
  return true;
}
