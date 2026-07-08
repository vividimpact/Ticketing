# Deploying Ticketing

How to take this repo live: create the repo, deploy the static files to the app
server, confirm Vampire, then swap the embed into the storefronts.

**Do the whole thing against TEST first** (test app-server host + `teststore.four51.com`
+ Vampire `/api-test`), verify end-to-end, then repeat for production.

Key facts that shape these steps:

- The iframe is **static files** — no backend, no build, no server-side secrets.
- It **reuses the existing Vampire Ticketing application** (applicationId 3,
  clientId 5) and the **same client token the storefronts already ship**. No new
  Vampire app, client, or token is created.
- The **token is not committed in this repo**. The storefront injects it at
  runtime (`ticketing:init` → `vampireToken`).
- Vampire CORS is already open (`Access-Control-Allow-Origin: *`) on the ticketing
  endpoints, so no CORS change is required today.

---

## 1. Git repo

- [ ] Create the `ticketing` repo (**TO CONFIRM:** name/org) and commit:
      `public/`, `deploy/`, `storefront/`, `README.md`, `PLAN.md`, `DEPLOY.md`.
- [ ] `.claude/launch.json` is DEV-ONLY (local preview server). Committing it is
      harmless — it lives outside `public/` so it is never served — but add a
      `.gitignore` if you'd rather leave it out. (There is no `.gitignore` yet.)
- [ ] Confirm no token is committed: the JWT string appears nowhere in the repo
      (only prose describing its `applicationId 3 / clientId 5` payload).

---

## 2. App server (nginx, static)

- [ ] Deploy the contents of `public/` to the ticketing web root
      (git checkout / rsync). This includes `preview.html`, which is intentionally
      served at `/ticketing/preview.html` as a QC harness.
- [ ] Configure nginx from `deploy/nginx.conf.example`:
  - [ ] Set the real `server_name` (placeholder: `apps.vividimpact.com`).
  - [ ] Set CSP `frame-ancestors 'self' https://*.four51.com;` — `'self'` lets the
        preview frame the iframe; `*.four51.com` lets the storefronts embed it.
        Add any storefront **custom domains** here too.
- [ ] The app-server origin must match in THREE places or the iframe silently
      fails: the iframe `src`, the storefront controller's `IFRAME_ORIGIN`, and
      the CSP `frame-ancestors`.
- [ ] Bump the `?v=` query on the CSS/JS links in `index.html` on every deploy to
      bust browser caches.
- [ ] (Optional) Protect `/ticketing/preview.html` — it's a QC tool on a public
      host. Consider basic auth / IP allowlist via a dedicated nginx location.

**Test vs prod app server:** if there is a separate test app-server host, deploy
there first and point `teststore.four51.com` at it. **TO CONFIRM:** test
app-server host.

---

## 3. Vampire

No new application, client, or token — the iframe reuses the existing Ticketing
setup. Only two things to check:

- [ ] **CORS:** confirm with the Vampire owner that `Access-Control-Allow-Origin: *`
      on `create-ticket` / `add-note` / `tickets` is intentional and staying.
      If Vampire is ever tightened to an allowlist, add the **app-server origin**
      (the origin serving the iframe, e.g. `https://apps.vividimpact.com`) — that
      is the `Origin` on the iframe's XHR, not the storefront's.
- [ ] **Company provisioning:** each storefront's company must be **set up for
      external ticketing** in the ticketing backend, and the `companyName` the
      storefront sends must match the registered name **exactly**. A mismatch
      returns `400 "Company not setup for external ticketing."`
      (Confirmed live: `AA Dermatology` works; `AA-Dermatology` did not.)
      Use `/ticketing/preview.html` to verify each company before its storefront
      goes live.

---

## 4. Storefronts (per storefront)

This is a **swap**, not an add — the route (`/supportticket`) and controller name
(`SupportTicketCtrl`) stay the same. Reference: `storefront/embed-snippet.html`.

- [ ] Replace `partials/supportTicket.html` with the iframe host.
- [ ] Replace `SupportTicketCtrl` with the ~20-line postMessage bridge.
- [ ] Set the iframe `src` and `IFRAME_ORIGIN` to the real app-server origin.
- [ ] Inject `vampireToken` — paste **this storefront's existing Ticketing token**
      (already in its current `supportTicketCtrl.js`). No token → `401`.
- [ ] Set `color` — the storefront brand color (was the `btn-centerwell` theme).
      **TO CONFIRM:** how each storefront supplies its color (hard-code, config,
      or read a themed element's computed background).
- [ ] `env` is derived automatically (`teststore.four51.com` → `test` → `/api-test`,
      else `production` → `/api`). Nothing to set.
- [ ] Delete the old inline form logic once the stub is in.

**Parent-origin allowlist:** the iframe accepts init only from `*.four51.com`
(plus its own origin). Storefronts on **custom domains** must be added to
`ALLOWED_PARENT_ORIGINS` in `public/js/ticketing.js` (a ticketing-repo change +
redeploy), and to the CSP `frame-ancestors`.

**Rollout order:** pilot ONE storefront on test end-to-end, then batch-migrate the
rest, then remove the legacy form logic everywhere.

---

## 5. Smoke test (each environment)

- [ ] Open `https://<app-server>/ticketing/preview.html`, pick a provisioned
      company, paste the token, Load → the ticket list populates and a test
      submission returns a ticket number.
- [ ] On the pilot storefront: sign in, open the ticket page, confirm the user +
      category tree arrive, the brand color applies, the iframe auto-sizes, and
      create / add-note / list all work.

## 6. Rollback

- Storefront: revert `supportTicket.html` + `SupportTicketCtrl` to the previous
  version (the old inline form is self-contained and still works).
- App server: no data/state to unwind — it's static files.
