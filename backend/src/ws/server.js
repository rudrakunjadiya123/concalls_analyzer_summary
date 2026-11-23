import { WebSocket, WebSocketServer } from "ws";
import { eventsAfter, latestEventId } from "../routes/browse.js";

/** Broadcast only committed outbox events, including changes written by another local process. */
export function attachSummariesSocket(
  server,
  db,
  config,
  logger,
  { pollMs = 300, heartbeatMs = 30_000 } = {},
) {
  const hub = new WebSocketServer({
    noServer: true,
    maxPayload: 2048,
    perMessageDeflate: false,
  });
  const mode = config.DATA_MODE;
  const cursors = new Map();
  function send(socket, event) {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const payload = JSON.stringify(event);
    if (
      socket.bufferedAmount + Buffer.byteLength(payload) >
      config.WS_MAX_BUFFERED_BYTES
    ) {
      socket.terminate();
      return false;
    }
    socket.send(payload, (error) => {
      if (error) {
        logger?.warn("ws_send_failed", { stage: "http" });
        socket.terminate();
      }
    });
    return true;
  }
  function upgrade(req, socket, head) {
    // Use a single exact route; deny extra paths and connections over the configured limit.
    if (req.url !== "/ws/summaries")
      return socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    if (hub.clients.size >= config.WS_MAX_CLIENTS)
      return socket.end(
        "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n",
      );
    hub.handleUpgrade(req, socket, head, (ws) => hub.emit("connection", ws));
  }
  server.on("upgrade", upgrade);
  hub.on("connection", (socket) => {
    socket.on("error", () => socket.terminate());
    socket.on("close", () => cursors.delete(socket));
    // Inbound application messages are ignored. The transport enforces maxPayload.
    socket.on("message", () => {});
    let last;
    try {
      last = latestEventId(db, mode);
    } catch {
      logger?.warn("ws_handshake_failed", { stage: "http" });
      socket.close(1011, "Feed temporarily unavailable");
      return;
    }
    const state = { cursor: last, alive: true };
    cursors.set(socket, state);
    socket.on("pong", () => {
      state.alive = true;
    });
    send(socket, {
      schema_version: 1,
      type: "connected",
      data: { last_event_id: last, data_mode: mode },
    });
  });
  const poll = setInterval(() => {
    if (!cursors.size) return;
    try {
      let after = Number.MAX_SAFE_INTEGER;
      for (const state of cursors.values())
        after = Math.min(after, state.cursor);
      for (const event of eventsAfter(db, mode, after, 100)) {
        for (const [socket, state] of cursors) {
          if (event.event_id > state.cursor && send(socket, event))
            state.cursor = event.event_id;
        }
      }
    } catch {
      logger?.warn("ws_outbox_poll_failed", { stage: "http" });
    }
  }, pollMs).unref();
  const heartbeat = setInterval(() => {
    for (const [socket, state] of cursors) {
      if (!state.alive) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) {
        state.alive = false;
        socket.ping();
      }
    }
  }, heartbeatMs).unref();
  return {
    count: () => cursors.size,
    close() {
      clearInterval(poll);
      clearInterval(heartbeat);
      server.off("upgrade", upgrade);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          for (const socket of hub.clients) socket.terminate();
        }, 250);
        hub.close(() => {
          clearTimeout(timer);
          resolve();
        });
        for (const socket of hub.clients)
          socket.close(1001, "Server shutting down");
      });
    },
  };
}
