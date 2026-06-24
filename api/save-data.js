export const config = {
  api: { bodyParser: true },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    res.status(500).json({ error: "Missing KV env vars" });
    return;
  }

  try {
    const { finalMap, others } = req.body;
    const saves = [];

    // Upstash REST: POST /set/key with plain string body
    if (finalMap !== undefined) {
      saves.push(
        fetch(
          `${url}/set/sats_final_map/${encodeURIComponent(JSON.stringify(finalMap))}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
          },
        ),
      );
    }

    if (others !== undefined) {
      saves.push(
        fetch(
          `${url}/set/sats_others/${encodeURIComponent(JSON.stringify(others))}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
          },
        ),
      );
    }

    const results = await Promise.all(saves);
    const texts = await Promise.all(results.map((r) => r.text()));
    console.log("Upstash responses:", texts);

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("save-data error:", e);
    res.status(500).json({ error: e.message });
  }
}
