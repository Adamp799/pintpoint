# PintPoint

A map of Cambridge pubs with the cost of the cheapest pint at each, plus a sidebar to search and find the cheapest pint in town.

**https://pintpoint.xyz/**

## Features

- **Map** – Leaflet map of Cambridge with a marker for each pub
- **Pub info** – Click a marker to see the pub name, address, description, and cheapest pint price
- **Community updates** – Logged-in, verified users can submit pint name/price update proposals from each pub popup
- **Auth + verification** – Email/password accounts with sessions, optional developer code, and 12-hour verification window
- **Verification resend** – Users can request a new verification email/code
- **Password reset** – Users can request reset by email (link + code), then set a new password
- **Developer moderation** – Developer accounts can approve or reject pending update proposals
- **Developer audit log** – Developer decisions (approve/reject) are recorded with timestamps and actor identity
- **Anti-abuse controls** – Combined account and IP throttling for sensitive actions
- **Sidebar** – List of all pubs; sort by cheapest first, most expensive first, or name A–Z
- **Search** – Filter pubs by name, address, or pint
- **Cheapest callout** – Highlights the single cheapest pint in Cambridge at the top of the sidebar

## Run locally

The app loads `data/pubs.json` via `fetch`, so it must be served over HTTP (not opened as `file://`).

From the project root:

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

Optional email delivery environment variables:

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=example@example.com
SMTP_PASS=your-password
SMTP_FROM=no-reply@pintpoint.xyz
SESSION_SECRET=replace-me
APP_BASE_URL=http://localhost:3000
```

For local development, copy `.env.local.example` to `.env.local` and fill it:

```bash
cp .env.local.example .env.local
```

Then restart `npm run dev` so the server picks up your SMTP settings.

## Data

- **`data/pubs.json`** – List of Cambridge pubs with `name`, `address`, `description`, `cheapestPint` (£), `cheapestPintName`, `lastUpdated` (`dd/mm/yyyy`), and `lat`/`lng`.
- **`data/update-proposals.private.json`** – Pending user-submitted update proposals.
- **`data/users.private.json`** – Account storage (private).

## Deploy (GitHub Action)

Deploys via Vercel CLI on every push to `main`. Requires GitHub secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`. Get these from [vercel.com/account/tokens](https://vercel.com/account/tokens) and `.vercel/project.json` (run `npx vercel link` first).

The project must be disconnected from Git in Vercel (Settings → Git → Disconnect) so deployments use the token rather than commit-author checks. Any collaborator can push and deploy.

## Tech

- Vanilla HTML, CSS, and JavaScript
- [Leaflet](https://leafletjs.com/) for the map
- CARTO dark basemap (no API key required)
