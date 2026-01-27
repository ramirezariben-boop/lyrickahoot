import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = 3000;

// ========================
// FIX CLAVE ❗
// ========================
app.use(express.json()); // ← SIN ESTO TODO FALLA

// ========================
// PATHS
// ========================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========================
// SERVIR ARCHIVOS
// ========================
app.use("/game", express.static(path.join(__dirname, "game")));
app.use("/data", express.static(path.join(__dirname, "data")));
app.use("/shared", express.static(path.join(__dirname, "shared")));

// ========================
// MXP PROXY (SIN TOCAR TRADING)
// ========================
app.post("/api/pay-mxp", async (req, res) => {
  try {
    console.log("📦 MXP BODY (raw):", req.body);

    const safeBody = {
      changes: (req.body.changes || []).map(c => ({
        id: typeof c.id === "string" && /^\d+$/.test(c.id)
          ? Number(c.id)   // 🔥 AQUÍ ESTÁ LA CLAVE
          : c.id,
        delta: Number(c.delta)
      }))
    };

    console.log("📤 MXP BODY (normalized):", safeBody);

    const response = await fetch(
      "https://classroom-trading.ariiben.com/api/update-multiple",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(safeBody)
      }
    );

    const text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    res.status(response.status).json(data);

  } catch (err) {
    console.error("❌ MXP proxy error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ========================
// FAVICON
// ========================
app.get("/favicon.ico", (req, res) => {
  res.sendFile(path.join(__dirname, "favicon.ico"));
});


// ========================
// ROOT
// ========================
app.get("/", (_, res) => {
  res.send("🟢 Lyrickahoot server running");
});

// ========================
// START
// ========================
app.listen(PORT, () => {
  console.log(`🟢 Server running on http://localhost:${PORT}`);
  console.log(`🎮 Game screen → http://localhost:${PORT}/game/game-screen.html`);
});
