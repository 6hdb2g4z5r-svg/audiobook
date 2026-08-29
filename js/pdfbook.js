/*
 * pdfbook.js — PDF text extraction with chapter detection.
 *
 * Strategy, in order of preference:
 *   1. Use the PDF's own outline (bookmarks) — the most reliable chapter map.
 *   2. Detect headings heuristically (numbering patterns + type size + position).
 *   3. Fall back to fixed-length parts so a book always converts.
 *
 * Text is rebuilt from positioned glyph runs rather than taken verbatim, so
 * line wraps, hyphenation, running heads and page numbers do not end up
 * being narrated.
 */

import { cleanText } from './text.js';

let pdfjsLib = null;

async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import('../vendor/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url)
    .href;
  return pdfjsLib;
}

const ROMAN = /^[ivxlcdm]+$/i;
const NUMBER_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|' +
  'un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize';

const HEADING_RE = new RegExp(
  `^\\s*(chapter|chapitre|chap\\.?|part|partie|book|livre|section|prologue|epilogue|épilogue|introduction|préface|preface|foreword|avant-propos|conclusion|appendix|annexe)` +
    `(\\s+(\\d{1,3}|[IVXLCDM]{1,7}|${NUMBER_WORDS}))?\\s*[.:—-]?\\s*(.{0,80})?$`,
  'i'
);

/** Group positioned text items into visual lines, keeping the largest type size. */
function itemsToLines(items, viewport) {
  const lines = [];
  let current = null;
  const yTol = 3;

  for (const it of items) {
    if (!it.str) continue;
    const t = it.transform;
    const size = Math.hypot(t[2], t[3]) || 10;
    const x = t[4];
    const y = t[5];

    if (!current || Math.abs(current.y - y) > yTol) {
      current = { y, minX: x, maxSize: size, parts: [] };
      lines.push(current);
    }
    current.minX = Math.min(current.minX, x);
    current.maxSize = Math.max(current.maxSize, size);
    current.parts.push({ x, str: it.str, w: it.width || 0, size });
    if (it.hasEOL) current = null;
  }

  return lines
    .map((ln) => {
      ln.parts.sort((a, b) => a.x - b.x);
      let text = '';
      let prevEnd = null;
      for (const p of ln.parts) {
        if (prevEnd !== null) {
          const gap = p.x - prevEnd;
          if (gap > p.size * 0.22 && !/\s$/.test(text) && !/^\s/.test(p.str)) text += ' ';
        }
        text += p.str;
        prevEnd = p.x + p.w;
      }
      return {
        text: text.replace(/\s+/g, ' ').trim(),
        y: ln.y,
        size: ln.maxSize,
        indent: ln.minX,
        pageHeight: viewport.height,
      };
    })
    .filter((l) => l.text.length);
}

const norm = (s) =>
  s
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^\p{L}#]+/gu, '')
    .slice(0, 60);

/** Lines repeated at the top/bottom of many pages are running heads, not prose. */
function findFurniture(pages) {
  const top = new Map();
  const bottom = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  // Running heads and folios are short. Never treat a full line of prose as
  // furniture, however often a phrase happens to repeat.
  const candidate = (l) => l.text.length > 2 && l.text.length <= 70;
  for (const lines of pages) {
    if (!lines.length) continue;
    for (const l of lines.slice(0, 2)) if (candidate(l)) bump(top, norm(l.text));
    for (const l of lines.slice(-2)) if (candidate(l)) bump(bottom, norm(l.text));
  }
  const threshold = Math.max(3, pages.length * 0.25);
  const furniture = new Set();
  for (const [k, n] of top) if (n >= threshold && k) furniture.add(k);
  for (const [k, n] of bottom) if (n >= threshold && k) furniture.add(k);
  return furniture;
}

const isPageNumber = (t) =>
  /^[\d\s.\-–—|]{1,12}$/.test(t) || (ROMAN.test(t.trim()) && t.trim().length <= 7);

function medianSize(pages) {
  const sizes = [];
  for (const lines of pages) for (const l of lines) if (l.text.length > 40) sizes.push(l.size);
  if (!sizes.length) return 10;
  sizes.sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)];
}

/** Resolve an outline entry to a zero-based page index. */
async function destToPage(doc, dest) {
  try {
    let d = dest;
    if (typeof d === 'string') d = await doc.getDestination(d);
    if (!Array.isArray(d) || !d[0]) return null;
    if (typeof d[0] === 'object' && d[0] !== null && 'num' in d[0]) return await doc.getPageIndex(d[0]);
    if (typeof d[0] === 'number') return d[0];
  } catch (_) {
    /* broken destination */
  }
  return null;
}

async function outlineChapters(doc) {
  let outline;
  try {
    outline = await doc.getOutline();
  } catch (_) {
    return [];
  }
  if (!outline || !outline.length) return [];

  // Take the deepest level that still looks like a chapter list (2–200 entries).
  const levels = [];
  let level = outline;
  for (let depth = 0; depth < 3 && level && level.length; depth++) {
    levels.push(level);
    const next = level.flatMap((n) => n.items || []);
    if (!next.length) break;
    level = next;
  }
  let chosen = levels[0];
  for (const lv of levels) if (lv.length >= 3 && lv.length <= 200) chosen = lv;
  if (chosen.length < 2 || chosen.length > 400) return [];

  const out = [];
  for (const node of chosen) {
    const page = await destToPage(doc, node.dest);
    const title = (node.title || '').replace(/\s+/g, ' ').trim();
    if (page === null || !title) continue;
    out.push({ title, page });
  }
  out.sort((a, b) => a.page - b.page);
  return out.filter((c, i) => i === 0 || c.page !== out[i - 1].page || c.title !== out[i - 1].title);
}

/**
 * @param {File|Blob} file
 * @param {(msg:string, pct:number)=>void} onProgress
 */
export async function parsePdf(file, onProgress = () => {}) {
  const pdfjs = await loadPdfjs();
  onProgress('Opening PDF…', 2);

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).href,
  }).promise;

  const numPages = doc.numPages;
  const meta = await doc.getMetadata().catch(() => null);
  const info = meta?.info || {};
  let title = (info.Title || '')
    .replace(/^Microsoft Word\s*-\s*/i, '')
    .replace(/\.(pdf|docx?|indd|tex)$/i, '')
    .trim();
  // Many producers stamp a placeholder here; the filename is a better guess.
  if (!title || title.length < 3 || /^(untitled|document\d*|unknown|print|output)$/i.test(title)) {
    title = file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();
  }
  const author = /^(unknown|anonymous|user|admin|none|author)$/i.test((info.Author || '').trim())
    ? ''
    : (info.Author || '').trim();

  // ---- cover thumbnail -----------------------------------------------------
  let cover = null;
  try {
    const p1 = await doc.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    const v = p1.getViewport({ scale: Math.min(420 / vp.width, 2) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(v.width);
    canvas.height = Math.ceil(v.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const task = p1.render({ canvasContext: ctx, viewport: v });
    // A malformed first page must not be able to stall the whole import.
    await Promise.race([
      task.promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('cover timeout')), 8000)),
    ]).catch((e) => {
      task.cancel();
      throw e;
    });
    cover = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
  } catch (_) {
    cover = null; // cover is optional
  }

  // ---- text ---------------------------------------------------------------
  const pages = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push(itemsToLines(content.items, viewport));
    page.cleanup();
    if (i % 3 === 0 || i === numPages) {
      onProgress(`Reading page ${i} of ${numPages}…`, 5 + (i / numPages) * 88);
    }
    if (i % 25 === 0) await new Promise((r) => setTimeout(r)); // keep the UI alive
  }

  const furniture = findFurniture(pages);
  const body = medianSize(pages);

  // Drop running heads / page numbers, remember where each page starts.
  const kept = pages.map((lines) =>
    lines.filter(
      (l) => !(l.text.length <= 70 && furniture.has(norm(l.text))) && !isPageNumber(l.text)
    )
  );

  const outline = await outlineChapters(doc);
  let chapters;

  if (outline.length >= 2) {
    chapters = outline.map((c, i) => {
      const from = c.page;
      const to = i + 1 < outline.length ? outline[i + 1].page : numPages;
      const slice = kept.slice(from, Math.max(to, from + 1));
      return { title: c.title, text: linesToProse(slice.flat(), body) };
    });
    // A chapter that starts mid-page picks up the tail of the previous one; a
    // single-page overlap is acceptable and far better than losing text.
  } else {
    chapters = heuristicChapters(kept, body);
  }

  chapters = chapters
    .map((c) => ({ title: c.title.trim() || 'Untitled', text: cleanText(c.text) }))
    .filter((c) => c.text.replace(/\s/g, '').length > 150);

  if (!chapters.length) {
    const all = cleanText(linesToProse(kept.flat(), body));
    if (all.replace(/\s/g, '').length < 150) {
      throw new Error(
        'No selectable text found. This looks like a scanned PDF — it needs OCR before it can be narrated.'
      );
    }
    chapters = splitEvenly(all);
  }

  onProgress('Done', 100);
  return { title, author, lang: '', cover, chapters, pageCount: numPages };
}

/** Join visual lines into paragraphs using indentation and line-end punctuation. */
function linesToProse(lines, bodySize) {
  const out = [];
  let para = '';
  const indents = lines.map((l) => l.indent).sort((a, b) => a - b);
  const baseIndent = indents.length ? indents[Math.floor(indents.length * 0.2)] : 0;

  for (const l of lines) {
    const t = l.text;
    if (!t) continue;
    const isHeading = l.size > bodySize * 1.18 && t.length < 90;
    const startsPara = l.indent > baseIndent + bodySize * 0.6;

    if (isHeading) {
      if (para) out.push(para.trim());
      out.push(t);
      para = '';
      continue;
    }
    if (!para) {
      para = t;
      continue;
    }
    const endsSentence = /[.!?…:"'»”)]$/.test(para);
    if (startsPara && endsSentence) {
      out.push(para.trim());
      para = t;
    } else if (/[-—]$/.test(para)) {
      para = para.replace(/[-—]$/, '') + t;
    } else {
      para += ' ' + t;
    }
  }
  if (para) out.push(para.trim());
  return out.join('\n\n');
}

function heuristicChapters(pages, bodySize) {
  const flat = [];
  pages.forEach((lines, pageIdx) =>
    lines.forEach((l, i) => flat.push({ ...l, pageIdx, firstOnPage: i === 0 }))
  );

  const marks = [];
  for (let i = 0; i < flat.length; i++) {
    const l = flat[i];
    const t = l.text.trim();
    if (t.length > 90) continue;

    const namedHeading = HEADING_RE.test(t) && t.length < 80;
    const bigType = l.size >= bodySize * 1.35 && t.length > 1;
    const bareNumber = /^\d{1,3}$/.test(t) && l.firstOnPage && l.size >= bodySize * 1.15;

    if (!namedHeading && !bigType && !bareNumber) continue;
    if (marks.length && i - marks[marks.length - 1].i < 6) continue; // subtitle on the next line

    let title = t;
    // "Chapter 4" on one line, its name on the next — join them.
    const next = flat[i + 1];
    if (next && /^(chapter|chapitre|part|partie|livre|\d{1,3}|[IVXLCDM]{1,7})\b/i.test(t) && next.text.length < 70 && next.size >= bodySize) {
      title = `${t} — ${next.text}`;
    }
    marks.push({ i, title });
  }

  if (marks.length < 2) return [];

  const chapters = [];
  if (marks[0].i > 20) {
    chapters.push({ title: 'Front matter', text: linesToProse(flat.slice(0, marks[0].i), bodySize) });
  }
  marks.forEach((m, k) => {
    const end = k + 1 < marks.length ? marks[k + 1].i : flat.length;
    chapters.push({ title: m.title, text: linesToProse(flat.slice(m.i + 1, end), bodySize) });
  });
  return chapters;
}

function splitEvenly(text, target = 14000) {
  const paras = text.split(/\n{2,}/);
  const out = [];
  let buf = '';
  for (const p of paras) {
    buf = buf ? buf + '\n\n' + p : p;
    if (buf.length >= target) {
      out.push({ title: `Part ${out.length + 1}`, text: buf });
      buf = '';
    }
  }
  if (buf.trim()) out.push({ title: `Part ${out.length + 1}`, text: buf });
  return out;
}
