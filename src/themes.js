// What a store looks and sounds like. Potomac Shop runs as a whole store (Rix Racing's parts) or
// beside a business's own site (Garrett County Adventures' shop), and the theme is the difference:
// its stylesheet, header, footer, home page words, and whether the auto pack (shop by vehicle,
// fitment, donor cars) is on. STORE_THEME picks one; SITE_URL is the business's own site, for a
// store that sits beside it.
//
// A theme only says things; the pages decide how. Nothing in here touches the database.

export const THEMES = {
  rix: {
    name: 'rix',
    css: null,
    fonts: 'https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Roboto:wght@400;500;700&display=swap',
    dark: true,
    auto: true,
    words: { item: 'part', items: 'parts', Items: 'Parts', path: 'parts', all: 'All parts' },
    brand: { mark: 'RIX', name: (business) => business.replace(/^Rix\s*/i, '') || business },
    nav: () => [['All parts', '/parts'], ['1G DSM', '/parts?platform=1G'], ['2G DSM', '/parts?platform=2G'], ['EVO', '/parts?platform=EVO89']],
    footer: null,
    home: null,
    gone: 'It may have sold. See what’s listed, or ask us: much of the stock isn’t online.',
  },

  gcadv: {
    name: 'gcadv',
    css: '/static/themes/gcadv.css',
    // The site itself names Manrope and DM Sans; loading them here keeps the shop and the site one voice.
    fonts: 'https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&family=Manrope:wght@600;700;800&display=swap',
    dark: false,
    auto: false,
    words: { item: 'item', items: 'goods', Items: 'Goods', path: 'products', all: 'Everything in the shop' },
    brand: { mark: '', name: (business) => business },
    nav: (site) => [['Adventure map', `${site}/explore.html`], ['Trail app', `${site}/trails/`], ['Trip guides', `${site}/#trip-guides`], ['Shop', '/']],
    footer: (site) => ({
      line: 'Local travel ideas for Garrett County, Maryland',
      links: [['Home & trip guides', `${site}/`], ['Adventure map', `${site}/explore.html`], ['Trail app', `${site}/trails/`], ['Privacy', `${site}/privacy.html`]],
    }),
    home: {
      title: 'Take a little of Garrett County home.',
      lede: 'Stickers for the water bottle, shirts and hats for the trail, and a guide to the county through the seasons. Printed when you order, so nothing sits in a warehouse.',
      image: (site) => `${site}/images/gcadv-home.webp`,
      imageAlt: 'A sunset over Garrett County’s rolling hills',
      strip: 'Good days outside, and something to remember them by.',
      shelf: 'The shop',
      shelfNote: 'Shirts, hats and the book are made to order and shipped from the printer. Stickers come from us.',
    },
    gone: 'It isn’t in the shop right now. See what is, or ask us about it.',
    // Until BUSINESS_* say otherwise. No contact address is made up: set CONTACT_EMAIL.
    demoLogins: { owner: { email: 'owner@gcadv.example', name: 'Mikey', password: 'gcadv-owner-demo' }, helper: { email: 'helper@gcadv.example', name: 'Shop helper', password: 'gcadv-helper-demo' } },
    defaults: { business: 'Garrett County Adventures', tagline: '', place: 'Garrett County, Maryland', contactEmail: '', contactFacebook: '' },
  },
};

/** The theme STORE_THEME names, Rix's when it names none (the store this started as). */
export const themeOf = (name) => THEMES[String(name ?? '').trim().toLowerCase()] ?? THEMES.rix;
