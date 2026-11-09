import assert from "node:assert/strict";
import test from "node:test";
import { SYSTEM_PROMPT, buildUserText, geminiBody, localAnswer, parseAnswer } from "../site/js/ground.js";

test("the assistant is told to stay inside the passages", () => {
  assert.match(SYSTEM_PROMPT, /only the passages inside <documents>/);
  assert.match(SYSTEM_PROMPT, /Do not use outside knowledge/);
  assert.match(SYSTEM_PROMPT, /about a child/i);
  const body = geminiBody("Can we do this?", [{ path: "wiki/committee/rules.md", title: "Rules", heading: "Overview", text: "The minutes approve a book drive." }]);
  assert.equal(body.tools, undefined);
  assert.equal(body.generationConfig.temperature, 0.2);
  assert.match(body.contents[0].parts[0].text, /book drive/);
});

test("citations cannot name a file that was not retrieved", () => {
  const parsed = parseAnswer("The minutes approve a book drive.\nCITATIONS: wiki/committee/rules.md, wiki/secret/plan.md", ["wiki/committee/rules.md"]);
  assert.deepEqual(parsed.citations, ["wiki/committee/rules.md"]);
  assert.match(parsed.answer, /book drive/);
  assert.doesNotMatch(parsed.answer, /CITATIONS/);
});

test("a refusal does not keep a fake citation", () => {
  const parsed = parseAnswer("The published documents do not answer that.\nCITATIONS: none", ["wiki/committee/rules.md"]);
  assert.equal(parsed.refused, true);
  assert.deepEqual(parsed.citations, []);
});

test("local replies do not invent an answer", () => {
  assert.match(localAnswer("nomatch", "en"), /won't guess/);
  assert.match(localAnswer("empty", "ar"), /لم يُنشر/);
  assert.match(localAnswer("nomatch", "fr"), /sans deviner/);
  assert.match(buildUserText("Question", []), /<question>/);
});
