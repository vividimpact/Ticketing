# Centralized Ticketing — Implementation Plan

## Goal

Today every storefront ships its own copy of `supportTicketCtrl.js` +
`partials/supportTicket.html`. Editing the support-ticket form means repeating
the same change across ~40 storefronts. This plan consolidates the form into a
**single set of static files** that:

- live in a new `ticketing/` directory on the **app server** (nginx) and are
  embedded into every storefront as an **iframe**;
- are **edited as a normal dev task** in this repo (to become a GitHub repo) and
  **deployed to the app server as static files** (git checkout / rsync);
- reuse the **existing** Vampire Ticketing application and its client token — the
  same one the storefronts ship today — so **no new backend is required**.

After this, a form change is made once in this repo and deployed once to the app
server, propagating to all storefronts with no storefront redeploys.

> This document is the full, system-by-system plan. Assumptions that need a real
> value or a team decision are marked **TO CONFIRM**.

---

## What already exists (and does not change)

The current controller (`AA-Dermatology/app/js/controllers/supportTicketCtrl.js`)
already sends all three ticket operations to Vampire:

| Operation      | Endpoint (today)                                          |
| -------------- | --------------------------------------------------------- |
| Create ticket  | `POST https://vampire.vividimpact.com/api(-test)/create-ticket` |
| Add note       | `POST https://vampire.vividimpact.com/api(-test)/add-note`      |
| List tickets   | `POST https://vampire.vividimpact.com/api(-test)/tickets`       |

It authenticates with a hard-coded Bearer JWT whose payload is
`{"applicationId":3,"clientId":5,"authorized":true}` — a **Four51 client of the
existing Ticketing application** (app id 3). Test vs prod is chosen in the
storefront by `window.location.host === 'teststore.four51.com'`, which selects
the `/api-test` vs `/api` path on the same host.

**Key consequence:** the ticket *backend* is already centralized in Vampire, and
the iframe reuses it unchanged (same endpoints, same token). What duplicates
across storefronts is only the **frontend** (form UI + controller). This plan
moves only that frontend.

---

## Target architecture

```
        RUNTIME /         ┌───────────────────────────────────────────┐
        SUBMIT FLOW       │              Storefront (Four51)           │
                          │  /supportticket route -> iframe host       │
                          │  postMessage(user + categoryTree +         │
                          │              env + color)              ──► │
                          └───────────────┬────────────────────────────┘
                                          │  <iframe src=app server/ticketing/>
                                          ▼
                          ┌───────────────────────────────────────────┐
                          │   Ticketing iframe (static, app server)    │
                          │  create-ticket / add-note / tickets ──────►│
                          │  (existing Ticketing client token)         │
                          └───────────────┬────────────────────────────┘
                                          ▼
                          ┌───────────────────────────────────────────┐
                          │   Vampire (existing Ticketing app)         │
                          │   -> Vivid Ticketing backend               │
                          └───────────────────────────────────────────┘
```

There is one flow (runtime/submit) and no deploy pipeline: the files are static
assets deployed from this repo, and they call the existing Vampire Ticketing
application directly from the browser, exactly as the storefront does now.

---

## Component 1 — App server (`ticketing/` directory)

Delivered in this repo (to become the `ticketing` GitHub repo).

**Served assets (`public/`):**

- `index.html` — the iframe page (form + ticket list), no framework beyond
  jQuery + select2, renders nothing until it receives a trusted `ticketing:init`
  message from the parent storefront.
- `js/ticketing.js` — form logic ported from `supportTicketCtrl.js`; listens for
  the parent's user/category/env/color payload; calls Vampire with the existing
  Ticketing client token.
- `css/ticketing.css` — self-contained styling that reproduces the storefront's
  Bootstrap-3 support-ticket appearance (buttons, form controls, striped table,
  modal + translucent backdrop, Open Sans). The per-storefront brand color is
  supplied at runtime (see "Brand color" below).

**Serving infra (`deploy/`):**

- `nginx.conf.example` — server block: serve `/ticketing/` statically and set a
  `Content-Security-Policy: frame-ancestors` header for the storefront origins.

**Steps:**

1. Create the `ticketing` GitHub repo from this scaffold. **TO CONFIRM:** repo
   name / GitHub org.
2. Deploy `public/` to the app server ticketing web root (static; git checkout or
   rsync). Assets are versioned with `?v=` query strings; bump on deploy to bust
   caches.
3. Add the app-server origin to Vampire's CORS allow-list (see Security).
4. Decide the real app-server hostname. **TO CONFIRM** — placeholder throughout
   is `apps.vividimpact.com`; `services.vividimpact.com` is a candidate given the
   existing `herd/api` app.

No PHP, no server-side secrets, and no in-app file editor are involved.

---

## Component 2 — Storefronts (future change; NOT applied now)

Documented here and scaffolded in `storefront/embed-snippet.html` for when you
choose to roll it out.

- Keep the existing route `when('/supportticket', … 'partials/supportTicket.html',
  … 'SupportTicketCtrl')`.
- Replace `partials/supportTicket.html` with the iframe host.
- Shrink `SupportTicketCtrl` to: post `{ user, categoryTree, env, color }` to the
  iframe on `ticketing:ready`, and resize the iframe on `ticketing:resize`.
- This is the only per-storefront code that remains, and it should rarely change.

Two per-storefront values are passed in, not hard-coded in the iframe:

- `env`: `'test'` when `window.location.host === 'teststore.four51.com'`, else
  `'production'`.
- `categoryTree`: the storefront's own `$scope.tree` (product categories).
- `color`: the storefront brand color (previously the platform theme color used
  by `btn-centerwell` / the ticket banner).

---

## Message contract (parent storefront ⇄ iframe)

```
parent -> iframe   { type: 'ticketing:init', payload: {
                       env, storefront, color,
                       user: { id, firstName, lastName, email, companyName,
                               allowTicketing, ticketingDashboard },
                       categoryTree } }

iframe -> parent   { type: 'ticketing:ready' }
iframe -> parent   { type: 'ticketing:resize', height }
```

Both sides validate origin. The iframe restricts accepted parents via
`ALLOWED_PARENT_ORIGINS`; the parent posts only to the app-server origin.

---

## Three carried-over / new design points

1. **Category tree.** The New-Product category dropdown is built from the
   storefront's own `$scope.tree`, which lives only in that storefront. The
   iframe cannot see it, so the parent passes it in via `ticketing:init`
   (`categoryTree`). `ticketing.js` flattens it exactly like the legacy
   recursive walk. This is the single most important piece to get right during
   the pilot.
2. **Test vs prod.** Inside the iframe, `window.location.host` is the app
   server's, so the old `teststore.four51.com` check no longer works there. The
   parent tells the iframe which environment it is (`env`), and the iframe picks
   the matching Vampire base URL (`/api-test` vs `/api`).
3. **Brand color.** The Create Ticket button used the platform theme class
   `btn-centerwell` and the ticket banner was themed per storefront — neither is
   visible to the iframe. The parent passes `color`, which the iframe applies to
   the `--brand-theme` CSS variable driving the ticket-request-banner background
   and the Create Ticket button. Other buttons keep Bootstrap semantics (Create =
   green, Cancel = red, Add Comment = blue), matching the storefront.

---

## Security

- **Token exposure:** the Ticketing client JWT is **not committed in this repo**.
  The parent storefront injects it at runtime via the `ticketing:init` payload
  (`vampireToken`) — the same token each storefront already ships in its own
  `supportTicketCtrl.js`. The token is still present in browser-delivered JS (in
  the storefront), unchanged from today. A further step (not required) is to
  proxy the Vampire calls server-side so the token never reaches the browser.
- **Spoofable identity:** `user.id` / `email` are supplied by the parent and are
  technically spoofable via dev tools — unchanged from today. If it ever matters,
  Vampire can validate identity against Four51 rather than trusting passed values.
- **Framing:** the app server sets `Content-Security-Policy: frame-ancestors` to
  the storefront origins so only storefronts can embed the page.
- **CORS:** add the app-server origin to Vampire's allow-list. (Vampire currently
  returns `Access-Control-Allow-Origin: *` on the ticketing endpoints.)

---

## Rollout

1. **Build & stage.** Finish the files in this repo; deploy `public/` to the
   **test** app server; verify against Vampire test (`/api-test`).
2. **Pilot one storefront.** Apply the `storefront/embed-snippet.html` change to a
   single storefront (e.g. AA-Dermatology) pointing at the test app server.
   Verify: user info arrives, category tree renders, brand color applies, and
   create / add-note / list all work end-to-end, iframe resizes cleanly.
3. **Promote to production.** Deploy `public/` to the prod app server.
4. **Migrate storefronts in batches.** Swap each storefront's `supportTicket.html`
   + `SupportTicketCtrl` for the stub. Because the stub rarely changes, this is
   the last bulk edit across the 40 storefronts.
5. **Decommission.** Once all storefronts use the iframe, retire the per-storefront
   `supportTicketCtrl.js` form logic.

---

## Task checklist

**ticketing repo (this scaffold)**
- [x] `public/index.html`, `public/js/ticketing.js`, `public/css/ticketing.css`
- [x] Reuse existing Ticketing app token + `/api` / `/api-test` endpoints
- [x] Brand color via `ticketing:init` `color` -> `--brand-theme`
- [x] Storefront-matched styling (Bootstrap-3 look, Open Sans, modal)
- [x] `deploy/nginx.conf.example` (static serving + CSP)
- [x] `storefront/embed-snippet.html`
- [ ] Create GitHub repo and push. **TO CONFIRM** repo name/org.

**App server**
- [ ] Deploy `public/` to the ticketing web root (static)
- [ ] Serve per `nginx.conf.example` (CSP frame-ancestors)
- [ ] Confirm app-server hostname. **TO CONFIRM**
- [ ] Confirm app-server origin on Vampire's CORS allow-list

**Storefronts (later)**
- [ ] Pilot one storefront with the embed stub
- [ ] Verify category tree + env + color passing + resize
- [ ] Batch-migrate remaining storefronts
- [ ] Remove old form logic

---

## Open questions (TO CONFIRM)

1. Real app-server hostname (and test app-server host/path if different).
2. GitHub repo name/org for `ticketing`.
3. Exact storefront origins for CSP `frame-ancestors` and the iframe's
   `ALLOWED_PARENT_ORIGINS` / Vampire CORS allow-list.
4. Which companies are provisioned for external ticketing in **test** — a QC
   submission against a company that is not set up returns
   `400 "Company not setup for external ticketing."`
5. Token delivery is decided: injected by the parent via `ticketing:init`
   (`vampireToken`), not committed in this repo. Open follow-up: whether to later
   proxy the Vampire calls server-side so the token never reaches the browser.
