# PintPoint

A map of Cambridge pubs with the cost of the cheapest pint at each, plus a sidebar to search and find the cheapest pint in town.

**https://pintpoint.xyz/**

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

Deploys via Vercel CLI on every push to `main`. Requires GitHub secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`. Get these from [vercel.com/account/tokens](https://vercel.com/account/tokens) and `.vercel/project.json` (run `npx vercel link` first).

The project must be disconnected from Git in Vercel (Settings → Git → Disconnect) so deployments use the token rather than commit-author checks. Any collaborator can push and deploy.

## Tech

- Vanilla HTML, CSS, and JavaScript
- [Leaflet](https://leafletjs.com/) for the map
- CARTO dark basemap (no API key required)
