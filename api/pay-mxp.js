export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const raw = req.body; // ✅ YA PARSEADO

    const safeBody = {
      changes: (raw.changes || []).map(c => ({
        id: typeof c.id === "string" && /^\d+$/.test(c.id)
          ? Number(c.id)
          : c.id,
        delta: Number(c.delta),
      })),
    };

    console.log("📤 MXP PAYLOAD →", JSON.stringify(safeBody, null, 2));

    const response = await fetch(
      "https://classroom-trading.ariiben.com/api/update-multiple",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(safeBody),
      }
    );

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    return res.status(response.status).json(data);

  } catch (e) {
    console.error("PAY MXP ERROR:", e);
    return res.status(500).json({ error: "MXP payment failed" });
  }
}
