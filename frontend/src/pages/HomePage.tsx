import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { AccountLink } from '../auth/AccountLink'
import accountLinkCss from '../styles/account-link.css?inline'
import homeCss from '../styles/home.css?inline'
import {
  OFFLINE, PROGRAMS, REVIEWS, TRAINEES, TRAININGS, WEBINAR_CART_ART, money,
  type Art, type Currency, type Trainee, type Training,
} from '../data'
import { api, newIdempotencyKey } from '../api/client'
import { calendarDaysInclusive, formatDateRange, formatDayMonth, formatPrice, formatSessionDateTime, formatTime, staticMoney } from '../api/format'
import type { Money, PublicSession } from '../api/types'
import { useAuth } from '../auth/auth-context'
import { PHONE_COUNTRIES, bookingStatusLabel, bookingWhen } from '../bookings/booking-display'
import { requestBookings, suggestedContactName, type CheckoutResult } from '../bookings/checkout'
import { priceFor, useCatalog, type CatalogState } from '../catalog/catalog-context'
import { WebinarBanner } from '../catalog/WebinarBanner'
import { webinar } from '../webinarData'

/* ---------------- Icons (same paths as the original page) ---------------- */
const CheckIconSm = () => <svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
const CartIconSm = () => <svg viewBox="0 0 24 24" fill="none"><path d="M3 4h2l2.4 12.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.6L21 8H6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
const CloseIcon = () => <svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
const ChevronLeft = ({ width = '2' }: { width?: string }) => <svg viewBox="0 0 24 24" fill="none"><path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" /></svg>
const ChevronRight = ({ width = '2' }: { width?: string }) => <svg viewBox="0 0 24 24" fill="none"><path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" /></svg>
const STAR_PATH = 'M10 1l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L10 14.9 4.4 18l1.4-6.2L1 7.5l6.4-.6L10 1z'
const BrandMark = ({ fill, stroke }: { fill: string; stroke: string }) => (
  <svg className="brand-mark" viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="20" fill={fill} /><path d="M20 30V19M20 19C15 19 12 15 12 10C17 10 20 13 20 17C20 13 23 10 28 10C28 15 25 19 20 19Z" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" /></svg>
)
const ArtImage = ({ art }: { art: Art }) => <img src={art.src} alt={art.alt} loading="lazy" decoding="async" />

const NAV_ITEMS = [
  // "How It Works" was removed: it pointed to #how-it-works, a section that never existed (also not in the
  // original site). Re-add it together with a real section once the content is approved.
  ['trainings', 'Trainings'], ['offline', 'Offline Workshop'], ['webinar', 'Webinar'],
  ['trainees', 'Trainees'], ['programs', 'Projects'], ['reviews', 'Reviews'],
] as const

const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/* ---------------- Cart state ---------------- */
/** What the server needs to book this item: the product and exactly one published session or cohort. */
type BookingTarget = { productId: string; sessionId: string } | { productId: string; cohortId: string }
/**
 * `price`/`currency` are the catalog figures shown while browsing; the booking's real price is the
 * server's snapshot. `bookingKey` is the idempotency key for this item, so retrying a checkout after a
 * network failure can never book it twice.
 */
type CartItem = { cartId: string; title: string; price: number; currency: Currency; meta: string; art: Art; booking: BookingTarget; bookingKey: string }
// v2: items carry a real booking target. Demo-cart items from v1 (no target) cannot be booked and are not loaded.
const CART_KEY = 'afforestt_training_cart_v2'
const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isBookingTarget = (value: unknown): value is BookingTarget => {
  if (typeof value !== 'object' || value === null) return false
  const target = value as Record<string, unknown>
  return isString(target.productId) && (isString(target.sessionId) !== isString(target.cohortId))
}
const sameTarget = (a: BookingTarget, b: BookingTarget) => JSON.stringify(a) === JSON.stringify(b)

/* ---------------- Catalog prices ---------------- */
const isCartCurrency = (currency: string): currency is Currency => currency === 'USD' || currency === 'INR'

/**
 * The product's price from the catalog API once loaded; until then (or if the API is
 * unreachable) the site's existing static price, so the layout and figures never break.
 */
function catalogPrice(catalog: CatalogState, slug: string, fallback: Money): Money {
  const price = priceFor(catalog, slug, fallback)
  return isCartCurrency(price.currency) ? price : fallback // the demo cart only supports USD and INR
}

/** The demo cart keeps numbers (it is browser-only); exact strings stay the source for display. */
const cartPrice = (price: Money) => ({ price: Number(price.amount), currency: price.currency as Currency })

function loadCart(): CartItem[] {
  try {
    const raw = localStorage.getItem(CART_KEY)
    const items: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(items)) return []
    return items.filter((item): item is CartItem =>
      typeof item === 'object' && item !== null && isString(item.cartId) && isString(item.title) && typeof item.price === 'number' &&
      (item.currency === 'USD' || item.currency === 'INR') && isBookingTarget(item.booking) && isString(item.bookingKey) &&
      typeof item.art === 'object' && item.art !== null)
  } catch {
    return []
  }
}

/** Sum of listed prices per currency. No tax is calculated in the browser; prices are shown as listed. */
function cartTotals(items: CartItem[]) {
  const totals: { currency: Currency; total: number }[] = []
  items.forEach((item) => {
    let group = totals.find((entry) => entry.currency === item.currency)
    if (!group) {
      group = { currency: item.currency, total: 0 }
      totals.push(group)
    }
    group.total += item.price
  })
  return totals
}

function formatCartTotals(totals: ReturnType<typeof cartTotals>) {
  return totals.map((group) => (totals.length > 1 ? `${group.currency} ${money(group.total, group.currency)}` : money(group.total, group.currency))).join(' · ')
}


type ModalState =
  | { kind: 'training'; training: Training }
  | { kind: 'offline' }
  | { kind: 'checkout' }
  | { kind: 'result'; results: CheckoutResult[] }
  | { kind: 'trainee'; trainee: Trainee; trigger: HTMLElement | null }
  | null

/* ---------------- Sections ---------------- */
function CourseGallery({ images }: { images: Art[] }) {
  const [index, setIndex] = useState(0)
  const show = (next: number) => setIndex((next + images.length) % images.length)
  return (
    <div className="course-gallery" aria-label="In-depth Training images">
      <img id="courseGalleryImage" src={images[index].src} alt={images[index].alt} fetchPriority="high" decoding="async" />
      <div className="course-gallery-controls">
        <button className="course-gallery-arrow" id="courseGalleryPrev" aria-label="Previous image" disabled={images.length < 2} onClick={() => show(index - 1)}><ChevronLeft width="1.8" /></button>
        <div className="course-gallery-dots" id="courseGalleryDots" aria-label="Image pagination">
          {images.map((image, i) => <button key={image.src} className={`course-gallery-dot${i === index ? ' is-active' : ''}`} aria-label={`Show image ${i + 1}`} data-index={i} onClick={() => show(i)} />)}
        </div>
        <button className="course-gallery-arrow" id="courseGalleryNext" aria-label="Next image" disabled={images.length < 2} onClick={() => show(index + 1)}><ChevronRight width="1.8" /></button>
      </div>
    </div>
  )
}

function OfflineGallery() {
  const images = OFFLINE.images
  const [index, setIndex] = useState(0)
  const [visible, setVisible] = useState(true)
  const imageRef = useRef<HTMLImageElement>(null)
  const swipeStart = useRef<number | null>(null)
  const show = (next: number) => {
    setVisible(false)
    setIndex((next + images.length) % images.length)
  }
  useLayoutEffect(() => {
    if (imageRef.current?.complete) setVisible(true)
  }, [index])
  return (
    <div
      className="offline-art"
      id="offlineArt"
      onTouchStart={(event) => { swipeStart.current = event.changedTouches[0].clientX }}
      onTouchEnd={(event) => {
        if (swipeStart.current === null) return
        const delta = event.changedTouches[0].clientX - swipeStart.current
        if (Math.abs(delta) > 40) show(index + (delta < 0 ? 1 : -1))
        swipeStart.current = null
      }}
    >
      <img ref={imageRef} id="offlineGalleryImage" src={images[index].src} alt={images[index].alt} decoding="async" style={{ opacity: visible ? 1 : 0 }} onLoad={() => setVisible(true)} onError={() => setVisible(true)} />
      <button className="offline-gallery-arrow prev" id="offlineGalleryPrev" type="button" aria-label="Previous workshop image" onClick={() => show(index - 1)}>←</button>
      <button className="offline-gallery-arrow next" id="offlineGalleryNext" type="button" aria-label="Next workshop image" onClick={() => show(index + 1)}>→</button>
      <div className="offline-gallery-dots" id="offlineGalleryDots" role="group" aria-label="Choose a workshop image">
        {images.map((image, i) => <button key={image.src} className={`offline-gallery-dot${i === index ? ' is-active' : ''}`} type="button" aria-label={`Show workshop image ${i + 1}`} aria-current={i === index ? 'true' : 'false'} data-index={i} onClick={() => show(i)} />)}
      </div>
    </div>
  )
}

/** Mouse drag-to-scroll used by the original carousels. */
function useDragScroll(ref: RefObject<HTMLDivElement | null>, options: { ignoreTouch: boolean; threshold: number }) {
  useEffect(() => {
    const track = ref.current
    if (!track) return
    let isDown = false
    let isDragging = false
    let startX = 0
    let scrollStart = 0
    const down = (event: PointerEvent) => {
      if (options.ignoreTouch && event.pointerType === 'touch') return
      isDown = true
      isDragging = false
      startX = event.clientX
      scrollStart = track.scrollLeft
      if (options.threshold === 0) {
        isDragging = true
        track.classList.add('dragging')
        track.setPointerCapture(event.pointerId)
      }
    }
    const move = (event: PointerEvent) => {
      if (!isDown) return
      if (!isDragging && Math.abs(event.clientX - startX) > options.threshold) {
        isDragging = true
        track.classList.add('dragging')
        track.setPointerCapture(event.pointerId)
      }
      if (isDragging) track.scrollLeft = scrollStart - (event.clientX - startX)
    }
    const up = () => {
      isDown = false
      isDragging = false
      track.classList.remove('dragging')
    }
    track.addEventListener('pointerdown', down)
    track.addEventListener('pointermove', move)
    const ends = ['pointerup', 'pointerleave', 'pointercancel'] as const
    ends.forEach((name) => track.addEventListener(name, up))
    return () => {
      track.removeEventListener('pointerdown', down)
      track.removeEventListener('pointermove', move)
      ends.forEach((name) => track.removeEventListener(name, up))
    }
  }, [ref, options.ignoreTouch, options.threshold])
}

function ProgramsCarousel() {
  const track = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  // The original captures the pointer immediately on pointerdown. That
  // retargets clicks to the track, so links inside slides never open with a
  // mouse. A small threshold keeps drag-to-scroll and leaves links working.
  useDragScroll(track, { ignoreTouch: false, threshold: 5 })
  const updateDots = () => window.requestAnimationFrame(() => {
    const element = track.current
    if (!element) return
    const center = element.scrollLeft + element.clientWidth / 2
    let closest = 0
    let closestDist = Infinity
    Array.from(element.children).forEach((child, i) => {
      const slide = child as HTMLElement
      const dist = Math.abs(slide.offsetLeft + slide.offsetWidth / 2 - center)
      if (dist < closestDist) { closestDist = dist; closest = i }
    })
    setActive(closest)
  })
  return (
    <div className="carousel-shell">
      <div className="carousel-track overflow-x" id="programTrack" ref={track} onScroll={updateDots}>
        {PROGRAMS.map((program) => (
          <div className="program-slide" key={program.title}>
            <div className="program-art"><a href={program.url} target="_blank" rel="noopener noreferrer"><ArtImage art={{ src: program.image, alt: program.imageAlt }} /></a></div>
            <div className="program-body"><span className="loc">{program.loc.toUpperCase()}</span><h3>{program.title}</h3><p>{program.desc}</p><a className="program-link" href={program.url} target="_blank" rel="noopener noreferrer">Read project story</a></div>
          </div>
        ))}
      </div>
      <div className="carousel-controls">
        <div className="carousel-dots" id="programDots">
          {PROGRAMS.map((program, i) => <button key={program.title} className={i === active ? 'is-active' : ''} aria-label={`Go to slide ${i + 1}`} onClick={() => {
            const slide = track.current?.children[i] as HTMLElement | undefined
            if (slide) track.current?.scrollTo({ left: slide.offsetLeft - 4, behavior: 'smooth' })
          }} />)}
        </div>
        <div className="carousel-nav">
          <button id="progPrev" aria-label="Previous" onClick={() => track.current?.scrollBy({ left: -340, behavior: 'smooth' })}><ChevronLeft /></button>
          <button id="progNext" aria-label="Next" onClick={() => track.current?.scrollBy({ left: 340, behavior: 'smooth' })}><ChevronRight /></button>
        </div>
      </div>
    </div>
  )
}

function TraineesCarousel({ onOpen }: { onOpen: (trainee: Trainee, trigger: HTMLElement) => void }) {
  const track = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState(0)
  const [activeDot, setActiveDot] = useState(0)
  const [dotsTouched, setDotsTouched] = useState(false)
  useDragScroll(track, { ignoreTouch: true, threshold: 5 })

  const nearestIndex = () => {
    const element = track.current
    if (!element) return 0
    let closest = 0
    let distance = Infinity
    Array.from(element.children).forEach((child, i) => {
      const current = Math.abs((child as HTMLElement).offsetLeft - element.offsetLeft - element.scrollLeft)
      if (current < distance) { distance = current; closest = i }
    })
    return closest
  }
  const updateDots = (index: number) => {
    setDotsTouched(true)
    setActiveDot(index)
  }
  const scrollToTrainee = (index: number) => {
    const element = track.current
    const card = element?.children[index] as HTMLElement | undefined
    if (!element || !card) return
    element.scrollTo({ left: card.offsetLeft - element.offsetLeft, behavior: reduceMotion ? 'auto' : 'smooth' })
    setSelected(index)
    updateDots(index)
  }

  return (
    <div className="carousel-shell">
      <div className="trainee-track" id="traineeTrack" aria-label="Trainee profiles" ref={track} onScroll={() => window.requestAnimationFrame(() => updateDots(nearestIndex()))}>
        {TRAINEES.map((trainee, i) => {
          const location = trainee.project || (trainee.city ? trainee.city + (trainee.country ? `, ${trainee.country}` : '') : '')
          return (
            <button key={trainee.name} type="button" className={`trainee-card${i === selected ? ' is-selected' : ''}`} aria-pressed={i === selected ? 'true' : 'false'} aria-label={`View profile: ${trainee.name}`} onClick={(event) => {
              const card = event.currentTarget
              setSelected(i)
              card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' })
              updateDots(i)
              onOpen(trainee, card)
            }}>
              <div className="trainee-photo">
                <img src={trainee.image} alt={trainee.imageAlt || `Sample profile photo for ${trainee.name}`} loading="lazy" />
                {trainee.demo ? <span className="demo-label">DEMO PROFILE · SAMPLE PHOTO</span> : null}
              </div>
              <div className="trainee-body"><h3>{trainee.name}</h3><p className="trainee-location">{location}</p><p className="trainee-role">{trainee.type || trainee.role}</p></div>
            </button>
          )
        })}
      </div>
      <div className="carousel-controls trainee-controls">
        <div className="carousel-dots" id="traineeDots" aria-label="Choose a trainee">
          {TRAINEES.map((trainee, i) => <button key={trainee.name} type="button" className={i === activeDot ? 'is-active' : ''} aria-label={`Show demo trainee ${i + 1}`} aria-current={dotsTouched ? (i === activeDot ? 'true' : 'false') : undefined} onClick={() => scrollToTrainee(i)} />)}
        </div>
        <div className="carousel-nav">
          <button className="trainee-nav-btn" id="traineePrev" aria-label="Previous trainee" onClick={() => scrollToTrainee(Math.max(0, nearestIndex() - 1))}><ChevronLeft /><span>Previous</span></button>
          <button className="trainee-nav-btn" id="traineeNext" aria-label="Next trainee" onClick={() => scrollToTrainee(Math.min(TRAINEES.length - 1, nearestIndex() + 1))}><span>Next</span><ChevronRight /></button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- Modal bodies ---------------- */
/**
 * Date picker modal. The chips are real published dates from the catalog API (Stage 4B); while they
 * load, if none are scheduled, or if the API is unreachable, the grid is replaced by a short message.
 */
export function DateChipModal({ heading, art, intro, chips, availability, chipLabel, emptyLabel, noneText, addLabel, detail, onRetry, onClose, onAdd, children }: {
  heading: string
  art: Art
  intro: ReactNode
  /** `soldOut` comes from the server's seatsAvailable; the booking request re-checks it. */
  chips: { key: string; label: string; small: string; soldOut?: boolean }[]
  availability: 'loading' | 'ready' | 'error'
  chipLabel: string
  emptyLabel: string
  noneText: string
  addLabel: string
  detail?: (index: number) => ReactNode
  onRetry: () => void
  onClose: () => void
  onAdd: (index: number) => void
  children?: ReactNode
}) {
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const message = availability === 'loading' ? 'Loading dates…' : availability === 'error' ? 'We couldn’t load the dates.' : chips.length === 0 ? noneText : null
  return (
    <>
      <button className="icon-btn close-x" aria-label="Close" onClick={onClose}><CloseIcon /></button>
      <div style={{ borderRadius: 14, overflow: 'hidden', marginBottom: 16 }}><ArtImage art={art} /></div>
      <h3>{heading}</h3>{intro}
      {children}
      <p style={{ fontSize: '.82rem', fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>{chipLabel}</p>
      {message ? (
        <p style={{ fontSize: '.88rem', margin: '10px 0 18px' }} role={availability === 'error' ? 'alert' : 'status'}>
          {message}{availability === 'error' ? <> <button type="button" className="remove-link" onClick={onRetry}>Try again</button></> : null}
        </p>
      ) : (
        <div className="date-chip-grid">
          {chips.map((chip, i) => <button key={chip.key} className={`chip-date${selectedIdx === i ? ' is-selected' : ''}`} data-idx={i} disabled={chip.soldOut} onClick={() => setSelectedIdx(i)}>{chip.label}<small>{chip.soldOut ? 'Fully booked' : chip.small}</small></button>)}
        </div>
      )}
      {selectedIdx !== null && detail ? <p style={{ fontSize: '.85rem', margin: '-8px 0 14px' }}>{detail(selectedIdx)}</p> : null}
      <button className="btn btn-primary btn-block" disabled={selectedIdx === null} onClick={() => { if (selectedIdx !== null) onAdd(selectedIdx) }}>
        {selectedIdx === null ? (message ? 'No dates available yet' : emptyLabel) : <><CartIconSm /> {addLabel}</>}
      </button>
    </>
  )
}

function TraineeGallery({ id, title, description, images, traineeName }: { id: string; title: string; description: string; images: string[]; traineeName: string }) {
  const [index, setIndex] = useState(0)
  const touchStart = useRef<number | null>(null)
  const show = (next: number) => setIndex((next + images.length) % images.length)
  const alt = index === 0 ? `${title} image 1` : `${traineeName} — ${title.toLowerCase()} image ${index + 1}`
  return (
    <section className="trainee-gallery-section" aria-labelledby={`${id}Heading`}>
      <h4 id={`${id}Heading`}>{title}</h4><p>{description}</p>
      <div
        className="trainee-gallery-frame" id={`${id}Frame`} data-gallery-frame={id}
        onPointerDown={(event) => {
          if (images.length < 2 || event.pointerType !== 'touch') return
          touchStart.current = event.clientX
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerUp={(event) => {
          if (touchStart.current === null) return
          const distance = event.clientX - touchStart.current
          touchStart.current = null
          if (Math.abs(distance) > 45) show(index + (distance < 0 ? 1 : -1))
        }}
        onPointerCancel={() => { touchStart.current = null }}
      >
        <img src={images[index]} alt={alt} decoding="async" />
      </div>
      {images.length > 1 ? (
        <div className="trainee-gallery-controls">
          <button className="trainee-gallery-arrow" type="button" aria-label="Previous image" onClick={() => show(index - 1)}><ChevronLeft width="1.8" /></button>
          <div className="trainee-gallery-pagination">
            <span className="trainee-gallery-count" aria-live="polite">{index + 1} / {images.length}</span>
            <div className="trainee-gallery-dots" role="group" aria-label={`${title} images`}>
              {images.map((image, i) => <button key={image} className={`trainee-gallery-dot${i === index ? ' is-active' : ''}`} type="button" aria-label={`Show ${title} image ${i + 1}`} aria-current={i === index ? 'true' : 'false'} onClick={() => show(i)} />)}
            </div>
          </div>
          <button className="trainee-gallery-arrow" type="button" aria-label="Next image" onClick={() => show(index + 1)}><ChevronRight width="1.8" /></button>
        </div>
      ) : <div className="trainee-gallery-controls" hidden />}
    </section>
  )
}

function TraineeProfile({ trainee, onClose }: { trainee: Trainee; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { closeRef.current?.focus() }, [])
  const staticImagePair = trainee.name === 'Tancy Arron-Walker'
  const beforeImages = (staticImagePair ? trainee.beforePlantingImages?.slice(0, 1) : trainee.beforePlantingImages) ?? []
  const afterImages = (staticImagePair ? trainee.afterPlantingImages?.slice(0, 1) : trainee.afterPlantingImages) ?? []
  return (
    <>
      <button ref={closeRef} className="icon-btn close-x" id="traineeProfileClose" type="button" aria-label="Close trainee profile" onClick={onClose}><CloseIcon /></button>
      <header className="trainee-profile-head">
        <img className="trainee-profile-photo" src={trainee.image} alt={trainee.imageAlt || trainee.name} decoding="async" />
        <div className="trainee-profile-heading">
          <h2 id="traineeProfileTitle">{trainee.name}</h2>
          <p className="trainee-profile-type">{trainee.type || trainee.role}</p>
          {trainee.project ? <p className="trainee-profile-project"><strong>{trainee.projectLabel || 'Project'}:</strong> {trainee.project}</p> : null}
        </div>
      </header>
      {trainee.projectIntro ? <section className="trainee-project-intro"><h3>About the Project</h3><p>{trainee.projectIntro}</p></section> : null}
      {beforeImages.length || afterImages.length ? (
        <section className="trainee-project-journey" aria-labelledby="traineeJourneyHeading">
          <h3 id="traineeJourneyHeading">Project Journey</h3>
          <div className={`trainee-project-galleries${staticImagePair ? ' static-pair' : ''}`}>
            {beforeImages.length ? <TraineeGallery id="traineeBefore" title="Before Planting" description="See the site before the planting work began." images={beforeImages} traineeName={trainee.name} /> : null}
            {afterImages.length ? <TraineeGallery id="traineeAfter" title="After Planting" description="See how the site developed after planting." images={afterImages} traineeName={trainee.name} /> : null}
          </div>
        </section>
      ) : null}
      {trainee.links?.length ? (
        <nav className="trainee-profile-links" aria-label="Trainee links">
          {trainee.links.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">{link.label} &rarr;</a>)}
        </nav>
      ) : null}
    </>
  )
}

/* ---------------- Checkout (Stage 4C: real booking requests, no payment) ---------------- */
const SIGN_IN_RETURN = '/#trainings'

/**
 * Sends one booking request per cart item, each with its own idempotency key, and reports exactly what
 * the server answered. Nothing is shown as booked unless the server returned the booking.
 */
export function CheckoutPanel({ cart, onClose, onDone, onRotateKey }: {
  cart: CartItem[]
  onClose: () => void
  /** Called with every result once all requests have finished (booked items leave the cart). */
  onDone: (results: CheckoutResult[]) => void
  /** The server said this key was used for a different booking: the item needs a fresh key. */
  onRotateKey: (cartId: string) => void
}) {
  const auth = useAuth()
  const [processing, setProcessing] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [country, setCountry] = useState<string>('IN')
  const sending = useRef(false)
  const totals = cartTotals(cart)

  const summary = (
    <>
      <button className="icon-btn close-x" id="modalCloseBtn" aria-label="Close" onClick={onClose}><CloseIcon /></button>
      <h3>Order summary</h3><p style={{ marginBottom: 6 }}>Review your booking request.</p>
      {cart.map((item) => <div className="order-line" key={item.cartId}><span>{item.title}<small>{item.meta}</small></span><span>{money(item.price, item.currency)}</span></div>)}
      <div className="order-total"><span>Total</span><span>{formatCartTotals(totals)}</span></div>
    </>
  )
  const footnote = <p style={{ fontSize: '.76rem', textAlign: 'center', margin: '12px 0 0' }}>No payment is taken now. Each booking request holds your seat while our team confirms it; we aim to contact you by phone within 24 hours. Bookings close 24 hours before the start.</p>

  if (auth.status === 'loading') return <>{summary}<p role="status" style={{ marginTop: 16 }}>Checking your sign-in…</p></>
  if (auth.status === 'unavailable' || auth.status === 'error') {
    return (
      <>{summary}
        <p className="checkout-error" role="alert">{auth.status === 'unavailable' ? 'Booking isn’t available at the moment because sign-in is unavailable.' : 'We couldn’t reach the server.'}</p>
        <button className="btn btn-primary btn-block" style={{ marginTop: 18 }} type="button" onClick={auth.refresh}>Try again</button>
      </>
    )
  }
  if (auth.status === 'signed-out' || !auth.me) {
    return (
      <>{summary}
        <p style={{ marginTop: 16 }} role={auth.expired ? 'alert' : undefined}>{auth.expired ? 'Your session has expired. ' : ''}Please sign in or create an account to book. Your cart is kept.</p>
        <a className="btn btn-primary btn-block" style={{ marginTop: 12 }} href={api.signInUrl(SIGN_IN_RETURN)}>Sign in to book</a>
        <a className="btn btn-outline btn-block" style={{ marginTop: 10 }} href={api.registerUrl(SIGN_IN_RETURN)}>Create an account</a>
        {footnote}
      </>
    )
  }
  const { user, session, csrfToken } = auth.me
  if (session.kind !== 'CUSTOMER' || user.role !== 'CUSTOMER') {
    return <>{summary}<p className="checkout-error" role="alert">You’re signed in with a staff account. Bookings are made with a customer account.</p></>
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (sending.current) return // one submission at a time
    const form = event.currentTarget.elements
    const contactName = (form.namedItem('name') as HTMLInputElement).value.trim()
    const number = (form.namedItem('phone') as HTMLInputElement).value
    sending.current = true
    setProcessing(true)
    setFieldError(null)
    try {
      const outcome = await requestBookings(api, csrfToken, cart, { contactName, phone: { country, number } })
      if (outcome.kind === 'expired') return auth.sessionExpired()
      if (outcome.kind === 'field-error') return setFieldError(outcome.message)
      outcome.rotateKeys.forEach(onRotateKey)
      onDone(outcome.results)
    } finally {
      sending.current = false
      setProcessing(false)
    }
  }

  return (
    <>{summary}
      <form id="checkoutForm" onSubmit={submit}>
        <div className="checkout-fields">
          <label htmlFor="checkoutName">Full name<input id="checkoutName" name="name" autoComplete="name" required maxLength={100} defaultValue={suggestedContactName(user.displayName)} /></label>
          <label htmlFor="checkoutEmail">Email address<input id="checkoutEmail" name="email" type="email" value={user.email} readOnly aria-describedby="checkoutEmailNote" /></label>
          <small id="checkoutEmailNote" style={{ marginTop: -6, color: 'var(--ink-soft)', fontSize: '.74rem' }}>From your account.</small>
          <div className="checkout-phone">
            <label htmlFor="checkoutCountry">Country<select id="checkoutCountry" name="country" value={country} autoComplete="tel-country-code" onChange={(event) => setCountry(event.target.value)}>
              {PHONE_COUNTRIES.map((option) => <option key={option.code} value={option.code}>{option.label} (+{option.dial})</option>)}
            </select></label>
            <label htmlFor="checkoutPhone">Phone number<input id="checkoutPhone" name="phone" type="tel" autoComplete="tel-national" inputMode="tel" required maxLength={20} pattern="[0-9+\(\) .\-]{4,20}" title="Digits, spaces and + ( ) - only" /></label>
          </div>
        </div>
        {fieldError ? <p className="checkout-error" role="alert">{fieldError}</p> : null}
        <button className="btn btn-primary btn-block" style={{ marginTop: 18 }} id="payNowBtn" type="submit" disabled={processing || cart.length === 0}>{processing ? 'Sending your booking…' : `Request booking${cart.length > 1 ? 's' : ''}`}</button>
      </form>
      {footnote}
    </>
  )
}

/** What the server answered for each item. A successful booking is pending payment, never "paid". */
export function CheckoutResults({ results, onClose }: { results: CheckoutResult[]; onClose: () => void }) {
  const booked = results.filter((result) => result.ok)
  const failed = results.filter((result) => !result.ok)
  return (
    <>
      <button className="icon-btn close-x" id="modalCloseBtn2" aria-label="Close" onClick={onClose}><CloseIcon /></button>
      <div className="pay-success">
        {booked.length ? <svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="var(--forest)" /><path d="M20 33l8 8 16-18" stroke="var(--on-forest)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /></svg> : null}
        <h3>{booked.length === 0 ? 'Booking not completed' : failed.length ? 'Some bookings were received' : `Booking${booked.length > 1 ? 's' : ''} received: ${booked.every((result) => result.ok && result.booking.status === 'PENDING_PAYMENT') ? 'payment pending' : 'awaiting confirmation'}`}</h3>
        {booked.length ? <p>Your seat is held while our team confirms your booking. <strong>No payment has been taken</strong> through this website. Our team aims to contact you by phone within 24 hours; if we cannot confirm in time, the request is released automatically.</p> : null}
        <ul className="booking-results">
          {results.map((result) => result.ok ? (
            <li key={result.cartId}>
              <strong>{result.booking.product.name}</strong> · {result.booking.reference}
              <small>{bookingWhen(result.booking.target)}</small>
              <small>{bookingStatusLabel(result.booking)} · {formatPrice(result.booking.price)}</small>
            </li>
          ) : (
            <li key={result.cartId} className="is-failed" role="alert">
              <strong>{result.title}: not booked</strong>
              <small>{result.message}</small>
            </li>
          ))}
        </ul>
        {booked.length ? <a className="btn btn-primary btn-block" id="doneBtn" href="/account">View my bookings</a> : null}
        {failed.length ? <p style={{ fontSize: '.8rem', marginTop: 10 }}>Items that weren’t booked are still in your cart.</p> : null}
        <button className={`btn ${booked.length ? 'btn-outline' : 'btn-primary'} btn-block`} style={{ marginTop: 10 }} type="button" onClick={onClose}>Close</button>
      </div>
    </>
  )
}

/* ---------------- Page ---------------- */

export default function HomePage() {
  const [cart, setCart] = useState<CartItem[]>(loadCart)
  const [cartOpen, setCartOpen] = useState(false)
  const [cartBump, setCartBump] = useState(0)
  const [modal, setModal] = useState<ModalState>(null)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [activeSection, setActiveSection] = useState('')
  const [showTop, setShowTop] = useState(false)
  const [toast, setToast] = useState({ text: 'Added to cart', show: false })
  const catalog = useCatalog()
  const toastTimer = useRef<number | undefined>(undefined)
  const modalBodyRef = useRef<HTMLDivElement>(null)
  const cartBtnRef = useRef<HTMLButtonElement>(null)
  const reserveHandled = useRef(false)

  useEffect(() => { document.title = 'DIY Forests — Trainings' }, [])

  useEffect(() => {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)) } catch { /* storage unavailable */ }
  }, [cart])

  // Restart the cart bump animation on every add (the original toggles the class and forces reflow).
  useLayoutEffect(() => {
    const button = cartBtnRef.current
    if (!button || cartBump === 0) return
    button.classList.remove('bump')
    void button.offsetWidth
    button.classList.add('bump')
  }, [cartBump])

  const showToast = useCallback((text: string) => {
    setToast({ text, show: true })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast((current) => ({ ...current, show: false })), 2600)
  }, [])

  const addToCart = useCallback((item: Omit<CartItem, 'cartId' | 'bookingKey'>) => {
    // One seat per customer per date: the same dates can only be in the cart once.
    if (cart.some((entry) => sameTarget(entry.booking, item.booking))) {
      showToast(`“${item.title}” is already in your cart`)
      setCartOpen(true)
      return
    }
    setCart((current) => [...current, { ...item, cartId: `c${Date.now()}${Math.random().toString(16).slice(2)}`, bookingKey: newIdempotencyKey() }])
    setCartBump((count) => count + 1)
    showToast(`Added “${item.title}” to cart`)
    setCartOpen(true)
  }, [cart, showToast])

  const closeModal = useCallback(() => {
    setModal((current) => {
      if (current?.kind === 'trainee') {
        const trigger = current.trigger
        window.setTimeout(() => { if (trigger && document.contains(trigger)) trigger.focus() })
      }
      return null
    })
  }, [])

  // Adds the published session to the cart. A seat is reserved only when checkout succeeds on the server.
  const reserveWebinar = useCallback((session: PublicSession) => {
    const price = isCartCurrency(session.product.price.currency) ? session.product.price : staticMoney(webinar.price, 'INR')
    addToCart({ title: session.product.name, ...cartPrice(price), meta: formatSessionDateTime(session.startsAt), art: WEBINAR_CART_ART, booking: { productId: session.product.id, sessionId: session.id } })
  }, [addToCart])

  // ?reserve=webinar (from the webinar page) adds the webinar on arrival, like the original,
  // but only once the catalog confirms a published upcoming session exists.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (reserveHandled.current || params.get('reserve') !== 'webinar' || catalog.status === 'loading') return
    reserveHandled.current = true
    // One-time sync with external inputs (the URL and the network result), guarded by reserveHandled.
    // oxlint-disable-next-line react/set-state-in-effect
    if (catalog.status === 'ready' && catalog.nextWebinar && catalog.nextWebinar.seatsAvailable !== 0) reserveWebinar(catalog.nextWebinar)
    // Drop the query so a refresh doesn't add it a second time.
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`)
  }, [catalog.status, catalog.nextWebinar, reserveWebinar])

  // The static page scrolls to its #hash natively; React content mounts later, so do it here.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView()
  }, [])

  // Scrollspy
  useEffect(() => {
    if (!('IntersectionObserver' in window)) return
    const spy = new IntersectionObserver((entries) => {
      entries.forEach((entry) => { if (entry.isIntersecting) setActiveSection(entry.target.id) })
    }, { rootMargin: '-40% 0px -50% 0px', threshold: 0 })
    ;['trainings', 'offline', 'webinar', 'trainees', 'programs', 'reviews'].forEach((id) => {
      const section = document.getElementById(id)
      if (section) spy.observe(section)
    })
    return () => spy.disconnect()
  }, [])

  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 700)
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Trainee profile: body scroll lock, Escape to close, Tab focus trap.
  const traineeOpen = modal?.kind === 'trainee'
  useEffect(() => {
    if (!traineeOpen) return
    document.body.classList.add('trainee-modal-open')
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeModal()
        return
      }
      if (event.key !== 'Tab' || !modalBodyRef.current) return
      const focusable = modalBodyRef.current.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.classList.remove('trainee-modal-open')
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [traineeOpen, closeModal])

  const totals = cartTotals(cart)
  const indepth = TRAININGS.find((training) => training.id === 'indepth')!
  const onlinePrice = catalogPrice(catalog, 'online-training', staticMoney(indepth.price, indepth.currency ?? 'INR'))
  const offlinePrice = catalogPrice(catalog, 'offline-workshop', staticMoney(OFFLINE.price, 'INR'))
  const webinarPrice = catalogPrice(catalog, 'monthly-webinar', staticMoney(webinar.price, 'INR'))
  // Online Training is the only training offered; its price comes from the API when available.
  const trainingPrice = (t: Training) => (t.id === indepth.id ? onlinePrice : staticMoney(t.price, t.currency ?? 'INR'))
  const closeCart = () => setCartOpen(false)

  const renderModal = () => {
    if (!modal) return null
    if (modal.kind === 'training') {
      const t = modal.training
      // Real published cohorts: two 4-hour sessions on consecutive Fridays, shown in the visitor's zone.
      const cohorts = catalog.trainingCohorts
      const fridays = (index: number) => `${formatDayMonth(cohorts[index]!.sessions[0]!.startsAt)} & ${formatDayMonth(cohorts[index]!.sessions[1]!.startsAt)}`
      return (
        <DateChipModal
          heading={t.title}
          art={{ src: t.image, alt: t.imageAlt }}
          intro={<><p>{t.tagline}</p><p style={{ fontSize: '.85rem' }}><strong>Suitable for:</strong> {t.audience}</p></>}
          chips={cohorts.map((cohort) => ({ key: cohort.id, label: formatDayMonth(cohort.sessions[0]!.startsAt), small: `& ${formatDayMonth(cohort.sessions[1]!.startsAt)} · ${formatTime(cohort.sessions[0]!.startsAt)}`, soldOut: cohort.seatsAvailable === 0 }))}
          availability={catalog.status}
          chipLabel="Choose your two Friday evening sessions"
          emptyLabel="Select dates to continue"
          noneText="New Friday dates will be announced soon."
          addLabel={`Add to cart — ${formatPrice(trainingPrice(t))}`}
          detail={(index) => <>Two 4-hour sessions: {fridays(index)}, {formatTime(cohorts[index]!.sessions[0]!.startsAt)}–{formatTime(cohorts[index]!.sessions[0]!.endsAt)} (your time).</>}
          onRetry={catalog.retry}
          onClose={closeModal}
          onAdd={(index) => {
            const cohort = cohorts[index]!
            addToCart({ title: t.title, ...cartPrice(trainingPrice(t)), meta: `${t.duration} · ${fridays(index)} · ${formatTime(cohort.sessions[0]!.startsAt)}`, art: { src: t.image, alt: t.imageAlt }, booking: { productId: cohort.product.id, cohortId: cohort.id } })
            closeModal()
          }}
        >
          <p style={{ fontSize: '.82rem', fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>What you&rsquo;ll learn</p>
          <ul className="includes-list" style={{ marginBottom: 16 }}>{t.learn.map((item) => <li key={item}><CheckIconSm /><span>{item}</span></li>)}</ul>
          <p style={{ fontSize: '.82rem', fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>What&rsquo;s included</p>
          <ul className="includes-list" style={{ marginBottom: 18 }}>{t.includes.map((item) => <li key={item}><CheckIconSm /><span>{item}</span></li>)}</ul>
        </DateChipModal>
      )
    }
    if (modal.kind === 'offline') {
      // Real published batches with their venue and start/end dates.
      const batches = catalog.workshopBatches
      const range = (index: number) => formatDateRange(batches[index]!.startsAt, batches[index]!.endsAt ?? batches[index]!.startsAt)
      return (
        <DateChipModal
          heading="Offline Workshop"
          art={{ src: OFFLINE.image, alt: OFFLINE.imageAlt }}
          intro={<p>Pick the 5-day batch that works for you. Food and accommodation are included.</p>}
          chips={batches.map((batch, index) => ({ key: batch.id, label: range(index), small: `${calendarDaysInclusive(batch.startsAt, batch.endsAt ?? batch.startsAt)} days`, soldOut: batch.seatsAvailable === 0 }))}
          availability={catalog.status}
          chipLabel="Choose your batch"
          emptyLabel="Select a batch to continue"
          noneText="New workshop batches will be announced soon."
          addLabel={`Add to cart — ${formatPrice(offlinePrice)}`}
          detail={(index) => <>Venue: {batches[index]!.venue ?? 'to be confirmed'}</>}
          onRetry={catalog.retry}
          onClose={closeModal}
          onAdd={(index) => {
            const batch = batches[index]!
            addToCart({ title: 'Offline Workshop', ...cartPrice(offlinePrice), meta: `${range(index)} · ${batch.venue ?? 'in person'}`, art: { src: OFFLINE.image, alt: OFFLINE.imageAlt }, booking: { productId: batch.product.id, sessionId: batch.id } })
            closeModal()
          }}
        />
      )
    }
    if (modal.kind === 'checkout') {
      return (
        <CheckoutPanel
          cart={cart}
          onClose={closeModal}
          onRotateKey={(cartId) => setCart((current) => current.map((item) => (item.cartId === cartId ? { ...item, bookingKey: newIdempotencyKey() } : item)))}
          onDone={(results) => {
            // Only items the server actually booked leave the cart; failed ones stay (same key) for a safe retry.
            const booked = new Set(results.filter((result) => result.ok).map((result) => result.cartId))
            setCart((current) => current.filter((item) => !booked.has(item.cartId)))
            setModal({ kind: 'result', results })
          }}
        />
      )
    }
    if (modal.kind === 'result') {
      return <CheckoutResults results={modal.results} onClose={() => { closeModal(); if (cart.length === 0) closeCart() }} />
    }
    return <TraineeProfile trainee={modal.trainee} onClose={closeModal} />
  }

  return (
    <>
      <style>{homeCss}</style>
      <style>{accountLinkCss}</style>
      <header className="site">
        <div className="wrap nav-row">
          <a href="#top" className="brand"><BrandMark fill="var(--forest)" stroke="var(--on-forest)" /><span>DIY Forests</span></a>
          <nav className="nav-links" id="navLinks">
            {NAV_ITEMS.map(([id, label]) => <a key={id} href={`#${id}`} data-section={id} className={activeSection === id ? 'active' : undefined}>{label}</a>)}
          </nav>
          <div className="nav-right">
            <AccountLink />
            <button ref={cartBtnRef} className="icon-toggle cart-btn" id="cartOpenBtn" aria-label="Open cart" style={{ width: 'auto', padding: '0 14px 0 12px', borderRadius: 22, gap: 6 }} onClick={() => setCartOpen(true)}>
              <svg viewBox="0 0 24 24" fill="none" width="19" height="19" style={{ position: 'static' }}><path d="M3 4h2l2.4 12.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.6L21 8H6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><circle cx="9" cy="20" r="1.4" fill="currentColor" /><circle cx="17" cy="20" r="1.4" fill="currentColor" /></svg>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Cart</span>
              <span className="cart-badge" id="cartBadge" style={{ display: cart.length ? 'flex' : 'none', position: 'static', marginLeft: 2 }}>{cart.length}</span>
            </button>
            <button className="hamburger" id="hamburgerBtn" aria-label="Menu" onClick={() => setMobileMenuOpen((open) => !open)}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            </button>
          </div>
        </div>
        <div className={`mobile-menu${mobileMenuOpen ? ' open' : ''}`} id="mobileMenu">
          {NAV_ITEMS.map(([id, label]) => <a key={id} href={`#${id}`} onClick={() => setMobileMenuOpen(false)}>{label}</a>)}
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="wrap">
            <div className="hero-copy">
              <h1>Learn to Grow a Forest</h1>
              <p>Imagine a dense, thriving forest growing in your backyard, on a city plot, or even a patch of barren land.</p>
              <p>Learn how with Shubhendu Sharma, the eco-entrepreneur who has helped grow hundreds of tiny, fast-growing forests around the world.</p>
              <p>Master the method that grows native forests 10x faster and 30x denser, even in your backyard.</p>
              <p className="hero-close">Enroll now and start planting your own forest!</p>
              <div className="hero-cta">
                <a href="#trainings" className="btn btn-primary">See trainings</a>
                <a href="#webinar" className="btn btn-outline">This month&apos;s webinar — {formatPrice(webinarPrice)}</a>
              </div>
            </div>
            <div className="hero-art">
              <img src="/webphoto1.jpeg" alt="Native forest restoration project in the Lesser Caucasus, Armenia" fetchPriority="high" decoding="async" />
            </div>
          </div>
        </section>

        <section className="founder-story" id="about-shubhendu" aria-labelledby="shubhendu-heading">
          <div className="wrap founder-grid">
            <div className="founder-media">
              <div className="founder-photo">
                <img src="/4c2a0a97a31a1e8bc7a05a2ee1835eaa636730e5_2400x1800-1024x768.webp" alt="Shubhendu Sharma, founder of Afforestt" loading="lazy" decoding="async" />
              </div>
            </div>
            <div className="founder-card">
              <div className="story-label">MEET YOUR TRAINER</div>
              <h2 id="shubhendu-heading">Shubhendu Sharma</h2>
              <div className="story-copy">
                <p>Shubhendu Sharma trained directly under Dr. Akira Miyawaki and turned his forest-making method into a replicable system. He founded Afforestt, which has built hundreds of dense native forests across the world, from backyards to industrial sites. A TED Fellow, he is a leading global voice in urban afforestation.</p>
              </div>
              <div className="meta-line">Industrial Engineer • Eco-entrepreneur • TED Fellow</div>
              <div className="milestones" aria-label="Key milestones in Shubhendu Sharma's journey">
                <div className="milestone"><span className="milestone-year">2008</span><span className="milestone-text">Met Akira Miyawaki</span></div>
                <div className="milestone"><span className="milestone-year">2009</span><span className="milestone-text">Worked with Miyawaki&apos;s team</span></div>
                <div className="milestone"><span className="milestone-year">2011</span><span className="milestone-text">Founded Afforestt</span></div>
              </div>
              <div className="founder-cta">
                <a className="btn btn-primary" href="https://www.ted.com/speakers/shubhendu_sharma" target="_blank" rel="noopener noreferrer">Explore on TED</a>
              </div>
            </div>
          </div>
        </section>

        <hr className="divider" />

        <section id="trainings">
          <div className="wrap">
            <div className="featured-training" id="trainingGrid">
              <CourseGallery images={indepth.images ?? [{ src: indepth.image, alt: indepth.imageAlt }]} />
              <div className="course-content">
                <h3>{indepth.title}</h3>
                <p className="course-intro">A complete live training to understand the method and learn how to create a native forest from start to finish.</p>
                <p className="course-description">{indepth.tagline}</p>
                <div className="course-facts"><span>{indepth.duration}</span><span>Live online · Friday evenings</span></div>
                <p className="course-suitable"><strong>Suitable for</strong>{indepth.audience}</p>
                <p className="course-price">{formatPrice(onlinePrice)}</p>
                <div className="course-actions">
                  <button className="btn btn-outline" data-id={indepth.id} data-kind="training" onClick={() => setModal({ kind: 'training', training: indepth })}>View details</button>
                  <button className="btn btn-primary" data-id={indepth.id} data-kind="training" onClick={() => setModal({ kind: 'training', training: indepth })}>Choose a Friday</button>
                </div>
              </div>
            </div>

            <div id="offline" className="offline-feature">
              <div>
                <span className="offline-tag">5-day in-person residency</span>
                <h2>Offline Workshop</h2>
                <p>Five full days on the ground with our team — planting, soil work, species selection and design, done for real. Food and accommodation are included, so all you bring is yourself.</p>
                <ul className="includes-list" id="offlineIncludes" style={{ color: 'var(--on-forest)' }}>
                  {OFFLINE.includes.map((item) => <li key={item}><CheckIconSm /><span>{item}</span></li>)}
                </ul>
                <div className="offline-price-row"><span className="price" id="offlinePrice">{formatPrice(offlinePrice)}</span><span className="per">all-inclusive · 5 days</span></div>
                <button className="btn btn-ochre" id="offlineEnrollBtn" onClick={() => setModal({ kind: 'offline' })}>Choose your start date</button>
              </div>
              <OfflineGallery />
            </div>
          </div>
        </section>

        <hr className="divider" />

        <section id="webinar">
          <div className="wrap">
            <div className="section-head"><div><span className="section-tag">Live online · {formatPrice(webinarPrice)}</span><h2>Monthly webinar</h2></div></div>
            <WebinarBanner catalog={catalog} price={webinarPrice} onReserve={reserveWebinar} />
          </div>
        </section>

        <hr className="divider" />

        <section id="trainees">
          <div className="wrap">
            <div className="section-head"><div><span className="section-tag">Learning together</span><h2>Meet Our Trainees</h2></div></div>
            <p className="trainee-note">Select a trainee to view their profile and project. Sample profiles are marked as demos.</p>
            <TraineesCarousel onOpen={(trainee, trigger) => setModal({ kind: 'trainee', trainee, trigger })} />
          </div>
        </section>

        <hr className="divider" />

        <section id="programs">
          <div className="wrap">
            <div className="section-head"><div><span className="section-tag">Field work</span><h2>What our Trainees Have Created</h2></div></div>
            <ProgramsCarousel />
          </div>
        </section>

        <hr className="divider" />

        <section id="reviews">
          <div className="wrap">
            <div className="section-head"><div><span className="section-tag">Reviews</span><h2>What past trainees say</h2></div></div>
            <div className="review-track overflow-x" id="reviewTrack">
              {REVIEWS.map((review) => (
                <div className="review-card" key={review.name}>
                  <div className="stars">{Array.from({ length: 5 }, (_, i) => <svg key={i} viewBox="0 0 20 20" style={i < review.stars ? undefined : { fill: 'var(--line)' }}><path d={STAR_PATH} /></svg>)}</div>
                  <p className="quote">{`“${review.quote}”`}</p>
                  <div className="review-who"><div className="avatar" style={{ background: review.color }}>{review.initials}</div><div><strong>{review.name}</strong><span>{review.role}</span></div></div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="site">
        <div className="wrap">
          <div>
            <div className="brand" style={{ color: 'var(--on-forest)', marginBottom: 14 }}>
              <BrandMark fill="var(--bg-raised)" stroke="var(--forest)" />
              <span style={{ color: 'var(--on-forest)' }}>DIY Forests<br /><small style={{ color: 'var(--footer-muted)' }}>BY SHUBHENDU SHARMA</small></span>
            </div>
            <p>DIY Forests is the training platform from Afforestt, who have been growing native forests using the Miyawaki method since 2011, founded by Shubhendu Sharma. Headquartered in Kashipur, Uttarakhand — our mission is to bring back lost native forests.</p>
          </div>
          <div>
            <h4>Explore</h4>
            <ul>
              <li><a href="#trainings">Live trainings</a></li>
              <li><a href="#trainees">Trainees</a></li>
              <li><a href="#programs">Projects</a></li>
              <li><a href="#offline">Offline workshop</a></li>
              <li><a href="#webinar">Monthly webinar</a></li>
              <li><a href="#reviews">Reviews</a></li>
            </ul>
          </div>
          <div>
            <h4>Support</h4>
            <ul>
              <li><a href="#" onClick={(event) => event.preventDefault()}>Help centre</a></li>
              <li><a href="#" onClick={(event) => event.preventDefault()}>Refund policy</a></li>
              <li><a href="#" onClick={(event) => event.preventDefault()}>Contact us</a></li>
            </ul>
          </div>
        </div>
        <div className="wrap foot-bottom">
          <span>© 2026 DIY Forests. A training platform from Afforestt.</span>
          <span>Made with the Miyawaki method in mind 🌱</span>
        </div>
      </footer>

      <div className={`scrim${cartOpen ? ' open' : ''}`} id="scrim" onClick={() => { closeCart(); closeModal() }} />
      <aside className={`cart-drawer${cartOpen ? ' open' : ''}`} id="cartDrawer" aria-label="Shopping cart">
        <div className="cart-head"><h3>Your cart</h3><button className="icon-btn" id="cartCloseBtn" aria-label="Close cart" onClick={closeCart}><CloseIcon /></button></div>
        <div className="cart-items" id="cartItems">
          {cart.length === 0 ? (
            <div className="cart-empty">
              <svg viewBox="0 0 24 24" fill="none"><path d="M3 4h2l2.4 12.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.6L21 8H6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <p style={{ margin: 0 }}>Your cart is empty.<br />Add a training to get started.</p>
            </div>
          ) : cart.map((item) => (
            <div className="cart-item" key={item.cartId}>
              <div className="thumb"><ArtImage art={item.art} /></div>
              <div className="info"><h5>{item.title}</h5><span>{item.meta}</span><br /><button className="remove-link" data-cid={item.cartId} onClick={() => setCart((current) => current.filter((entry) => entry.cartId !== item.cartId))}>Remove</button></div>
              <div className="price-col"><span className="price">{money(item.price, item.currency)}</span></div>
            </div>
          ))}
        </div>
        <div className="cart-summary" id="cartSummary" style={{ display: cart.length ? 'block' : 'none' }}>
          <div className="cart-row total"><span>Total</span><span className="price" id="cartTotal">{formatCartTotals(totals)}</span></div>
          <p style={{ fontSize: '.76rem', margin: '6px 0 10px' }}>Prices as listed. No payment is taken at checkout: our team confirms each booking request. Bookings close 24 hours before the start.</p>
          <button className="btn btn-primary btn-block" id="checkoutBtn" onClick={() => { if (cart.length) setModal({ kind: 'checkout' }) }}>Proceed to checkout</button>
        </div>
      </aside>

      <div className={`modal-scrim${modal ? ' open' : ''}`} id="modalScrim" onClick={(event) => { if (event.target === event.currentTarget) closeModal() }}>
        <div
          ref={modalBodyRef}
          className={`modal${traineeOpen ? ' trainee-profile-modal' : ''}`}
          id="modalBody"
          role={traineeOpen ? 'dialog' : undefined}
          aria-modal={traineeOpen ? 'true' : undefined}
          aria-labelledby={traineeOpen ? 'traineeProfileTitle' : undefined}
        >
          {renderModal()}
        </div>
      </div>

      <div className={`toast${toast.show ? ' show' : ''}`} id="toast"><svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg><span id="toastText">{toast.text}</span></div>

      <button className={`top-btn${showTop ? ' show' : ''}`} id="topBtn" aria-label="Back to top" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><svg viewBox="0 0 24 24" fill="none"><path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>

    </>
  )
}
