export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const r = await fetch(
      "https://classroom-trading.ariiben.com/api/update-multiple",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      }
    );

    const data = await r.json();
    return res.status(200).json(data);
  } catch (e) {
    console.error("PAY MXP ERROR:", e);
    return res.status(500).json({ error: "MXP payment failed" });
  }
}
