# Lisan — book to audiobook

A self-contained web app that turns an **EPUB or PDF into a chaptered audiobook**. Built for
iPhone and iPad: install it to the Home Screen, convert a book once, and the audio lives on
the device — playable on a plane, in the metro, anywhere.

Two narration engines are supported. **Google Cloud is the default and is free for normal
use** — 1,000,000 characters a month on their best voices, which is about two 300-page books,
recurring every month forever. **OpenAI** is there as the paid alternative when you want its
delivery or its free-text style directions.

There is no server. Your books never leave your device except as text sent to the engine for
narration, and your API key is stored only in your own browser.

---

## What it does

- **Reads real chapters.** EPUB chapters come from the book's own table of contents
  (EPUB 3 nav or EPUB 2 NCX). PDFs use the embedded bookmarks when present, and fall back to
  heading detection (numbering patterns, type size, page position) when they aren't.
- **Cleans the text before narrating it.** Running heads, folios, hyphenation across line
  breaks, ligatures and stray footnote markers are removed, so the narrator doesn't read
  "The Sample Voyage 47" at the top of every page.
- **Lets you edit before you spend.** Rename chapters, untick front matter and indexes, and
  see the estimated length and cost before a single request is made.
- **Never pays twice.** Every ~3,500-character chunk of audio is cached the moment it
  arrives. If the conversion fails, is paused, or the tab is closed, resuming picks up
  exactly where it stopped.
- **One MP3 per chapter.** Chunks are joined at the MPEG frame level, with exact durations
  computed from the frame headers.
- **Plays offline with lock-screen controls.** Media Session gives you real chapter titles,
  cover art and transport controls on the iPhone lock screen. Sleep timer, 0.8×–2× speed,
  15s back / 30s forward, and resume-where-you-left-off.
- **Exports.** Save a single chapter or the whole book as a zip — on iOS this opens the
  share sheet so you can drop it into Files, Books or AirDrop it.
- **Narrate only what you need.** Convert a single chapter, a hand-picked selection, or the
  whole book — and come back for the rest whenever you like.
- **Change your mind about the voice.** Heard a chapter and want a different narrator? Open
  the book, tap **Change**, preview the alternatives, and it re-narrates the whole thing
  consistently.

---

## Setting it up (about 5 minutes)

### 1. Get an API key

**Google Cloud (free, recommended)**

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the **Cloud Text-to-Speech API** for it (APIs & Services → Library → search for it → Enable)
3. APIs & Services → Credentials → **Create credentials → API key**
4. Click the new key and restrict it — this matters, since the key sits in your browser:
   - *Application restrictions* → **Websites**, and add your app's address (e.g. `https://your-app.netlify.app/*`)
   - *API restrictions* → **Restrict key** → tick only **Cloud Text-to-Speech API**
5. Set a **$0 budget alert** (Billing → Budgets & alerts) so an accidental overage can't surprise you

Google needs a card on file even for the free tier, but you stay at $0 as long as you're
inside the monthly allowance:

| Voice | Free every month | A 300-page book | After the allowance |
|---|---|---|---|
| **Chirp 3 HD** | 1,000,000 characters | **free** (≈ 2 books/month) | $30 / 1M |
| WaveNet | 4,000,000 characters | **free** (≈ 8 books/month) | $16 / 1M |
| Neural2 | 1,000,000 characters | **free** | $16 / 1M |
| Standard | 4,000,000 characters | **free**, but robotic | $4 / 1M |

Settings shows a live meter of how much of this month's allowance you've used, and the
estimate on each book tells you whether it fits inside what's left.

**OpenAI (paid alternative)**

Create a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys) and add
credit. No free allowance — GPT-4o mini TTS and TTS-1 are $15 / 1M characters (**$8–12** for a
300-page book), TTS-1 HD is $30 / 1M. Its advantage is the *style direction* box: you can tell
it how to read, not just what to read.

### 2. Put the app on the web

It must be served over **HTTPS** — service workers, Home Screen install and offline storage
all require it. Any static host works; pick whichever is least effort:

**Netlify Drop (easiest, free, no account needed to try)**

1. Go to [app.netlify.com/drop](https://app.netlify.com/drop)
2. Drag the whole `lisan` folder onto the page
3. You get a URL like `https://something-random.netlify.app` — that's it

**Cloudflare Pages / Vercel** — create a project, upload the folder, deploy.

**GitHub Pages** — push the folder to a repository, then Settings → Pages → deploy from the
`main` branch. Subfolder URLs work fine; all paths in the app are relative.

**Trying it on your own machine first**

```bash
cd lisan
python3 -m http.server 8000
# then open http://localhost:8000
```

`localhost` counts as a secure context, so everything works — but your iPhone can't reach it
unless it's on the same Wi-Fi, and iOS won't install a plain-HTTP site to the Home Screen.

### 3. Install it on your iPhone or iPad

1. Open your URL in **Safari** (not Chrome — only Safari can install to the Home Screen)
2. Tap the **Share** button → **Add to Home Screen**
3. Open Lisan from the Home Screen icon

This matters more than it sounds: installed, the app runs full screen, keeps playing with the
screen off, shows lock-screen controls, and iOS gives it far more durable storage.

### 4. Add your key and pick a voice

Settings → choose the engine → paste the API key → **Test key**. The narrator list loads live
from the provider, so it's never out of date.

On Google, set **Language** to match your books — it decides which narrators are offered, and
`fr-FR` narrators read French properly rather than with an English accent. If you read in both
French and English, switch the language before importing each book; the choice is stamped onto
the book, so a French book keeps its French narrator even if you switch later.

Use **Preview voice** to hear a sample sentence (in the chosen language) before committing to
a whole book. On OpenAI, the style direction box also accepts instructions like *"Lis ce texte
calmement, comme un narrateur de livre audio."*

---

## Converting a book

1. **Add book** → choose a file. On iPhone the picker opens Files, so an EPUB in iCloud
   Drive, Dropbox or Google Drive works directly.
2. Check the chapter list. Untick anything you don't want narrated right now. Nothing is
   thrown away — unticked chapters stay in the book and can be narrated later. Tap a title
   to rename it.
3. Check the estimate, then **Convert**.
4. **Leave the app open on this screen while it converts.** iOS suspends background tabs, and
   a suspended tab stops making requests. The app asks iOS to keep the screen awake, but it
   can't work while you're in another app. A 10-hour book takes roughly 20–40 minutes.

If it's interrupted, reopen the book and tap **Narrate all remaining** — finished chapters and
partial chunks are kept, so you only pay for what's left.

### Narrating part of a book

You rarely need a whole book at once. On the book page:

- **One chapter** — tap the ∿ button on its row. That chapter alone is narrated.
- **A few chapters** — **Choose chapters…**, tick what you want, and the sheet shows the
  length and cost of exactly that selection before you commit.
- **Everything left** — **Narrate all remaining**.

Playback steps over chapters that aren't narrated yet, so a partly-converted book still plays
straight through what you have instead of stopping at the first gap.

---

## Notes and limits

**Your API key** lives in this browser's storage on this device and is sent only to the
engine you chose. That's the trade for having no server. Don't install the app on a shared or
public device, and if a key ever leaks, revoke it from the provider's console. Google keys can
be locked to your own domain and to the Text-to-Speech API alone, which makes a leaked key
close to worthless — do that, it takes a minute.

**Scanned PDFs won't work.** If a PDF is page images with no text layer, there is nothing to
narrate and the app says so. Run it through OCR first (macOS Preview, Acrobat, or
`ocrmypdf`), then import the result.

**PDF chapter detection is best-effort.** Books with proper bookmarks come out perfectly.
Ones without get heuristics, which are good but not infallible — that's exactly why the
review screen lets you rename and deselect before spending anything. EPUB is always more
reliable; if you have a choice of format, choose EPUB.

**Storage.** Audio is roughly 0.5 MB per minute, so a 12-hour book is around 350 MB. iOS
gives an installed web app a generous quota but not an unlimited one; the Settings screen
shows what you're using. Delete a finished book to reclaim the space — the exported MP3s in
Files are unaffected.

**Rate limits.** New OpenAI accounts have low limits, and Google caps Chirp 3 at 200 requests
per minute. If you see "retrying", it's handling a 429 correctly — lower **Parallel requests**
in Settings to 1 or 2 if it happens constantly.

**The allowance is per calendar month.** A very long book can exceed 1M characters on its own.
The estimate tells you how much would spill over; converting some chapters now and the rest
after the 1st costs nothing, since partial progress is kept.

**Switching engines mid-book.** Each book remembers the engine, model, voice and language it
was started with, so continuing a half-converted book never mixes two narrators — changing the
narrator in Settings affects the *next* book you import, not one already under way.

**To change the narrator of an existing book**, open it and use **Change** next to "Narrated
by". You can pick a different voice, model or language, preview it first, and the book is then
regenerated from scratch with the new voice. The dialog tells you how many characters that
costs before you commit. Existing audio is replaced rather than mixed, so the book never ends
up with two narrators.

---

## What's in the folder

```
index.html            markup and the icon sprite
styles.css            all styling (dark/light, safe areas, iOS sizing)
manifest.webmanifest  Home Screen install metadata
sw.js                 service worker — caches the app shell for offline use
js/app.js             navigation, import flow, conversion UI, settings
js/db.js              IndexedDB: books, chapters, chunk cache, audio, settings
js/epub.js            EPUB 2/3 parsing: container → OPF → spine → TOC
js/pdfbook.js         PDF text reconstruction, furniture removal, chapter detection
js/text.js            normalisation, sentence-aware chunking, estimates
js/tts.js             engines (Google + OpenAI), resumable queue, retries, MP3 joining
js/player.js          playback, Media Session, sleep timer, position saving
vendor/               pdf.js and JSZip, bundled locally so nothing loads from a CDN
icons/                app icons
```

Everything is plain ES modules — no build step, no bundler, no dependencies to install.
Edit a file, reload, done. (`window.lisan` in the console exposes the player, app state and
the database if you want to poke at it from Safari's Web Inspector.)
