/** Render a small, safe slice of Markdown. Documents are escaped before tags are added. */

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderMarkdown(markdown, options = {}) {
  const from = options.from || "";
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const collected = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        collected.push(lines[index]);
        index += 1;
      }
      index += 1;
      html.push(`<pre><code>${escapeHtml(collected.join("\n"))}</code></pre>`);
      continue;
    }
    if (isTableStart(lines, index)) {
      const table = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        table.push(lines[index]);
        index += 1;
      }
      html.push(renderTable(table, from));
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2], from)}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      html.push("<hr>");
      index += 1;
      continue;
    }
    if (line.trim().startsWith(">")) {
      const quote = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quote.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      html.push(`<blockquote>${quote.map((line) => `<p>${inline(line, from)}</p>`).join("")}</blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      html.push(`<ul>${items.map((item) => `<li>${inline(item, from)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ""));
        index += 1;
      }
      html.push(`<ol>${items.map((item) => `<li>${inline(item, from)}</li>`).join("")}</ol>`);
      continue;
    }
    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith("```") &&
      !/^(#{1,4})\s+/.test(lines[index]) &&
      !lines[index].trim().startsWith(">") &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+[.)]\s+/.test(lines[index]) &&
      !lines[index].trim().startsWith("|")
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p>${inline(paragraph.join(" "), from)}</p>`);
  }
  return html.join("\n");
}

function isTableStart(lines, index) {
  return lines[index].trim().startsWith("|") && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1]);
}

function renderTable(lines, from) {
  const rows = lines
    .filter((line) => !/^\s*\|?\s*:?-{3,}/.test(line))
    .map((line) => splitRow(line));
  if (!rows.length) return "";
  const head = rows[0].map((cell) => `<th>${inline(cell, from)}</th>`).join("");
  const body = rows
    .slice(1)
    .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell, from)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function splitRow(line) {
  let cells = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return cells.split("|").map((cell) => cell.trim());
}

function inline(text, from) {
  let value = escapeHtml(text);
  value = value.replace(/`([^`]+)`/g, "<code>$1</code>");
  value = value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const href = resolveHref(unescapeHtml(url), from);
    if (!href) return label;
    const external = /^https?:/i.test(href);
    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a href="${escapeHtml(href)}"${attrs}>${label}</a>`;
  });
  value = value.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  value = value.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return value;
}

function unescapeHtml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export function resolveHref(url, from) {
  const trimmed = String(url || "").trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^(javascript:|data:)/i.test(trimmed)) return null;
  if (trimmed.startsWith("#")) return trimmed;
  const base = String(from || "").split("/").slice(0, -1);
  const parts = [...base];
  for (const part of trimmed.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(decodeURIComponent(part));
  }
  const path = parts.join("/");
  if (!path || path.split("/").includes("..")) return null;
  if (path.endsWith(".md") && /^(wiki|raw|sources)\//.test(path)) {
    return `#/doc?path=${encodeURIComponent(path)}`;
  }
  if (/^(wiki|raw|sources)\//.test(path)) {
    return `./${path.split("/").map(encodeURIComponent).join("/")}`;
  }
  return null;
}

export function safeDocPath(input) {
  if (!input) return null;
  let path = input;
  try {
    path = decodeURIComponent(input);
  } catch {
    return null;
  }
  path = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (path.includes("..") || path.includes("//") || path.includes(":") || path.includes("?")) return null;
  if (!/^(wiki|raw|sources)\//.test(path)) return null;
  if (!/^[\p{L}\p{N}._/-]+$/u.test(path)) return null;
  return path;
}
