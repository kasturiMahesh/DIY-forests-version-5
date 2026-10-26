// Functional parity: run identical flows on the original and React sites, record observations.
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')
const OUT = process.argv[2] || require('path').resolve(__dirname, '../../../comparison-screenshots')
fs.mkdirSync(OUT, { recursive: true })

const SITES = {
  orig: { home: 'http://localhost:8011/afforestt-trainings%20(1).html', webinar: 'http://localhost:8011/monthly-webinar.html' },
  react: { home: 'http://localhost:4173/', webinar: 'http://localhost:4173/monthly-webinar' },
}
const DESKTOP = { viewport: { width: 1440, height: 900 } }
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }

const text = (page, sel) => page.locator(sel).first().innerText().then((t) => t.replace(/\s+/g, ' ').trim()).catch(() => null)
const visible = (page, sel) => page.locator(sel).first().isVisible().catch(() => false)
const badge = async (page) => (await visible(page, '#cartBadge')) ? await text(page, '#cartBadge') : 'hidden'
const cartState = async (page) => ({
  badge: await badge(page),
  items: await page.locator('#cartItems .cart-item').count(),
  metas: await page.locator('#cartItems .cart-item .info span').allInnerTexts(),
  thumbs: await page.locator('#cartItems .cart-item .thumb img').count(),
  subtotal: await text(page, '#cartSubtotal'),
  gst: await text(page, '#cartGst'),
  total: await text(page, '#cartTotal'),
  drawerOpen: await page.locator('#cartDrawer.open').count() === 1,
})

const tests = {
  async navigationAndScrollspy(page, site) {
    await page.goto(site.home, { waitUntil: 'domcontentloaded' })
    const links = await page.locator('#navLinks a').allInnerTexts()
    await page.click('#navLinks a[href="#reviews"]')
    await page.waitForTimeout(1500)
    const active = await page.locator('#navLinks a.active').allInnerTexts()
    const headerTop = await page.locator('header.site').evaluate((el) => Math.round(el.getBoundingClientRect().top))
    const headerPosition = await page.locator('header.site').evaluate((el) => getComputedStyle(el).position)
    const reviewsTop = await page.locator('#reviews').evaluate((el) => Math.round(el.getBoundingClientRect().top))
    const themeToggle = await page.locator('[aria-label*="theme" i], .theme-toggle, [data-theme-toggle]').count()
    return { links, activeAfterReviewsClick: active, stickyHeaderTop: headerTop, headerPosition, reviewsTopAfterJump: reviewsTop, themeToggleCount: themeToggle }
  },
  async backToTop(page, site) {
    await page.goto(site.home, { waitUntil: 'domcontentloaded' })
    const before = await page.locator('#topBtn.show').count()
    await page.evaluate(() => window.scrollTo(0, 1500))
    await page.waitForTimeout(500)
    const after = await page.locator('#topBtn.show').count()
    await page.click('#topBtn')
    await page.waitForTimeout(1500)
    return { shownAtTop: before === 1, shownAt1500: after === 1, scrollYAfterClick: await page.evaluate(() => window.scrollY) }
  },
  async mobileMenu(page, site) {
    await page.goto(site.home, { waitUntil: 'domcontentloaded' })
    const navHidden = !(await visible(page, '#navLinks'))
    const hamburger = await visible(page, '#hamburgerBtn')
    await page.click('#hamburgerBtn')
    const openAfterClick = await visible(page, '#mobileMenu')
    const items = await page.locator('#mobileMenu a').allInnerTexts()
    await page.click('#mobileMenu a[href="#trainees"]')
    await page.waitForTimeout(800)
    return { desktopNavHidden: navHidden, hamburgerVisible: hamburger, openAfterClick, items, closedAfterLink: !(await visible(page, '#mobileMenu')), hash: new URL(page.url()).hash }
  },
  async trainingDateSelection(page, site) {
    await page.goto(site.home, { waitUntil: 'domcontentloaded' })
    await page.click('#trainingGrid button:has-text("Choose a Friday")')
    const modalText = await text(page, '#modalBody')
    const chips = await page.locator('#modalBody .chip-date').allInnerTexts()
    const addBtn = page.locator('#modalBody .btn-primary')
    const disabledBefore = await addBtn.isDisabled()
    const labelBefore = await text(page, '#modalBody .btn-primary')
    await page.locator('#modalBody .chip-date').nth(1).click()
    const selectedCount = await page.locator('#modalBody .chip-date.is-selected').count()
    const labelAfter = await text(page, '#modalBody .btn-primary')
    const modalHasImage = await page.locator('#modalBody img').count()
    await addBtn.click()
    await page.waitForTimeout(400)
    return {
      modalHasImage, chips: chips.map((c) => c.replace(/\s+/g, ' ')), disabledBefore, labelBefore, selectedCount, labelAfter,
      modalHasLearnSection: /What you.ll learn/.test(modalText), modalClosed: !(await page.locator('#modalScrim.open').count()),
      toast: await text(page, '#toastText'), cart: await cartState(page),
    }
  },
  async cartMultiCurrencyAndRemove(page, site) {
    await page.goto(site.home, { waitUntil: 'domcontentloaded' })
    await page.click('#trainingGrid button:has-text("Choose a Friday")')
    await page.locator('#modalBody .chip-date').first().click()
    await page.locator('#modalBody .btn-primary').click()
    await page.click('#cartCloseBtn')
    await page.click('#offlineEnrollBtn')
    const offlineChips = await page.locator('#modalBody .chip-date').allInnerTexts()
    const offlineEmpty = await text(page, '#modalBody .btn-primary')
    await page.locator('#modalBody .chip-date').first().click()
    const offlineLabel = await text(page, '#modalBody .btn-primary')
    await page.locator('#modalBody .btn-primary').click()
    await page.waitForTimeout(400)
    const both = await cartState(page)
    await page.locator('#cartItems .remove-link').first().click()
    const afterRemove = await cartState(page)
    await page.locator('#cartItems .remove-link').first().click()
    const empty = await cartState(page)
    const emptyText = await text(page, '#cartItems')
    await page.reload()
    const persisted = await badge(page)
    return { offlineChips: offlineChips.map((c) => c.replace(/\s+/g, ' ')), offlineEmpty, offlineLabel, both, afterRemove, empty, emptyText, badgeAfterReload: persisted }
  },
  async webinarReserve(page, site) {
    await page.goto(site.home, { waitUntil: 'domcontentloaded' })
    const before = { seats: await text(page, '#seatsLeftText'), date: await text(page, '#webinarDateLine'), countdown: await text(page, '#homeWebinarCountdown'), price: await text(page, '#homeWebinarPrice') }
    await page.click('#webinarRegisterBtn')
    await page.waitForTimeout(300)
    const after = { seats: await text(page, '#seatsLeftText'), cart: await cartState(page) }
    const detailsHref = await page.locator('.webinar-details-link').getAttribute('href')
    return { before, after, detailsHref }
  },
  async checkout(page, site) {
    await page.goto(site.home, { waitUntil: 'domcontentloaded' })
    await page.click('#webinarRegisterBtn')
    await page.click('#checkoutBtn')
    const summary = await text(page, '#modalBody')
    await page.click('#payNowBtn')
    const invalidEmpty = await page.locator('#checkoutForm :invalid').count()
    await page.fill('#checkoutName', 'Asha Rao')
    await page.fill('#checkoutEmail', 'not-an-email')
    await page.fill('#checkoutPhone', 'abc')
    await page.click('#payNowBtn')
    const invalidBad = await page.locator('#checkoutForm :invalid').count()
    await page.fill('#checkoutEmail', 'asha@example.com')
    await page.fill('#checkoutPhone', '+91 98765 43210')
    // Clicking a payment chip with a valid form: does it submit?
    await page.locator('.pay-chip[data-pm="card"]').click()
    await page.waitForTimeout(100)
    const afterChipClick = { processing: (await text(page, '#payNowBtn')) || 'gone', cardSelected: await page.locator('.pay-chip.is-selected[data-pm="card"]').count() }
    await page.waitForTimeout(1100)
    const successAfterChip = /Demo booking complete/.test((await text(page, '#modalBody')) || '')
    if (!successAfterChip) {
      await page.click('#payNowBtn')
      await page.waitForTimeout(100)
      afterChipClick.processingOnSubmit = await text(page, '#payNowBtn')
      await page.waitForTimeout(1100)
    }
    const success = await text(page, '#modalBody .pay-success')
    await page.click('#doneBtn')
    await page.waitForTimeout(300)
    return { summary, invalidEmpty, invalidBad, afterChipClick, successAfterChipClickOnly: successAfterChip, success, cartAfterDone: await cartState(page), modalOpen: await page.locator('#modalScrim.open').count() }
  },
  async galleries(page, site) {
    await page.goto(site.home, { waitUntil: 'domcontentloaded' })
    const src = (sel) => page.locator(sel).getAttribute('src').then((s) => decodeURIComponent(s.replace(/^.*\//, '')))
    const course = [await src('#courseGalleryImage')]
    await page.click('#courseGalleryNext'); course.push(await src('#courseGalleryImage'))
    await page.click('#courseGalleryPrev'); await page.click('#courseGalleryPrev'); course.push(await src('#courseGalleryImage'))
    await page.locator('#courseGalleryDots button').nth(1).click(); course.push(await src('#courseGalleryImage'))
    const offline = [await src('#offlineGalleryImage')]
    await page.click('#offlineGalleryNext'); offline.push(await src('#offlineGalleryImage'))
    await page.click('#offlineGalleryPrev'); await page.click('#offlineGalleryPrev'); offline.push(await src('#offlineGalleryImage'))
    await page.locator('#offlineGalleryDots button').nth(1).click(); offline.push(await src('#offlineGalleryImage'))
    await page.waitForTimeout(600)
    const offlineOpacity = await page.locator('#offlineGalleryImage').evaluate((el) => getComputedStyle(el).opacity)
    return { course, offline, offlineOpacity, activeOfflineDot: await page.locator('#offlineGalleryDots .is-active').getAttribute('aria-label') }
  },
  async programsCarousel(page, site, context) {
    await page.goto(site.home, { waitUntil: 'domcontentloaded' })
    await page.locator('#programs').scrollIntoViewIfNeeded()
    const track = page.locator('#programTrack')
    const slides = await page.locator('#programTrack .program-slide h3').allInnerTexts()
    await page.click('#progNext'); await page.waitForTimeout(800)
    const afterNext = await track.evaluate((el) => el.scrollLeft)
    await page.locator('#programDots button').nth(5).click(); await page.waitForTimeout(900)
    const activeDot = await page.locator('#programDots button.is-active').getAttribute('aria-label')
    await page.click('#progPrev'); await page.waitForTimeout(800)
    // Mouse click on the "Read project story" link of the first visible slide
    await track.evaluate((el) => { el.scrollLeft = 0 })
    await page.waitForTimeout(300)
    const popupPromise = context.waitForEvent('page', { timeout: 2500 }).then((p) => p.url()).catch(() => null)
    await page.locator('#programTrack .program-link').first().click()
    const popupUrl = await popupPromise
    // Mouse drag
    const box = await track.boundingBox()
    await page.mouse.move(box.x + 600, box.y + 100); await page.mouse.down(); await page.mouse.move(box.x + 300, box.y + 100, { steps: 8 }); await page.mouse.up()
    await page.waitForTimeout(300)
    return { slides, scrollAfterNext: afterNext > 0, activeDotAfterDot6: activeDot, mouseClickOpensProjectLink: popupUrl, scrolledAfterMouseDrag: (await track.evaluate((el) => el.scrollLeft)) > 0 }
  },
  async traineesAndModal(page, site) {
    await page.goto(site.home, { waitUntil: 'domcontentloaded' })
    await page.locator('#trainees').scrollIntoViewIfNeeded()
    const cards = await page.locator('#traineeTrack .trainee-card').evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()))
    await page.click('#traineeNext'); await page.waitForTimeout(800)
    const selectedAfterNext = await page.locator('#traineeTrack .trainee-card.is-selected h3').innerText()
    await page.locator('#traineeTrack .trainee-card').first().click()
    await page.waitForTimeout(300)
    const modal = {
      open: await page.locator('#modalScrim.open').count() === 1,
      role: await page.locator('#modalBody').getAttribute('role'),
      title: await text(page, '#traineeProfileTitle'),
      focused: await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
      galleryImages: await page.locator('#modalBody .trainee-gallery-frame img').count(),
      links: await page.locator('#modalBody .trainee-profile-links a').allInnerTexts(),
      bodyLocked: await page.evaluate(() => document.body.classList.contains('trainee-modal-open')),
    }
    for (let i = 0; i < 4; i++) await page.keyboard.press('Tab')
    modal.focusStillInModal = await page.evaluate(() => !!document.activeElement?.closest('#modalBody'))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    const afterEscape = { open: await page.locator('#modalScrim.open').count() === 1, focusReturnedTo: await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) }
    await page.locator('#traineeTrack .trainee-card').nth(2).click()
    await page.waitForTimeout(300)
    const demo = { title: await text(page, '#traineeProfileTitle'), type: await text(page, '.trainee-profile-type'), journey: await page.locator('#modalBody .trainee-project-journey').count() }
    await page.locator('#modalScrim').click({ position: { x: 5, y: 5 } })
    demo.closedByBackdrop = !(await page.locator('#modalScrim.open').count())
    return { cards, selectedAfterNext, modal, afterEscape, demo }
  },
  async webinarPage(page, site) {
    await page.goto(site.webinar, { waitUntil: 'domcontentloaded' })
    const info = {
      title: await page.title(),
      meta: await text(page, '.event-meta'),
      countdown: await text(page, '#heroCountdown'),
      reserveLinks: (await page.locator('[data-reserve-webinar]').evaluateAll((els) => els.map((a) => a.textContent.trim()))),
      iframe: await page.locator('.hero-image iframe').getAttribute('src'),
      resources: await page.locator('.resource-card h3').allInnerTexts(),
      stickyAtTop: await page.locator('#stickyBooking.is-visible').count(),
    }
    await page.mouse.wheel(0, 900); await page.waitForTimeout(600)
    info.stickyAfterScroll = await page.locator('#stickyBooking.is-visible').count()
    info.stickyText = await text(page, '#stickyBooking .sticky-label')
    await page.click('#closeStickyBooking'); await page.waitForTimeout(300)
    await page.mouse.wheel(0, 300); await page.waitForTimeout(400)
    info.stickyAfterDismiss = await page.locator('#stickyBooking.is-visible').count()
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.locator('.hero-copy-wrap [data-reserve-webinar]').click()
    await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(800)
    info.afterReserve = { cart: await cartState(page), seats: await text(page, '#seatsLeftText'), webinarInView: await page.locator('#webinar').evaluate((el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0 }) }
    await page.goto(site.webinar)
    await page.locator('.header-return').click(); await page.waitForLoadState('domcontentloaded')
    info.backLinkLandsOnHome = await page.locator('#trainingGrid').count() === 1
    return info
  },
}

;(async () => {
  const browser = await chromium.launch()
  const results = {}
  for (const [name, fn] of Object.entries(tests)) {
    results[name] = {}
    for (const side of ['orig', 'react']) {
      const context = await browser.newContext(name === 'mobileMenu' ? MOBILE : DESKTOP)
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      try {
        results[name][side] = await fn(page, SITES[side], context)
      } catch (error) {
        results[name][side] = { ERROR: error.message.split('\n')[0] }
      }
      if (errors.length) results[name][side].pageErrors = errors
      await context.close()
    }
    const same = JSON.stringify(results[name].orig) === JSON.stringify(results[name].react)
    console.log(`${same ? 'MATCH ' : 'DIFF  '} ${name}`)
    if (!same) console.log(JSON.stringify(results[name], null, 1))
  }
  await browser.close()
  fs.writeFileSync(path.join(OUT, 'functional-results.json'), JSON.stringify(results, null, 2))
})()
