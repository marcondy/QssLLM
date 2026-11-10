import assert from "node:assert/strict";
import test from "node:test";
import {
  SYSTEM_PROMPT,
  buildUserText,
  geminiBody,
  localAnswer,
  parseAnswer,
  detectQuestionLanguage,
  HISTORY_TURN_LIMIT,
} from "../site/js/ground.js";

test("the assistant is told to stay inside the passages", () => {
  assert.match(SYSTEM_PROMPT, /only the passages inside <documents>/);
  assert.match(SYSTEM_PROMPT, /Do not use outside knowledge/);
  assert.match(SYSTEM_PROMPT, /about a child/i);
  assert.match(SYSTEM_PROMPT, /different language from the question/i);
  const body = geminiBody("Can we do this?", [
    { path: "wiki/committee/rules.md", title: "Rules", heading: "Overview", text: "The minutes approve a book drive." },
  ]);
  assert.equal(body.tools, undefined);
  assert.equal(body.generationConfig.temperature, 0.2);
  assert.match(body.contents[0].parts[0].text, /book drive/);
});

test("geminiBody includes prior turns and puts documents only on the latest user turn", () => {
  const chunks = [
    { path: "wiki/committee/rules.md", title: "Rules", heading: "Overview", text: "Parents committees follow published laws." },
  ];
  const history = [
    { role: "user", text: "What is our role?" },
    { role: "assistant", text: "The published files describe the committee role.\nCITATIONS: wiki/committee/rules.md" },
    { role: "user", text: "Can we change the budget?" },
    { role: "assistant", text: "Only if the published rules allow it.\nCITATIONS: wiki/committee/rules.md" },
  ];
  const body = geminiBody("And school fees?", chunks, history);
  assert.equal(body.contents.length, 5);
  assert.equal(body.contents[0].role, "user");
  assert.equal(body.contents[1].role, "model");
  assert.equal(body.contents[4].role, "user");
  assert.match(body.contents[4].parts[0].text, /<documents>/);
  assert.match(body.contents[4].parts[0].text, /And school fees\?/);
  assert.doesNotMatch(body.contents[0].parts[0].text, /<documents>/);
  assert.ok(HISTORY_TURN_LIMIT >= 4);
});

test("history is capped so long chats stay within the free-tier window", () => {
  const history = [];
  for (let i = 0; i < 20; i += 1) {
    history.push({ role: "user", text: `Question ${i}` });
    history.push({ role: "assistant", text: `Answer ${i}` });
  }
  const body = geminiBody(
    "Latest?",
    [{ path: "wiki/committee/rules.md", title: "Rules", heading: "", text: "Rule text." }],
    history,
  );
  assert.equal(body.contents.length, HISTORY_TURN_LIMIT + 1);
  assert.match(body.contents.at(-1).parts[0].text, /Latest\?/);
});

test("citations cannot name a file that was not retrieved", () => {
  const parsed = parseAnswer(
    "The minutes approve a book drive.\nCITATIONS: wiki/committee/rules.md, wiki/secret/plan.md",
    ["wiki/committee/rules.md"],
  );
  assert.deepEqual(parsed.citations, ["wiki/committee/rules.md"]);
  assert.match(parsed.answer, /book drive/);
  assert.doesNotMatch(parsed.answer, /CITATIONS/);
});

test("a refusal does not keep a fake citation", () => {
  const parsed = parseAnswer("The published documents do not answer that.\nCITATIONS: none", [
    "wiki/committee/rules.md",
  ]);
  assert.equal(parsed.refused, true);
  assert.deepEqual(parsed.citations, []);
});

test("local replies do not invent an answer", () => {
  assert.match(localAnswer("nomatch", "en"), /won't guess/);
  assert.match(localAnswer("empty", "ar"), /لم يُنشر/);
  assert.match(localAnswer("nomatch", "fr"), /sans deviner/);
  assert.match(localAnswer("passages", "en"), /matching published passages/i);
  assert.match(buildUserText("Question", []), /<question>/);
});

test("question language follows the ask text, not only the site chrome", () => {
  assert.equal(detectQuestionLanguage("هل يمكننا فعل هذا؟", "en"), "ar");
  assert.equal(detectQuestionLanguage("Can the committee change the budget?", "ar"), "en");
  assert.equal(detectQuestionLanguage("Est-ce que le comité peut le faire ?", "en"), "fr");
});
