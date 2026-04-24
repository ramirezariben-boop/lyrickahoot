import crypto from "crypto";
import express from "express";
import path from "path";
import http from "http";
import { promises as fs } from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { WebSocketServer, WebSocket } from "ws";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const PORT = Number(process.env.PORT || 3000);
const ADMIN_ID = Number(process.env.ADMIN_ID || 64);
const ADMIN_PIN = process.env.ADMIN_PIN || "";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PUBLIC_DATA_TYPES = new Set(["lyrics-base", "exercise"]);
const PUBLIC_DATA_FILES = new Set(["rules.json"]);
const PLAYER_TO_HOST_TYPES = new Set(["PLAYER_JOIN", "PLAYER_REJOIN", "PLAYER_ALIVE"]);
const HOST_BROADCAST_TYPES = new Set(["OPEN", "CLOSE", "QUESTION_RESULT", "GAME_RESET"]);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const sessions = new Map();
const rooms = new Map();

app.use(express.json({ limit: "1mb" }));

function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function now() {
  return Date.now();
}

function pruneExpiredSessions() {
  const cutoff = now() - SESSION_TTL_MS;
  for (const [token, session] of sessions) {
    if (session.createdAt < cutoff) {
      sessions.delete(token);
    }
  }
}

function createSession(user, extra = {}) {
  pruneExpiredSessions();
  const token = randomToken();
  sessions.set(token, {
    token,
    createdAt: now(),
    user,
    ...extra,
  });
  return token;
}

function getSession(token) {
  if (!token) return null;
  pruneExpiredSessions();
  return sessions.get(token) || null;
}

function getRequestToken(req) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }

  const headerToken = req.headers["x-auth-token"];
  if (typeof headerToken === "string" && headerToken.trim()) {
    return headerToken.trim();
  }

  const bodyToken = req.body?.authToken;
  if (typeof bodyToken === "string" && bodyToken.trim()) {
    return bodyToken.trim();
  }

  return null;
}

function requireSession(req, res, next) {
  const session = getSession(getRequestToken(req));
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  const session = getSession(getRequestToken(req));
  if (!session?.isAdmin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  req.session = session;
  next();
}

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      host: null,
      hostSessionToken: null,
      hostUserId: null,
      players: new Map(),
      currentQuestion: null,
      activeExercise: null,
    });
  }
  return rooms.get(code);
}

function cleanupRoomIfEmpty(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (!room.host && room.players.size === 0) {
    rooms.delete(roomCode);
  }
}

function broadcastToPlayers(room, payload) {
  for (const player of room.players.values()) {
    safeSend(player.ws, payload);
  }
}

async function loadJsonFile(filename) {
  const text = await fs.readFile(path.join(DATA_DIR, filename), "utf8");
  return JSON.parse(text);
}

async function listDataFiles() {
  return fs.readdir(DATA_DIR);
}

async function listExercisesWithSongs() {
  const files = await listDataFiles();
  const songs = new Map();
  const exercises = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const json = await loadJsonFile(file);
      if (json?.type === "lyrics-base" && json.song?.id) {
        songs.set(json.song.id, {
          title: json.song.title,
          artist: json.song.artist,
          youtubeId: json.song.youtubeId,
          file,
        });
      }

      if (json?.type === "exercise" && json.exercise?.songId) {
        exercises.push({
          file,
          id: json.exercise.id,
          songId: json.exercise.songId,
          name: json.exercise.name,
          description: json.exercise.description ?? "",
          questionWordIds: json.exercise.questionWordIds ?? [],
        });
      }
    } catch (error) {
      console.warn("Skipping invalid data file:", file, error);
    }
  }

  return exercises.map((item) => ({
    ...item,
    song: songs.get(item.songId) ?? null,
  }));
}

async function findSongById(songId) {
  const files = await listDataFiles();
  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const json = await loadJsonFile(file);
      if (json?.type === "lyrics-base" && json.song?.id === songId) {
        return json;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function isPublicDataFile(filename) {
  if (!filename || filename.includes("/") || filename.includes("\\") || !filename.endsWith(".json")) {
    return false;
  }

  if (PUBLIC_DATA_FILES.has(filename)) {
    return true;
  }

  try {
    const json = await loadJsonFile(filename);
    return PUBLIC_DATA_TYPES.has(json?.type);
  } catch {
    return false;
  }
}

function normalizeLoginInput(req) {
  const raw = req.body;
  let id = null;
  let secret = null;
  let pin = null;
  let role = null;

  if (typeof raw === "object" && raw) {
    id = raw.id ?? null;
    secret = raw.password ?? raw.nip ?? null;
    pin = raw.pin ?? null;
    role = raw.role ?? null;
  } else if (typeof raw === "string") {
    const params = new URLSearchParams(raw);
    id = params.get("id");
    secret = params.get("password") ?? params.get("nip");
    pin = params.get("pin");
    role = params.get("role");
  }

  return { id, secret, pin, role };
}

async function validateAgainstCt(id, secret) {
  const normalizedId = /^\d+$/.test(String(id)) ? Number(id) : id;
  const payload = { id: normalizedId, nip: secret };

  const response = await fetch(
    "https://classroom-trading.ariiben.com/api/auth/validate",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.INTERNAL_API_SECRET}`,
      },
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(text || "Unauthorized");
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function buildUserPayload(user) {
  return {
    id: user.id,
    name: user.name,
    nivelActual: user.nivelActual,
    resolvedCourseId: user.resolvedCourseId ?? null,
    isCurrent: user.isCurrent ?? false,
    day: user.day ?? null,
    privCode: user.privCode ?? null,
    listNumber: user.listNumber ?? null,
    points: user.points ?? null,
    level: user.level ?? 0,
    levelUpdatedAt: user.levelUpdatedAt ?? null,
    levelMeta: user.levelMeta ?? null,
  };
}

function sanitizeNickname(nickname, fallback) {
  const value = String(nickname || "").trim().slice(0, 24);
  if (!value) return fallback;
  return value.replace(/[<>]/g, "");
}

function sanitizeEmoji(emoji) {
  const value = String(emoji || "").trim();
  return value || "🙂";
}

async function writeJsonFile(filename, payload) {
  await fs.writeFile(path.join(DATA_DIR, filename), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

app.post("/api/login", async (req, res) => {
  try {
    const { id, secret, pin, role } = normalizeLoginInput(req);

    if (!id || !secret) {
      return res.status(400).json({ error: "Datos inválidos" });
    }

    const user = await validateAgainstCt(id, secret);
    const userPayload = buildUserPayload(user);
    const isAdmin = Number(user.id) === ADMIN_ID || (!!ADMIN_PIN && pin === ADMIN_PIN);
    const wantsHost = role === "host";

    if (wantsHost && !isAdmin) {
      return res.status(403).json({ error: "Solo admin puede entrar como host" });
    }

    const authToken = createSession(userPayload, { isAdmin });

    res.json({
      ok: true,
      authToken,
      isAdmin,
      canHost: isAdmin,
      user: userPayload,
    });
  } catch (error) {
    console.error("Error en /api/login:", error);
    res.status(error.status || 500).json({
      error: error.status === 403 ? "Forbidden" : "Error interno",
    });
  }
});

app.get("/api/exercises", async (_req, res) => {
  try {
    res.json(await listExercisesWithSongs());
  } catch (error) {
    console.error("Error listing exercises:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/song/:songId", async (req, res) => {
  try {
    const song = await findSongById(req.params.songId);
    if (!song) {
      return res.status(404).json({ error: "Song not found" });
    }
    res.json(song);
  } catch (error) {
    console.error("Error fetching song:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/rules", async (_req, res) => {
  try {
    res.json(await loadJsonFile("rules.json"));
  } catch (error) {
    console.error("Error fetching rules:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/admin/songs", requireAdmin, async (req, res) => {
  try {
    const { song, words, lines } = req.body || {};

    if (!song?.title || !song?.artist || !song?.youtubeId) {
      return res.status(400).json({ error: "Song metadata incompleta" });
    }

    if (!Array.isArray(words) || words.length === 0 || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: "Letra inválida" });
    }

    const songId = slugify(song.id || `${song.artist}-${song.title}`);

    const normalizedSong = {
      version: "1.1",
      type: "lyrics-base",
      song: {
        id: songId,
        title: String(song.title).trim(),
        artist: String(song.artist).trim(),
        youtubeId: String(song.youtubeId).trim(),
      },
      words: words.map((word, index) => ({
        id: Number(word.id ?? index + 1),
        text: String(word.text ?? "").trim(),
        time: Number(word.time),
      })),
      lines: lines.map((line, index) => ({
        id: Number(line.id ?? index + 1),
        wordIds: Array.isArray(line.wordIds) ? line.wordIds.map(Number) : [],
      })),
    };

    const lyricsFilename = `lyrics-${songId}.json`;

    await writeJsonFile(lyricsFilename, normalizedSong);

    res.json({
      ok: true,
      songId,
      files: {
        lyrics: lyricsFilename,
      },
    });
  } catch (error) {
    console.error("Error saving song payload:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/admin/exercises", requireAdmin, async (req, res) => {
  try {
    const { song, words, lines, exercise } = req.body || {};

    if (!song?.title || !song?.artist || !song?.youtubeId) {
      return res.status(400).json({ error: "Song metadata incompleta" });
    }

    if (!Array.isArray(words) || words.length === 0 || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: "Letra inválida" });
    }

    if (!exercise?.name || !Array.isArray(exercise.questionWordIds) || exercise.questionWordIds.length === 0) {
      return res.status(400).json({ error: "Ejercicio inválido" });
    }

    const songId = slugify(song.id || `${song.artist}-${song.title}`);
    const exerciseId = slugify(exercise.id || `${songId}-${exercise.name}`);

    const normalizedSong = {
      version: "1.1",
      type: "lyrics-base",
      song: {
        id: songId,
        title: String(song.title).trim(),
        artist: String(song.artist).trim(),
        youtubeId: String(song.youtubeId).trim(),
      },
      words: words.map((word, index) => ({
        id: Number(word.id ?? index + 1),
        text: String(word.text ?? "").trim(),
        time: Number(word.time),
      })),
      lines: lines.map((line, index) => ({
        id: Number(line.id ?? index + 1),
        wordIds: Array.isArray(line.wordIds) ? line.wordIds.map(Number) : [],
      })),
    };

    const normalizedExercise = {
      version: "1.0",
      type: "exercise",
      exercise: {
        id: exerciseId,
        songId,
        name: String(exercise.name).trim(),
        description: String(exercise.description || "").trim(),
        questionWordIds: exercise.questionWordIds.map(Number),
      },
    };

    const lyricsFilename = `lyrics-${songId}.json`;
    const exerciseFilename = `exercise-${exerciseId}.json`;

    await writeJsonFile(lyricsFilename, normalizedSong);
    await writeJsonFile(exerciseFilename, normalizedExercise);

    res.json({
      ok: true,
      songId,
      exerciseId,
      files: {
        lyrics: lyricsFilename,
        exercise: exerciseFilename,
      },
    });
  } catch (error) {
    console.error("Error saving editor payload:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/pay-mxp", requireAdmin, async (req, res) => {
  try {
    if (!req.body || !Array.isArray(req.body.changes)) {
      return res.status(400).json({ error: "Invalid request body" });
    }

    if (req.body.changes.length > 100) {
      return res.status(400).json({ error: "Too many changes" });
    }

    const safeBody = {
      changes: req.body.changes.map((change) => {
        if (typeof change.id !== "string" || !/^\d+$/.test(change.id)) {
          throw new Error("Invalid id");
        }

        const delta = Number(change.delta);
        if (Number.isNaN(delta) || delta < -1000 || delta > 1000) {
          throw new Error("Invalid delta");
        }

        return { id: Number(change.id), delta };
      }),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(
      "https://classroom-trading.ariiben.com/api/update-multiple",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(safeBody),
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    res.status(response.status).json(data);
  } catch (error) {
    if (error.name === "AbortError") {
      return res.status(504).json({ error: "Request timeout" });
    }
    console.error("MXP proxy error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.use("/game", express.static(path.join(__dirname, "game")));
app.use("/editor", express.static(path.join(__dirname, "editor")));
app.use("/shared", express.static(path.join(__dirname, "shared")));

app.get("/editor.html", (_req, res) => {
  res.redirect("/editor/editor.html");
});

app.get("/data/:filename", async (req, res) => {
  try {
    const filename = req.params.filename;
    if (!(await isPublicDataFile(filename))) {
      return res.status(404).json({ error: "Not found" });
    }
    res.sendFile(path.join(DATA_DIR, filename));
  } catch (error) {
    console.error("Error serving public data file:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/favicon.ico", (_req, res) => {
  res.sendFile(path.join(__dirname, "favicon.ico"));
});

app.get("/", (_req, res) => {
  res.send("Lyrickahoot server running");
});

wss.on("connection", (ws) => {
  ws.meta = { role: null, roomCode: null, userId: null, authToken: null };

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "ROOM_CHECK") {
      const room = rooms.get(msg.roomCode);
      safeSend(ws, { type: room?.host ? "ROOM_OK" : "ROOM_NO" });
      return;
    }

    if (msg.type === "HELLO") {
      const session = getSession(msg.authToken);
      const roomCode = String(msg.roomCode || "").trim().toUpperCase();
      const role = msg.role;

      if (!session || !roomCode || !role) {
        safeSend(ws, { type: "AUTH_ERROR" });
        return;
      }

      const room = getRoom(roomCode);
      ws.meta = {
        role,
        roomCode,
        userId: String(session.user.id),
        authToken: session.token,
      };

      if (role === "HOST") {
        if (!session.isAdmin) {
          safeSend(ws, { type: "AUTH_ERROR" });
          return;
        }

        if (room.host && room.host !== ws) {
          safeSend(room.host, { type: "GAME_RESET" });
          try {
            room.host.close();
          } catch {
            // noop
          }
        }

        room.host = ws;
        room.hostSessionToken = session.token;
        room.hostUserId = String(session.user.id);

        safeSend(ws, {
          type: "HOST_OK",
          roomCode,
          currentQuestion: room.currentQuestion,
        });

        broadcastToPlayers(room, { type: "HOST_ONLINE" });
        return;
      }

      if (role === "PLAYER") {
        const userId = String(session.user.id);
        const nickname = sanitizeNickname(msg.nickname, session.user.name || `Jugador ${userId}`);
        const emoji = sanitizeEmoji(msg.emoji);

        room.players.set(userId, {
          ws,
          authToken: session.token,
          userId,
          nickname,
          emoji,
        });

        safeSend(ws, {
          type: "PLAYER_OK",
          roomCode,
          userId,
          currentQuestion: room.currentQuestion,
        });

        safeSend(room.host, {
          type: "PLAYER_JOIN",
          user: userId,
          nickname,
          emoji,
        });

        if (room.currentQuestion) {
          safeSend(ws, room.currentQuestion);
        }

        return;
      }

      safeSend(ws, { type: "AUTH_ERROR" });
      return;
    }

    if (msg.type === "ANSWER") {
      if (ws.meta.role !== "PLAYER") return;

      const room = rooms.get(ws.meta.roomCode);
      const player = room?.players.get(ws.meta.userId);
      if (!room || !player || player.ws !== ws || !room.currentQuestion) return;

      safeSend(room.host, {
        type: "ANSWER",
        user: ws.meta.userId,
        wordId: Number(msg.wordId),
        answer: String(msg.answer || ""),
        timestamp: Number(msg.timestamp) || now(),
      });
      return;
    }

    if (msg.type === "HOST_BROADCAST") {
      const room = rooms.get(ws.meta.roomCode);
      if (!room || room.host !== ws) return;

      const payload = msg.payload || {};
      if (!HOST_BROADCAST_TYPES.has(payload.type)) return;

      if (payload.type === "OPEN") {
        room.currentQuestion = {
          type: "OPEN",
          wordId: Number(payload.wordId),
          openedAt: Number(payload.openedAt),
          options: Array.isArray(payload.options) ? payload.options.map(String) : [],
        };
      }

      if (payload.type === "CLOSE" || payload.type === "GAME_RESET") {
        room.currentQuestion = null;
      }

      broadcastToPlayers(room, payload);
      return;
    }

    if (msg.type === "PLAYER_TO_HOST") {
      if (ws.meta.role !== "PLAYER") return;

      const room = rooms.get(ws.meta.roomCode);
      const player = room?.players.get(ws.meta.userId);
      const payload = msg.payload || {};

      if (!room || !player || player.ws !== ws || !PLAYER_TO_HOST_TYPES.has(payload.type)) return;

      safeSend(room.host, {
        type: payload.type,
        user: ws.meta.userId,
        nickname: player.nickname,
        emoji: player.emoji,
      });
    }
  });

  ws.on("close", () => {
    const { role, roomCode, userId } = ws.meta || {};
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    if (role === "HOST" && room.host === ws) {
      room.host = null;
      room.hostSessionToken = null;
      room.hostUserId = null;
      room.currentQuestion = null;
      broadcastToPlayers(room, { type: "GAME_RESET" });
    }

    if (role === "PLAYER" && userId) {
      const player = room.players.get(userId);
      if (player?.ws === ws) {
        room.players.delete(userId);
        safeSend(room.host, { type: "PLAYER_LEAVE", user: userId });
      }
    }

    cleanupRoomIfEmpty(roomCode);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
