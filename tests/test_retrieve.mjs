import assert from "node:assert/strict";
import test from "node:test";
import { search, searchQuery, retrieve, expandQueryTokens, scriptsMismatch } from "../site/js/retrieve.js";

const chunks = [
  {
    id: "raw/committee/minutes.md#0",
    path: "raw/committee/minutes.md",
    title: "Sample preview minutes",
    heading: "Overview",
    text: "The sample rule says a book drive is described as approved only after the minutes contain the words approved in the minutes.",
    kind: "raw",
    topic: "committee",
    updated: "2026-11-09",
  },
  {
    id: "wiki/committee/book-drive.md#0",
    path: "wiki/committee/book-drive.md",
    title: "Book drive",
    heading: "Overview",
    text: "A book drive is approved in the minutes. The page does not mention other events.",
    kind: "wiki",
    topic: "committee",
    updated: "2026-11-09",
  },
];

const arabicChunks = [
  {
    id: "raw/committee/laws.md#0",
    path: "raw/committee/laws.md",
    title: "QSS Laws Parents Committees",
    heading: "Overview",
    text: "لجان الأهل في المدارس الخاصة مجموعة القوانين والمراسيم والقرارات الخاصة بلجان الأهل وتنظيم الموازنة المدرسية",
    kind: "raw",
    topic: "committee",
    updated: "2026-11-09",
  },
  {
    id: "raw/committee/laws.md#1",
    path: "raw/committee/laws.md",
    title: "QSS Laws Parents Committees",
    heading: "Overview",
    text: "ينشأ في كل مدرسة خاصة غير مجانية لجنة تمثل أولياء التلامذة مهمتها رعاية شؤون التلاميذ",
    kind: "raw",
    topic: "committee",
    updated: "2026-11-09",
  },
];

test("a question about the book drive returns that passage", () => {
  const hits = search(chunks, "Does a book drive need to be approved in the minutes?");
  assert.ok(hits.length >= 1);
  assert.match(hits[0].text, /book drive/i);
});

test("an unrelated question does not borrow a passage", () => {
  const hits = search(chunks, "What is the capital of France?");
  assert.equal(hits.length, 0);
});

test("a broad committee question still opens the latest guide", () => {
  const hits = search(chunks, "What did we do?");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].broad, true);
  assert.equal(hits[0].kind, "wiki");
});

test("a short follow-up keeps the previous question", () => {
  assert.match(searchQuery(["Can we hold a book drive?"], "what about that?"), /book drive/i);
});

test("a new question is not mixed into the previous topic", () => {
  const query = searchQuery(
    ["What does the sample rule say a book drive needs?"],
    "What is the capital of France?",
  );
  assert.equal(query, "What is the capital of France?");
  assert.equal(search(chunks, query).length, 0);
});

test("English committee words expand into Arabic synonyms", () => {
  const tokens = expandQueryTokens("What's the community law");
  assert.ok(tokens.includes("لجنة") || tokens.includes("لجان"));
  assert.ok(tokens.includes("قانون") || tokens.includes("القوانين"));
});

test("an English question can retrieve Arabic parent-committee passages", () => {
  assert.equal(scriptsMismatch("What's the community law", arabicChunks), true);
  const hits = retrieve(arabicChunks, "What's the community law", { allowCrossLingual: true });
  assert.ok(hits.length >= 1);
  assert.match(hits[0].text, /لجان|لجنة|القوانين/);
});

test("same-language off-topic questions still refuse without borrowing Arabic files", () => {
  const hits = retrieve(chunks, "What is the capital of France?", { allowCrossLingual: true });
  assert.equal(hits.length, 0);
});

test("an off-topic English question does not fall back into Arabic laws", () => {
  const hits = retrieve(arabicChunks, "What is the capital of France?", { allowCrossLingual: true });
  assert.equal(hits.length, 0);
});
