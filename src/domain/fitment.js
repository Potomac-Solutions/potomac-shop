// Fitment for the auto parts pack: which vehicles a part fits. Pure rules, no I/O.
//
// A fitment entry is { platform, from, to, models, drive }:
//   platform  one of PLATFORMS' keys ('1G', '2G', 'GVR4', 'EVO89', 'EVOX')
//   from, to  model years, inclusive
//   models    names within the platform the part fits (Eclipse, Talon, Laser, ...)
//   drive     'AWD', 'FWD' or null when either
//
// `fromTitle` reads fitment out of the way DSM sellers already write titles ("2g 95-99 ...",
// "1G 1990 DSM ...", "GVR4", "Evo 8/9"). It is a first guess the owner confirms, never the final word.

export const PLATFORMS = Object.freeze({
  '1G': { label: '1G DSM', from: 1990, to: 1994, models: ['Eclipse', 'Talon', 'Laser'] },
  '2G': { label: '2G DSM', from: 1995, to: 1999, models: ['Eclipse', 'Talon'] },
  GVR4: { label: 'Galant VR-4', from: 1991, to: 1992, models: ['Galant VR-4'] },
  EVO89: { label: 'Evo VIII / IX', from: 2003, to: 2006, models: ['Lancer Evolution'] },
  EVOX: { label: 'Evo X', from: 2008, to: 2015, models: ['Lancer Evolution'] },
});

const MODEL_WORDS = [
  [/\beclipse\b/i, 'Eclipse'],
  [/\btalon\b/i, 'Talon'],
  [/\blaser\b/i, 'Laser'],
];

/** A two- or four-digit year to four digits: 95 → 1995, 03 → 2003. Null when it can't be a model year here. */
function fullYear(text) {
  let year = Number(text);
  if (text.length === 2) year += year >= 80 ? 1900 : 2000;
  return year >= 1989 && year <= 2016 ? year : null;
}

/** The years a title names: "95-99", "1991-1994", "1998", "97–99". */
function yearsIn(title) {
  const range = /(?<![\w.])((?:19|20)?\d{2})\s*[-–\/]\s*((?:19|20)?\d{2})(?![\w.])/.exec(title);
  if (range) {
    const from = fullYear(range[1]);
    const to = fullYear(range[2]);
    if (from && to && from <= to) return { from, to };
  }
  const single = /(?<![\w.-])((?:19|20)\d{2})(?![\w.-])/.exec(title);
  if (single) {
    const year = fullYear(single[1]);
    if (year) return { from: year, to: year };
  }
  return null;
}

/** The platforms a title names outright. */
function platformsIn(title) {
  const found = new Set();
  if (/\b1ga?\b/i.test(title) || /\b1st\s*gen\b/i.test(title)) found.add('1G');
  if (/\b2g[ab]?\b/i.test(title) || /\b2nd\s*gen\b/i.test(title)) found.add('2G');
  if (/\bg\s*vr-?\s*4\b|\bgalant\s+vr-?\s*4\b/i.test(title)) found.add('GVR4');
  if (/\bevo(?:lution)?\s*(?:x|10)\b/i.test(title)) found.add('EVOX');
  else if (/\bevo(?:lution)?\s*(?:viii|ix|8|9)\b/i.test(title)) found.add('EVO89');
  else if (/\bevo\b/i.test(title)) found.add('EVO89');
  // "DSM" on its own, with no generation, is a part both generations share (a 4G63 valve cover).
  if (found.size === 0 && /\bdsm\b/i.test(title)) {
    found.add('1G');
    found.add('2G');
  }
  return [...found];
}

/** Which platform a year range belongs to, for titles that give years but no generation. */
function platformForYears({ from, to }) {
  for (const key of ['1G', '2G']) {
    const p = PLATFORMS[key];
    if (from >= p.from && to <= p.to) return key;
  }
  return null;
}

/** Fitment guessed from a listing title. An empty list means the title says nothing we can read. */
export function fromTitle(title) {
  const text = String(title ?? '');
  const years = yearsIn(text);
  let platforms = platformsIn(text);
  if (platforms.length === 0 && years) {
    const guess = platformForYears(years);
    if (guess) platforms = [guess];
  }
  if (platforms.length === 0) return [];
  const named = MODEL_WORDS.filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
  const drive = /\bawd\b/i.test(text) ? 'AWD' : /\bfwd\b/i.test(text) ? 'FWD' : null;
  return platforms.map((key) => {
    const p = PLATFORMS[key];
    const span = years && platforms.length === 1 ? clamp(years, p) : { from: p.from, to: p.to };
    const models = key === '1G' || key === '2G' ? named.filter((m) => p.models.includes(m)) : [];
    return { platform: key, from: span.from, to: span.to, models: models.length ? models : [...p.models], drive };
  });
}

function clamp(years, p) {
  const from = Math.max(years.from, p.from);
  const to = Math.min(years.to, p.to);
  return from <= to ? { from, to } : { from: p.from, to: p.to };
}

/** Whether a part with these fitment entries fits the vehicle a buyer picked. */
export function fits(fitment, { platform, year = null, model = null, drive = null }) {
  return fitment.some((entry) =>
    entry.platform === platform &&
    (year == null || (year >= entry.from && year <= entry.to)) &&
    (model == null || entry.models.includes(model)) &&
    (drive == null || entry.drive == null || entry.drive === drive));
}

/** "1995–1999 Eclipse, Talon (AWD)": one entry, for people. */
export function describe(entry) {
  const years = entry.from === entry.to ? String(entry.from) : `${entry.from}–${entry.to}`;
  return `${years} ${entry.models.join(', ')}${entry.drive ? ` (${entry.drive})` : ''}`;
}

/**
 * Fitment written in our CSV's `fitment` column ("1995-1999 Eclipse GSX; 1G 1990-1994") read back.
 * Each part separated by ";" is read like a title, so the column and a title follow the same rules.
 */
export function fromColumn(text) {
  return String(text ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => fromTitle(part));
}

/** Fitment to our CSV's `fitment` column. `fromColumn(toColumn(x))` gives back x's platforms and years. */
export const toColumn = (fitment) => fitment.map((e) => `${PLATFORMS[e.platform]?.label ?? e.platform} ${e.from}-${e.to}${e.models.length ? ` ${e.models.join(' ')}` : ''}${e.drive ? ` ${e.drive}` : ''}`).join('; ');
