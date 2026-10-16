// Content mirrors the data objects in the original static page
// (afforestt-trainings (1).html). Keep the two in sync.

export type Currency = 'USD' | 'INR'
export type Art = { src: string; alt: string }

export type Training = {
  id: string
  title: string
  tagline: string
  duration: string
  price: number
  currency?: Currency
  image: string
  imageAlt: string
  images?: Art[]
  audience: string
  learn: string[]
  includes: string[]
}

/** Thumbnail shown for the webinar in the cart (unchanged; it used to be read from the first TRAININGS entry). */
export const WEBINAR_CART_ART: Art = { src: 'https://afforestt.com/wp-content/uploads/2025/12/IMG_2501-1024x576.webp', alt: 'Native forest restoration work in Tunisia' }

/** The single in-depth Online Training. Crash Course and Detailed Training were retired and are not offered. */
export const TRAININGS: Training[] = [
  {
    id: 'indepth', title: 'Online Training', tagline: 'Know everything about the Method — spread over 2 days.', duration: '8 hours · 2 days', price: 500, currency: 'USD',
    image: '/WhatsApp%20Image%202026-10-07%20at%204.41.13%20PM.jpeg', imageAlt: 'Native forest growth from initial planting to a mature site',
    images: [
      { src: '/carousel-first-image.png', alt: 'Participants learning in the field during a forest restoration training' },
      { src: '/WhatsApp%20Image%202026-10-07%20at%204.41.13%20PM%20(1).jpeg', alt: 'Dense native forest with more than 20,000 seedlings' },
      { src: '/WhatsApp%20Image%202026-10-07%20at%204.41.13%20PM.jpeg', alt: 'Native forest growth from initial planting to a mature site' },
    ],
    audience: 'Anyone who wants to know the full method, start to finish.',
    learn: ['Soil science in depth', 'Full species-selection process', 'Site design and planning', 'How to guide others through the method'],
    includes: ['Two 4-hour live sessions, a week apart', 'Recordings and all worksheets to keep', 'Certificate of completion'],
  },
]

export const OFFLINE = {
  title: 'Offline Workshop',
  price: 100000,
  image: 'https://afforestt.com/wp-content/uploads/2025/12/DSC00830-1024x768.webp',
  imageAlt: 'Native forest created through an Afforestt restoration project',
  images: [
    { src: '/offline%20training%20ima/WhatsApp%20Image%202026-10-07%20at%204.45.08%20PM.jpeg', alt: 'Offline workshop participant exploring a mature forest tree' },
    { src: '/offline%20training%20ima/WhatsApp%20Image%202026-10-07%20at%204.45.08%20PM%20(1).jpeg', alt: 'Offline workshop participants visiting a forest restoration site' },
    { src: '/offline%20training%20ima/WhatsApp%20Image%202026-10-07%20at%204.45.07%20PM.jpeg', alt: 'Offline workshop group walking through a forest restoration site' },
  ],
  includes: ['Hands-on training for 5 full days', 'Accommodation included', 'All meals included', 'Small batch size, real planting site'],
}

export const PROGRAMS = [
  { loc: 'Springfield, Massachusetts', title: 'Linear Urban Forests', desc: 'Reimagining American streets as native forests.', image: 'https://afforestt.com/wp-content/uploads/2026/01/Excerpt-1024x576.jpg', imageAlt: 'Linear urban forest project in Springfield, Massachusetts', url: 'https://afforestt.com/linear-urban-forests-reimagining-american-streets-as-native-forests/' },
  { loc: 'Lesser Caucasus, Armenia', title: 'Sub-Alpine Restoration', desc: 'Restoring degraded ski slopes and mountain landscapes.', image: 'https://afforestt.com/wp-content/uploads/2025/12/IMG_5002-1024x517.webp', imageAlt: "Afforestt restoration work in Armenia's Lesser Caucasus", url: 'https://afforestt.com/restoring-sub-alpine-ski-slopes-of-the-lesser-caucasus/' },
  { loc: 'San Miguel de Allende, Mexico', title: 'The Encinos', desc: 'Building a native forest within a growing community.', image: 'https://afforestt.com/wp-content/uploads/2025/12/DSC00830-1024x768.webp', imageAlt: 'The Encinos native forest project in Mexico', url: 'https://afforestt.com/the-encinos-of-mexico-building-a-native-forest-in-san-miguel-de-allende/' },
  { loc: 'Tunisia', title: 'Forests of the Mediterranean', desc: 'Growing native forests and sharing restoration knowledge.', image: 'https://afforestt.com/wp-content/uploads/2025/12/IMG_2721-1-1024x472.jpg', imageAlt: "Afforestt's Mediterranean forest work in Tunisia", url: 'https://afforestt.com/forests-of-the-mediterranean-afforestt-in-tunisia/' },
  { loc: 'Jodhpur, Rajasthan', title: 'Soil Restoration in the Thar', desc: 'Restoring desert soil with native grasses and millets.', image: 'https://afforestt.com/wp-content/uploads/2025/07/DSC01230-1024x576.jpg', imageAlt: 'Afforestt soil restoration project in Rajasthan', url: 'https://afforestt.com/soil-restoration-in-the-thar-desert-using-millets-grasses/' },
  { loc: 'Rajasthan, India', title: 'Maruvan', desc: 'A living demonstration site for desert restoration.', image: 'https://afforestt.com/wp-content/uploads/2025/07/IMG_3019-1024x576.jpg', imageAlt: 'Afforestt forest restoration in the Rajasthan desert', url: 'https://afforestt.com/maruvan/' },
]

export type Trainee = {
  name: string
  type?: string
  role?: string
  project?: string
  projectLabel?: string
  projectIntro?: string
  city?: string
  country?: string
  image: string
  imageAlt?: string
  demo?: boolean
  beforePlantingImages?: string[]
  afterPlantingImages?: string[]
  links?: { label: string; url: string }[]
}

const tancyBefore = '/assets/trainees/tancy/Before%20Planting/'
const tancyAfter = '/assets/trainees/tancy/After%20Planting-20261008T141329Z-1-001/After%20Planting/'

export const TRAINEES: Trainee[] = [
  {
    name: 'Tancy Arron-Walker', type: 'Online Trainee', project: 'Indiana 10,000 Trees', projectLabel: 'Project',
    projectIntro: 'Explore the supplied project images below, organized into before- and after-planting views.',
    image: '/assets/trainees/tancy/profile.jpeg', imageAlt: 'Tancy Arron-Walker',
    beforePlantingImages: ['IMG_6694', 'IMG_6737', 'IMG_6794', 'IMG_6835', 'IMG_7014', 'IMG_7072'].map((name) => `${tancyBefore}${name}.jpeg`),
    afterPlantingImages: ['IMG_2789', 'IMG_3105', 'IMG_3507', 'IMG_4108'].map((name) => `${tancyAfter}${name}.jpeg`),
    links: [
      { label: 'View on Instagram', url: 'https://www.instagram.com/candycreekfarm?stkn=dHljczJ0c20xZXdu' },
      { label: 'View Project Photos', url: 'https://drive.google.com/drive/folders/1o046RypscMO9pEspahbkPFycvXCOGCA0' },
    ],
  },
  {
    name: 'Brett Krause', type: 'Online Trainee', project: 'Forest Restoration Work', projectLabel: 'Work',
    image: '/assets/trainees/brett/brett1.jpeg', imageAlt: 'Brett Krause',
    links: [{ label: 'View Work', url: 'https://www.facebook.com/reel/952851422536857' }],
  },
  { name: 'Maria Silva', city: 'Sao Paulo', country: 'Brazil', role: 'DIY Forests Trainee', image: 'https://images.unsplash.com/photo-1531123897727-8f129e1688ce?auto=format&fit=crop&w=700&q=80', demo: true },
  { name: 'Daniel Okafor', city: 'Lagos', country: 'Nigeria', role: 'Native Forest Trainee', image: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=700&q=80', demo: true },
]

export const REVIEWS = [
  { name: 'Shreya Pareek', role: 'Trainee', initials: 'SP', color: '#493631', stars: 5, quote: 'The training was very beneficial. I learnt so much and implemented the learnings to create my very own tiny patch of forest in my city. Thank you for the guidance.' },
  { name: 'Arvind Menon', role: 'In-depth Training, Kochi', initials: 'AM', color: '#A5644B', stars: 5, quote: 'Two Friday evenings were all it took to actually understand soil prep and species selection, not just watch it happen. Worth every rupee.' },
  { name: 'Neha Chawla', role: 'Offline Workshop batch, Dehradun', initials: 'NC', color: '#80564A', stars: 5, quote: 'Five days on-site with the team taught me more than a year of reading could. The food and stay being handled meant I could focus entirely on learning.' },
  { name: 'Vikram Suri', role: 'Crash Course, Jaipur', initials: 'VS', color: '#B8755B', stars: 4, quote: 'Booked the crash course on a whim before a Friday evening. Two hours in, I had a clear plan for the space behind my house.' },
]

export function money(amount: number, currency?: Currency) {
  return currency === 'USD' ? `$${amount.toLocaleString('en-US')}` : `₹${amount.toLocaleString('en-IN')}`
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function nextWeekdayDates(weekday: number, count: number, intervalWeeks: number) {
  const out: Date[] = []
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  while (date.getDay() !== weekday) date.setDate(date.getDate() + 1)
  for (let index = 0; index < count; index += 1) {
    out.push(new Date(date))
    date.setDate(date.getDate() + 7 * intervalWeeks)
  }
  return out
}

export const fmtShort = (date: Date) => `${WEEKDAY_SHORT[date.getDay()]}, ${date.getDate()} ${MONTH_SHORT[date.getMonth()]}`
export const fmtRange = (start: Date, end: Date) => `${start.getDate()}–${end.getDate()} ${MONTH_SHORT[end.getMonth()]}`
export function addDays(date: Date, days: number) {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}
