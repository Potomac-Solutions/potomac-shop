// Reading and writing CSV, as pure functions. Quoted fields, doubled quotes, commas and line breaks
// inside quotes, a byte-order mark and either line ending are all handled.

/** Parse CSV text into a list of rows, each a list of strings. Blank lines are dropped. */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((cell) => cell !== '')) rows.push(row);
  return rows;
}

/** Parse CSV with a header row into objects keyed by the header, trimmed. Duplicate headers keep the first. */
export function parseCsvObjects(text) {
  const [header = [], ...body] = parseCsv(text);
  const keys = header.map((name) => name.trim());
  return {
    headers: keys,
    rows: body.map((cells) => {
      const record = {};
      keys.forEach((key, index) => {
        if (!(key in record)) record[key] = cells[index] ?? '';
      });
      return record;
    }),
  };
}

// A cell starting with one of these is run as a formula by spreadsheet programs. Prefixing a quote
// keeps it as text (OWASP's advice for CSV injection).
const FORMULA = /^[=+\-@\t\r]/;

/** One cell, quoted when it needs to be and made safe to open in a spreadsheet. Numbers pass as they are. */
export function csvCell(value) {
  if (value == null) return '';
  if (typeof value === 'number') return String(value);
  let text = String(value);
  if (FORMULA.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows (lists of values) to CSV text, with a header row first. Lines end in CRLF, as RFC 4180 says. */
export function toCsv(header, rows) {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
