# DIY Forests React Migration

React + TypeScript + Vite version of the original DIY Forests static site. The original pages in the parent folder (`afforestt-trainings (1).html`, `monthly-webinar.html`) are the visual and functional baseline.

## Project structure

- `src/pages/HomePage.tsx`: training page (`/`), with the same DOM, classes and behaviour as the original
- `src/pages/WebinarPage.tsx`: monthly webinar page (`/monthly-webinar`)
- `src/styles/home.css`, `src/styles/webinar.css`: the original `<style>` blocks, copied verbatim. Each page injects only its own sheet, because the two originals define conflicting `.btn`/`.wrap`/`body` rules. Edit these to change the design.
- `src/data.ts`, `src/webinarData.ts`: trainings, trainees, projects, reviews, webinar resource cards, and **fallback** prices used only when the API can't be reached. No webinar date is hard-coded any more.
- `src/api/`: typed client for the backend catalog API (`client.ts`), the response types (`types.ts`) and exact price/date formatting (`format.ts`)
- `src/catalog/`: `CatalogProvider` loads the products and the next published webinar once for the whole app. Also holds the home page webinar banner and the shared countdown.
- `public/`: original images used by the pages
- `tests/parity/`: Playwright scripts that compare the React build with the original site

## Local setup

```bash
cd frontend
npm install
npm run dev       # http://localhost:5173
```

To see live catalog data, also run the backend: `cd backend && npm run dev`. The full instructions are in `backend/README.md` under "Running the backend and frontend together".

## Catalog API

**What the API drives:**
- **Prices:** the Online Training price, the Offline Workshop price, and the webinar price (hero button, banner and webinar page). Each is an exact decimal string with its currency, so nothing is converted.
- **The webinar:** its date, countdown and Reserve buttons, on both pages, come only from a **published, upcoming** session in the database.
  - The date is formatted in the visitor's own time zone. For example, 18:30 IST appears as 9:00 AM to a visitor in New York.
  - If no such session exists, the site says the next date hasn't been announced and offers no reservation.

**How each state looks:**

| State | What the site shows |
|---|---|
| Loading | Webinar heading "Loading…"; Reserve disabled; static prices |
| Empty (no published webinar) | "Next date to be announced"; button "Dates coming soon" (disabled); no countdown. The webinar page shows no Reserve links and hides the sticky booking bar. |
| API error or unreachable | "Schedule unavailable" with a **Try again** button; prices fall back to the existing static values, so the layout never breaks |
| Published session | Real date, live countdown, "Limited to N seats" if capacity is set, and Reserve adds it to the cart |
| Fully booked | "Fully booked" (from the server's `seatsAvailable`); Reserve is disabled |

- **Online training dates (Stage 4B):** the "Choose a Friday" picker lists published cohorts from `GET /api/v1/cohorts?product=online-training`. Each chip is one enrolment: two 4-hour sessions on consecutive Fridays, for example "Fri, 13 Nov & Fri, 20 Nov · 6:30 PM", shown in the visitor's time zone.
- **Workshop batches (Stage 4B):** the "Choose your start date" picker lists published `OFFLINE_WORKSHOP` sessions, with their real date range, number of days and venue.
- While these load, if none are published, or if the API fails, the pickers say so ("Loading dates…", "New … will be announced soon.", "We couldn’t load the dates." with **Try again**), and the add-to-cart button stays disabled. No dates are generated in the browser any more.
- Dates with no seats left (`seatsAvailable: 0`) are shown as "Fully booked" and can't be selected. The booking request re-checks availability on the server.

**Checkout (Stage 4C):** checkout sends real booking requests (`POST /api/v1/me/bookings`); `src/bookings/checkout.ts` holds the logic.
- **Sign-in:** checkout needs a signed-in customer account. Signed out, it offers sign-in or account creation and keeps the cart. Staff sessions are told to use a customer account.
- **The form:** the account email (read-only), a contact name, and a phone country plus number. The server validates and normalizes the phone.
- **One request per cart item:** each item has its own idempotency key, so retrying after a network failure can't book twice.
- **Results:** only bookings the server returned are shown as received, each with its reference and **"pending payment"**. Items that failed stay in the cart with the server's reason.
- **No payment:** online payment isn't built. Nothing is charged, no card details are collected, and bookings stay pending payment until cancelled.
- **No tax in the browser:** prices are shown as listed. The demo GST line, payment-method chips and confetti have been removed.
- **Saved carts:** the cart is stored under `afforestt_training_cart_v2`. Items from the old demo cart had no booking target, so they aren't loaded.

**Configuration:**

| Setting | Where | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | `.env.local` (see `.env.example`) | API origin for production builds, e.g. `https://api.example.com`. It's public and compiled into the bundle, so **never put secrets in `VITE_*`**. Leave it empty locally. |
| Dev/preview proxy | `vite.config.ts` | `npm run dev` and `npm run preview` forward `/api` to `http://localhost:3000`. Override the target with the `API_PROXY_TARGET` environment variable. |

When `VITE_API_BASE_URL` points at another origin, add that site's origin to the backend's `CORS_ORIGINS`.

## Accounts and sign-in (Stage 4A)

- **Header:** a **Sign in** pill sits beside Cart, in the same style. Signed in, it reads **Account**, or **Admin** for a staff session. On phones it shows only its icon, so the header stays on one row.
- **Pages:**

  | Page | Purpose |
  |---|---|
  | `/sign-in` | Sign-in and create-account buttons, plus friendly messages for sign-in errors (`?error=…`) |
  | `/account` | Your own details, display name, session expiry and sign out, plus **Your bookings** (Stage 4C): status, reference, dates and price from `GET /api/v1/me/bookings`, with **Cancel booking** until the dates start |
  | `/admin/*` | Staff sign-in, then the admin dashboard (Stage 4B). The page asks the server (`GET /api/v1/admin/me`) before showing anything, so a customer session only ever sees "no access". |

  These pages reuse the webinar page's header, footer and buttons (`webinar.css`), plus a few form and card rules in `src/styles/auth.css`.
- **Sign-in and session handling:**
  - Sign-in and sign-out are full-page navigations to the backend, which talks to the identity provider. No password ever passes through this app.
  - The session is an `HttpOnly` cookie, so JavaScript can't read it.
  - `AuthProvider` (`src/auth/`) asks `GET /api/v1/auth/me` once, then exposes these states: loading, signed out (including "session expired"), signed in, unavailable, error.
  - State-changing requests send the CSRF token from `/auth/me` in `X-CSRF-Token`.
- **Local sign-in with test identities:** follow "Local development with test identities" in `backend/README.md`.

## Admin dashboard (Stage 4B)

The admin dashboard lives in `src/admin/`, with tabs at `/admin`, `/admin/products`, `/admin/webinars`, `/admin/workshops`, `/admin/training` and (Stage 4C) `/admin/bookings`.

| Tab | What staff can do |
|---|---|
| Overview | Product counts, plus upcoming published/draft dates per type, with the next few dates |
| Products | Create (starts inactive), edit texts and exact price/currency, activate or deactivate. Nothing is deleted. |
| Webinars | Create a draft, edit or reschedule, publish, cancel (with an optional reason). Capacity is optional. |
| Workshops | The same, plus the required venue and end date |
| Online training | Pick the first Friday and a start time. The form previews both 4-hour sessions one week apart. Both are published or cancelled together. |
| Bookings (Stage 4C) | Filter by status, or search by reference or customer email. **Details** shows the contact phone. **Cancel** needs a reason and releases the seat. There's no "mark as paid": payment isn't built. |

How it behaves:
- Times are entered and shown in **organizer time (IST)**. `src/admin/admin-time.ts` converts them to exact instants with a `+05:30` offset, so the admin's computer zone never shifts a date.
- Forms check the same rules as the server for quick feedback. The server stays the authority, and its error messages are shown as-is.
- Writes send the CSRF token from `/auth/me`. A 401 switches the page to "session expired".
- Overview shows booking counts (pending payment / cancelled). Webinar, workshop and training tables show **booked / capacity**.
- A session or cohort with active bookings can't be rescheduled, cancelled, or given a capacity below the seats held. The server refuses, and its message is shown.

## Tests and checks

```bash
npm test                                   # Vitest: API client, formatting, catalog/sign-in/admin states, admin rules, forms and date pickers
npm run lint
npx tsc -p tsconfig.app.json --noEmit
npx tsc -p tsconfig.node.json --noEmit
npm run build
```

## Production build

```bash
npm run build     # outputs dist/ (git-ignored)
npm run preview   # serves dist/ on http://localhost:4173 (with the /api proxy)
```

When hosting, rewrite unknown paths (for example `/monthly-webinar`) to `index.html`.

## Parity check against the original

Use three terminals:

```bash
npm run parity:serve-original   # original site on :8011
npm run build && npm run preview -- --port 4173 --strictPort
npm run parity:visual           # screenshots and diffs into ../comparison-screenshots
npm run parity:functional       # same user flows on both sites; prints MATCH/DIFF
```

If Playwright reports a missing browser, run `npx playwright install chromium`.

Since Stage 3, the webinar banner, the webinar page, and the old fake "seats left" bar intentionally differ from the original static site, because they now reflect real catalog data. Since Stage 4C, the cart and checkout differ too: no GST line (`#cartGst`), no payment-method chips, and a real sign-in and booking flow. Expect the parity scripts to report those differences.
