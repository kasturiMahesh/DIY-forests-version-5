import { useEffect, useState } from 'react'
import { getCountdown } from '../api/format'

/**
 * Live countdown to a fixed instant. Class names are passed in because the two pages
 * use different stylesheets (webinar-countdown* on the home page, countdown* on the webinar page).
 */
export function Countdown({ target, id, containerClass, itemClass, statusClass }: {
  target: string
  id: string
  containerClass: string
  itemClass: string
  statusClass: string
}) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const value = getCountdown(new Date(target), now)
  if (value.complete) return <div className={statusClass} id={id} aria-label="Time until the webinar" aria-live="off">Webinar starting soon</div>
  const units: [number, string][] = [[value.days, 'DAYS'], [value.hours, 'HOURS'], [value.minutes, 'MINUTES'], [value.seconds, 'SECONDS']]
  return (
    <div className={containerClass} id={id} aria-label="Time until the webinar" aria-live="off">
      {units.map(([amount, label]) => <span key={label} className={itemClass}><strong>{String(amount).padStart(2, '0')}</strong><span>{label}</span></span>)}
    </div>
  )
}
