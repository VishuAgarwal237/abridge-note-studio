// Bun dev server: serves the React app and proxies /api -> FastAPI backend.
const PORT = Number(process.env.PORT ?? 5173);
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Proxy API calls to the Python backend.
    if (url.pathname.startsWith("/api")) {
      const target = BACKEND + url.pathname + url.search;
      const resp = await fetch(target, {
        method: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
      });
      return new Response(resp.body, { status: resp.status, headers: resp.headers });
    }

    // Bundle the React entrypoint on the fly.
    if (url.pathname === "/index.tsx") {
      const built = await Bun.build({ entrypoints: ["./index.tsx"], target: "browser" });
      const out = await built.outputs[0].text();
      return new Response(out, { headers: { "content-type": "application/javascript" } });
    }

    // Everything else -> index.html (single page app).
    return new Response(await Bun.file("./index.html").bytes(), {
      headers: { "content-type": "text/html" },
    });
  },
});

console.log(`\n  Abridge UI  ->  http://localhost:${PORT}\n  (proxying /api -> ${BACKEND})\n`);
