#!/usr/bin/env node
// Zero-dependency local caption/translation relay for ConferenceCaptioning.
//
// The Chrome extension POSTs each transcript update here (alongside its
// existing remote api.deafassistant.com send — this is a second, optional
// destination, not a replacement). Anything on the same LAN can then load
// this server's viewer page as a browser source (OBS, a smart TV, another
// laptop) and see captions update live over Server-Sent Events, with no
// internet round-trip involved for that path.
//
// Run: node server.js [port]   (default 8787)

const http = require("http");
const os = require("os");

const PORT = Number(process.argv[2]) || 8787;

// roomName -> { payload, clients: Set<ServerResponse> }
const rooms = new Map();

// "Any active room" stream, for viewers that don't know the exact room name
// ahead of time (e.g. a URL bookmarked before you know what the stream name
// will be for a given event). Mirrors whatever room most recently posted.
let lastActiveRoomName = null;
const anyRoomClients = new Set();

function getRoom(roomName) {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, { payload: null, clients: new Set() });
  }
  return rooms.get(roomName);
}

function sendCors(res) {
  // The extension's origin is chrome-extension://<id>, which varies per
  // install; captions aren't sensitive enough to warrant pinning this down,
  // so this stays permissive rather than trying to enumerate origins.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Body too large"));
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

function broadcast(roomName) {
  const room = getRoom(roomName);
  const data = `data: ${JSON.stringify(room.payload)}\n\n`;
  for (const client of room.clients) {
    client.write(data);
  }
  for (const client of anyRoomClients) {
    client.write(data);
  }
}

// Each /update payload carries the *entire* running transcript (not just the
// newest line), so "show the last two lines, auto-scrolling" is done with a
// fixed-height overflow:hidden window that snaps its scroll position to the
// bottom on every update — the tail of the wrapped text is always what's
// visible, which is exactly the last ~N lines regardless of how long the
// full transcript has grown. `LINES_VISIBLE` controls the window height.
function viewerHtml(roomName) {
  const isSpecificRoom = roomName != null;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ConferenceCaptioning${isSpecificRoom ? " — " + roomName : ""}</title>
<style>
  :root {
    --lines-visible: 2;
    --line-height: 1.35;
    --font-size: 2.4vw;
  }
  html, body {
    margin: 0;
    height: 100%;
    background: transparent;
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  #captionBox {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 20px 32px;
    box-sizing: border-box;
    background: rgba(0, 0, 0, 0.82);
  }
  #transcriptWindow {
    height: calc(var(--font-size) * var(--line-height) * var(--lines-visible));
    overflow: hidden;
    scroll-behavior: smooth;
  }
  #transcript {
    color: #fff;
    font-size: var(--font-size);
    font-weight: 700;
    line-height: var(--line-height);
    text-shadow: 0 2px 6px rgba(0,0,0,0.9);
  }
  #translation {
    margin-top: 0.35em;
    font-size: calc(var(--font-size) * 0.7);
    font-weight: 600;
    color: #ffd76a;
    text-shadow: 0 2px 6px rgba(0,0,0,0.9);
  }
  #status {
    position: fixed;
    top: 8px;
    left: 8px;
    font-size: 12px;
    color: #888;
    font-family: monospace;
    background: rgba(0,0,0,0.5);
    padding: 2px 6px;
    border-radius: 4px;
  }
</style>
</head>
<body>
  <div id="status">connecting…</div>
  <div id="captionBox">
    <div id="transcriptWindow"><div id="transcript"></div></div>
    <div id="translation"></div>
  </div>
  <script>
    const room = ${JSON.stringify(roomName)}; // null => follow whichever room is currently active
    const statusEl = document.getElementById("status");
    const windowEl = document.getElementById("transcriptWindow");
    const transcriptEl = document.getElementById("transcript");
    const translationEl = document.getElementById("translation");

    function scrollToLatest() {
      // rAF so layout has settled before measuring scrollHeight
      requestAnimationFrame(() => { windowEl.scrollTop = windowEl.scrollHeight; });
    }

    function connect() {
      const qs = room ? ("?room=" + encodeURIComponent(room)) : "";
      const es = new EventSource("/events" + qs);
      es.onopen = () => { statusEl.textContent = room ? ("connected: " + room) : "connected (following active room)"; };
      es.onerror = () => {
        statusEl.textContent = "disconnected, retrying…";
        es.close();
        setTimeout(connect, 2000);
      };
      es.onmessage = (event) => {
        const data = JSON.parse(event.data);
        transcriptEl.textContent = data.transcript || "";
        translationEl.textContent = data.translation && data.translation !== "None" ? data.translation : "";
        scrollToLatest();
      };
    }
    connect();
  </script>
</body>
</html>`;
}

function indexHtml() {
  const roomNames = [...rooms.keys()];
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>ConferenceCaptioning — Local Server</title></head>
<body style="font-family: sans-serif; padding: 2rem;">
  <h1>ConferenceCaptioning local server</h1>
  <p>Listening on port ${PORT}. Point the extension's "Local Network Display" setting at this server's URL, then open a viewer URL below as a browser source.</p>
  <p><a href="/view">/view</a> — follows whichever room most recently sent captions (no need to know the exact stream name ahead of time).</p>
  <h2>Active rooms</h2>
  ${roomNames.length
      ? "<ul>" + roomNames.map((r) => `<li><a href="/view?room=${encodeURIComponent(r)}">/view?room=${r}</a></li>`).join("") + "</ul>"
      : "<p>No rooms have sent captions yet.</p>"
    }
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    sendCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/update") {
    sendCors(res);
    try {
      const payload = await readJsonBody(req);
      const roomName = (payload.roomName || "default").toLowerCase();
      const room = getRoom(roomName);
      room.payload = payload;
      lastActiveRoomName = roomName;
      broadcast(roomName);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, room: roomName, viewers: room.clients.size }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    sendCors(res);
    const roomParam = url.searchParams.get("room");
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write("\n");

    if (roomParam) {
      const room = getRoom(roomParam.toLowerCase());
      room.clients.add(res);
      if (room.payload) res.write(`data: ${JSON.stringify(room.payload)}\n\n`);
      req.on("close", () => room.clients.delete(res));
    } else {
      // No room specified: follow whichever room most recently posted.
      anyRoomClients.add(res);
      if (lastActiveRoomName) {
        const room = getRoom(lastActiveRoomName);
        if (room.payload) res.write(`data: ${JSON.stringify(room.payload)}\n\n`);
      }
      req.on("close", () => anyRoomClients.delete(res));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/view") {
    const roomParam = url.searchParams.get("room");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(viewerHtml(roomParam ? roomParam.toLowerCase() : null));
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(indexHtml());
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

function lanAddresses() {
  const results = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (addr.family === "IPv4" && !addr.internal) results.push(addr.address);
    }
  }
  return results;
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ConferenceCaptioning local server listening on port ${PORT}`);
  console.log("Reachable at:");
  console.log(`  http://localhost:${PORT}/  (this machine)`);
  for (const addr of lanAddresses()) {
    console.log(`  http://${addr}:${PORT}/  (LAN)`);
  }
  console.log("\nPoint the extension's 'Local Network Display' setting at one of the LAN URLs above.");
});
