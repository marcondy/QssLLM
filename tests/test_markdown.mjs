import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown, resolveHref, safeDocPath } from "../site/js/markdown.js";

test("document html is escaped", () => {
  const html = renderMarkdown("# Title\n\n<script>alert(1)</script>\n\nSee [rules](../../raw/committee/rules.md).", {
    from: "wiki/committee/guide.md",
  });
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /#\/doc\?path=raw%2Fcommittee%2Frules\.md/);
});

test("javascript links are dropped", () => {
  assert.equal(resolveHref("javascript:alert(1)", "wiki/committee/guide.md"), null);
  assert.equal(safeDocPath("../secrets.md"), null);
  assert.equal(safeDocPath("wiki/committee/guide.md"), "wiki/committee/guide.md");
});
