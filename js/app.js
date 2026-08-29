/*
 * app.js — application shell: navigation, import, conversion and playback UI.
 */

import { DB, requestPersistence, storageEstimate } from './db.js';
import { parseEpub } from './epub.js';
import { parsePdf } from './pdfbook.js';
import { estimateMinutes, formatBytes, formatDuration } from './text.js';
import {
  Conversion,
  GOOGLE_LANGUAGES,
  providerOf,
  modelOf,
  listVoices,
  chunksFor,
  estimate,
  synthesize,
  getUsage,
  addUsage,
} from './tts.js';
import { Player } from './player.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DEFAULTS = {
  provider: 'google',
  keys: { openai: '', google: '' },
  models: { openai: 'gpt-4o-mini-tts', google: 'Chirp3-HD' },
  voices: { openai: 'ash', google: '' },
  lang: 'en-US',
  instructions:
    'Read this like a professional audiobook narrator: unhurried, warm and clear, with natural pauses at paragraph breaks. Read in the language the text is written in.',
  concurrency: 3,
  ttsSpeed: 1,
  theme: 'auto',
};

/** Current engine settings, flattened into what the TTS layer expects. */
function engine() {
  const s = state.settings;
  return {
    provider: s.provider,
    apiKey: s.keys[s.provider] || '',
    model: s.models[s.provider],
    voice: s.voices[s.provider],
    lang: s.lang,
    instructions: s.instructions,
    speed: Number(s.ttsSpeed) || 1,
    concurrency: Number(s.concurrency) || 3,
  };
}

const state = {
  settings: { ...DEFAULTS },
  view: 'library',
  books: [],
  book: null,
  chapters: [],
  pending: null, // parsed-but-not-saved book
  conversion: null,
  coverUrls: new Map(),
  wakeLock: null,
};

const player = new Player();

// Debug handle — handy from Safari's Web Inspector when something misbehaves.
window.lisan = { player, state, DB };

// ===========================================================================
// Boot
// ===========================================================================

(async function boot() {
  for (const k of Object.keys(DEFAULTS)) {
    const stored = await DB.get(k, null);
    state.settings[k] =
      stored && typeof DEFAULTS[k] === 'object' && !Array.isArray(DEFAULTS[k])
        ? { ...DEFAULTS[k], ...stored }
        : stored ?? DEFAULTS[k];
  }
  // Carry over settings saved before the engine picker existed.
  const legacyKey = await DB.get('apiKey', '');
  if (legacyKey && !state.settings.keys.openai) {
    state.settings.keys.openai = legacyKey;
    state.settings.provider = 'openai';
    const legacyModel = await DB.get('model', null);
    const legacyVoice = await DB.get('voice', null);
    if (legacyModel) state.settings.models.openai = legacyModel;
    if (legacyVoice) state.settings.voices.openai = legacyVoice;
    await DB.set('keys', state.settings.keys);
    await DB.set('provider', 'openai');
    await DB.set('models', state.settings.models);
    await DB.set('voices', state.settings.voices);
    await DB.del('apiKey');
  }
  player.rate = await DB.get('rate', 1);
  applyTheme(state.settings.theme);
  requestPersistence();

  bindShell();
  bindImport();
  bindSettings();
  bindPlayer();
  await fillSettings();

  await refreshLibrary();
  await restoreLastSession();
  updateStorage();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

// ===========================================================================
// Chrome: navigation, toast, modal
// ===========================================================================

function show(view, opts = {}) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const titles = { library: 'Library', import: 'Add book', settings: 'Settings', book: '' };
  $('#title').textContent = opts.title || titles[view] || '';
  $('#btn-back').classList.toggle('hidden', view !== 'book');
  $('#btn-action').classList.add('hidden');
  window.scrollTo(0, 0);
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), bad ? 4200 : 2400);
}

function modal(html) {
  $('#modal-panel').innerHTML = html;
  $('#modal').classList.add('open');
  return $('#modal-panel');
}
function closeModal() {
  $('#modal').classList.remove('open');
}

function bindShell() {
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  $('#btn-back').addEventListener('click', () => show('library'));
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') closeModal();
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.conversion) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

function applyTheme(theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

// ===========================================================================
// Library
// ===========================================================================

function coverUrl(book) {
  if (!book.cover) return null;
  if (!state.coverUrls.has(book.id)) state.coverUrls.set(book.id, URL.createObjectURL(book.cover));
  return state.coverUrls.get(book.id);
}

async function refreshLibrary() {
  state.books = (await DB.allBooks()).sort(
    (a, b) => (b.lastPlayed || b.createdAt) - (a.lastPlayed || a.createdAt)
  );
  const host = $('#library-list');
  host.innerHTML = '';

  if (!state.books.length) {
    host.append(
      el(
        'div',
        'empty',
        `<div class="glyph">🎧</div><h2>Your shelf is empty</h2>
         <p class="small">Add an EPUB or PDF and Lisan will narrate it chapter by chapter, ready to download and play offline.</p>
         <button class="btn primary" style="margin-top:18px" id="empty-add">Add your first book</button>`
      )
    );
    $('#empty-add').addEventListener('click', () => show('import'));
    return;
  }

  for (const book of state.books) {
    const chapters = await DB.chaptersOf(book.id);
    const ready = chapters.filter((c) => c.status === 'ready').length;
    const secs = chapters.reduce((n, c) => n + (c.duration || 0), 0);
    const pos = await DB.get('pos:' + book.id, null);

    const row = el('div', 'book');
    const art = coverUrl(book);
    row.innerHTML = `
      ${art ? `<img class="cover" src="${art}" alt="">` : `<div class="cover">${esc((book.title || '?')[0].toUpperCase())}</div>`}
      <div class="grow">
        <h3 class="truncate">${esc(book.title)}</h3>
        <div class="tiny muted truncate">${esc(book.author || 'Unknown author')}</div>
        <div class="row" style="gap:8px;margin-top:7px">
          ${
            ready === chapters.length && chapters.length
              ? `<span class="pill ok">${chapters.length} chapters</span>`
              : `<span class="pill warn">${ready} of ${chapters.length} ready</span>`
          }
          ${secs ? `<span class="tiny muted">${formatDuration(secs)}</span>` : ''}
        </div>
        ${
          pos && ready
            ? `<div class="bar" style="margin-top:9px"><i style="width:${listenedPct(chapters, pos)}%"></i></div>`
            : ''
        }
      </div>
      <svg style="width:18px;height:18px;color:var(--text-3);transform:rotate(180deg)"><use href="#i-chev"/></svg>`;
    row.addEventListener('click', () => openBook(book.id));
    host.append(row);
  }
}

function listenedPct(chapters, pos) {
  const total = chapters.reduce((n, c) => n + (c.duration || 0), 0);
  if (!total) return 0;
  let done = 0;
  for (let i = 0; i < pos.chapterIndex && i < chapters.length; i++) done += chapters[i].duration || 0;
  done += pos.seconds || 0;
  return Math.min(100, (done / total) * 100);
}

// ===========================================================================
// Book view
// ===========================================================================

async function openBook(id) {
  const book = await DB.getBook(id);
  if (!book) return;
  state.book = book;
  state.chapters = await DB.chaptersOf(id);
  show('book', { title: book.title });
  renderBook();
}

async function renderBook() {
  const book = state.book;
  const chapters = state.chapters;
  const ready = chapters.filter((c) => c.status === 'ready');
  const pendingCh = chapters.filter((c) => c.status !== 'ready');
  const secs = ready.reduce((n, c) => n + (c.duration || 0), 0);
  const bytes = ready.reduce((n, c) => n + (c.audioSize || 0), 0);
  const art = coverUrl(book);

  $('#book-head').innerHTML = `
    <div class="card row" style="align-items:flex-start;gap:16px">
      ${art ? `<img class="cover" style="width:76px;height:108px" src="${art}" alt="">` : `<div class="cover" style="width:76px;height:108px">${esc((book.title || '?')[0].toUpperCase())}</div>`}
      <div class="grow">
        <h2 style="font-size:18px;line-height:1.25">${esc(book.title)}</h2>
        <div class="small muted" style="margin:4px 0 10px">${esc(book.author || 'Unknown author')}</div>
        <div class="tiny muted">${chapters.length} chapters · ${secs ? formatDuration(secs) + ' · ' : ''}${formatBytes(bytes)}</div>
      </div>
    </div>`;

  const conv = $('#book-convert');
  if (state.conversion && state.conversion.book.id === book.id) {
    conv.innerHTML = `
      <div class="card">
        <div class="row"><div class="spinner"></div><div class="grow">
          <b id="conv-msg">Converting…</b>
          <div class="bar" style="margin-top:9px"><i id="conv-bar" style="width:0%"></i></div>
          <div class="tiny muted" style="margin-top:7px" id="conv-sub">Keep this screen open while it works.</div>
        </div></div>
        <button class="btn ghost block sm" style="margin-top:14px" id="btn-stop-conv">Pause conversion</button>
      </div>`;
    $('#btn-stop-conv').addEventListener('click', () => state.conversion.cancel());
  } else if (pendingCh.length) {
    const chars = pendingCh.reduce((n, c) => n + c.text.length, 0);
    const prov = book.provider || state.settings.provider;
    const mdl = modelOf(prov, book.model || state.settings.models[prov]);
    const est = estimate(chars, prov, mdl.id, await getUsage(prov, mdl.id));
    const remainingCost =
      est.cost < 0.005 ? ' · free within this month’s allowance' : ` · about $${est.cost.toFixed(2)}`;
    conv.innerHTML = `
      <div class="card">
        <div class="spread" style="margin-bottom:12px">
          <div><b>${pendingCh.length} chapter${pendingCh.length > 1 ? 's' : ''} still to narrate</b>
          <div class="tiny muted" style="margin-top:3px">≈ ${Math.round(estimateMinutes(chars))} min of audio${remainingCost}</div></div>
        </div>
        <button class="btn primary block" id="btn-resume-conv">${ready.length ? 'Continue converting' : 'Convert to audiobook'}</button>
      </div>`;
    $('#btn-resume-conv').addEventListener('click', () => startConversion(book, chapters));
  } else {
    conv.innerHTML = '';
  }

  const host = $('#book-chapters');
  host.innerHTML = '';
  chapters.forEach((c, i) => {
    const row = el('div', 'chapter');
    if (player.book?.id === book.id && player.index === i) row.classList.add('playing');
    const status =
      c.status === 'ready'
        ? `<span class="tiny muted">${formatDuration(c.duration || 0)}</span>`
        : c.status === 'converting'
        ? `<span class="pill warn">${c.doneChunks || 0}/${c.chunkCount || '?'}</span>`
        : c.status === 'error'
        ? `<span class="pill err">Failed</span>`
        : `<span class="pill">Not converted</span>`;
    row.innerHTML = `
      <span class="num">${i + 1}</span>
      <div class="grow" style="min-width:0">
        <div class="name">${esc(c.title)}</div>
        <div class="row" style="gap:8px;margin-top:3px">${status}${
          c.status === 'ready' ? '' : `<span class="tiny muted">≈ ${Math.round(estimateMinutes(c.text.length))} min</span>`
        }</div>
        ${c.error ? `<div class="tiny" style="color:var(--bad);margin-top:4px">${esc(c.error)}</div>` : ''}
      </div>`;
    if (c.status === 'ready') {
      const dl = el('button', 'icon-btn', '<svg><use href="#i-down"/></svg>');
      dl.title = 'Save this chapter';
      dl.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadChapter(book, c);
      });
      const pl = el('button', 'icon-btn', '<svg><use href="#i-play"/></svg>');
      pl.style.color = 'var(--accent)';
      pl.addEventListener('click', (e) => {
        e.stopPropagation();
        playChapter(i);
      });
      row.append(dl, pl);
      row.addEventListener('click', () => playChapter(i));
    }
    host.append(row);
  });

  $('#btn-download-all').classList.toggle('hidden', !ready.length);
}

$('#btn-delete-book').addEventListener('click', () => {
  const book = state.book;
  modal(`<h3>Remove “${esc(book.title)}”?</h3>
    <p class="small muted">The book, its text and all downloaded audio will be deleted from this device.</p>
    <div class="stack" style="margin-top:18px">
      <button class="btn danger block" id="m-yes">Remove everything</button>
      <button class="btn ghost block" id="m-no">Keep it</button>
    </div>`);
  $('#m-no').addEventListener('click', closeModal);
  $('#m-yes').addEventListener('click', async () => {
    closeModal();
    if (player.book?.id === book.id) {
      player.pause();
      $('#mini').classList.remove('up');
      player.book = null;
    }
    await DB.deleteBook(book.id);
    state.coverUrls.delete(book.id);
    await refreshLibrary();
    show('library');
    toast('Removed');
  });
});

$('#btn-download-all').addEventListener('click', async () => {
  const book = state.book;
  const ready = state.chapters.filter((c) => c.status === 'ready');
  if (!ready.length) return;
  const btn = $('#btn-download-all');
  btn.disabled = true;
  btn.textContent = 'Packing…';
  try {
    const zip = new JSZip();
    const folder = zip.folder(safeName(book.title));
    for (const c of ready) {
      const row = await DB.getAudio(c.id);
      if (row?.blob) {
        folder.file(`${String(c.index + 1).padStart(2, '0')} — ${safeName(c.title)}.mp3`, row.blob);
      }
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    await saveFile(blob, `${safeName(book.title)}.zip`, 'application/zip');
  } catch (e) {
    toast('Could not build the zip — try saving chapters one at a time.', true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg style="width:18px;height:18px"><use href="#i-down"/></svg>Download all chapters (.zip)';
  }
});

const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 70);

/**
 * Hand a file to the user. On iPhone and iPad the share sheet is the route that
 * actually reaches Files, Books or AirDrop, so it is tried first; everywhere
 * else (and if sharing is declined) a normal download link does the job.
 */
async function saveFile(blob, filename, mime = 'audio/mpeg') {
  const file = new File([blob], filename, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user closed the sheet
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 30000);
}

async function downloadChapter(book, chapter) {
  const row = await DB.getAudio(chapter.id);
  if (!row?.blob) return toast('That chapter is not converted yet.', true);
  await saveFile(
    row.blob,
    `${safeName(book.title)} - ${String(chapter.index + 1).padStart(2, '0')} ${safeName(chapter.title)}.mp3`
  );
}

// ===========================================================================
// Import
// ===========================================================================

function bindImport() {
  const drop = $('#drop');
  const input = $('#file');
  $('#btn-pick').addEventListener('click', () => input.click());
  drop.addEventListener('click', (e) => {
    if (e.target === drop) input.click();
  });
  input.addEventListener('change', () => {
    if (input.files[0]) handleFile(input.files[0]);
    input.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove('over');
    })
  );
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });

  $('#btn-cancel-import').addEventListener('click', () => {
    state.pending = null;
    importStep('pick');
  });
  $('#btn-toggle-all').addEventListener('click', () => {
    const anyOff = state.pending.chapters.some((c) => !c.include);
    state.pending.chapters.forEach((c) => (c.include = anyOff));
    renderReview();
  });
  $('#btn-convert').addEventListener('click', saveAndConvert);
  ['#meta-title', '#meta-author'].forEach((s) =>
    $(s).addEventListener('input', () => {
      if (state.pending) {
        state.pending.title = $('#meta-title').value;
        state.pending.author = $('#meta-author').value;
      }
    })
  );
}

function importStep(step) {
  ['pick', 'parse', 'review'].forEach((s) =>
    $('#import-step-' + s).classList.toggle('hidden', s !== step)
  );
  show('import');
}

async function handleFile(file) {
  const isEpub = /\.epub$/i.test(file.name) || file.type === 'application/epub+zip';
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  if (!isEpub && !isPdf) return toast('Please choose an EPUB or PDF file.', true);

  importStep('parse');
  const onProgress = (msg, pct) => {
    $('#parse-msg').textContent = msg;
    $('#parse-bar').style.width = Math.min(100, pct) + '%';
  };

  try {
    const parsed = isEpub ? await parseEpub(file, onProgress) : await parsePdf(file, onProgress);
    parsed.chapters.forEach((c) => (c.include = true));
    state.pending = parsed;
    $('#meta-title').value = parsed.title || '';
    $('#meta-author').value = parsed.author || '';
    renderReview();
    importStep('review');
  } catch (e) {
    console.error(e);
    importStep('pick');
    toast(e.message || 'That file could not be read.', true);
  }
}

function renderReview() {
  const chapters = state.pending.chapters;
  const host = $('#review-list');
  host.innerHTML = '';
  chapters.forEach((c, i) => {
    const row = el('div', 'chapter-edit');
    const box = el('button', 'chk' + (c.include ? ' on' : ''), '✓');
    box.addEventListener('click', () => {
      c.include = !c.include;
      box.classList.toggle('on', c.include);
      updateEstimate();
    });
    const input = el('input');
    input.type = 'text';
    input.value = c.title;
    input.addEventListener('input', () => (c.title = input.value));
    const meta = el('span', 'tiny muted', `${Math.round(estimateMinutes(c.text.length))}m`);
    meta.style.flex = 'none';
    row.append(box, input, meta);
    host.append(row);
  });
  $('#chapter-count').textContent = `(${chapters.length})`;
  updateEstimate();
}

async function updateEstimate() {
  const included = state.pending.chapters.filter((c) => c.include);
  const chars = included.reduce((n, c) => n + c.text.length, 0);
  const opts = engine();
  const p = providerOf(opts.provider);
  const model = modelOf(opts.provider, opts.model);
  const requests = included.reduce((n, c) => n + chunksFor(c.text, opts.provider).length, 0);
  const used = await getUsage(opts.provider, model.id);
  const est = estimate(chars, opts.provider, model.id, used);
  const mins = estimateMinutes(chars);
  const ready = !!opts.apiKey && !!opts.voice;

  const costLine = est.cost < 0.005
    ? `<b style="color:var(--good)">Free</b>`
    : `<b>≈ $${est.cost.toFixed(2)}</b>`;

  $('#estimate').innerHTML = `
    <div class="spread"><span class="small muted">Selected</span><b>${included.length} chapters</b></div>
    <div class="spread" style="margin-top:8px"><span class="small muted">Estimated length</span><b>${
      mins >= 60 ? (mins / 60).toFixed(1) + ' hours' : Math.round(mins) + ' min'
    }</b></div>
    <div class="spread" style="margin-top:8px"><span class="small muted">Estimated cost</span>${costLine}</div>
    ${
      est.allowance
        ? `<div class="hint" style="margin-top:10px">${
            est.billable === 0
              ? `Covered by your free monthly allowance — ${est.remaining.toLocaleString()} of ${est.allowance.toLocaleString()} characters left before this book, ${(
                  est.remaining - est.free
                ).toLocaleString()} after.`
              : `${est.free.toLocaleString()} characters fall inside this month's free allowance; ${est.billable.toLocaleString()} would be billed at $${
                  model.price
                } per million. Converting some chapters now and the rest next month would cost nothing.`
          }</div>`
        : ''
    }
    <div class="hint" style="margin-top:${est.allowance ? '6' : '10'}px">${requests.toLocaleString()} requests to ${esc(
      p.name
    )} ${esc(model.name)}, ${chars.toLocaleString()} characters. Figures are estimates based on published rates.</div>
    ${
      ready
        ? ''
        : `<div class="hint" style="color:var(--bad)">${
            opts.apiKey ? 'Pick a narrator in Settings before converting.' : `Add your ${esc(p.name)} API key in Settings before converting.`
          }</div>`
    }`;

  $('#btn-convert').disabled = !included.length || !ready;
}

/** Books without artwork get a generated jacket so the shelf never looks broken. */
function makeCover(title, author) {
  const W = 400;
  const H = 600;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#1c2231');
  grad.addColorStop(1, '#0a0c11');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  g.fillStyle = '#f0b429';
  g.fillRect(0, 0, 14, H);
  g.globalAlpha = 0.16;
  g.fillRect(46, 96, 60, 4);
  g.globalAlpha = 1;

  const words = String(title || 'Untitled').split(/\s+/);
  let size = words.some((w) => w.length > 12) ? 30 : 36;
  const lines = [];
  g.font = `650 ${size}px -apple-system, "SF Pro Display", Helvetica, sans-serif`;
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (g.measureText(test).width > W - 100 && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  while (lines.length > 7) lines.pop();

  g.fillStyle = '#eef1f7';
  let y = 150;
  for (const l of lines) {
    g.fillText(l, 46, y);
    y += size * 1.24;
  }

  if (author) {
    g.font = '400 20px -apple-system, Helvetica, sans-serif';
    g.fillStyle = '#9aa4bb';
    g.fillText(String(author).slice(0, 34), 46, Math.min(y + 26, H - 60));
  }

  g.font = '650 15px -apple-system, Helvetica, sans-serif';
  g.fillStyle = '#f0b429';
  g.fillText('AUDIOBOOK', 46, H - 44);

  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.88));
}

async function saveAndConvert() {
  const p = state.pending;
  const included = p.chapters.filter((c) => c.include);
  if (!included.length) return;

  const eng = engine();
  const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const title = ($('#meta-title').value || p.title || 'Untitled').trim();
  const author = ($('#meta-author').value || p.author || '').trim();
  const book = {
    id,
    title,
    author,
    lang: p.lang || '',
    cover: p.cover || (await makeCover(title, author)),
    createdAt: Date.now(),
    lastPlayed: 0,
    provider: eng.provider,
    model: eng.model,
    voice: eng.voice,
    voiceLang: eng.lang,
    chapterCount: included.length,
    totalChars: included.reduce((n, c) => n + c.text.length, 0),
  };
  const chapters = included.map((c, i) => ({
    id: `${id}:${i}`,
    bookId: id,
    index: i,
    title: c.title.trim() || `Chapter ${i + 1}`,
    text: c.text,
    chars: c.text.length,
    status: 'pending',
    chunkCount: chunksFor(c.text, eng.provider).length,
    doneChunks: 0,
    duration: 0,
    audioSize: 0,
  }));

  await DB.putBook(book);
  await DB.putChapters(chapters);
  state.pending = null;
  importStep('pick');
  await refreshLibrary();

  state.book = book;
  state.chapters = chapters;
  show('book', { title: book.title });
  renderBook();
  startConversion(book, chapters);
}

// ===========================================================================
// Conversion
// ===========================================================================

async function startConversion(book, chapters) {
  if (state.conversion) return toast('A conversion is already running.');
  const eng = engine();
  if (!eng.apiKey) {
    show('settings');
    return toast(`Add your ${providerOf(eng.provider).name} API key first.`, true);
  }
  const todo = chapters.filter((c) => c.status !== 'ready');
  if (!todo.length) return;

  // A book keeps the engine it was started with, so a half-converted book
  // does not end up with two different narrators.
  const provider = book.provider || eng.provider;
  const model = book.model || eng.model;
  const conv = new Conversion(book, todo, {
    ...eng,
    provider,
    model,
    apiKey: state.settings.keys[provider] || '',
    voice: book.voice || eng.voice,
    lang: book.voiceLang || eng.lang,
    onBilled: async (chars) => {
      await addUsage(provider, model, chars);
    },
  });
  state.conversion = conv;
  keepAwake(true);
  renderBook();

  conv.addEventListener('progress', (e) => {
    const d = e.detail;
    const bar = $('#conv-bar');
    if (!bar) return;
    bar.style.width = Math.min(100, d.pct) + '%';
    $('#conv-msg').textContent =
      d.phase === 'retrying' ? 'Waiting…' : `Narrating ${d.title ? '“' + d.title + '”' : ''}`;
    $('#conv-sub').textContent =
      d.message || `${Math.round(d.pct)}% · keep this screen open while it works.`;
  });

  conv.addEventListener('chapter', async (e) => {
    const idx = state.chapters.findIndex((c) => c.id === e.detail.chapter.id);
    if (idx >= 0) state.chapters[idx] = e.detail.chapter;
    if (state.view === 'book' && state.book?.id === book.id) {
      const host = $('#book-chapters');
      const scroll = window.scrollY;
      renderBook();
      window.scrollTo(0, scroll);
    }
  });

  const finish = async (msg, bad = false) => {
    state.conversion = null;
    keepAwake(false);
    state.chapters = await DB.chaptersOf(book.id);
    await refreshLibrary();
    if (state.book?.id === book.id) await renderBook();
    updateStorage();
    updateAllowance();
    if (msg) toast(msg, bad);
  };

  conv.addEventListener('done', (e) =>
    finish(e.detail.cancelled ? 'Paused — your finished chapters are saved.' : 'Audiobook ready.')
  );
  conv.addEventListener('error', (e) => finish(e.detail.message, true));

  conv.run();
}

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', reacquire);
    } else if (!on && state.wakeLock) {
      document.removeEventListener('visibilitychange', reacquire);
      await state.wakeLock.release();
      state.wakeLock = null;
    }
  } catch (_) {
    /* not supported */
  }
}
async function reacquire() {
  if (document.visibilityState === 'visible' && state.conversion && 'wakeLock' in navigator) {
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
    } catch (_) {
      /* ignore */
    }
  }
}

// ===========================================================================
// Playback UI
// ===========================================================================

async function playChapter(index) {
  const chapter = state.chapters[index];
  if (!chapter || chapter.status !== 'ready') return;
  const pos = await DB.get('pos:' + state.book.id, null);
  const seconds = pos && pos.chapterIndex === index && !pos.finished ? pos.seconds : 0;
  await player.load({ ...state.book, coverUrl: coverUrl(state.book) }, state.chapters, index, {
    autoplay: true,
    seconds,
  });
  openPlayer();
}

function openPlayer() {
  $('#player').classList.add('up');
}
function closePlayer() {
  $('#player').classList.remove('up');
}

function bindPlayer() {
  $('#player-close').addEventListener('click', closePlayer);
  $('#mini-open').addEventListener('click', openPlayer);
  $('#mini-play').addEventListener('click', () => player.toggle());
  $('#mini-back').addEventListener('click', () => player.skip(-15));
  $('#p-play').addEventListener('click', () => player.toggle());
  $('#p-back').addEventListener('click', () => player.skip(-15));
  $('#p-fwd').addEventListener('click', () => player.skip(30));
  $('#p-prev').addEventListener('click', () => player.prev());
  $('#p-next').addEventListener('click', () => player.next());
  $('#p-save').addEventListener('click', () => {
    if (player.current && state.book) downloadChapter(player.book, player.current);
  });
  $('#player-list').addEventListener('click', () => {
    closePlayer();
    if (player.book) openBook(player.book.id);
  });

  const scrub = $('#scrub');
  let scrubbing = false;
  scrub.addEventListener('input', () => {
    scrubbing = true;
    const d = player.audio.duration || 0;
    $('#t-now').textContent = formatDuration((scrub.value / 1000) * d);
  });
  scrub.addEventListener('change', () => {
    const d = player.audio.duration || 0;
    player.seek((scrub.value / 1000) * d);
    scrubbing = false;
  });

  $('#p-speed').addEventListener('click', () => {
    const rates = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
    const panel = modal(
      `<h3>Playback speed</h3><div class="stack" style="margin-top:14px">${rates
        .map(
          (r) =>
            `<button class="btn ${r === player.rate ? 'primary' : 'ghost'} block" data-rate="${r}">${r.toFixed(
              2
            ).replace(/0$/, '')}×</button>`
        )
        .join('')}</div>`
    );
    panel.querySelectorAll('[data-rate]').forEach((b) =>
      b.addEventListener('click', () => {
        player.setRate(Number(b.dataset.rate));
        closeModal();
      })
    );
  });

  $('#p-sleep').addEventListener('click', () => {
    if (player.sleepTimer) {
      player.clearSleep();
      return toast('Sleep timer off');
    }
    const opts = [5, 10, 15, 30, 45, 60];
    const panel = modal(
      `<h3>Sleep timer</h3><p class="small muted">Playback fades out and stops.</p>
       <div class="stack" style="margin-top:14px">${opts
         .map((m) => `<button class="btn ghost block" data-min="${m}">${m} minutes</button>`)
         .join('')}</div>`
    );
    panel.querySelectorAll('[data-min]').forEach((b) =>
      b.addEventListener('click', () => {
        player.startSleep(Number(b.dataset.min));
        closeModal();
        toast(`Stopping in ${b.dataset.min} minutes`);
      })
    );
  });

  player.addEventListener('track', () => {
    const book = player.book;
    const c = player.current;
    if (!book || !c) return;
    $('#mini').classList.add('up');
    $('#player-book').textContent = book.title;
    $('#player-title').textContent = c.title;
    $('#player-sub').textContent = `Chapter ${c.index + 1} of ${player.chapters.length} · ${book.author || ''}`.replace(/ · $/, '');
    $('#mini-title').textContent = c.title;
    $('#mini-sub').textContent = book.title;
    const art = book.coverUrl;
    const pa = $('#player-art');
    const ma = $('#mini-art');
    if (art) {
      pa.src = art;
      ma.src = art;
      pa.style.display = ma.style.display = '';
    } else {
      pa.removeAttribute('src');
      ma.removeAttribute('src');
    }
    if (state.view === 'book') renderBook();
  });

  player.addEventListener('state', () => {
    const icon = player.playing ? '#i-pause' : '#i-play';
    $('#p-play').innerHTML = `<svg><use href="${icon}"/></svg>`;
    $('#mini-play').innerHTML = `<svg><use href="${icon}"/></svg>`;
    $('#speed-label').textContent = player.rate.toFixed(2).replace(/0$/, '') + '×';
  });

  player.addEventListener('time', () => {
    const a = player.audio;
    const d = a.duration || 0;
    const t = a.currentTime || 0;
    if (!scrubbing) scrub.value = d ? (t / d) * 1000 : 0;
    $('#t-now').textContent = formatDuration(t);
    $('#t-left').textContent = '-' + formatDuration(Math.max(0, d - t));
    $('#mini-progress').style.width = (d ? (t / d) * 100 : 0) + '%';
  });

  player.addEventListener('sleep', (e) => {
    const left = e.detail.left;
    $('#sleep-label').textContent = left ? formatDuration(left / 1000) : 'Sleep';
    $('#p-sleep').classList.toggle('on', !!left);
  });

  player.addEventListener('failure', (e) => toast(e.detail.message, true));
  player.addEventListener('finished', () => toast('End of the book.'));
}

async function restoreLastSession() {
  const recent = state.books.find((b) => b.lastPlayed);
  if (!recent) return;
  const pos = await DB.get('pos:' + recent.id, null);
  if (!pos) return;
  const chapters = await DB.chaptersOf(recent.id);
  const c = chapters[pos.chapterIndex];
  if (!c || c.status !== 'ready') return;
  await player.load({ ...recent, coverUrl: coverUrl(recent) }, chapters, pos.chapterIndex, {
    autoplay: false,
    seconds: pos.seconds,
  });
}

// ===========================================================================
// Settings
// ===========================================================================

async function fillSettings() {
  const s = state.settings;
  const p = providerOf(s.provider);

  $$('#provider-seg button').forEach((b) => b.classList.toggle('on', b.dataset.provider === s.provider));
  $('#provider-note').textContent = p.blurb;
  $('#set-key').value = s.keys[s.provider] || '';
  $('#set-key').placeholder = p.keyPlaceholder;
  $('#key-help').innerHTML = `${esc(p.keyHelp)} Create one at <a href="${p.keyUrl}" target="_blank" rel="noopener">${
    new URL(p.keyUrl).host
  }</a>.`;
  $('#key-status').textContent = '';

  $('#set-model').innerHTML = p.models
    .map((m) => `<option value="${m.id}" ${m.id === s.models[s.provider] ? 'selected' : ''}>${m.name}</option>`)
    .join('');

  $('#wrap-lang').classList.toggle('hidden', !p.needsLanguage);
  if (p.needsLanguage) {
    $('#set-lang').innerHTML = GOOGLE_LANGUAGES.map(
      (l) => `<option value="${l.code}" ${l.code === s.lang ? 'selected' : ''}>${l.label}</option>`
    ).join('');
  }

  $('#set-instructions').value = s.instructions;
  $('#set-conc').value = s.concurrency;
  $('#conc-val').textContent = s.concurrency;
  $('#set-tspeed').value = s.ttsSpeed;
  $('#tspeed-val').textContent = Number(s.ttsSpeed).toFixed(2) + '×';
  $$('#theme-seg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === s.theme));

  await syncVoiceOptions();
  await updateAllowance();
}

async function syncVoiceOptions() {
  const s = state.settings;
  const p = providerOf(s.provider);
  const model = modelOf(s.provider, s.models[s.provider]);
  const sel = $('#set-voice');
  const note = $('#voice-note');

  const priced = model.free
    ? `${(model.free / 1e6).toFixed(model.free >= 1e6 ? 0 : 1)}M characters free each month, then $${model.price} per million.`
    : `About $${model.price} per million characters.`;
  $('#model-note').textContent = `${model.note} ${priced}`;
  $('#wrap-instructions').classList.toggle('hidden', !(p.supportsInstructions && model.instructions !== false));

  let list = [];
  note.textContent = '';
  try {
    list = await listVoices(s.provider, {
      apiKey: s.keys[s.provider],
      model: model.id,
      lang: s.lang,
    });
  } catch (e) {
    note.textContent = e.message;
  }

  if (!list.length) {
    sel.innerHTML = '<option value="">—</option>';
    if (!note.textContent) {
      note.textContent = s.keys[s.provider]
        ? 'No narrators found for this language and model.'
        : 'Add your API key above and the narrator list will load.';
    }
    return;
  }

  if (!list.some((v) => v.id === s.voices[s.provider])) {
    s.voices[s.provider] = list[0].id;
    DB.set('voices', s.voices);
  }
  sel.innerHTML = list
    .map(
      (v) =>
        `<option value="${esc(v.id)}" ${v.id === s.voices[s.provider] ? 'selected' : ''}>${esc(v.name)}${
          v.desc ? ' — ' + esc(v.desc) : ''
        }</option>`
    )
    .join('');
}

async function updateAllowance() {
  const s = state.settings;
  const model = modelOf(s.provider, s.models[s.provider]);
  const box = $('#allowance');
  if (!model.free) return box.classList.add('hidden');

  const used = await getUsage(s.provider, model.id);
  const pct = Math.min(100, (used / model.free) * 100);
  box.classList.remove('hidden');
  $('#allowance-text').textContent = `${used.toLocaleString()} of ${model.free.toLocaleString()} characters`;
  $('#allowance-bar').style.width = pct + '%';
  $('#allowance-bar').style.background = pct > 90 ? 'var(--bad)' : 'var(--accent)';
  const left = Math.max(0, model.free - used);
  $('#allowance-note').textContent =
    left > 0
      ? `About ${Math.round(left / 500000)} more full-length book${
          Math.round(left / 500000) === 1 ? '' : 's'
        } this month at no cost. Resets on the 1st.`
      : `Allowance used up for this month. Further conversions bill at $${model.price} per million characters until it resets.`;
}

function bindSettings() {
  const save = (k, v) => {
    state.settings[k] = v;
    DB.set(k, v);
  };
  const saveIn = (group, v) => {
    state.settings[group][state.settings.provider] = v;
    DB.set(group, state.settings[group]);
  };

  $$('#provider-seg button').forEach((b) =>
    b.addEventListener('click', async () => {
      save('provider', b.dataset.provider);
      await fillSettings();
    })
  );
  $('#set-key').addEventListener('change', async (e) => {
    saveIn('keys', e.target.value.trim());
    $('#key-status').textContent = '';
    await syncVoiceOptions();
  });
  $('#set-model').addEventListener('change', async (e) => {
    saveIn('models', e.target.value);
    await syncVoiceOptions();
    await updateAllowance();
  });
  $('#set-lang').addEventListener('change', async (e) => {
    save('lang', e.target.value);
    await syncVoiceOptions();
  });
  $('#set-voice').addEventListener('change', (e) => saveIn('voices', e.target.value));
  $('#set-instructions').addEventListener('change', (e) => save('instructions', e.target.value));
  $('#set-conc').addEventListener('input', (e) => {
    save('concurrency', Number(e.target.value));
    $('#conc-val').textContent = e.target.value;
  });
  $('#set-tspeed').addEventListener('input', (e) => {
    save('ttsSpeed', Number(e.target.value));
    $('#tspeed-val').textContent = Number(e.target.value).toFixed(2) + '×';
  });
  $$('#theme-seg button').forEach((b) =>
    b.addEventListener('click', () => {
      save('theme', b.dataset.theme);
      applyTheme(b.dataset.theme);
      $$('#theme-seg button').forEach((x) => x.classList.toggle('on', x === b));
    })
  );

  $('#btn-test-key').addEventListener('click', async () => {
    const status = $('#key-status');
    const opts = engine();
    if (!opts.apiKey) return (status.textContent = 'Enter a key first.');
    status.textContent = 'Checking…';
    status.style.color = '';
    try {
      await syncVoiceOptions();
      await synthesize('Hello.', { ...engine(), instructions: '' });
      status.textContent = '✓ Working';
      status.style.color = 'var(--good)';
    } catch (e) {
      status.textContent = e.message;
      status.style.color = 'var(--bad)';
    }
  });

  const SAMPLES = {
    'fr-FR': 'Chapitre un. La lumière du matin entrait de biais par les volets, et pendant un long moment, personne ne bougea.',
    'fr-CA': 'Chapitre un. La lumière du matin entrait de biais par les volets, et pendant un long moment, personne ne bougea.',
    'es-ES': 'Capítulo uno. La luz de la mañana entraba de lado por las contraventanas, y durante un largo instante nadie se movió.',
  };

  $('#btn-preview-voice').addEventListener('click', async () => {
    const status = $('#preview-status');
    const opts = engine();
    if (!opts.apiKey) return (status.textContent = 'Enter a key first.');
    if (!opts.voice) return (status.textContent = 'Pick a narrator first.');
    status.textContent = 'Generating…';
    try {
      const sample =
        SAMPLES[opts.lang] ||
        'Chapter one. The morning light came in sideways through the shutters, and for a long moment nobody moved.';
      const blob = await synthesize(sample, opts);
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.play();
      a.addEventListener('ended', () => URL.revokeObjectURL(url));
      status.textContent = '';
      await addUsage(opts.provider, opts.model, sample.length);
      await updateAllowance();
    } catch (e) {
      status.textContent = e.message;
    }
  });
}

async function updateStorage() {
  const { usage, quota } = await storageEstimate();
  $('#storage-usage').textContent = quota ? `${formatBytes(usage)} of ${formatBytes(quota)}` : formatBytes(usage);
  $('#storage-bar').style.width = quota ? Math.min(100, (usage / quota) * 100) + '%' : '0%';
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  $('#storage-note').textContent = persisted
    ? 'Storage is marked persistent — iOS will not clear your audiobooks automatically.'
    : 'Tip: add Lisan to your Home Screen so iOS keeps your downloaded audio.';
}
