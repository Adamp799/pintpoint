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

When the Vercel Git integration is blocked, deploy via GitHub Actions using the owner's token:

1. **Get your Vercel credentials** (as the project owner):
   - **VERCEL_TOKEN**: [Create a token](https://vercel.com/account/tokens)
   - **VERCEL_ORG_ID** and **VERCEL_PROJECT_ID**: Run `npx vercel link` in the project root, then read `.vercel/project.json`

2. **Add GitHub secrets**: Repo → Settings → Secrets and variables → Actions → New repository secret. Add:
   - `VERCEL_TOKEN`
   - `VERCEL_ORG_ID`
   - `VERCEL_PROJECT_ID`

3. **Push to `main`** – the workflow deploys automatically.

## Tech

- Vanilla HTML, CSS, and JavaScript
- [Leaflet](https://leafletjs.com/) for the map
- CARTO dark basemap (no API key required)
