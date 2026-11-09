# Add a document here

Put a file in this folder, then commit it to `main`. The publish workflow copies it into `raw/` as markdown and, when `GEMINI_API_KEY` is available, compiles or updates pages in `wiki/`.

## What to upload

PDF, Word (`.docx`), HTML, Markdown, CSV, or plain text. A scanned PDF that has no text layer will not work; export a text PDF or paste the text into a `.md` file.

## Where it is filed

- `inbox/my-notes.pdf` is filed under the topic `committee`.
- `inbox/regulations/visitor-rules.pdf` is filed under the topic `regulations`.

Use a new folder only for a genuinely different topic. Folder and file names become part of a public URL.

## What not to upload

This repository and the GitHub Pages site are public. Do not upload student lists, medical notes, phone numbers, home addresses, or anything a family has not agreed to publish.

## After you commit

On `main`, GitHub Actions reads the inbox, updates `raw/` and `wiki/`, and republishes the site. The original file is kept under `sources/`.
