# spot mapper ✦

A map-based spot assignment tool for exhibitions, showcases, and events. Upload any floor plan image, drop pins for exhibitors and named locations, import rosters from spreadsheets, and share the live layout with everyone through a link.

Built by [Yafira Martinez](https://yafira.xyz) for the **Show All Things Show**, the end-of-camp showcase at [ITP Camp](https://itp.nyu.edu/camp/) 2026.

## What it does

- **Any map**: drop in any floor plan image (jpg, png). Pins are placed in the image's own coordinate space, so it works for any venue at any scale.
- **Spots and locations**: pins come in two flavors. Camper spots hold a person, project, spot number, and notes. Named locations (⚑) are landmarks like "Amphitheater" that spots can be assigned to.
- **Spreadsheet import**: bring in a roster from `.csv`, `.xlsx`, or `.xls`. Header names are matched loosely (name/camper/who, spot/space/#, project/title, notes/description, and so on). Rows without a name are skipped, so banner rows and duplicate headers in real-world exports don't become phantom entries. Imported people queue up and you click the map to place each one.
- **Shared state**: placements and the map image live in a shared database, so anyone with the link sees the current layout. No accounts, no local-only data.
- **Search**: find anyone by name, spot, project, location, or notes. Matches light up on the map.
- **Swap mode**: click any two people to trade their spots and positions.
- **Print list**: a clean printable roster grouped by location, sorted by spot number.
- **Profiles**: the app ships with a Generic profile (blank engine) and a Show All Things Show profile (camp theme). Each profile keeps its own map and placements.

## Stack

Static frontend (vanilla JS + [Leaflet](https://leafletjs.com/) with `CRS.Simple` for image maps, [SheetJS](https://sheetjs.com/) for Excel parsing), two Vercel serverless functions (`api/state.js`, `api/map.js`), and Upstash Redis for storage. No build step.

## Deploy your own

1. Fork or clone this repo.
2. Import it into [Vercel](https://vercel.com) (free Hobby tier is plenty).
3. In the Vercel project, open **Storage** and add an **Upstash Redis** database. This creates the `KV_REST_API_URL` and `KV_REST_API_TOKEN` env vars automatically.
4. Redeploy so the env vars take effect.
5. Open the site, upload a map, and start placing.

Sanity check: `https://your-app.vercel.app/api/state?profile=sats` should return `null` on a fresh deploy. A 404 means the `api/` folder didn't deploy; `{"error":"kv is not configured"}` means storage isn't connected or you haven't redeployed since connecting it.

To change the default profile for a deployment, edit `DEFAULT_PROFILE` in `app.js`.

## A note on access

The app has two faces:

- **Viewer (default)**: everyone with the link gets a read-only view — the map, search, the placements list, and the print list. No edit mode, no imports, no resets, no swap.
- **Admin**: unlocks the full toolkit (edit mode, data import/export, swap, resets, profile switching). Visit `https://your-app.vercel.app/?admin=YOURTOKEN` once — the key is stored in the browser and scrubbed from the address bar. Use the ⚿ admin badge's **exit** button (or `/?admin=off`) to drop back to viewer mode.

To enforce this on the backend, set an `ADMIN_TOKEN` environment variable in your Vercel project (any long random string) and redeploy. Once set, POST/DELETE requests to `/api/state` and `/api/map` require a matching `x-admin-token` header — hiding the buttons alone isn't security, this is what actually locks it down.

If `ADMIN_TOKEN` is **not** set, the backend stays open like before, but the UI still defaults to viewer mode, so any token passed via `?admin=` unlocks the admin toolbar. Fine for a trusted, short-lived event; set the env var if you want it real.

On mobile, the same split applies. Small screens lead with search and the placements list, and the **⌖ map / ☰ list** button flips between the list and a full-screen map. Tapping a camper in the list jumps straight to their pin on the map.

## License

MIT. See [LICENSE](LICENSE).
