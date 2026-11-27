// Reading a multipart/form-data body (a photo upload) with no dependencies. Answers
// { fields: URLSearchParams, files: [{ name, filename, bytes }] }, or throws with `status` 400.

const bad = (message) => Object.assign(new Error(message), { status: 400 });

export function boundaryOf(contentType) {
  const match = /^multipart\/form-data;.*\bboundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(String(contentType ?? ''));
  return match ? match[1] ?? match[2] : null;
}

export function parseMultipart(body, boundary, { maxFiles = 12 } = {}) {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = new URLSearchParams();
  const files = [];
  let at = body.indexOf(delimiter);
  if (at < 0) throw bad('no parts');
  while (true) {
    at += delimiter.length;
    if (body[at] === 0x2d && body[at + 1] === 0x2d) break; // "--": the closing delimiter
    if (body[at] === 0x0d && body[at + 1] === 0x0a) at += 2;
    const headerEnd = body.indexOf('\r\n\r\n', at);
    if (headerEnd < 0) throw bad('broken part');
    const headers = body.subarray(at, headerEnd).toString('utf8');
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delimiter]), headerEnd + 4);
    if (next < 0) throw bad('unterminated part');
    const content = body.subarray(headerEnd + 4, next);
    const disposition = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(headers)?.[1] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
    const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
    if (name != null) {
      if (filename != null) {
        if (content.length > 0) {
          if (files.length >= maxFiles) throw bad('too many files');
          files.push({ name, filename, bytes: Buffer.from(content) });
        }
      } else fields.append(name, content.toString('utf8'));
    }
    at = next + 2;
  }
  return { fields, files };
}
