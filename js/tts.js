/*
 * tts.js — narration engines, a resumable queue and MP3 joining.
 *
 * Two providers are supported behind one interface:
 *   openai  — pay per character, 13 voices, accepts free-text style direction
 *   google  — 1M characters/month free on Chirp 3 HD, 4M on WaveNet/Standard
 *
 * Every chunk of audio is cached in IndexedDB the moment it arrives, so a
 * conversion that is paused, interrupted, or that hits a network error resumes
 * exactly where it stopped and never pays for the same text twice.
 */

import { DB } from './db.js';
import { chunkText } from './text.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TTSError extends Error {
  constructor(message, { status = 0, retryable = false, retryAfter = 0 } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

const utf8 = (s) => new TextEncoder().encode(s).length;

/** Last-resort guard: providers cap by bytes, and accented French is 2 bytes. */
function enforceByteLimit(text, maxBytes) {
  if (utf8(text) <= maxBytes) return [text];
  const out = [];
  let rest = text;
  while (utf8(rest) > maxBytes) {
    let cut = Math.floor((rest.length * maxBytes) / utf8(rest));
    const space = rest.lastIndexOf(' ', cut);
    if (space > cut * 0.5) cut = space;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

const OPENAI_VOICES = [
  { id: 'alloy', name: 'Alloy', desc: 'Neutral, even' },
  { id: 'ash', name: 'Ash', desc: 'Warm, grounded' },
  { id: 'ballad', name: 'Ballad', desc: 'Soft, reflective' },
  { id: 'cedar', name: 'Cedar', desc: 'Deep, steady' },
  { id: 'coral', name: 'Coral', desc: 'Bright, expressive' },
  { id: 'echo', name: 'Echo', desc: 'Calm, measured' },
  { id: 'fable', name: 'Fable', desc: 'Storyteller, British' },
  { id: 'marin', name: 'Marin', desc: 'Clear, articulate' },
  { id: 'nova', name: 'Nova', desc: 'Crisp, energetic' },
  { id: 'onyx', name: 'Onyx', desc: 'Low, authoritative' },
  { id: 'sage', name: 'Sage', desc: 'Gentle, unhurried' },
  { id: 'shimmer', name: 'Shimmer', desc: 'Light, friendly' },
  { id: 'verse', name: 'Verse', desc: 'Lyrical, dynamic' },
];
const OPENAI_LEGACY = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);

const openai = {
  id: 'openai',
  name: 'OpenAI',
  blurb: 'Pay per character, no free allowance. The most natural delivery, and the only engine here that takes free-text style directions.',
  keyPlaceholder: 'sk-…',
  keyUrl: 'https://platform.openai.com/api-keys',
  keyHelp: 'Stored only in this browser on this device and sent straight to OpenAI.',
  maxChunk: 3600,
  maxBytes: 4000,
  needsLanguage: false,
  supportsInstructions: true,
  models: [
    { id: 'gpt-4o-mini-tts', name: 'GPT-4o mini TTS', price: 15, free: 0, instructions: true, note: 'Best balance. Natural delivery and accepts style directions.' },
    { id: 'tts-1-hd', name: 'TTS-1 HD', price: 30, free: 0, instructions: false, note: 'Highest-fidelity legacy model. Warmer, slightly slower to render.' },
    { id: 'tts-1', name: 'TTS-1', price: 15, free: 0, instructions: false, note: 'Fastest and cheapest. Fine for reference material.' },
  ],

  async listVoices({ model }) {
    return model === 'gpt-4o-mini-tts' ? OPENAI_VOICES : OPENAI_VOICES.filter((v) => OPENAI_LEGACY.has(v.id));
  },

  async synthesize(text, opts, signal) {
    const body = { model: opts.model, voice: opts.voice, input: text, response_format: 'mp3' };
    if (opts.speed && opts.speed !== 1) body.speed = Math.min(4, Math.max(0.25, opts.speed));
    if (opts.instructions && opts.model === 'gpt-4o-mini-tts') body.instructions = opts.instructions;

    let res;
    try {
      res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new TTSError('Network error — check your connection.', { retryable: true });
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json())?.error?.message || '';
      } catch (_) {
        /* not JSON */
      }
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      if (res.status === 401) throw new TTSError('Your API key was rejected. Check it in Settings.', { status: 401 });
      if (res.status === 403) throw new TTSError(detail || 'This key is not allowed to use the speech API.', { status: 403 });
      if (res.status === 429) throw new TTSError(detail || 'Rate limited or out of credit.', { status: 429, retryable: true, retryAfter });
      if (res.status >= 500) throw new TTSError('OpenAI is having trouble right now.', { status: res.status, retryable: true });
      throw new TTSError(detail || `Request failed (${res.status}).`, { status: res.status });
    }

    const blob = await res.blob();
    if (!blob.size) throw new TTSError('Empty audio returned.', { retryable: true });
    return blob;
  },
};

// ---------------------------------------------------------------------------
// Google Cloud
// ---------------------------------------------------------------------------

const GOOGLE_ENDPOINT = 'https://texttospeech.googleapis.com/v1';

/** Human-readable hints for the Chirp 3 voice names, which are all star names. */
const GOOGLE_VOICE_HINTS = {
  Achernar: 'Soft, light', Achird: 'Friendly', Algenib: 'Gravelly', Algieba: 'Smooth',
  Alnilam: 'Firm', Aoede: 'Breezy', Autonoe: 'Bright', Callirrhoe: 'Easy-going',
  Charon: 'Informative', Despina: 'Smooth', Enceladus: 'Breathy', Erinome: 'Clear',
  Fenrir: 'Lively', Gacrux: 'Mature', Iapetus: 'Clear', Kore: 'Firm',
  Laomedeia: 'Upbeat', Leda: 'Youthful', Orus: 'Firm', Pulcherrima: 'Forward',
  Puck: 'Upbeat', Rasalgethi: 'Informative', Sadachbia: 'Lively', Sadaltager: 'Knowledgeable',
  Schedar: 'Even', Sulafat: 'Warm', Umbriel: 'Easy-going', Vindemiatrix: 'Gentle',
  Zephyr: 'Bright', Zubenelgenubi: 'Casual',
};

export const GOOGLE_LANGUAGES = [
  { code: 'en-US', label: 'English (United States)' },
  { code: 'en-GB', label: 'English (United Kingdom)' },
  { code: 'fr-FR', label: 'French (France)' },
  { code: 'fr-CA', label: 'French (Canada)' },
  { code: 'es-ES', label: 'Spanish (Spain)' },
  { code: 'ar-XA', label: 'Arabic' },
  { code: 'de-DE', label: 'German' },
  { code: 'it-IT', label: 'Italian' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)' },
  { code: 'nl-NL', label: 'Dutch' },
];

function googleError(status, detail) {
  const d = detail || '';
  if (/API key not valid|API_KEY_INVALID/i.test(d))
    return new TTSError('That Google API key is not valid. Check it in Settings.', { status });
  if (/has not been used in project|is disabled|SERVICE_DISABLED/i.test(d))
    return new TTSError(
      'The Text-to-Speech API is not switched on for this Google Cloud project yet. Enable it in the console, wait a minute, then try again.',
      { status }
    );
  if (/referer|referrer|blocked|API_KEY_HTTP_REFERRER/i.test(d))
    return new TTSError(
      'This key is restricted to other websites. Add this app’s address to the key’s allowed referrers.',
      { status }
    );
  if (status === 429 || /RESOURCE_EXHAUSTED|Quota/i.test(d))
    return new TTSError(d || 'Google rate limit reached.', { status, retryable: true });
  if (status === 403)
    return new TTSError(d || 'Google refused this key. Check that billing is enabled on the project.', { status });
  if (status >= 500) return new TTSError('Google is having trouble right now.', { status, retryable: true });
  return new TTSError(d || `Request failed (${status}).`, { status });
}

async function googleCall(path, { key, method = 'GET', body, signal }) {
  const url = `${GOOGLE_ENDPOINT}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new TTSError('Network error — check your connection.', { retryable: true });
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw googleError(res.status, json?.error?.message);
  return json;
}

const base64ToBlob = (b64, type) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
};

const google = {
  id: 'google',
  name: 'Google Cloud',
  blurb:
    '1,000,000 characters a month free on Chirp 3 HD — about two 300-page books — and 4,000,000 on WaveNet. The allowance resets every month and does not expire.',
  keyPlaceholder: 'AIza…',
  keyUrl: 'https://console.cloud.google.com/apis/credentials',
  keyHelp:
    'Create an API key in a project that has the Cloud Text-to-Speech API enabled. Restrict the key to this app’s address and to the Text-to-Speech API — then it is useless to anyone else.',
  maxChunk: 2800,
  maxBytes: 4500, // hard API limit is 5,000 bytes
  needsLanguage: true,
  supportsInstructions: false,
  models: [
    { id: 'Chirp3-HD', name: 'Chirp 3 HD', price: 30, free: 1e6, note: 'Newest and most lifelike. 1M characters free each month.' },
    { id: 'Wavenet', name: 'WaveNet', price: 16, free: 4e6, note: 'Very good and far more generous: 4M characters free each month.' },
    { id: 'Neural2', name: 'Neural2', price: 16, free: 1e6, note: 'Previous-generation neural voices. 1M characters free each month.' },
    { id: 'Standard', name: 'Standard', price: 4, free: 4e6, note: 'Basic and robotic, but 4M characters free each month.' },
  ],

  /** Voices are read from the live API and cached, so the list never goes stale. */
  async listVoices({ apiKey, model, lang }) {
    const cacheKey = `voices:google:${lang}`;
    let all = await DB.get(cacheKey, null);
    if (!all) {
      if (!apiKey) return [];
      const json = await googleCall(`/voices?languageCode=${encodeURIComponent(lang)}`, { key: apiKey });
      all = (json.voices || []).map((v) => ({ name: v.name, gender: v.ssmlGender }));
      await DB.set(cacheKey, all);
    }
    const wanted = all.filter((v) => v.name.includes(`-${model}-`));
    return wanted
      .map((v) => {
        const leaf = v.name.split('-').pop();
        const gender = v.gender === 'FEMALE' ? 'F' : v.gender === 'MALE' ? 'M' : '';
        const hint = GOOGLE_VOICE_HINTS[leaf];
        return {
          id: v.name,
          name: leaf,
          desc: [hint, gender].filter(Boolean).join(', ') || v.name,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  async synthesize(text, opts, signal) {
    const json = await googleCall('/text:synthesize', {
      key: opts.apiKey,
      method: 'POST',
      signal,
      body: {
        input: { text },
        voice: { languageCode: opts.lang || 'en-US', name: opts.voice },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: Math.min(4, Math.max(0.25, opts.speed || 1)),
          sampleRateHertz: 24000,
        },
      },
    });
    if (!json?.audioContent) throw new TTSError('Empty audio returned.', { retryable: true });
    const blob = base64ToBlob(json.audioContent, 'audio/mpeg');
    if (!blob.size) throw new TTSError('Empty audio returned.', { retryable: true });
    return blob;
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const PROVIDERS = { openai, google };
export const providerOf = (id) => PROVIDERS[id] || PROVIDERS.openai;
export const modelOf = (providerId, modelId) => {
  const p = providerOf(providerId);
  return p.models.find((m) => m.id === modelId) || p.models[0];
};

export const MAX_CHUNK = 3600; // default used for pre-import estimates

export function chunksFor(text, providerId) {
  const p = providerOf(providerId);
  return chunkText(text, p.maxChunk).flatMap((c) => enforceByteLimit(c, p.maxBytes));
}

export function listVoices(providerId, opts) {
  return providerOf(providerId).listVoices(opts);
}

export function synthesize(text, opts, signal) {
  return providerOf(opts.provider).synthesize(text, opts, signal);
}

/**
 * Cost for `chars`, taking this month's already-used free allowance into account.
 * @returns {{cost:number, free:number, billable:number, allowance:number, used:number}}
 */
export function estimate(chars, providerId, modelId, usedThisMonth = 0) {
  const m = modelOf(providerId, modelId);
  const allowance = m.free || 0;
  const remaining = Math.max(0, allowance - usedThisMonth);
  const free = Math.min(chars, remaining);
  const billable = chars - free;
  return {
    cost: (billable / 1e6) * m.price,
    free,
    billable,
    allowance,
    used: usedThisMonth,
    remaining,
  };
}

export const monthKey = (d = new Date()) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export const usageKey = (providerId, modelId) => `usage:${providerId}:${modelId}:${monthKey()}`;

export async function getUsage(providerId, modelId) {
  return (await DB.get(usageKey(providerId, modelId), 0)) || 0;
}

export function addUsage(providerId, modelId, chars) {
  return DB.bump(usageKey(providerId, modelId), chars);
}

// ---------------------------------------------------------------------------
// MP3 joining
// ---------------------------------------------------------------------------

/** Strip ID3v2 / ID3v1 containers so joined frames decode as one stream. */
function stripTags(bytes) {
  let start = 0;
  let end = bytes.length;
  if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size =
      ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    start = 10 + size;
  }
  if (end - start > 128) {
    const t = end - 128;
    if (bytes[t] === 0x54 && bytes[t + 1] === 0x41 && bytes[t + 2] === 0x47) end = t;
  }
  return bytes.subarray(start, end);
}

export async function joinMp3(blobs) {
  const parts = [];
  for (const b of blobs) parts.push(stripTags(new Uint8Array(await b.arrayBuffer())));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const merged = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    merged.set(p, o);
    o += p.length;
  }
  return { blob: new Blob([merged], { type: 'audio/mpeg' }), duration: mp3Duration(merged) };
}

const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Exact duration by walking MPEG frame headers — no decoding, no guessing. */
export function mp3Duration(bytes) {
  let i = 0;
  let seconds = 0;
  const n = bytes.length;
  while (i < n - 4) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) {
      i++;
      continue;
    }
    const ver = (bytes[i + 1] >> 3) & 3;
    const layer = (bytes[i + 1] >> 1) & 3;
    const brIdx = (bytes[i + 2] >> 4) & 0xf;
    const srIdx = (bytes[i + 2] >> 2) & 3;
    const pad = (bytes[i + 2] >> 1) & 1;
    if (ver === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3 || !SR[ver]) {
      i++;
      continue;
    }
    const bitrate = (ver === 3 ? BR_V1 : BR_V2)[brIdx] * 1000;
    const rate = SR[ver][srIdx];
    const samples = ver === 3 ? 1152 : 576;
    const len = Math.floor((samples / 8) * (bitrate / rate)) + pad;
    if (len < 8) {
      i++;
      continue;
    }
    seconds += samples / rate;
    i += len;
  }
  return seconds;
}

// ---------------------------------------------------------------------------
// Conversion queue
// ---------------------------------------------------------------------------

const sleep = (ms, signal) =>
  new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        rej(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });

/**
 * Converts a whole book, chapter by chapter.
 * Emits: progress, chapter, done, error.
 */
export class Conversion extends EventTarget {
  constructor(book, chapters, opts) {
    super();
    this.book = book;
    this.chapters = chapters;
    this.opts = opts;
    this.controller = new AbortController();
    this.cancelled = false;
    this.charsDone = 0;
    this.charsTotal = chapters.reduce((n, c) => n + c.text.length, 0);
  }

  cancel() {
    this.cancelled = true;
    this.controller.abort();
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async run() {
    try {
      for (const chapter of this.chapters) {
        if (this.cancelled) break;
        if (chapter.status === 'ready') {
          this.charsDone += chapter.text.length;
          this.emit('progress', this.snapshot(chapter, 'skipped'));
          continue;
        }
        await this.convertChapter(chapter);
      }
      if (!this.cancelled) this.emit('done', {});
    } catch (e) {
      if (e.name === 'AbortError' || this.cancelled) this.emit('done', { cancelled: true });
      else this.emit('error', { message: e.message || String(e) });
    }
  }

  snapshot(chapter, phase) {
    return {
      chapterId: chapter.id,
      chapterIndex: chapter.index,
      title: chapter.title,
      phase,
      charsDone: this.charsDone,
      charsTotal: this.charsTotal,
      pct: this.charsTotal ? (this.charsDone / this.charsTotal) * 100 : 0,
    };
  }

  async convertChapter(chapter) {
    const signal = this.controller.signal;
    const pieces = chunksFor(chapter.text, this.opts.provider);

    chapter.status = 'converting';
    chapter.chunkCount = pieces.length;
    chapter.doneChunks = 0;
    delete chapter.error;
    await DB.putChapter(chapter);
    this.emit('chapter', { chapter });

    const cached = await DB.chunksOf(chapter.id);
    const byIndex = new Map(cached.map((c) => [c.index, c]));
    // A different chunking (edited text, or a provider swap) invalidates the cache.
    if (cached.length && cached.length > pieces.length) {
      await DB.clearChunksOf(chapter.id);
      byIndex.clear();
    }

    const results = new Array(pieces.length);
    let next = 0;
    const concurrency = Math.max(1, Math.min(6, this.opts.concurrency || 3));
    const startChars = this.charsDone;

    const worker = async () => {
      while (!this.cancelled) {
        const idx = next++;
        if (idx >= pieces.length) return;

        const id = `${chapter.id}:${idx}`;
        const hit = byIndex.get(idx);
        if (hit && hit.blob && hit.blob.size) {
          results[idx] = hit.blob;
        } else {
          results[idx] = await this.withRetry(() => synthesize(pieces[idx], this.opts, signal), signal);
          await DB.putChunk({ id, index: idx, chapterId: chapter.id, bookId: this.book.id, blob: results[idx] });
          try {
            await this.opts.onBilled?.(pieces[idx].length);
          } catch (_) {
            /* usage tracking is best-effort */
          }
        }

        chapter.doneChunks++;
        this.charsDone = startChars + pieces.slice(0, chapter.doneChunks).reduce((n, p) => n + p.length, 0);
        this.emit('progress', this.snapshot(chapter, 'converting'));
      }
    };

    try {
      await Promise.all(Array.from({ length: concurrency }, worker));
    } catch (e) {
      if (e.name === 'AbortError' || this.cancelled) throw e;
      chapter.status = 'error';
      chapter.error = e.message;
      await DB.putChapter(chapter);
      this.emit('chapter', { chapter });
      throw e;
    }
    if (this.cancelled) throw new DOMException('Aborted', 'AbortError');

    const { blob, duration } = await joinMp3(results.filter(Boolean));
    await DB.putAudio({ id: chapter.id, bookId: this.book.id, blob, type: 'audio/mpeg', size: blob.size, duration });
    await DB.clearChunksOf(chapter.id); // chunk cache is no longer needed

    chapter.status = 'ready';
    chapter.duration = duration;
    chapter.audioSize = blob.size;
    this.charsDone = startChars + chapter.text.length;
    await DB.putChapter(chapter);
    this.emit('chapter', { chapter });
    this.emit('progress', this.snapshot(chapter, 'chapter-done'));
  }

  async withRetry(fn, signal, attempts = 5) {
    let wait = 1200;
    for (let a = 0; a < attempts; a++) {
      try {
        return await fn();
      } catch (e) {
        if (e.name === 'AbortError' || this.cancelled) throw e;
        if (!e.retryable || a === attempts - 1) throw e;
        const delay = e.retryAfter ? e.retryAfter * 1000 : wait;
        this.emit('progress', {
          phase: 'retrying',
          message: `${e.message} Retrying in ${Math.round(delay / 1000)}s…`,
          charsDone: this.charsDone,
          charsTotal: this.charsTotal,
          pct: this.charsTotal ? (this.charsDone / this.charsTotal) * 100 : 0,
        });
        await sleep(delay, signal);
        wait = Math.min(wait * 2, 30000);
      }
    }
  }
}
