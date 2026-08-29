/*
 * player.js — offline audio playback.
 *
 * Audio is served from IndexedDB blobs, so once a book is converted nothing
 * touches the network again. Media Session wiring puts real chapter titles and
 * transport controls on the iPhone lock screen and in Control Centre.
 */

import { DB } from './db.js';

export class Player extends EventTarget {
  constructor() {
    super();
    const a = new Audio();
    a.preload = 'metadata';
    a.setAttribute('playsinline', '');
    this.audio = a;
    this.book = null;
    this.chapters = [];
    this.index = -1;
    this.url = null;
    this.rate = 1;
    this.sleepTimer = null;
    this.sleepEndsAt = 0;
    this._saveTick = 0;

    a.addEventListener('timeupdate', () => {
      this.emit('time');
      const now = Date.now();
      if (now - this._saveTick > 4000) {
        this._saveTick = now;
        this.savePosition();
      }
    });
    a.addEventListener('play', () => {
      this.emit('state');
      this.updateSession();
    });
    a.addEventListener('pause', () => {
      this.emit('state');
      this.savePosition();
    });
    a.addEventListener('ended', () => this.next(true));
    a.addEventListener('loadedmetadata', () => this.emit('time'));
    a.addEventListener('error', () => this.emit('failure', { message: 'This chapter could not be played.' }));

    this.setupSession();
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get current() {
    return this.index >= 0 ? this.chapters[this.index] : null;
  }
  get playing() {
    return !this.audio.paused && !this.audio.ended;
  }

  async load(book, chapters, index, { autoplay = true, seconds = 0 } = {}) {
    const chapter = chapters[index];
    if (!chapter) return;
    const row = await DB.getAudio(chapter.id);
    if (!row || !row.blob) {
      this.emit('failure', { message: 'That chapter has not been converted yet.' });
      return;
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.book = book;
    this.chapters = chapters;
    this.index = index;
    this.url = URL.createObjectURL(row.blob);
    this.audio.src = this.url;
    this.audio.playbackRate = this.rate;
    this.audio.currentTime = 0;

    const start = () => {
      if (seconds > 0 && seconds < (row.duration || Infinity) - 2) {
        try {
          this.audio.currentTime = seconds;
        } catch (_) {
          /* seek before metadata */
        }
      }
      this.audio.removeEventListener('loadedmetadata', start);
    };
    this.audio.addEventListener('loadedmetadata', start);

    this.emit('track');
    this.updateSession();
    await DB.putBook({ ...book, lastPlayed: Date.now() });
    if (autoplay) {
      try {
        await this.audio.play();
      } catch (_) {
        this.emit('state'); // iOS needs a user gesture; the UI shows Play
      }
    }
    this.savePosition();
  }

  async play() {
    try {
      await this.audio.play();
    } catch (_) {
      /* ignored */
    }
  }
  pause() {
    this.audio.pause();
  }
  toggle() {
    this.playing ? this.pause() : this.play();
  }

  seek(seconds) {
    if (!isFinite(seconds)) return;
    this.audio.currentTime = Math.max(0, Math.min(seconds, this.audio.duration || seconds));
    this.emit('time');
  }
  skip(delta) {
    this.seek((this.audio.currentTime || 0) + delta);
  }

  setRate(rate) {
    this.rate = rate;
    this.audio.playbackRate = rate;
    DB.set('rate', rate);
    this.emit('state');
  }

  /**
   * Index of the next/previous chapter that actually has audio. Unconverted
   * chapters are stepped over rather than stopping playback dead — you can
   * narrate a book in pieces and still listen straight through what you have.
   */
  findReady(from, step) {
    for (let i = from; i >= 0 && i < this.chapters.length; i += step) {
      if (this.chapters[i]?.status === 'ready') return i;
    }
    return -1;
  }

  async next(auto = false) {
    const i = this.findReady(this.index + 1, 1);
    if (i !== -1) {
      const skipped = i - this.index - 1;
      await this.load(this.book, this.chapters, i, { autoplay: true });
      if (skipped > 0) {
        this.emit('skipped', { count: skipped });
      }
      return;
    }
    if (auto) {
      this.emit('finished');
      this.savePosition(0, true);
    }
  }

  async prev() {
    if (this.audio.currentTime > 5) return this.seek(0);
    const i = this.findReady(this.index - 1, -1);
    if (i !== -1) await this.load(this.book, this.chapters, i, { autoplay: true });
  }

  savePosition(seconds = null, finished = false) {
    if (!this.book || this.index < 0) return;
    DB.set('pos:' + this.book.id, {
      chapterIndex: this.index,
      seconds: seconds === null ? this.audio.currentTime || 0 : seconds,
      finished,
      at: Date.now(),
    });
  }

  // ---- sleep timer --------------------------------------------------------
  startSleep(minutes) {
    this.clearSleep();
    if (!minutes) return;
    this.sleepEndsAt = Date.now() + minutes * 60000;
    this.sleepTimer = setInterval(() => {
      const left = this.sleepEndsAt - Date.now();
      if (left <= 0) {
        this.fadeOut();
        this.clearSleep();
      } else {
        this.emit('sleep', { left });
      }
    }, 1000);
    this.emit('sleep', { left: minutes * 60000 });
  }

  clearSleep() {
    if (this.sleepTimer) clearInterval(this.sleepTimer);
    this.sleepTimer = null;
    this.sleepEndsAt = 0;
    this.emit('sleep', { left: 0 });
  }

  fadeOut() {
    const from = this.audio.volume;
    let v = from;
    const step = setInterval(() => {
      v -= from / 20;
      if (v <= 0) {
        clearInterval(step);
        this.audio.pause();
        this.audio.volume = from;
      } else {
        this.audio.volume = v;
      }
    }, 150);
  }

  // ---- lock screen --------------------------------------------------------
  setupSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action, fn) => {
      try {
        ms.setActionHandler(action, fn);
      } catch (_) {
        /* unsupported action */
      }
    };
    set('play', () => this.play());
    set('pause', () => this.pause());
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
    set('seekbackward', (d) => this.skip(-(d?.seekOffset || 15)));
    set('seekforward', (d) => this.skip(d?.seekOffset || 30));
    set('seekto', (d) => {
      if (d?.seekTime != null) this.seek(d.seekTime);
    });
  }

  updateSession() {
    if (!('mediaSession' in navigator) || !this.book) return;
    const chapter = this.current;
    const artwork = this.book.coverUrl
      ? [{ src: this.book.coverUrl, sizes: '512x512', type: 'image/jpeg' }]
      : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chapter ? chapter.title : this.book.title,
        artist: this.book.author || 'Audiobook',
        album: this.book.title,
        artwork,
      });
    } catch (_) {
      /* ignore */
    }
  }
}
