export const webinar = {
  title: 'Monthly Webinar',
  date: new Date(2026, 9, 13, 18, 30, 0, 0),
  price: 149,
  format: 'Live Online',
}

export function formatWebinarDateTime(date: Date) {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${weekdays[date.getDay()]}, ${date.getDate()} ${months[date.getMonth()]} · ${time}`
}

export function getWebinarCountdown(now: Date) {
  const remaining = Math.max(0, webinar.date.getTime() - now.getTime())
  const seconds = Math.floor(remaining / 1000)
  return {
    days: Math.floor(seconds / 86400),
    hours: Math.floor((seconds % 86400) / 3600),
    minutes: Math.floor((seconds % 3600) / 60),
    seconds: seconds % 60,
    complete: remaining === 0,
  }
}

export const webinarResourceCards = [
  { title: 'Understanding the Miyawaki Method', label: 'Method', description: 'A simple introduction to the approach behind native forest creation.', image: '/webinar-section-images/WhatsApp Image 2026-10-07 at 5.08.31 PM.jpeg', alt: 'Afforestt forested hillside with the words Create a Forest' },
  { title: 'Choosing Native Species', label: 'Planning', description: 'Explore how local plant life can inform the planning of a native forest.', image: '/webinar-section-images/WhatsApp Image 2026-10-07 at 5.08.29 PM.jpeg', alt: 'Established forest planting in Indiana, US' },
  { title: 'Preparing the Soil', label: 'Site preparation', description: 'A look at the ground conditions considered before planting begins.', image: '/webinar-section-images/WhatsApp Image 2026-10-07 at 5.08.31 PM (1).jpeg', alt: 'Rows of seedlings on a prepared planting site' },
  { title: 'Planting a Dense Forest', label: 'Planting', description: 'An introduction to how a planting plan comes together on site.', image: '/webinar-section-images/WhatsApp Image 2026-10-07 at 5.08.30 PM.jpeg', alt: 'Dense native forest surrounding a path' },
  { title: 'From Barren Land to Forest', label: 'Forest growth', description: 'See forest growth represented across different stages of a site.', image: '/webinar-section-images/WhatsApp Image 2026-10-07 at 5.08.30 PM (1).jpeg', alt: 'Established Afforestt forest growth with training text on the image' },
  { title: 'Maintaining a Young Forest', label: 'After planting', description: 'An introduction to care after a young forest has been planted.', image: '/webinar-section-images/WhatsApp Image 2026-10-07 at 5.12.10 PM.jpeg', alt: 'Seedlings planted across an industrial campus with site information' },
]