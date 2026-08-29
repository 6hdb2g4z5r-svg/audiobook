/*
 * text.js — text normalisation, sentence-aware chunking and estimates.
 */

/** Characters a TTS request will happily read. Everything else is noise. */
export function cleanText(raw) {
  if (!raw) return '';
  let t = raw;

  t = t.replace(/\r\n?/g, '\n');
  t = t.replace(/­/g, ''); // soft hyphen
  t = t.replace(/[​-‍﻿]/g, ''); // zero-width
  t = t.replace(/[  -   　]/g, ' '); // exotic spaces

  // ligatures - some PDFs emit them literally
  t = t
    .replace(/ﬀ/g, 'ff')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi')
    .replace(/ﬄ/g, 'ffl');

  // typographic normalisation that helps prosody
  t = t.replace(/[‐-―]/g, '—');
  t = t.replace(/[‘’‛]/g, "'").replace(/[“”„]/g, '"');
  t = t.replace(/\.\.\./g, '…');

  // words broken across a line by hyphenation: "exam-\nple" -> "example"
  t = t.replace(/([\p{Ll}])[-—]\n([\p{Ll}])/gu, '$1$2');

  // a single newline inside a paragraph is a line wrap, not a break
  t = t.replace(/([^\n])\n(?!\n)([^\n])/g, '$1 $2');

  t = t.replace(/[ \t ]+/g, ' ');
  t = t.replace(/ *\n */g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');

  // isolated footnote/endnote markers left over from stripping <sup>
  t = t.replace(/(?<=[.!?"'’”])\s*\[\d{1,3}\]/g, '');

  return t.trim();
}

/**
 * Split text into TTS-sized chunks, never cutting a sentence in half unless a
 * single sentence is longer than the limit (then we fall back to clause, then
 * word boundaries).
 *
 * @param {string} text
 * @param {number} max  hard character ceiling per chunk
 */
export function chunkText(text, max = 3200) {
  const out = [];
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  let buf = '';
  const push = () => {
    const v = buf.trim();
    if (v) out.push(v);
    buf = '';
  };

  for (const para of paragraphs) {
    if (buf && buf.length + para.length + 2 > max) push();

    if (para.length <= max) {
      buf = buf ? buf + '\n\n' + para : para;
      continue;
    }

    // paragraph alone exceeds the limit — go sentence by sentence
    for (const sentence of splitSentences(para)) {
      if (sentence.length > max) {
        for (const piece of hardSplit(sentence, max)) {
          if (buf && buf.length + piece.length + 1 > max) push();
          buf = buf ? buf + ' ' + piece : piece;
        }
        continue;
      }
      if (buf && buf.length + sentence.length + 1 > max) push();
      buf = buf ? buf + ' ' + sentence : sentence;
    }
  }
  push();
  return out;
}

const ABBREV =
  /\b(?:M|Mr|Mrs|Ms|Dr|Pr|Prof|St|Ste|Mme|Mlle|MM|etc|vol|no|pp|fig|cf|al|ed|op|ch|art|env|approx|Inc|Ltd|Co|Jr|Sr|Ph|Sc|e\.g|i\.e|p\.ex|c\.-à-d)\.$/i;

/** Sentence splitter tuned for English and French prose. */
export function splitSentences(text) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '.' && c !== '!' && c !== '?' && c !== '…') continue;

    // swallow trailing quotes / brackets / repeated punctuation
    let end = i + 1;
    while (end < text.length && /["'»”’\)\]…!?\.]/.test(text[end])) end++;

    const next = text[end];
    if (next && !/\s/.test(next)) continue; // e.g. "3.14", "google.com"

    const candidate = text.slice(start, end);
    if (ABBREV.test(candidate.trimEnd())) continue; // "Dr." is not a sentence end
    if (/\b\p{Lu}\.$/u.test(candidate.trimEnd())) continue; // single initial "J."

    parts.push(candidate.trim());
    start = end;
    i = end - 1;
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts.filter(Boolean);
}

function hardSplit(s, max) {
  const out = [];
  let rest = s;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(
      window.lastIndexOf('; '),
      window.lastIndexOf(', '),
      window.lastIndexOf(' — '),
      window.lastIndexOf(': ')
    );
    if (cut < max * 0.4) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/** Rough narration length: ~150 words/min, ~5.7 chars/word including spaces. */
export function estimateMinutes(chars) {
  return chars / 860;
}

export function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / 1048576;
  if (mb < 1) return (bytes / 1024).toFixed(0) + ' KB';
  if (mb < 1024) return mb.toFixed(mb < 10 ? 1 : 0) + ' MB';
  return (mb / 1024).toFixed(2) + ' GB';
}
