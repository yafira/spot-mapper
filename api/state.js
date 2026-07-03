// shared state endpoint for spot mapper
// GET    /api/state?profile=sats   returns saved state or null
// POST   /api/state?profile=sats   saves the posted json
// DELETE /api/state?profile=sats   wipes the saved state for that profile
// needs upstash kv env vars set in vercel

module.exports = async function handler(req, res) {
  var base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  var token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!base || !token) {
    res.status(500).json({ error: "kv is not configured" });
    return;
  }

  var profile = String(req.query.profile || "generic").replace(
    /[^a-zA-Z0-9_-]/g,
    "",
  );
  var key = "spotmapper:" + profile;

  function redis(command) {
    return fetch(base, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    }).then(function (r) {
      return r.json();
    });
  }

  try {
    if (req.method === "GET") {
      var result = await redis(["GET", key]);
      res.status(200).json(result.result ? JSON.parse(result.result) : null);
      return;
    }

    if (req.method === "POST") {
      var body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      if (!body || typeof body !== "object") {
        res.status(400).json({ error: "expected a json body" });
        return;
      }
      // keep huge payloads out of kv, the map image itself never gets stored
      var value = JSON.stringify({
        image: typeof body.image === "string" ? body.image : null,
        dimensions: body.dimensions || null,
        locations: Array.isArray(body.locations) ? body.locations : [],
        spots: Array.isArray(body.spots) ? body.spots : [],
        updatedAt: Date.now(),
      });
      if (value.length > 900000) {
        res.status(413).json({ error: "state too large" });
        return;
      }
      await redis(["SET", key, value]);
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === "DELETE") {
      await redis(["DEL", key]);
      res.status(200).json({ ok: true });
      return;
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    res.status(500).json({ error: "kv request failed" });
  }
};
