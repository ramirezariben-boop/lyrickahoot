import crypto from "crypto";

const ADMIN_ID = Number(process.env.ADMIN_ID || 64);
const ADMIN_PIN = process.env.ADMIN_PIN || "";
const SESSION_SECRET = process.env.INTERNAL_API_SECRET || "dev-secret";

function normalizeLoginInput(req) {
  const raw = req.body;
  let id = null, secret = null, pin = null, role = null;
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
  const response = await fetch("https://classroom-trading.ariiben.com/api/auth/validate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.INTERNAL_API_SECRET}`,
    },
    body: JSON.stringify({ id: normalizedId, nip: secret }),
  });
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

function createToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

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

    const authToken = createToken({ ...userPayload, isAdmin, createdAt: Date.now() });

    res.json({ ok: true, authToken, isAdmin, canHost: isAdmin, user: userPayload });
  } catch (error) {
    console.error("Error en /api/login:", error);
    res.status(error.status || 500).json({
      error: error.status === 403 ? "Forbidden" : "Error interno",
    });
  }
}
