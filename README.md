# Ticketing (app-server files)

Self-contained eCommerce support-ticket UI that runs as an **iframe** embedded in
Four51 storefronts. These files are served as static assets by the app server
(nginx) from a `ticketing/` directory and are the single source that all ~40
storefronts pull from, replacing the per-storefront `supportTicketCtrl.js` +
`supportTicket.html`.

> **Status:** dev scaffold. The iframe reuses the **existing** Vampire Ticketing
> application (the same client token the storefronts ship today), so no new
> backend is required. Items that depend on values only the team can confirm are
> marked **TO CONFIRM** in `PLAN.md`.

## What lives here

```
ticketing/
├── public/                 # served by nginx as the iframe (the deliverable)
│   ├── index.html          # the iframe page (form + ticket list)
│   ├── js/ticketing.js     # form logic, postMessage listener, Vampire calls
│   ├── css/ticketing.css   # standalone styling (reproduces the storefront look)
│   └── preview.html        # QC harness (fake storefront parent), deployed with public/
├── deploy/
│   └── nginx.conf.example  # example server block: serve public/ + CSP frame-ancestors
├── .claude/launch.json     # DEV-ONLY preview server config (serves public/)
└── PLAN.md                 # the full implementation plan
```

This whole directory IS the app-server deliverable: deploy it to
`/var/www/ticketing` and nginx serves `public/`. The files in `public/` are
edited here (a normal dev task) and deployed as static files — no in-app editor.

> The **per-storefront embed** (the stub that goes into each Four51 storefront)
> lives in the sibling `../storefront-ticketing` directory, not here — it is not
> deployed to the app server.

## Data flow (runtime / submit)

```
Storefront page
  -> <iframe src="https://<app-server>/ticketing/">   (served by nginx)
  -> parent postMessage(user + category tree + env + color)   -> iframe
  -> iframe  POST /api(-test)/create-ticket | /add-note | /tickets
       (existing Ticketing client token)  -> Vampire -> ticketing backend
```

Test vs production is chosen by the `env` value the parent passes: `test` uses
`https://vampire.vividimpact.com/api-test`, production uses
`https://vampire.vividimpact.com/api` — matching the storefront exactly.

## Deploy to the app server

1. Deploy the contents of `public/` to the app server's `ticketing/` web root
   (git checkout / rsync from this repo).
2. Serve it per `deploy/nginx.conf.example` (static files + a CSP
   `frame-ancestors` header allow-listing the storefront origins).
3. Confirm the app-server origin is on Vampire's CORS allow-list so the iframe's
   XHR calls succeed. (Vampire currently returns `Access-Control-Allow-Origin: *`
   on the ticketing endpoints.)

No server-side secrets or PHP are required — the page is static and calls
Vampire directly from the browser, exactly as the storefront does today.

See `DEPLOY.md` for the full go-live checklist (repo, app server, Vampire,
storefronts).

## Preview / QC harness

`public/preview.html` simulates the storefront parent. It is deployed with
`public/`, so it is reachable on the app server at
`https://<app-server>/ticketing/preview.html`, and locally at
`http://localhost:8765/preview.html` (the preview server serves `public/`).
Pick a company / user / color, paste a Vampire token, and click Load to drive
the `ticketing:init` payload. The iframe trusts its own origin, so the harness
works same-origin in both places without widening `ALLOWED_PARENT_ORIGINS`.

See `PLAN.md` for the complete plan.
