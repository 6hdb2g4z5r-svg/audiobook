/*
 * epub.js — EPUB 2 / EPUB 3 chapter extraction.
 *
 * Reads the container, resolves the OPF, walks the spine in reading order and
 * uses the navigation document (EPUB 3 nav.xhtml or EPUB 2 toc.ncx) to name
 * chapters. Falls back to the first heading inside each document.
 */

import { cleanText } from './text.js';

const parser = new DOMParser();

function dirname(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i + 1);
}

/** Resolve `rel` against directory `base`, normalising "../" segments. */
function resolvePath(base, rel) {
  if (!rel) return '';
  if (/^[a-z]+:\/\//i.test(rel)) return rel;
  const clean = rel.replace(/^\.\//, '');
  const parts = (base + clean).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

/** Zip entries are sometimes percent-encoded in the OPF; try both spellings. */
function zipFile(zip, path) {
  return zip.file(path) || zip.file(decodeURIComponent(path)) || zip.file(encodeURI(path)) || null;
}

async function readText(zip, path) {
  const f = zipFile(zip, path);
  if (!f) return null;
  return f.async('string');
}

function xml(str) {
  return parser.parseFromString(str, 'application/xml');
}

function html(str) {
  return parser.parseFromString(str, 'text/html');
}

/** Turn an XHTML chapter document into clean, speakable plain text. */
function documentToText(doc) {
  doc.querySelectorAll('script,style,head,nav,svg,figure,figcaption,table,sup,sub').forEach((n) =>
    n.remove()
  );
  // epub:type based furniture we do not want narrated
  doc
    .querySelectorAll('[epub\\:type~="pagebreak"],[role="doc-pagebreak"],[epub\\:type~="noteref"]')
    .forEach((n) => n.remove());

  const blocks = [];
  const BLOCK = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,div,section,article,dd,dt,pre';
  const seen = new Set();
  doc.body?.querySelectorAll(BLOCK).forEach((el) => {
    // only take leaf-ish blocks so we do not duplicate nested wrappers
    if (el.querySelector(BLOCK)) return;
    const t = el.textContent.replace(/\s+/g, ' ').trim();
    if (!t) return;
    const key = t.slice(0, 80) + '|' + blocks.length;
    if (seen.has(key)) return;
    seen.add(key);
    blocks.push(t);
  });
  if (!blocks.length && doc.body) {
    const t = doc.body.textContent.replace(/\s+/g, ' ').trim();
    if (t) blocks.push(t);
  }
  return cleanText(blocks.join('\n\n'));
}

function headingOf(doc) {
  const h = doc.querySelector('h1,h2,h3,title');
  if (!h) return null;
  const t = h.textContent.replace(/\s+/g, ' ').trim();
  return t && t.length < 140 ? t : null;
}

/** Build href -> title map from an EPUB 3 nav document. */
function titlesFromNav(navDoc, navDir) {
  const map = new Map();
  const nav =
    navDoc.querySelector('nav[epub\\:type~="toc"], nav[*|type~="toc"]') || navDoc.querySelector('nav');
  if (!nav) return map;
  nav.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href').split('#')[0];
    if (!href) return;
    const key = resolvePath(navDir, href);
    const label = a.textContent.replace(/\s+/g, ' ').trim();
    if (label && !map.has(key)) map.set(key, label);
  });
  return map;
}

/** Build href -> title map from an EPUB 2 NCX document. */
function titlesFromNcx(ncxDoc, ncxDir) {
  const map = new Map();
  ncxDoc.querySelectorAll('navPoint').forEach((np) => {
    const content = np.querySelector('content');
    const label = np.querySelector('navLabel > text');
    if (!content || !label) return;
    const href = (content.getAttribute('src') || '').split('#')[0];
    if (!href) return;
    const key = resolvePath(ncxDir, href);
    const t = label.textContent.replace(/\s+/g, ' ').trim();
    if (t && !map.has(key)) map.set(key, t);
  });
  return map;
}

/**
 * @param {File|Blob} file
 * @param {(msg:string, pct:number)=>void} onProgress
 * @returns {Promise<{title:string, author:string, lang:string, cover:Blob|null,
 *                    chapters:{title:string,text:string}[]}>}
 */
export async function parseEpub(file, onProgress = () => {}) {
  onProgress('Opening EPUB…', 2);
  const zip = await JSZip.loadAsync(file);

  const containerRaw = await readText(zip, 'META-INF/container.xml');
  if (!containerRaw) throw new Error('Not a valid EPUB: META-INF/container.xml is missing.');
  const rootfile = xml(containerRaw).querySelector('rootfile');
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath) throw new Error('Not a valid EPUB: no OPF declared in the container.');

  const opfDir = dirname(opfPath);
  const opfRaw = await readText(zip, opfPath);
  if (!opfRaw) throw new Error('Not a valid EPUB: the OPF package file is missing.');
  const opf = xml(opfRaw);

  const meta = (name) => {
    const el =
      opf.querySelector(`metadata > ${name}`) ||
      opf.querySelector(`metadata > *|${name}`) ||
      [...opf.querySelectorAll('metadata > *')].find((n) => n.localName === name);
    return el ? el.textContent.trim() : '';
  };
  const title = meta('title') || file.name.replace(/\.epub$/i, '');
  const author = meta('creator') || '';
  const lang = (meta('language') || '').slice(0, 5);

  // manifest: id -> { href, type, properties }
  const manifest = new Map();
  opf.querySelectorAll('manifest > item').forEach((it) => {
    manifest.set(it.getAttribute('id'), {
      href: resolvePath(opfDir, it.getAttribute('href') || ''),
      type: it.getAttribute('media-type') || '',
      props: it.getAttribute('properties') || '',
    });
  });

  // ---- cover image ---------------------------------------------------------
  let cover = null;
  try {
    let coverItem = [...manifest.values()].find((m) => /cover-image/.test(m.props));
    if (!coverItem) {
      const metaCover = [...opf.querySelectorAll('metadata > meta')].find(
        (m) => m.getAttribute('name') === 'cover'
      );
      if (metaCover) coverItem = manifest.get(metaCover.getAttribute('content'));
    }
    if (coverItem && zipFile(zip, coverItem.href)) {
      cover = await zipFile(zip, coverItem.href).async('blob');
    }
  } catch (_) {
    /* cover is optional */
  }

  // ---- table of contents ---------------------------------------------------
  let titleMap = new Map();
  const navItem = [...manifest.values()].find((m) => /\bnav\b/.test(m.props));
  if (navItem) {
    const raw = await readText(zip, navItem.href);
    if (raw) titleMap = titlesFromNav(html(raw), dirname(navItem.href));
  }
  if (!titleMap.size) {
    const spineEl = opf.querySelector('spine');
    const ncxId = spineEl?.getAttribute('toc');
    const ncxItem =
      (ncxId && manifest.get(ncxId)) ||
      [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');
    if (ncxItem) {
      const raw = await readText(zip, ncxItem.href);
      if (raw) titleMap = titlesFromNcx(xml(raw), dirname(ncxItem.href));
    }
  }

  // ---- spine ---------------------------------------------------------------
  const spineIds = [...opf.querySelectorAll('spine > itemref')]
    .filter((ir) => ir.getAttribute('linear') !== 'no')
    .map((ir) => ir.getAttribute('idref'));

  const chapters = [];
  for (let i = 0; i < spineIds.length; i++) {
    const item = manifest.get(spineIds[i]);
    onProgress(`Reading section ${i + 1} of ${spineIds.length}…`, 5 + (i / spineIds.length) * 90);
    if (!item || !/html|xml/.test(item.type)) continue;
    const raw = await readText(zip, item.href);
    if (!raw) continue;
    const doc = html(raw);
    const heading = headingOf(doc);
    const text = documentToText(doc);
    if (text.replace(/\s/g, '').length < 200) continue; // skip covers, colophons, blank pages
    chapters.push({
      title: titleMap.get(item.href) || heading || `Section ${chapters.length + 1}`,
      text,
    });
  }

  if (!chapters.length) throw new Error('No readable text found in this EPUB.');
  onProgress('Done', 100);
  return { title, author, lang, cover, chapters };
}
