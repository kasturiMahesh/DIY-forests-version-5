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
| Published session | Real date, live countdown, "Limited to N seats" if capacity is set, and Reserve adds it to the demo cart |

**What it doesn't drive:**
- The Friday training dates and workshop batches are still **generated in the browser** (rolling next six Fridays and Saturdays). They are not database sessions.
- Checkout is still the browser-only demo; nothing is booked or paid.

**Configuration:**

| Setting | Where | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | `.env.local` (see `.env.example`) | API origin for production builds, e.g. `https://api.example.com`. It's public and compiled into the bundle, so **never put secrets in `VITE_*`**. Leave it empty locally. |
| Dev/preview proxy | `vite.config.ts` | `npm run dev` and `npm run preview` forward `/api` to `http://localhost:3000`. Override the target with the `API_PROXY_TARGET` environment variable. |

When `VITE_API_BASE_URL` points at another origin, add that site's origin to the backend's `CORS_ORIGINS`.

## Tests and checks

```bash
npm test                                   # Vitest: API client, price/date formatting, loading/empty/error/published states
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

Since Stage 3, the webinar banner, the webinar page, and the old fake "seats left" bar intentionally differ from the original static site, because they now reflect real catalog data. Expect the parity scripts to report those differences.
