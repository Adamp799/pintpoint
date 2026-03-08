# PintPoint

A map of Cambridge pubs with the cost of the cheapest pint at each, plus a sidebar to search and find the cheapest pint in town.

## Features

- **Map** – Leaflet map of Cambridge with a marker for each pub
- **Pub info** – Click a marker to see the pub name, address, description, and cheapest pint price
- **Sidebar** – List of all pubs; sort by cheapest first, most expensive first, or name A–Z
- **Search** – Filter pubs by name, address, or description
- **Cheapest callout** – Highlights the single cheapest pint in Cambridge at the top of the sidebar

## Run locally

The app loads `data/pubs.json` via `fetch`, so it must be served over HTTP (not opened as `file://`).

From the project root:

```bash
# Option 1: Node (npx)
npx serve .

# Option 2: Python 3
python3 -m http.server 3000
```

Then open [http://localhost:3000](http://localhost:3000) (or the port shown by `serve`).

## Data

- **`data/pubs.json`** – List of Cambridge pubs with `name`, `address`, `description`, `cheapestPint` (£), and `lat`/`lng`. Edit this file to add or update pubs and prices.

## Deploy (GitHub Action)

When the Vercel Git integration is blocked (e.g. "no git user associated with the commit"), use a Deploy Hook instead of the CLI:

1. **Create a Deploy Hook** (as the project owner): Vercel Dashboard → Project → Settings → Git → Deploy Hooks. Name it (e.g. "GitHub Actions"), select branch `main`, create, and copy the URL.

2. **Add GitHub secret**: Repo → Settings → Secrets and variables → Actions → New repository secret. Add:
   - `VERCEL_DEPLOY_HOOK_URL` (the URL from step 1)

3. **Push to `main`** – the workflow triggers the hook; Vercel pulls from Git and deploys. Works for any collaborator.

## Tech

- Vanilla HTML, CSS, and JavaScript
- [Leaflet](https://leafletjs.com/) for the map
- CARTO dark basemap (no API key required)
