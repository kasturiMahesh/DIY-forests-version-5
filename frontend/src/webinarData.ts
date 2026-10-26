// The webinar's date now comes only from the catalog API (a PUBLISHED session). There is
// deliberately no hard-coded date here: the old one (13 Oct 2026) had passed and was shown in
// each visitor's own zone. `price` is only a fallback for when the API cannot be reached.
export const webinar = {
  title: 'Monthly Webinar',
  price: 149,
  format: 'Live Online',
}

export const webinarResourceCards = [
  { title: 'Understanding the Miyawaki Method', label: 'Method', description: 'A simple introduction to the approach behind native forest creation.', image: '/webinar-section-images/WhatsApp Image 2026-10-07 at 5.08.31 PM.jpeg', alt: 'Afforestt forested hillside with the words Create a Forest' },
  { title: 'Choosing Native Species', label: 'Planning', description: 'Explore how local plant life can inform the planning of a native forest.', image: '/webinar-section-images/WhatsApp Image 2026-10-07 at 5.08.29 PM.jpeg', alt: 'Established forest planting in Indiana, US' },
  { title: 'Preparing the Soil', label: 'Site preparation', description: 'A look at the ground conditions considered before planting begins.', image: '/webinar-section-images/WhatsApp Image 2026-10-07 at 5.08.31 PM (1).jpeg', alt: 'Rows of seedlings on a prepared planting site' },
  { title: 'Planting a Dense Forest', label: 'Planting', description: 'An introduction to how a planting plan comes together on site.', image: '/webinar-section-images/WhatsApp Image 2026-10-07 at 5.08.30 PM.jpeg', alt: 'Dense native forest surrounding a path' },
  { title: 'From Barren Land to Forest', label: 'Forest growth', description: 'See forest growth represented across different stages of a site.', image: '/webinar-section-images/WhatsApp Image 2026-10-07 at 5.08.30 PM (1).jpeg', alt: 'Established Afforestt forest growth with training text on the image' },
  { title: 'Maintaining a Young Forest', label: 'After planting', description: 'An introduction to care after a young forest has been planted.', image: '/webinar-section-images/WhatsApp Image 2026-10-07 at 5.12.10 PM.jpeg', alt: 'Seedlings planted across an industrial campus with site information' },
]