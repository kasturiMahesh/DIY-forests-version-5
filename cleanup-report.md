# Afforestt cleanup and migration report

> **Update, 2026-10-15 (user-approved deletion):** these were permanently removed. Where this report mentions them below, that describes the earlier state.
> - `frontend/dist/` (regenerate with `npm run build`)
> - `comparison-screenshots/` (regenerate with `npm run parity:visual`)
> - `original-website-backup/` (identical to the git-tracked originals; restore with `git checkout e8b7883 -- .`)
> - `migration-rollback/` (including the only copy of the React v1 build; not recoverable)
> - the 69 MB of unreferenced media in `frontend/public/` listed in §4 (originals remain in the root `assets/` and root folder)
>
> After the removal, the build passes, lint is clean, every image path used in the code exists, and `dist/` is 44 MB instead of 113 MB.

Last updated: 2026-10-15. Baseline is the original static site at the project root, which is committed in git and also copied in `original-website-backup/`.

## 1. File classification

| Class | Files |
|---|---|
| **Required (original site, git-tracked)** | `afforestt-trainings (1).html`, `monthly-webinar.html`, `webinar-data.js`, `index.html` (redirect), `assets/`, `offline training ima/`, `webinar-section-images/`, root images |
| **Required (React app)** | `frontend/package.json`, `package-lock.json`, `index.html`, `vite.config.ts`, `tsconfig*.json`, `.oxlintrc.json`, `.gitignore`, `src/**`, `public/**` (asset copies) |
| **Safe to regenerate** | `frontend/node_modules/`, `frontend/dist/` (both git-ignored by `frontend/.gitignore`), `comparison-screenshots/` (run `npm run parity:visual`) |
| **Kept for rollback** | `original-website-backup/` (exact copy of the original), `migration-rollback/` (see §3) |
| **Unused, awaiting your approval** | See §4. Nothing in this group was deleted. |

No deployment workflow depends on `frontend/dist`: there's no CI config, deploy script or hosting config in the repo. It's rebuilt by `npm run build`.

## 2. Reference check

- All asset paths used by React (`src/data.ts`, `src/webinarData.ts`, `src/pages/*`) resolve to files in `frontend/public/`. Playwright saw every local image load on both pages.
- Remote images (afforestt.com, unsplash.com) and the YouTube embed are used by both versions, and all returned HTTP 200.
- The original HTML files were not referenced by React. Their copies in `frontend/public/` would have been published as part of the React deployment.

## 3. Files removed from the active project (moved, not deleted)

| File | Reason | Now at |
|---|---|---|
| `frontend/public/afforestt-trainings (1).html`, `monthly-webinar.html`, `webinar-data.js`, `index.html` | Byte-identical duplicates of the git-tracked originals. They would ship the old static site inside the React build. | `migration-rollback/frontend-public-removed/` |
| `frontend/public/favicon.svg`, `icons.svg` | Vite template files (purple Vite logo, social icons). They weren't part of the design, and the original has no favicon. | same |
| `frontend/src/App.css`, `src/index.css` | Hand-written approximation of the original CSS, which caused most of the visual drift. Replaced by the original stylesheets. | `migration-rollback/react-v1-src/` |
| Previous React build (`frontend/dist`) | Compiled previous React version, kept as a runnable rollback. The previous `App.tsx` source was overwritten and isn't recoverable as source; this build is its only copy. | `migration-rollback/react-v1-build/` |
| `comparison-screenshots/*.png` (old run) | Screenshots of the superseded React version. | `migration-rollback/old-comparison-screenshots/` |
| `frontend/src/assets/` | Empty folder. | deleted |

## 4. Uncertain files, listed for approval (not removed)

These 69 MB are copied into `frontend/public/`, so they end up in `dist/` (113 MB total). Neither the original nor the React pages reference them:

- `public/assets/trainees/tancy/After Planting…/IMG_4101.mov`, `IMG_4110.mov`, `IMG_4112.mov` (63 MB)
- `public/assets/trainees/brett/Screenshot 2026-10-08 195059.png`, `Screenshot 2026-10-08 195146.png`
- `public/training caraousel option 1.png`
- `public/WhatsApp Image 2026-10-07 at 4.41.12 PM.jpeg`

They may be intended for future trainee galleries. If approved, remove them from `frontend/public/` only. The originals stay at the project root.

Also note: Tancy's extra before/after photos (5 + 3 images, about 30 MB) are listed in the data but not shown. The original shows only the first of each (a "static pair"), and React does the same. They're kept because the data references them.

## 5. What changed in the React app

- `src/styles/home.css` and `src/styles/webinar.css` are the original `<style>` blocks, copied verbatim. Each page injects its own sheet, because the two originals define conflicting `.btn`, `.wrap`, `.brand` and `body` rules.
- `src/pages/HomePage.tsx` and `src/pages/WebinarPage.tsx` reproduce the original DOM (same classes, IDs and inline styles) and behaviour, with the data in `src/data.ts`.
- Restored features that the previous React version was missing: the "Monthly webinar" section heading, toast, cart bump animation, cart thumbnails and empty-cart icon, the image/tagline/"Suitable for" content in the training and offline modals, "Choose your batch" labels, combined multi-currency totals (`USD $590 · INR ₹1,18,000`), the training duration in cart meta, confetti, focus trap and focus return, mouse drag on carousels, nearest-card logic for trainee Prev/Next, offline-gallery swipe and fade, and the original arrow glyphs and SVG close icons.
- Fonts now load via `<link>` with preconnect, as in the original.
- Playwright parity scripts are in `frontend/tests/parity/` (`npm run parity:*`).

## 6. Build and test results

- `npm run build`: passes (`tsc -b` and `vite build`, 357 kB JS, no CSS file because the stylesheets are inlined per page).
- `npm run lint` (oxlint): 0 warnings, 0 errors.
- Visual and functional parity were tested with Playwright 1.64.1 / Chromium 156, at 1440×900 desktop and 390×844 mobile, DPR 1, reduced motion. Original was served from the project root on port 8011; React from `vite preview` on port 4173.

### Visual differences (pixelmatch, threshold 0.1)

| Page | Viewport | Full-page height | Sections pixel-identical | Full-page diff |
|---|---|---|---|---|
| Home | Desktop | 5536 = 5536 | 9 / 9 (header, hero, founder, trainings + offline, webinar, trainees, projects, reviews, footer) | 0.86%: one remote project image still loading in the React capture. The same section re-captured: 0%. |
| Home | Mobile | 7309 = 7309 | 9 / 9 | 0% |
| Webinar | Desktop | 2129 = 2129 | 5 / 5 | 0% (YouTube iframe masked in both) |
| Webinar | Mobile | 3727 = 3727 | 5 / 5 | 0% |

Screenshots are in `comparison-screenshots/`: `orig-*.png`, `react-*.png`, `sbs-*.png` (original | React | diff), and `sections/` for per-section comparisons.

What these numbers don't cover:
- The YouTube player contents (masked).
- Hover states and animation frames (captured with reduced motion).
- Remote image load timing.
- Other browsers (only Chromium was tested).

There's no dark/light theme toggle in the original, and none in React.

### Functional differences

| Flow | Result |
|---|---|
| Nav links, scrollspy, hash jumps | Match |
| Mobile menu open, close on link | Match |
| Back-to-top button | Match |
| Online training date chips, add-button states, cart meta, toast | Match |
| Offline batch chips, multi-currency subtotal/GST/total, remove, badge, persistence | Match |
| Webinar countdown, seats 12→11, reserve-to-cart, ₹149 + ₹27 GST = ₹176 | Match |
| Checkout validation (3 invalid when empty, phone pattern), Processing…, success, Done clears cart | Match |
| Course and offline galleries (next, prev, dots, wrap-around) | Match |
| Trainee cards, Prev/Next, profile modal, Escape, focus return, backdrop close, demo profiles | Match |
| Webinar page: meta, countdown, resources, sticky bar show/dismiss, reserve hand-off, back link | Match |
| **Sticky header** | **Differs.** In the original, the header scrolls away even though it's set to `position:sticky`, because `html,body{height:100%}` limits the sticky container. In React it stays pinned at the top, which is what the original CSS intends. This is a visible difference when scrolled. |
| **Payment method chips** | **Differs (original bug fixed).** In the original they are submit buttons, so choosing "Card" on a filled form completes the booking. In React they only select the method. |
| **"Read project story" / project images (mouse)** | **Differs (original bug fixed).** In the original, pointer capture on the carousel swallows mouse clicks, so the links never open. In React they open, and drag-to-scroll still works. |
| `?reserve=webinar` | React removes the query string after booking a seat, so a refresh doesn't book a second one. The original books again on every refresh. |
| Webinar link URLs | `/monthly-webinar` and `/` instead of the `.html` file names (`/monthly-webinar.html` is also routed). |

## 7. Remaining issues and recommended fixes

1. **Approve or decline the 69 MB of unreferenced media** (§4). If kept, deploys stay at 113 MB.
2. **Sticky header**: decide whether React should match the original's non-sticky behaviour. One line would do it (`html,body{height:100%}` on `#root`'s parent), but sticky is clearly what the CSS intends.
3. **SPA hosting**: `/monthly-webinar` needs a rewrite to `index.html` on the host (for example Netlify `_redirects` or Vercel `rewrites`). `vite preview` handles this locally; no host config exists yet.
4. **Webinar date is hard-coded** (`src/webinarData.ts`, 13 Oct 2026). It has passed, so both versions show "Webinar starting soon" and still sell seats.
5. **Seat count and cart live in `localStorage`**, and checkout is a demo. This is expected for this task; no real payment or backend was added.
6. **"How It Works" nav link** points to a section that doesn't exist (same in the original).
7. **Large images**: the root JPEG/PNGs are 0.8–3 MB each. Compressing them would speed up both versions (not done, to keep the visuals byte-identical).
8. `migration-rollback/` and `original-website-backup/` are untracked. Add them to a root `.gitignore`, or delete them once you're satisfied.

## 8. Status summary

- **Build success**: yes.
- **Visual parity**: both pages are pixel-identical at the two tested viewports in Chromium, with every section at 0 changed pixels. The one visual-behaviour difference is the sticky header while scrolling. Not verified: other browsers, hover and animation frames.
- **Functional parity**: all tested flows match, except three deliberate fixes of original bugs and the sticky header (see table).
- **Production readiness**: not yet. Before shipping, it still needs SPA rewrite config, a decision on the unreferenced media, real webinar dates, and a real booking/payment backend.
