import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 3000;

// roomCode -> { host: ws|null, players: Map(studentId, ws), sig: string|null }
const rooms = new Map();

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, { host: null, players: new Map(), sig: null });
  }
  return rooms.get(code);
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcastToPlayers(room, msg) {
  for (const ws of room.players.values()) safeSend(ws, msg);
}

const server = http.createServer(async (req, res) => {

if (req.method === "OPTIONS") {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "https://lyrickahoot.ariiben.com",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  return res.end();
}

if (req.method === "POST" && req.url === "/api/pay-mxp") {
  let body = "";
  req.on("data", chunk => (body += chunk));
  req.on("end", async () => {
    try {
      const parsed = JSON.parse(body);

      const response = await fetch(
        "https://classroom-trading.ariiben.com/api/update-multiple",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed)
        }
      );

      const data = await response.text();

      res.writeHead(response.status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "https://lyrickahoot.ariiben.com",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end(data);
    } catch (e) {
      res.writeHead(500, {
        "Access-Control-Allow-Origin": "https://lyrickahoot.ariiben.com",
      });
      res.end(JSON.stringify({ error: "MXP proxy failed" }));
    }
  });
  return;
}


  if (req.url === "/health") {
    res.writeHead(200);
    return res.end("ok");
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.meta = { role: null, roomCode: null, userId: null };

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Handshake mínimo
    if (msg.type === "HELLO") {
      const { role, roomCode, userId } = msg;
      if (!role || !roomCode) return;

      ws.meta.role = role;
      ws.meta.roomCode = roomCode;
      ws.meta.userId = userId || null;

      const room = getRoom(roomCode);

      if (role === "HOST") {
        // 1 host por sala (si llega otro, reemplaza)
        room.host = ws;
        safeSend(ws, { type: "HOST_OK" });
        // opcional: notificar a players
        broadcastToPlayers(room, { type: "HOST_ONLINE" });
        return;
      }

      if (role === "PLAYER") {
        if (!userId) return;
        room.players.set(userId, ws);
        safeSend(ws, { type: "PLAYER_OK" });
        // avisar host
        safeSend(room.host, { type: "PLAYER_JOIN", user: userId, nickname: msg.nickname, emoji: msg.emoji });
        return;
      }
    }

    // Verificación de sala (lo que hoy hacías con ROOM_CHECK/ROOM_OK)
    if (msg.type === "ROOM_CHECK") {
      const room = rooms.get(msg.roomCode);
      const ok = !!room?.host; // sala existe si el host ya está conectado
      safeSend(ws, { type: ok ? "ROOM_OK" : "ROOM_NO" });
      return;
    }

  // Respuestas directas del PLAYER hacia el HOST
if (msg.type === "ANSWER") {
  if (ws.meta.role !== "PLAYER") return;
  const room = rooms.get(ws.meta.roomCode);
  if (!room) return;
  safeSend(room.host, msg);
  return;
}

    // Enrutamiento de mensajes del HOST hacia PLAYERS
    if (msg.type === "HOST_BROADCAST") {
      const room = rooms.get(ws.meta.roomCode);
      if (!room || room.host !== ws) return;

      // guardamos una firma/sig por sala (similar a tu trustedSignature)
      if (msg.payload?.sig && !room.sig) room.sig = msg.payload.sig;

      broadcastToPlayers(room, msg.payload);
      return;
    }

    // Respuestas del PLAYER hacia el HOST
    if (msg.type === "PLAYER_TO_HOST") {
      const room = rooms.get(ws.meta.roomCode);
      if (!room) return;
      safeSend(room.host, msg.payload);
      return;
    }
  });

  ws.on("close", () => {
    const { role, roomCode, userId } = ws.meta || {};
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    if (role === "HOST" && room.host === ws) {
      room.host = null;
      broadcastToPlayers(room, { type: "GAME_RESET" }); // o HOST_OFFLINE
    }

    if (role === "PLAYER" && userId) {
      room.players.delete(userId);
      safeSend(room.host, { type: "PLAYER_LEAVE", user: userId });
    }

    // Limpieza: si no hay host y no hay players, borramos sala
    if (!room.host && room.players.size === 0) rooms.delete(roomCode);
  });
});

server.listen(PORT, () => {
  console.log("WS server on port", PORT);
});
