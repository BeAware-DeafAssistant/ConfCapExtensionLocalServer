# ConfCapExtensionLocalServer

A zero-dependency local relay for ConferenceCaptioning's Chrome extension. Lets you display live captions/translations on a screen or OBS browser source over your local network, without going through the remote `api.deafassistant.com` backend for that path.

## Run

```
node server.js [port]
```

Default port is `8787`. No `npm install` needed — uses only Node's built-in `http`/`os` modules.

On startup it prints the LAN URL(s) to use, e.g.:

```
http://192.168.1.42:8787/
```

## Wire up the extension

In the extension's Dashboard (options page), under "Local Network Display," enable it and enter this server's LAN URL (e.g. `http://192.168.1.42:8787`). The extension sends each transcript update here in addition to (not instead of) the existing remote backend.

## Use it as a browser source

Open `http://<server-ip>:<port>/view?room=<your-room-name>` in OBS's Browser Source (or any browser on the LAN) — captions and translations update live via Server-Sent Events. `http://<server-ip>:<port>/` lists all rooms that have sent captions since the server started.

## Notes

- In-memory only — restarting the server clears all room state. Nothing is persisted to disk.
- No authentication. Anything on your LAN that knows (or guesses) a room name can post fake captions to it or view it. Fine for a private event network; don't expose this port to the internet.
- Each room keeps only its most recent payload; there's no history/transcript log kept server-side.
