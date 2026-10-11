# Palabra por palabra

A reader for learning languages word by word. Paste a chapter in Spanish, French, Japanese, German or any other language: every word becomes clickable and gets its own knowledge level from 5 (don't know) to 1 (know). Claude writes the translation, pronunciation, origin, history, a fact and an explanation of why the word is used in that exact place. Words you are learning go into spaced-repetition review. Learners share translations and explanations in a common library, so people without their own Claude key can use the site too.

The site is plain files with no build step. Hosting: GitHub Pages. Database and sign-in (Google account or email): Firebase (free Spark plan). Claude requests are paid separately through the API.

Live site: **https://slowmeow.github.io/palabra-por-palabra/** — open it and press **Continue with Google**. Nothing to set up.

The rest of this file is for whoever runs the site (the admin) or a fork of it.

---

## Features

- **Any language.** Words are found with the browser's built-in segmenter, so Japanese, Chinese and Thai work without spaces, French or Italian elisions are split (`l'homme` → `l'` + `homme`), and Japanese verb endings stay with their verb (`食べました`). Spanish, French, German, Japanese and some others get extra tuning: transcription standard, kana readings for Japanese, articles and plurals for German nouns, language-specific dictionaries (RAE, CNRTL, DWDS, Jisho…). Any other language can be added by its code.
- **Interface in English or Russian**, switchable in Settings and on the sign-in screen.
- **Explanation language.** Translations and analyses are written in English by default; pick any other language in Settings.
- **Library home.** All your texts grouped by language and book, with progress bars, search, a language filter and a "Continue reading" card that brings you back to the exact place you stopped. The logo always leads home; the browser's back button works.
- **Levels 1–5** with highlighting in the text, keyboard shortcuts and a quick dictionary for the whole chapter.
- **Detailed analysis** by Claude: origin, history, a fact, related words, a mnemonic and why the word stands in this exact sentence. Every field can be edited by hand.
- **Review mode** with flashcards and spaced repetition, rated with the same 5→1 levels.
- **Two modes.** With your own Claude API key you translate and analyze words yourself. Without a key you read, review and use what other learners have shared.
- **Shared library.** Quick translations and detailed analyses made with a key go to a common library (switch it off in Settings). Anyone who opens the same word sees the explanations available, with the author's name and likes, and picks one. Picking one stores only a link to it, not a copy. Editing it makes your own copy. "Why this word here" is shared for the exact same sentence, so readers of the same book benefit.
- **Admin panel** for the site owner: users, plans (prepared for a future Pro tier) and moderation of the library.
- **Backups** to a single JSON file.

---

## Running the site

The live site is connected to the Firebase project `wordanalytics-e4cb9`; its web config is in `config.js`, so visitors never see a setup screen. To run your own copy:

1. **Create a Firebase project** with sign-in and a Firestore database (steps 1–4 below, about 10 minutes).
2. Put the project's `firebaseConfig` into `config.js` (or leave it empty: then the site asks for it on the first screen).
3. Publish `firestore.rules` and make yourself an admin (step 5).

---

## One-time setup

### 1. Create a Firebase project

1. Go to https://console.firebase.google.com and sign in with a Google account.
2. **Create a project**. Any name, for example `palabra`. Google Analytics isn't needed, you can turn it off.
3. You stay on the free **Spark** plan; no card is required.

### 2. Turn on sign-in

The site offers **Continue with Google** and, as a fallback, email and password.

1. **Security** → **Authentication** → **Get started** (in older consoles: **Build** → **Authentication**).
2. **Sign-in method** → **Add new provider** → **Google** → enable, pick your email as the support email → **Save**.
3. Optionally also **Email/Password** → enable only the first switch (not "Email link") → **Save**, then **Users** → **Add user** with your email and a password.
4. **Settings** → **Authorized domains** → **Add domain** → `slowmeow.github.io` (or your own `<username>.github.io`). Without it Google sign-in is refused on the site.

Leave **Settings** → **User actions** → **Enable create (sign-up)** turned on: the first Google sign-in creates your account. Anyone with a Google account can then use the site.

### 3. Create the database and its rules

1. **Build** → **Firestore Database** → **Create database**.
2. Choose a location close to you (for example `eur3` for Europe) and **Start in production mode**.
3. Open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules) and press **Publish**.

The rules keep each user's own data private, let everyone signed in read and add to the shared library without overwriting others' entries, and reserve deletion and plans for the author or the admin. Without them the site shows "Firestore refused access". After updating the site, publish the rules again.

### 4. Get the config for the site

1. Press the gear next to **Project Overview** → **Project settings** → **General**.
2. Under **Your apps** press the **Web** button (`</>`), give the app any name, leave Firebase Hosting off, **Register app**.
3. Copy the whole `firebaseConfig = { … }` snippet.
4. Open the site and paste it on the first screen, then press **Continue with Google** (or sign in with the email and password from step 2).

These values are safe in a public repository and on the site: they only identify the project. Your data is protected by your password and the rules. To skip the first screen on every device, put `apiKey`, `authDomain`, `projectId` and `appId` into `config.js`.

**Never paste a service account key (JSON with `private_key`) or your Anthropic key (`sk-ant-…`) into the site or `config.js`.**

### 5. Make yourself the admin

1. Open the site and sign in once with your Google account.
2. On the site: gear → **Account** → **Your user ID** → **Copy**. (It is also in Firebase → Authentication → Users, column "User UID".)
3. In Firebase: **Firestore Database** → **Data** → **Start collection** → Collection ID `admins` → **Document ID**: paste your user ID → add any field, for example `note` = `owner` → **Save**.
4. Reload the site: a shield button appears in the header. That's the admin panel.

Nobody can make themselves an admin from the site: the rules allow creating `admins` documents only in the console.

### 6. A Claude API key (each user, optional)

Every user who wants to translate and analyze words on their own adds their own key:

1. Go to console.anthropic.com and add credit to your balance.
2. **API Keys** → **Create Key**, copy the whole key.
3. On the site: gear → paste the key → "Save key" → "Check".

API billing is separate from a claude.ai subscription: you pay per token. The key stays in that person's browser. Without a key the site still works with the shared library.

### Publishing your own copy on GitHub Pages

The live site above is already published. For your own fork: **Settings** → **Pages** → Source: **GitHub Actions**. Every push to `main` publishes the site through `.github/workflows/deploy.yml`.

---

## Free plan limits

Firebase's free Spark plan allows 1 GiB of data, 50,000 document reads and 20,000 writes a day **for the whole site**, and it never pauses. The site is built to stay far below that:

- Each person's words are packed into 32 documents per language, so opening the site costs a few dozen reads even with thousands of words.
- The shared dictionary is packed into 64 documents per language pair; a new chapter reads only the ones it needs, and translations are saved every few batches, not after each one.
- A detailed card is read only when you open its word. Picking someone's explanation stores a link, not a copy. Shared explanations are stored deflated: roughly 1–2 KB each, so 1 GiB holds hundreds of thousands of them.

In practice the limit you meet first is reads: roughly 1,000–2,000 visits a day across all users. The admin panel and Firebase → Firestore → **Usage** show where you are. If the site outgrows it, the pay-as-you-go Blaze plan keeps the free quota and costs about $0.06 per extra 100,000 reads.

Optional: Firebase indexes every field, including the compressed text of shared explanations. To save that space, add an exemption: Firestore → **Indexes** → **Single field** → **Add exemption** → collection `shared_cards`, field `z`, turn off all index types.

## Plans (prepared, not active yet)

Every profile has a plan, `free` by default, which only the admin can change in the admin panel (with an optional end date). Pro doesn't unlock anything yet. The idea for later: Pro users analyze words through the owner's Claude key, without a key of their own, up to 100 analyses a month with Claude Sonnet 5.5. That needs a tiny server (for example a free Cloudflare Worker) so the owner's key never reaches the browser.

---

## Moving from the earlier Supabase version

Download a backup in the old version (Settings → "Download backup"), then in this version press "Restore backup" and choose the file. Chapters and words from old backups become Spanish, as they were.

On first start the settings move to the new models (Opus 5.5 for analysis, Haiku 5.5 for the dictionary), and translations and explanations switch to English. Quick translations made earlier in Russian are redone automatically when you open a chapter (with Haiku 5.5 this costs fractions of a cent). Detailed cards keep their text and get a "Rewrite in English" button. To keep everything in Russian, choose Russian as the explanation language in Settings.

---

## How to use it

- **Library**: the logo or "Library" in the chapter list. Texts are grouped by language and book; the folder button on a card moves it into a book. At the end of a chapter, "Next" opens the following chapter of the same book.
- **Add a chapter**: the plus in the header. Choose the language of the text, optionally a book, and paste it. "Join lines" helps when the text was copied from a PDF and broken into lines. Before saving you see how many words are new to you.
- **Languages**: the badge next to the chapter list shows the current language. Chapters of different languages are grouped in the list; opening a chapter switches the language for the vocabulary, progress and review.
- **Levels 1–5.** Every new word starts at 5, "don't know". Tap a word and set the level with a button or keys 1–5. Arrows ← → move to the neighbouring word. Level 1 means learned, and the word stops being highlighted.
- **Highlight**: the marker button in the header switches between all words, only unlearned ones and no highlight. The lower the level, the paler the word.
- **Quick dictionary**: translation, pronunciation and IPA (plus the kana reading for Japanese) appear right away. "Prepare dictionary" fills them in for the whole chapter in batches of 60 with a cheap model.
- **Detailed analysis**: "Analyze the word with Claude". If thinking display is on, you see a short summary of how the model reasons.
- **Edits**: any field can be rewritten by hand with "Edit" on the card. You can also keep your own notes. "Regenerate" accepts a wish, for example "make the fact creepier".
- **Review**: the cards button in the header. Choose this chapter or all words of the language, look at the word, recall it, show the answer and rate it 5→1. Words you know come back after days, then weeks; words you don't know come back in the same session. The badge on the button shows how many words are due.
- **My vocabulary**: all words with search (accents don't matter: `cancion` finds `canción`) and a level filter. **Progress**: how many words are learned, what you did this week, how much the API cost.

## Choosing a model

Settings let you choose the model and the thinking depth:

| Model | Price per million tokens (input / output) | When to use |
|---|---|---|
| Claude Fable 5.1 | $10 / $50 | the deepest analysis, always thinks before answering |
| Claude Opus 5.5 | $4 / $20 | very strong and cheaper, the default for analysis |
| Claude Sonnet 5.5 | $2 / $10 | fast and cheap, usually good enough |
| Claude Haiku 5.5 | $0.10 / $0.50 | the default for the quick dictionary |

Older models (Opus 5, Sonnet 5, Haiku 4.5) are still in the list. You can also enter any other model ID with "Another model".

Thinking depth goes from low to maximum. Maximum gives a more careful analysis but takes longer and costs more; for one word "High" is usually enough. If Fable, Opus or Sonnet decline a request, the API automatically retries it on a fallback model.

## Backups

Every couple of weeks open Settings and press "Download backup": you get one JSON file with all chapters, words, levels, cards and review data. "Restore backup" loads it back. Backups from the earlier Supabase version can be restored too.

## Security

- Data is protected by Google or email sign-in and by the Firestore rules: each user's chapters, levels, notes and settings are visible only to that user. The shared library is readable by every signed-in user; entries can't be overwritten, and only their author or an admin can delete them.
- The Anthropic key lives in your browser's `localStorage` and goes straight to Anthropic. That's fine for a personal site, but don't open the site on someone else's computer and don't paste the key where you can't remove it. If the key leaks, revoke it in the Anthropic Console with one click.
- The Firebase web config is public by design. Never publish a service account key: it bypasses all rules.
- Only accounts with a verified email (every Google account) can add to the shared library, and an explanation always carries its author's real Google name.
- A Content Security Policy in `index.html` lets the page run scripts only from this site and Google's Firebase CDN and send data only to Firebase and the Claude API, so even injected text can't steal the Claude key.
- Everything shown on the page from users or the shared library is escaped. Shared explanations are cleaned to the expected fields before they are shown.
- The publishing workflow uses actions pinned to exact commits and publishes only the site's files (`index.html`, `config.js`, `styles.css`, `js/`).
- Recommended in the Firebase and Google Cloud consoles: turn on App Check, restrict the browser API key to your site's address, and disable sign-in providers you don't use.

## Files

```
index.html             the page
styles.css             styles
config.js              Firebase web config (optional, you fill it in)
firestore.rules        database access rules to paste into Firebase
js/app.js              logic: library home, reading, levels, word panel, review, library, admin, settings
js/claude.js           Claude API requests, models, prompts
js/db.js               Firebase sign-in and Firestore storage
js/text.js             splitting text into sentences and words for any language
js/langs.js            language profiles and external dictionaries
js/i18n.js             interface strings (English, Russian)
js/srs.js              spaced-repetition schedule
js/icons.js            icons
.github/workflows/     publishing to GitHub Pages
```
