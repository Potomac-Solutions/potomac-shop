// Drafting a listing with Claude from the part's photos, the donor car and whatever the owner
// typed. It only drafts: the item stays a draft until a person lists it, and the price is never
// touched. A monthly budget stops it before it overspends.

import { fromColumn } from '../domain/fitment.js';

const API = 'https://api.anthropic.com/v1/messages';

/** The month's start (UTC) for a time in ms. */
const monthStart = (ms) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

export function createDrafts({ db, catalog, photos, apiKey = '', model = 'claude-haiku-5-5', monthlyDollars = 10, rates = { input: 1, output: 5 }, fetch: fetcher = fetch, now = Date.now, business = 'the shop' }) {
  const enabled = Boolean(apiKey);

  /** What drafting has cost this month, in dollars, and what's left. */
  function budget() {
    const micro = db.prepare('SELECT COALESCE(SUM(micro_dollars), 0) AS n FROM ai_usage WHERE at >= ?').get(monthStart(now())).n;
    const spent = micro / 1e6;
    return { spent, limit: monthlyDollars, left: Math.max(0, monthlyDollars - spent) };
  }

  function prompt(item, lot, categories) {
    return [
      `You write listings for ${business}, which sells used DSM (1990-1999 Eclipse, Talon, Laser), Galant VR-4 and Lancer Evolution parts pulled from donor cars.`,
      'Look at the photos and write a draft listing for the part shown. Answer with JSON only, no other text:',
      '{"title": string, "description": string, "category": string, "condition": "used" | "new" | "refurbished", "fits": string, "notes": string}',
      '- title: under 80 characters, written the way DSM sellers do: generation and years first ("2g 95-99 ...", "1g 90-94 ...", "GVR4 ..."), then the part, then what matters (AWD, manual, color).',
      '- description: 2 to 4 short plain sentences: what it is, what condition the photos show (marks, cracks, missing pieces), what it came off. No sales talk, no emoji.',
      `- category: one of ${categories.map((c) => JSON.stringify(c)).join(', ')}.`,
      '- fits: the vehicles, semicolon-separated, like "2G DSM 1995-1999 Eclipse Talon AWD; GVR4". Empty if the photos and notes don\'t say.',
      '- notes: anything the seller should check before listing (a part number you could not read, a fitment you are unsure of). Never invent part numbers.',
      lot ? `The donor car: ${lot.name}.` : '',
      item.title ? `The seller's own words for it: ${JSON.stringify(item.title)}.` : '',
      item.description ? `The seller's notes: ${JSON.stringify(item.description.slice(0, 600))}.` : '',
    ].filter(Boolean).join('\n');
  }

  /** Read the first JSON object out of the model's answer, with only the fields we use. */
  function readAnswer(text, categories) {
    const match = /\{[\s\S]*\}/.exec(String(text ?? ''));
    if (!match) return null;
    let raw;
    try {
      raw = JSON.parse(match[0]);
    } catch {
      return null;
    }
    const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
    const title = str(raw.title, 120);
    if (!title) return null;
    return {
      title,
      description: str(raw.description, 2000),
      category: categories.includes(raw.category) ? raw.category : '',
      condition: ['used', 'new', 'refurbished'].includes(raw.condition) ? raw.condition : 'used',
      fitment: fromColumn(str(raw.fits, 300)),
      notes: str(raw.notes, 500),
    };
  }

  /** Draft an item's listing from its photos. Answers { ok, item, notes } or { error }. */
  async function draft(itemId, { who = 'owner' } = {}) {
    if (!enabled) return { error: 'ai-off' };
    const item = catalog.get(itemId);
    if (!item) return { error: 'not-found' };
    if (item.status !== 'draft') return { error: 'not-draft' };
    const images = photos.forItem(item);
    if (images.length === 0) return { error: 'no-photos' };
    if (budget().left <= 0.01) return { error: 'over-budget' };
    const lot = item.lotId ? catalog.lots().find((one) => one.id === item.lotId) : null;
    const categories = [...new Set(['Drivetrain', 'Engine', 'Electrical & tuning', 'Cooling', 'Suspension & brakes', 'Exterior', 'Interior', 'Gaskets', 'Cars & swaps', ...catalog.list({ limit: 2000 }).map((one) => one.category).filter(Boolean)])];

    let response;
    try {
      response = await fetcher(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: 700,
          messages: [{
            role: 'user',
            content: [
              ...images.map((photo) => ({ type: 'image', source: { type: 'base64', media_type: photo.type, data: photo.bytes.toString('base64') } })),
              { type: 'text', text: prompt(item, lot, categories) },
            ],
          }],
        }),
      });
    } catch {
      return { error: 'ai-unreachable' };
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { error: response.status === 401 || response.status === 403 ? 'ai-key' : response.status === 429 || response.status === 529 ? 'ai-busy' : 'ai-failed', detail: body?.error?.message ?? '' };

    const usage = body.usage ?? {};
    const input = Number(usage.input_tokens ?? 0);
    const output = Number(usage.output_tokens ?? 0);
    db.prepare('INSERT INTO ai_usage (at, item_id, model, input_tokens, output_tokens, micro_dollars) VALUES (?, ?, ?, ?, ?, ?)')
      .run(now(), itemId, String(body.model ?? model), input, output, Math.ceil(input * rates.input + output * rates.output));

    const text = (body.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');
    const answer = readAnswer(text, categories);
    if (!answer) return { error: 'ai-unreadable' };
    const fields = { title: answer.title, description: answer.description, condition: answer.condition };
    if (answer.category) fields.category = answer.category;
    if (answer.fitment.length) fields.fitment = answer.fitment;
    const saved = catalog.edit(itemId, fields, { who: `${who} (AI draft)` });
    if (saved.error) return saved;
    return { ok: true, item: saved.item, notes: answer.notes };
  }

  return { enabled, budget, draft, readAnswer };
}
