// Visual comparison: original static pages vs React build.
// Usage: node visual.js <outDir>
const { chromium } = require('playwright')
const { PNG } = require('pngjs')
const pixelmatch = require('pixelmatch')
const fs = require('fs')
const path = require('path')

const OUT = process.argv[2] || require('path').resolve(__dirname, '../../../comparison-screenshots')
fs.mkdirSync(OUT, { recursive: true })
const ORIG = 'http://localhost:8011'
const REACT = 'http://localhost:4173'
const PAGES = [
  { key: 'home', orig: `${ORIG}/afforestt-trainings%20(1).html`, react: `${REACT}/`,
    sections: ['header.site', '.hero', '.founder-story', '#trainings', '#webinar', '#trainees', '#programs', '#reviews', 'footer.site'] },
  { key: 'webinar', orig: `${ORIG}/monthly-webinar.html`, react: `${REACT}/monthly-webinar`,
    sections: ['.site-header', '.webinar-hero', 'section.section', '.qa-section', '.site-footer'] },
]
const VIEWPORTS = [
  { key: 'desktop', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { key: 'mobile', viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
]

async function prepare(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
  await page.evaluate(() => document.fonts.ready)
  // Trigger lazy images, then return to the top.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)) }
    window.scrollTo(0, 0)
  })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.evaluate(() => Promise.all(Array.from(document.images).filter((img) => !img.complete).map((img) => new Promise((r) => { img.onload = img.onerror = r }))))
  await page.waitForTimeout(400)
}

function pad(png, width, height) {
  const out = new PNG({ width, height })
  out.data.fill(255)
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0)
  return out
}

function compare(aBuf, bBuf, file) {
  let a = PNG.sync.read(aBuf)
  let b = PNG.sync.read(bBuf)
  const width = Math.max(a.width, b.width)
  const height = Math.max(a.height, b.height)
  const sizeMatch = a.width === b.width && a.height === b.height
  a = pad(a, width, height)
  b = pad(b, width, height)
  const diff = new PNG({ width, height })
  const changed = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.1 })
  // side-by-side: original | react | diff
  const gap = 12
  const sbs = new PNG({ width: width * 3 + gap * 2, height })
  sbs.data.fill(255)
  PNG.bitblt(a, sbs, 0, 0, width, height, 0, 0)
  PNG.bitblt(b, sbs, 0, 0, width, height, width + gap, 0)
  PNG.bitblt(diff, sbs, 0, 0, width, height, (width + gap) * 2, 0)
  if (file) fs.writeFileSync(file, PNG.sync.write(sbs))
  return { sizeMatch, origSize: `${PNG.sync.read(aBuf).width}x${PNG.sync.read(aBuf).height}`, reactSize: `${PNG.sync.read(bBuf).width}x${PNG.sync.read(bBuf).height}`, changedPx: changed, changedPct: +(100 * changed / (width * height)).toFixed(3) }
}

;(async () => {
  const browser = await chromium.launch()
  const results = []
  for (const vp of VIEWPORTS) {
    for (const pg of PAGES) {
      const shots = {}
      for (const side of ['orig', 'react']) {
        const context = await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch, reducedMotion: 'reduce' })
        const page = await context.newPage()
        await prepare(page, pg[side])
        const mask = pg.key === 'webinar' ? [page.locator('.hero-image iframe')] : []
        shots[side] = { full: await page.screenshot({ fullPage: true, mask, animations: 'disabled' }), sections: {} }
        fs.writeFileSync(path.join(OUT, `${side}-${pg.key}-${vp.key}.png`), shots[side].full)
        for (const sel of pg.sections) {
          if (sel !== pg.sections[0]) await page.addStyleTag({ content: 'header.site,.site-header,.toast,.top-btn,.sticky-booking{visibility:hidden!important}' })
          const loc = page.locator(sel).first()
          if (await loc.count() === 0) { shots[side].sections[sel] = null; continue }
          await loc.scrollIntoViewIfNeeded()
          await page.waitForTimeout(150)
          shots[side].sections[sel] = await loc.screenshot({ mask, animations: 'disabled' })
        }
        await context.close()
      }
      const full = compare(shots.orig.full, shots.react.full, path.join(OUT, `sbs-${pg.key}-${vp.key}.png`))
      results.push({ viewport: vp.key, page: pg.key, section: 'FULL PAGE', ...full })
      for (const sel of pg.sections) {
        const o = shots.orig.sections[sel]
        const r = shots.react.sections[sel]
        if (!o || !r) { results.push({ viewport: vp.key, page: pg.key, section: sel, missing: !o ? 'orig' : 'react' }); continue }
        const safe = sel.replace(/[^a-z0-9]+/gi, '_')
        results.push({ viewport: vp.key, page: pg.key, section: sel, ...compare(o, r, path.join(OUT, `section-${pg.key}-${vp.key}-${safe}.png`)) })
      }
    }
  }
  await browser.close()
  fs.writeFileSync(path.join(OUT, 'visual-results.json'), JSON.stringify(results, null, 2))
  console.table(results.map((r) => ({ vp: r.viewport, page: r.page, section: r.section, size: r.sizeMatch ? r.origSize : `${r.origSize} vs ${r.reactSize}`, diffPct: r.changedPct, missing: r.missing })))
})().catch((error) => { console.error(error); process.exit(1) })
