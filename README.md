# Palabra por palabra

A personal reader for learning languages word by word. Paste a chapter in Spanish, French, Japanese, German or any other language: every word becomes clickable and gets its own knowledge level from 5 (don't know) to 1 (know). Claude writes the translation, pronunciation, origin, history, a fact and an explanation of why the word is used in that exact place. Words you are learning go into spaced-repetition review. Everything is stored in your own Firebase project.

The site is plain files with no build step. Hosting: GitHub Pages. Database and sign-in: Firebase (free Spark plan). Claude requests are paid separately through the API.

Live site: **https://slowmeow.github.io/palabra-por-palabra/**

If you fork it, your copy will be at `https://<your-github-username>.github.io/palabra-por-palabra/`.

---

## Features

- **Any language.** Words are found with the browser's built-in segmenter, so Japanese, Chinese and Thai work without spaces, French or Italian elisions are split (`l'homme` → `l'` + `homme`), and Japanese verb endings stay with their verb (`食べました`). Spanish, French, German, Japanese and some others get extra tuning: transcription standard, kana readings for Japanese, articles and plurals for German nouns, language-specific dictionaries (RAE, CNRTL, DWDS, Jisho…). Any other language can be added by its code.
- **Interface in English or Russian**, switchable in Settings and on the sign-in screen.
- **Explanation language.** Translations and analyses are written in English by default; pick any other language in Settings.
- **Levels 1–5** with highlighting in the text, keyboard shortcuts and a quick dictionary for the whole chapter.
- **Detailed analysis** by Claude: origin, history, a fact, related words, a mnemonic and why the word stands in this exact sentence. Every field can be edited by hand.
- **Review mode** with flashcards and spaced repetition, rated with the same 5→1 levels.
- **Backups** to a single JSON file.

---

## Quick start

1. **Create a Firebase project** with sign-in and a Firestore database (steps 1–4 below, about 10 minutes).
2. **Open the site**, paste the project's `firebaseConfig` on the first screen and sign in.
3. **Paste your Anthropic key** in Settings.

You don't have to edit any files: the site asks for the Firebase config itself and remembers it in the browser. If you don't want to paste it on every new device, put it into `config.js` later.

---

## One-time setup

### 1. Create a Firebase project

1. Go to https://console.firebase.google.com and sign in with a Google account.
2. **Create a project**. Any name, for example `palabra`. Google Analytics isn't needed, you can turn it off.
3. You stay on the free **Spark** plan; no card is required.

### 2. Turn on sign-in and add yourself

1. **Build** → **Authentication** → **Get started**.
2. **Sign-in method** → **Email/Password** → enable the first switch → **Save**.
3. **Users** → **Add user**: your email and a password. This is the account you'll sign in with.
4. Recommended: **Settings** → **User actions** → untick **Enable create (sign-up)**, so nobody else can register in your project. Even without this, other people could only ever see their own empty data.

### 3. Create the database and its rules

1. **Build** → **Firestore Database** → **Create database**.
2. Choose a location close to you (for example `eur3` for Europe) and **Start in production mode**.
3. Open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules) and press **Publish**.

The rules let each signed-in user read and write only their own folder `users/{uid}`. Without them the site shows "Firestore refused access".

### 4. Get the config for the site

1. Press the gear next to **Project Overview** → **Project settings** → **General**.
2. Under **Your apps** press the **Web** button (`</>`), give the app any name, leave Firebase Hosting off, **Register app**.
3. Copy the whole `firebaseConfig = { … }` snippet.
4. Open the site and paste it on the first screen, then sign in with the email and password from step 2.

These values are safe in a public repository and on the site: they only identify the project. Your data is protected by your password and the rules. To skip the first screen on every device, put `apiKey`, `authDomain`, `projectId` and `appId` into `config.js`.

**Never paste a service account key (JSON with `private_key`) or your Anthropic key (`sk-ant-…`) into the site or `config.js`.**

### 5. Get a Claude API key

1. Go to console.anthropic.com and add credit to your balance.
2. **API Keys** → **Create Key**, copy the whole key.
3. Open your site, sign in, press the gear → paste the key → "Save key" → "Check".

API billing is separate from a claude.ai subscription: you pay per token.

### Publishing your own copy on GitHub Pages

The live site above is already published. For your own fork: **Settings** → **Pages** → Source: **GitHub Actions**. Every push to `main` publishes the site through `.github/workflows/deploy.yml`.

---

## Free plan limits

Firebase's free Spark plan allows 1 GiB of data, 50,000 document reads and 20,000 writes a day, and it never pauses. The site is built to stay far below that: words are packed into 32 documents per language, so opening the site costs a few dozen reads even with thousands of words, and a new chapter costs a few dozen writes. A detailed card is read only when you open its word.

---

## Moving from the earlier Supabase version

Download a backup in the old version (Settings → "Download backup"), then in this version press "Restore backup" and choose the file. Chapters and words from old backups become Spanish, as they were.

On first start the settings move to the new models (Opus 5.5 for analysis, Haiku 5.5 for the dictionary), and translations and explanations switch to English. Quick translations made earlier in Russian are redone automatically when you open a chapter (with Haiku 5.5 this costs fractions of a cent). Detailed cards keep their text and get a "Rewrite in English" button. To keep everything in Russian, choose Russian as the explanation language in Settings.

---

## How to use it

- **Add a chapter**: the plus in the header. Choose the language of the text and paste it. "Join lines" helps when the text was copied from a PDF and broken into lines. Before saving you see how many words are new to you.
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

- Data is protected by email-and-password sign-in and by the Firestore rules: each user sees only their own folder.
- The Anthropic key lives in your browser's `localStorage` and goes straight to Anthropic. That's fine for a personal site, but don't open the site on someone else's computer and don't paste the key where you can't remove it. If the key leaks, revoke it in the Anthropic Console with one click.
- The Firebase web config is public by design. Never publish a service account key: it bypasses all rules.

## Files

```
index.html             the page
styles.css             styles
config.js              Firebase web config (optional, you fill it in)
firestore.rules        database access rules to paste into Firebase
js/app.js              logic: reading, levels, word panel, review, settings
js/claude.js           Claude API requests, models, prompts
js/db.js               Firebase sign-in and Firestore storage
js/text.js             splitting text into sentences and words for any language
js/langs.js            language profiles and external dictionaries
js/i18n.js             interface strings (English, Russian)
js/srs.js              spaced-repetition schedule
js/icons.js            icons
.github/workflows/     publishing to GitHub Pages
```
