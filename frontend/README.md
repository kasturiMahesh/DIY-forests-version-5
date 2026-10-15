# DIY Forests React Migration

React + TypeScript + Vite version of the original DIY Forests static site. The original pages in the parent folder (`afforestt-trainings (1).html`, `monthly-webinar.html`) are the visual and functional baseline.

## Project structure

- `src/pages/HomePage.tsx`: training page (`/`), with the same DOM, classes and behaviour as the original
- `src/pages/WebinarPage.tsx`: monthly webinar page (`/monthly-webinar`)
- `src/styles/home.css`, `src/styles/webinar.css`: the original `<style>` blocks, copied verbatim. Each page injects only its own sheet, because the two originals define conflicting `.btn`/`.wrap`/`body` rules. Edit these to change the design.
- `src/data.ts`, `src/webinarData.ts`: trainings, trainees, projects, reviews, webinar date and price
- `public/`: original images used by the pages
- `tests/parity/`: Playwright scripts that compare the React build with the original site

## Local setup

```bash
cd frontend
npm install
npm run dev
```

## Production build

```bash
npm run build     # outputs dist/ (git-ignored)
npm run preview   # serves dist/ on http://localhost:4173
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
