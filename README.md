# QSS Parent Committee knowledge base

A public wiki and question box for the QSS Parent Committee. People can ask what the committee is, what it has done, and what the published rules allow. Answers come only from files the committee adds. If a document does not answer the question, the page says so instead of guessing.

The page is a static site on GitHub Pages. Nothing here requires a paid host.

## Add a document

1. Put a PDF, Word (`.docx`), HTML, Markdown, CSV, or text file in [`inbox/`](inbox/).
2. A file in `inbox/` is filed under the topic `committee`. A file in `inbox/regulations/` is filed under `regulations`.
3. Commit that file to `main`.

GitHub Actions then:

- saves the original in `sources/`
- copies the text into `raw/` and does not edit it again
- asks Gemini to compile or update a page in `wiki/`, using the [karpathy-llm-wiki](.agents/skills/karpathy-llm-wiki/SKILL.md) article format
- refuses the compiled page if a number, date, quotation, or too much of the wording is not in the source
- republishes the site

`raw/` stays the record. `wiki/` is the readable guide. The question box searches both, and every answer shows the passages it used.

Do not upload student lists, medical notes, phone numbers, addresses, or anything a family has not agreed to publish. This repository is public, and so is the site.

## Ask a question

After the site is published, open the GitHub Pages URL. Ask in Arabic, French, or English. The chrome of the page can be switched among those three languages.

The assistant will:

- answer from the published files about the committee, its work, and the rules those files contain
- show the passage under the answer
- say when the files do not answer, including when they do not say whether the committee can do something

It will not invent a rule, and it will not answer about a particular child or family. Questions and the matching passages are sent to Google Gemini. Do not type a child's name into the box.

## One-time setup

The repository secret `GEMINI_API_KEY` is already the place for the key. Two switches still have to be turned on by a person, because this environment cannot change them.

### 1. Keep the key on the free tier

In [Google AI Studio](https://aistudio.google.com/), open the key:

- Do not attach a billing account to the Google project. A key that is visible in a static site can be copied, and billing would turn that into a charge.
- Restrict the key to the Generative Language API.
- Under application restrictions, allow only these HTTP referrers:
  - `https://marcondy.github.io/*`
  - `http://127.0.0.1:8765/*` if you want local written answers

Referrer limits stop ordinary use from other websites. They do not stop someone who copies the key into their own program. The Pages build writes the key into the published `config.js` so the browser can call Gemini. It is never committed to git. If the free quota disappears, replace the key in the repository secret and run **Publish knowledge base** again.

Leave the secret empty if you would rather not expose a key. The page still finds the matching passages and shows them. It just does not write a paragraph on top.

Optional repository variable `GEMINI_MODEL` (default `gemini-2.5-flash`).

### 2. Turn on GitHub Pages

In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

The first run of `.github/workflows/publish.yml` on `main` publishes the site, usually at:

`https://marcondy.github.io/QssLLM/`

If Actions cannot push compiled pages back to `main`, allow GitHub Actions to write to the branch. The site build still includes the new pages for that run.

## How a question stays inside the documents

1. The browser ranks passages from `wiki/` and `raw/` on the device. No account is required.
2. If nothing matches, Gemini is not called.
3. If something matches, only those passages are sent, with instructions to ignore outside knowledge and any instructions hidden inside a document.
4. Google Search grounding is not enabled.
5. Each browser is limited to 20 written answers a day. Reading the library is not limited.

## Local preview

```bash
pip install -r requirements.txt
python3 scripts/preview.py
```

Open `http://127.0.0.1:8765/`. The library is empty until a file is ingested.

```bash
python3 scripts/preview.py --demo
```

`--demo` serves one labeled sample file in a temporary folder. It does not write into `wiki/` and it is not a committee decision.

```bash
python3 -m unittest discover -s tests -v
node --test tests/*.mjs
```

## Layout

| Path | Role |
| --- | --- |
| `inbox/` | Drop a new public document here |
| `sources/` | Original upload, kept after ingest |
| `raw/` | Immutable markdown copy |
| `wiki/` | Compiled pages, index, and log |
| `site/` | The Pages interface |
| `.agents/skills/karpathy-llm-wiki/` | Wiki schema, MIT licensed, from [Astro-Han/karpathy-llm-wiki](https://github.com/Astro-Han/karpathy-llm-wiki) |

Coding agents working in this repository should follow that skill for ingest, query, and lint.

## Credits

Wiki structure and `check_evidence.py` are from karpathy-llm-wiki by Yuhan Lei, used under the MIT license included in `.agents/skills/karpathy-llm-wiki/LICENSE`. The wiki idea comes from Andrej Karpathy.
