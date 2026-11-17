'use strict';
// Turns an uploaded note file into searchable "sections" ({ title, text, html }).

const fs = require('fs');
const path = require('path');
const sanitizeHtml = require('sanitize-html');

const SUPPORTED = ['.docx', '.pdf', '.mht', '.mhtml', '.html', '.htm', '.one', '.txt', '.md'];

const SANITIZE_OPTS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'u', 's']),
  allowedAttributes: {
    a: ['href'],
    img: ['src', 'alt', 'width', 'height'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
  },
  allowedSchemesByTag: { img: ['data', 'http', 'https'] },
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
  },
};
SANITIZE_OPTS.allowedAttributes.a.push('target', 'rel');

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function htmlToText(html) {
  const spaced = html.replace(/<(br|\/p|\/li|\/td|\/th|\/tr|\/div|\/h[1-6]|\/pre|\/blockquote)\b[^>]*>/gi, '$&\n');
  const stripped = sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} });
  return decodeEntities(stripped).replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function textToHtml(text) {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// Split sanitized HTML into one section per heading (h1-h3), with breadcrumb titles.
function splitHtml(rawHtml, docTitle) {
  const clean = sanitizeHtml(rawHtml, SANITIZE_OPTS);
  const parts = clean.split(/(?=<h[1-3]>)/i);
  const trail = [];
  const sections = [];
  for (const part of parts) {
    const m = part.match(/^<h([1-3])>([\s\S]*?)<\/h\1>/i);
    let title = docTitle;
    let body = part;
    if (m) {
      const level = Number(m[1]);
      const heading = htmlToText(m[2]).replace(/\n/g, ' ');
      trail.length = level - 1;
      trail[level - 1] = heading;
      title = trail.filter(Boolean).join(' › ') || docTitle;
      body = part.slice(m[0].length);
    }
    const text = htmlToText(body);
    const hasImage = /<img\b/i.test(body);
    if (!text && !hasImage) continue; // heading with nothing under it
    sections.push({ title, text, html: body.trim() });
  }
  return sections;
}

// ---------- individual formats ----------

async function parseDocx(file, docTitle) {
  const mammoth = require('mammoth');
  const { value } = await mammoth.convertToHtml({ path: file });
  return splitHtml(value, docTitle);
}

async function parsePdf(file, docTitle) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true, verbosity: 0 }).promise;
  const sections = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    let text = '';
    for (const item of content.items) {
      text += item.str;
      if (item.hasEOL) text += '\n';
    }
    text = text.trim();
    if (!text) continue;
    sections.push({
      title: doc.numPages > 1 ? `${docTitle} — page ${n}` : docTitle,
      text,
      html: textToHtml(text.replace(/\n/g, '\n\n')),
    });
  }
  await doc.loadingTask.destroy();
  return sections;
}

function decodeQuotedPrintable(s) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// MHT/MHTML ("Single File Web Page") as exported by OneNote.
function parseMht(file, docTitle) {
  const raw = fs.readFileSync(file).toString('latin1');
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  if (!boundaryMatch) return splitHtml(raw, docTitle);
  const chunks = raw.split('--' + boundaryMatch[1]).slice(1);
  let html = null;
  const images = [];
  for (const chunk of chunks) {
    const sep = chunk.search(/\r?\n\r?\n/);
    if (sep < 0) continue;
    const headers = chunk.slice(0, sep).replace(/\r?\n[ \t]+/g, ' ');
    let body = chunk.slice(sep).replace(/^\r?\n\r?\n/, '');
    const type = (headers.match(/Content-Type:\s*([^;\r\n]+)/i) || [])[1] || '';
    const enc = ((headers.match(/Content-Transfer-Encoding:\s*(\S+)/i) || [])[1] || '').toLowerCase();
    const loc = (headers.match(/Content-Location:\s*(\S+)/i) || [])[1] || '';
    const cid = (headers.match(/Content-ID:\s*<([^>]+)>/i) || [])[1] || '';
    if (/^text\/html/i.test(type) && html === null) {
      let bytes;
      if (enc === 'base64') bytes = Buffer.from(body, 'base64');
      else bytes = Buffer.from(enc === 'quoted-printable' ? decodeQuotedPrintable(body) : body, 'latin1');
      let charset = ((headers.match(/charset="?([^"\s;]+)/i) || [])[1] || 'utf-8').toLowerCase();
      if (charset === 'unicode') charset = 'utf-16le';
      try {
        html = new TextDecoder(charset).decode(bytes);
      } catch {
        html = bytes.toString('utf8');
      }
    } else if (/^image\//i.test(type) && enc === 'base64') {
      images.push({ type: type.trim(), loc, cid, data: body.replace(/\s+/g, '') });
    }
  }
  if (html === null) return [];
  // Inline images so the note is self-contained.
  html = html.replace(/(<img\b[^>]*?\bsrc=)(["'])([^"']+)\2/gi, (all, pre, q, src) => {
    const base = decodeURIComponent(src.split('/').pop() || '');
    const hit = images.find(
      (im) =>
        (im.cid && src === 'cid:' + im.cid) ||
        (im.loc && (im.loc === src || decodeURIComponent(im.loc.split('/').pop() || '') === base))
    );
    return hit ? `${pre}${q}data:${hit.type};base64,${hit.data}${q}` : all;
  });
  return splitHtml(html, docTitle);
}

// Native .one files are a proprietary binary format. We recover the readable
// text (stored as UTF-16LE or ANSI runs) on a best-effort basis: formatting,
// images and page boundaries are lost, and some noise may slip through.
const ONE_NOISE = /^(calibri|segoe ui|arial|times new roman|consolas|courier new|verdana|tahoma|cambria|symbol|wingdings|ms gothic|pagetitle|untitled page|p|h[1-6]|cite|code|blockquote|en-[a-z]{2}|[a-z]{2}-[a-z]{2})$/i;

function extractOneText(buf) {
  const runs = [];
  const okUnit = (c) =>
    (c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d ||
    (c >= 0xa0 && c <= 0x24f) || (c >= 0x2010 && c <= 0x2027) || c === 0x20ac;
  // UTF-16LE runs
  let i = 0;
  while (i + 1 < buf.length) {
    let j = i;
    while (j + 1 < buf.length && okUnit(buf.readUInt16LE(j))) j += 2;
    if (j - i >= 8) {
      runs.push({ pos: i, text: buf.toString('utf16le', i, j) });
      i = j;
    } else {
      i += j > i ? j - i : 1;
    }
  }
  // ANSI runs (OneNote stores pure-ASCII paragraphs this way)
  const ascii = buf.toString('latin1');
  const re = /[\x20-\x7e\t]{6,}/g;
  let m;
  while ((m = re.exec(ascii))) {
    const s = m[0];
    const letters = (s.match(/[A-Za-z ]/g) || []).length;
    if (letters / s.length >= 0.8 && /[aeiou]/i.test(s) && / /.test(s.trim())) runs.push({ pos: m.index, text: s });
  }
  runs.sort((a, b) => a.pos - b.pos);
  const seen = new Set();
  const lines = [];
  for (const run of runs) {
    for (let line of run.text.split(/[\r\n]+/)) {
      line = line.replace(/\s+/g, ' ').trim();
      if (line.length < 3 || ONE_NOISE.test(line)) continue;
      if (/^\{?[0-9a-f]{8}-[0-9a-f]{4}-/i.test(line) || /\.(one|onetoc2)$/i.test(line)) continue;
      if (!/[A-Za-zÀ-ɏ]{2}/.test(line)) continue;
      if (seen.has(line)) continue; // .one keeps old revisions of the same text
      seen.add(line);
      lines.push(line);
    }
  }
  return lines;
}

function parseOne(file, docTitle) {
  const lines = extractOneText(fs.readFileSync(file));
  const sections = [];
  let cur = [];
  let size = 0;
  const flush = () => {
    if (!cur.length) return;
    sections.push({ text: cur.join('\n'), html: cur.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n') });
    cur = [];
    size = 0;
  };
  for (const line of lines) {
    cur.push(line);
    size += line.length;
    if (size > 1200) flush();
  }
  flush();
  return sections.map((s, i) => ({
    ...s,
    title: sections.length > 1 ? `${docTitle} (part ${i + 1} of ${sections.length})` : docTitle,
  }));
}

function parseMarkdown(file, docTitle) {
  // Light-weight: headings become sections, everything else is kept as text.
  const src = fs.readFileSync(file, 'utf8');
  let html = '';
  let para = [];
  const flush = () => {
    if (para.length) html += `<p>${escapeHtml(para.join('\n')).replace(/\n/g, '<br>')}</p>\n`;
    para = [];
  };
  for (const line of src.split(/\r?\n/)) {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      html += `<h${h[1].length}>${escapeHtml(h[2])}</h${h[1].length}>\n`;
    } else if (!line.trim()) flush();
    else para.push(line);
  }
  flush();
  return splitHtml(html, docTitle);
}

async function parseFile(file) {
  const ext = path.extname(file).toLowerCase();
  const docTitle = path.basename(file, path.extname(file));
  let sections;
  let warning = null;
  switch (ext) {
    case '.docx': sections = await parseDocx(file, docTitle); break;
    case '.pdf': sections = await parsePdf(file, docTitle); break;
    case '.mht':
    case '.mhtml': sections = parseMht(file, docTitle); break;
    case '.html':
    case '.htm': sections = splitHtml(fs.readFileSync(file, 'utf8'), docTitle); break;
    case '.one':
      sections = parseOne(file, docTitle);
      warning = 'Native .one file: text recovered on a best-effort basis (no formatting, images or page titles). Export as .docx, .mht or .pdf for better results.';
      break;
    case '.md': sections = parseMarkdown(file, docTitle); break;
    case '.txt': {
      const text = fs.readFileSync(file, 'utf8').trim();
      sections = text ? [{ title: docTitle, text, html: textToHtml(text) }] : [];
      break;
    }
    default: throw new Error(`Unsupported file type: ${ext}`);
  }
  if (!sections.length && !warning) warning = 'No readable text found in this file.';
  if (!sections.length && ext === '.one') warning = 'No readable text could be recovered from this .one file. Export it as .docx, .mht or .pdf instead.';
  return { sections, warning };
}

module.exports = { parseFile, SUPPORTED, escapeHtml };
