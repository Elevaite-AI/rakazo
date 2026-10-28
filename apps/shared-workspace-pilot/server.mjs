import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createAccess, Denied, Invalid } from "./access.mjs";

export function createPilotServer({ access, sessions, streamMs = 500 }) {
  const timers = new Set();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      const host = req.headers.host;
      if (!/^127\.0\.0\.1:\d+$/.test(host || "")) throw new Denied();
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new Denied();
      const url = new URL(req.url, `http://${host}`);
      if (req.method === "GET" && ["/", "/ui.mjs"].includes(url.pathname)) {
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        );
        res.setHeader("Content-Type", url.pathname === "/" ? "text/html" : "text/javascript");
        res.end(
          await readFile(new URL(url.pathname === "/" ? "index.html" : "ui.mjs", import.meta.url)),
        );
        return;
      }
      const session = sessions[req.headers.authorization?.replace(/^Bearer /, "")];
      if (!session || session.expiresAt < Date.now()) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Sign in required" }));
        return;
      }
      const user = session.id;
      const json = (value) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(value));
      };
      if (req.method === "GET" && url.pathname === "/api/spaces") {
        json({ user, spaces: await access.spaces(user) });
        return;
      }
      const match = url.pathname.match(
        /^\/api\/spaces\/([^/]+)\/(snapshot|thread|memory|jobs|run|members|stream)(?:\/([^/]+))?$/,
      );
      if (!match) throw new Denied();
      const [, space, action, target] = match;
      if (req.method === "GET") {
        if (action === "snapshot") {
          json(await access.snapshot(user, space));
          return;
        }
        if (action === "thread") {
          json(await access.thread(user, space, target));
          return;
        }
        if (action === "memory") {
          json(await access.memory(user, space, target));
          return;
        }
        if (action === "members") {
          json(await access.members(user, space));
          return;
        }
        if (action === "stream") {
          await access.snapshot(user, space);
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write("event: ready\ndata: {}\n\n");
          let busy = false;
          const timer = setInterval(async () => {
            if (busy) return;
            busy = true;
            try {
              if (session.expiresAt < Date.now()) throw new Denied();
              await access.snapshot(user, space);
              res.write("event: tick\ndata: {}\n\n");
            } catch {
              res.write("event: revoked\ndata: {}\n\n");
              res.end();
              clearInterval(timer);
              timers.delete(timer);
            } finally {
              busy = false;
            }
          }, streamMs);
          timers.add(timer);
          res.on("close", () => {
            clearInterval(timer);
            timers.delete(timer);
          });
          return;
        }
      }
      if (req.method === "DELETE" && action === "members") {
        json(await access.revoke(user, space, target));
        return;
      }
      if (req.method === "POST") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 8192) throw new Invalid("Request too large");
        }
        let body;
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          throw new Invalid("Invalid JSON");
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Invalid("Object required");
        if (action === "jobs") {
          json(await access.enqueue(user, space, target, body));
          return;
        }
        if (action === "run") {
          json(await access.run(user, space, target));
          return;
        }
      }
      throw new Denied();
    } catch (e) {
      res.statusCode = e.status || 500;
      res.end(JSON.stringify({ error: e.status ? e.message : "Service unavailable" }));
    }
  });
  return {
    server,
    async close() {
      for (const t of timers) clearInterval(t);
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const access = createAccess();
  const sessions = JSON.parse(
    await readFile(new URL(".local/sessions.json", import.meta.url), "utf8"),
  );
  const pilot = createPilotServer({ access, sessions });
  pilot.server.listen(15440, "127.0.0.1", () =>
    console.log("Isolated pilot listening on loopback port 15440"),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await pilot.close();
      await access.close();
      process.exit(0);
    });
}
