// shared map image endpoint for spot mapper
// the image travels as a data url split into chunks since kv values and function bodies have size limits
// GET  /api/map?profile=sats                       returns meta {name, parts, version, dims} or null
// GET  /api/map?profile=sats&v=123&part=0          returns one chunk {data}, cached immutably per version
// POST /api/map?profile=sats&v=123&part=0          stores one chunk, body {data}
// POST /api/map?profile=sats&v=123&finalize=1      stores meta and deletes the previous version's chunks

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
  var version = String(req.query.v || "").replace(/[^0-9]/g, "");
  var prefix = "spotmapper:map:" + profile;

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

  function parseBody() {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }

  try {
    if (req.method === "GET") {
      if (req.query.part !== undefined) {
        if (!version) {
          res.status(400).json({ error: "missing version" });
          return;
        }
        var part = parseInt(req.query.part, 10);
        var chunk = await redis(["GET", prefix + ":" + version + ":" + part]);
        if (!chunk.result) {
          res.status(404).json({ error: "chunk not found" });
          return;
        }
        // versioned urls never change content so browsers and the cdn can cache them forever
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.status(200).json({ data: chunk.result });
        return;
      }
      var meta = await redis(["GET", prefix + ":meta"]);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json(meta.result ? JSON.parse(meta.result) : null);
      return;
    }

    if (req.method === "POST") {
      if (req.query.finalize) {
        var body = parseBody();
        if (
          !body ||
          typeof body.name !== "string" ||
          !Number.isInteger(body.parts) ||
          body.parts < 1 ||
          body.parts > 40 ||
          body.version !== version
        ) {
          res.status(400).json({ error: "bad finalize payload" });
          return;
        }
        var oldMetaRaw = await redis(["GET", prefix + ":meta"]);
        await redis([
          "SET",
          prefix + ":meta",
          JSON.stringify({
            name: body.name,
            parts: body.parts,
            version: version,
            dims: body.dims || null,
            updatedAt: Date.now(),
          }),
        ]);
        // clean up the replaced version's chunks
        if (oldMetaRaw.result) {
          try {
            var old = JSON.parse(oldMetaRaw.result);
            if (old.version && old.version !== version) {
              for (var i = 0; i < (old.parts || 0); i++) {
                await redis(["DEL", prefix + ":" + old.version + ":" + i]);
              }
            }
          } catch (err) {}
        }
        res.status(200).json({ ok: true });
        return;
      }

      if (req.query.part !== undefined) {
        if (!version) {
          res.status(400).json({ error: "missing version" });
          return;
        }
        var partIdx = parseInt(req.query.part, 10);
        if (!Number.isInteger(partIdx) || partIdx < 0 || partIdx > 39) {
          res.status(400).json({ error: "bad part index" });
          return;
        }
        var chunkBody = parseBody();
        if (
          !chunkBody ||
          typeof chunkBody.data !== "string" ||
          chunkBody.data.length > 800000
        ) {
          res.status(400).json({ error: "bad chunk payload" });
          return;
        }
        await redis([
          "SET",
          prefix + ":" + version + ":" + partIdx,
          chunkBody.data,
        ]);
        res.status(200).json({ ok: true });
        return;
      }

      res.status(400).json({ error: "missing part or finalize" });
      return;
    }

    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    res.status(500).json({ error: "kv request failed" });
  }
};
