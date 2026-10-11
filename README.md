# Palabra por palabra

A personal reader for learning languages word by word. Paste a chapter in Spanish, French, Japanese, German or any other language: every word becomes clickable and gets its own knowledge level from 5 (don't know) to 1 (know). Claude writes the translation, pronunciation, origin, history, a fact and an explanation of why the word is used in that exact place. Words you are learning go into spaced-repetition review. Everything is stored in your own database.

The site is plain files with no build step. Hosting: GitHub Pages. Database and sign-in: Supabase. Both are free. Claude requests are paid separately through the API.

Live site: **https://slowmeow.github.io/palabra-por-palabra/**

If you fork it, your copy will be at `https://<your-github-username>.github.io/palabra-por-palabra/`.

---

## Features

- **Any language.** Words are found with the browser's built-in segmenter, so Japanese, Chinese and Thai work without spaces, and French or Italian elisions are split (`l'homme` → `l'` + `homme`). Spanish, French, German, Japanese and some others get extra tuning: transcription standard, kana readings for Japanese, articles and plurals for German nouns, language-specific dictionaries (RAE, CNRTL, DWDS, Jisho…). Any other language can be added by its code.
- **Interface in English or Russian**, switchable in Settings and on the sign-in screen.
- **Explanation language.** Translations and analyses are written in English by default; pick any other language in Settings.
- **Levels 1–5** with highlighting in the text, keyboard shortcuts and a quick dictionary for the whole chapter.
- **Detailed analysis** by Claude: origin, history, a fact, related words, a mnemonic and why the word stands in this exact sentence. Every field can be edited by hand.
- **Review mode** with flashcards and spaced repetition, rated with the same 5→1 levels.
- **Backups** to a single JSON file.

---

## Quick start

1. **Create the database** in Supabase and run `supabase/schema.sql` (steps 1–4 below).
2. **Publish the site** with GitHub Desktop and turn on Pages (step 5).
3. **Open the site**, enter the database address and publishable key on the first screen, sign in and paste your Anthropic key in Settings.

You don't have to edit any files: `config.js` can stay empty, the site asks for the values itself and remembers them in the browser. If you don't want to be asked on a new device, put them into `config.js` later.

---

## One-time setup

The order is: database (Supabase) first, then the site (GitHub), then the Claude key.

### 1. Create a Supabase project

1. Go to supabase.com, create an account and a new project (pick the region closest to you).
2. Choose and save a database password. You'll need it if something goes wrong.
3. Wait until the project starts (a couple of minutes).

### 2. Create the tables

1. In the project open **SQL Editor** → **New query**.
2. Copy the whole `supabase/schema.sql` file and paste it into the editor.
3. Press **Run**. You should see "Success".

### 3. Create your account and close sign-ups

1. **Authentication** → **Users** → **Add user** → **Create new user**.
2. Enter your email and a password, turn on "Auto Confirm User", create the user.
3. **Authentication** → **Sign In / Providers** (or Settings) → turn off **Allow new users to sign up** and save.

Now nobody else can register on your site. Only this account can sign in.

### 4. Get the two values for config.js

1. In the project press **Connect** (or **Project Settings** → **API Keys**).
2. Copy the **Project URL** (`https://…supabase.co`) and the **publishable key** (starts with `sb_publishable_`).
3. Enter them on the site's first screen, or put them into `config.js`.

Both values are safe in a public repository: without an email and password they open nothing, because access to rows is protected by the policies in `schema.sql`.

**Never put your Anthropic key (`sk-ant-…`) into `config.js`.** It is entered in the site's Settings and stays in your browser.

### 5. Publish the site on GitHub Pages

With GitHub Desktop:

1. Open the repository in GitHub Desktop and press **Publish repository**.
2. Name it `palabra-por-palabra`, untick **Keep this code private** (free GitHub Pages needs a public repository) and publish.
3. On github.com open the repository → **Settings** → **Pages** → Source: **GitHub Actions**.
4. Publishing runs on every push through `.github/workflows/deploy.yml`. A minute later the site opens at `https://<your-github-username>.github.io/palabra-por-palabra/`.

The repository can stay public: there are no secrets in the files, and the data is protected by your password and the database policies.

### 6. Get a Claude API key

1. Go to console.anthropic.com and add credit to your balance.
2. **API Keys** → **Create Key**, copy the whole key.
3. Open your site, sign in, press the gear → paste the key → "Save key" → "Check".

API billing is separate from a claude.ai subscription: you pay per token.

### 7. Keep the database awake

A free Supabase project pauses after a week without requests. If you read regularly, this won't happen.

To be safe, turn on the automatic ping: in the repository **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, create `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` with the same values you entered on the site. GitHub will wake the database every three days.

GitHub switches off scheduled workflows after 60 days without commits. The ping workflow re-enables itself through the GitHub API on every run to prevent that. If you ever see it disabled in the **Actions** tab, press **Enable workflow**.

---

## Updating from an earlier version

This version stores a language for every chapter and word and keeps review data. After updating the files, **run `supabase/schema.sql` once more** in the SQL Editor. It adds the new columns and keeps all your data; existing chapters and words are marked as Spanish. Until you do this, the site shows a message asking for the update.

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

Supabase makes no backups on the free plan. Every couple of weeks open Settings and press "Download backup": you get one JSON file with all chapters, words, levels, cards and review data. "Restore backup" loads it back. Backups from the earlier version can be restored too.

## Security

- Data is protected by email-and-password sign-in and by database policies: each user sees only their own rows.
- The Anthropic key lives in your browser's `localStorage` and goes straight to Anthropic. That's fine for a personal site, but don't open the site on someone else's computer and don't paste the key where you can't remove it. If the key leaks, revoke it in the Anthropic Console with one click.
- Never publish `sb_secret_…`: the Supabase secret key bypasses all policies. The site doesn't need it.

## Files

```
index.html             the page
styles.css             styles
config.js              Supabase address and key (you fill them in)
js/app.js              logic: reading, levels, word panel, review, settings
js/claude.js           Claude API requests, models, prompts
js/db.js               database access
js/text.js             splitting text into sentences and words for any language
js/langs.js            language profiles and external dictionaries
js/i18n.js             interface strings (English, Russian)
js/srs.js              spaced-repetition schedule
js/icons.js            icons
supabase/schema.sql    tables, upgrades and access rules
.github/workflows/     publishing to Pages and the database keep-alive ping
```
