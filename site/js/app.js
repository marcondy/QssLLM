import { STRINGS, detectLanguage } from "./i18n.js";
import { renderMarkdown, escapeHtml, safeDocPath } from "./markdown.js";
import { search, searchQuery, contentTokens } from "./retrieve.js";
import { localAnswer, geminiBody, parseAnswer, answerTextFromGemini } from "./ground.js";

const DAILY_LIMIT = 20;
const INBOX_URL = "https://github.com/marcondy/QssLLM/tree/main/inbox";
const config = window.QSS_CONFIG || { apiKey: "", model: "gemini-3.8-flash", sample: false };

const state = {
  lang: "en",
  corpus: { articles: [], chunks: [], sample: false },
  messages: [],
  busy: false,
  previousQuestions: [],
};

const els = {
  name: document.getElementById("site-name"),
  tagline: document.getElementById("site-tagline"),
  banner: document.getElementById("sample-banner"),
  heroTitle: document.getElementById("hero-title"),
  scopeTitle: document.getElementById("scope-title"),
  scopeBody: document.getElementById("scope-body"),
  scopeNo: document.getElementById("scope-no"),
  stage: document.getElementById("ask-stage"),
  suggestions: document.getElementById("suggestions"),
  thread: document.getElementById("thread"),
  form: document.getElementById("ask-form"),
  question: document.getElementById("question"),
  send: document.getElementById("send"),
  sendLabel: document.getElementById("send-label"),
  fineprint: document.getElementById("fineprint"),
  emptyNote: document.getElementById("empty-note"),
  ask: document.getElementById("panel-ask"),
  library: document.getElementById("panel-library"),
  doc: document.getElementById("panel-doc"),
  footer: document.getElementById("footer-note"),
};

init();

async function init() {
  state.lang = detectLanguage();
  applyLanguage();
  els.form.addEventListener("submit", onSubmit);
  document.querySelectorAll("[data-lang]").forEach((button) => {
    button.addEventListener("click", () => {
      state.lang = button.dataset.lang;
      localStorage.setItem("qss-lang", state.lang);
      applyLanguage();
      renderRoute();
    });
  });
  window.addEventListener("hashchange", () => {
    restartPanelMotion();
    renderRoute();
  });
  try {
    const response = await fetch("./corpus.json");
    if (response.ok) state.corpus = await response.json();
  } catch {
    state.corpus = { articles: [], chunks: [], sample: false };
  }
  if (state.corpus.sample || config.sample) {
    els.banner.hidden = false;
    els.banner.textContent = STRINGS[state.lang].sampleBanner;
  }
  renderSuggestions();
  renderEmptyNote();
  renderRoute();
}

function t() {
  return STRINGS[state.lang] || STRINGS.en;
}

function applyLanguage() {
  const text = t();
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.lang === "ar" ? "rtl" : "ltr";
  document.body.dir = document.documentElement.dir;
  document.title = text.name;
  els.name.textContent = text.name;
  els.tagline.textContent = text.tagline;
  els.heroTitle.textContent = text.heroTitle;
  els.scopeTitle.textContent = text.scopeTitle;
  els.scopeBody.textContent = text.scopeBody;
  els.scopeNo.textContent = text.scopeNo;
  els.question.placeholder = text.askPlaceholder;
  els.question.setAttribute("aria-label", text.ask);
  els.sendLabel.textContent = text.send;
  els.footer.textContent = text.footer;
  document.querySelector('[data-nav="ask"]').textContent = text.ask;
  document.querySelector('[data-nav="library"]').textContent = text.library;
  document.querySelectorAll("[data-lang]").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.lang === state.lang ? "true" : "false");
  });
  if (!els.banner.hidden) els.banner.textContent = text.sampleBanner;
  renderSuggestions();
  renderEmptyNote();
  renderThread();
  renderFineprint();
}

function renderFineprint() {
  const text = t();
  if (!config.apiKey) {
    els.fineprint.textContent = text.privacyLocal;
    return;
  }
  els.fineprint.textContent = `${text.privacy} ${text.remaining}: ${asksToday()}/${DAILY_LIMIT}.`;
}

function renderSuggestions() {
  if (state.messages.length) {
    els.suggestions.hidden = true;
    return;
  }
  const articles = (state.corpus.articles || []).filter((article) => article.kind === "wiki").slice(0, 3);
  const pool = articles.length ? articles : (state.corpus.articles || []).slice(0, 3);
  if (!pool.length) {
    els.suggestions.hidden = true;
    els.suggestions.innerHTML = "";
    return;
  }
  const text = t();
  els.suggestions.hidden = false;
  els.suggestions.innerHTML = pool
    .map((article, index) => `<button type="button" style="--delay:${180 + index * 70}ms" data-q="${escapeHtml(suggestion(article.title))}">${escapeHtml(suggestion(article.title))}</button>`)
    .join("");
  els.suggestions.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      els.question.value = button.dataset.q;
      els.form.requestSubmit();
    });
  });
  els.suggestions.insertAdjacentHTML("afterbegin", `<span class="sr-only">${escapeHtml(text.suggested)}</span>`);
}

function renderEmptyNote() {
  if ((state.corpus.articles || []).length || state.messages.length) {
    els.emptyNote.hidden = true;
    els.emptyNote.innerHTML = "";
    return;
  }
  els.emptyNote.hidden = false;
  els.emptyNote.innerHTML = `${escapeHtml(t().emptyLibraryBody)} <a href="${INBOX_URL}">${escapeHtml(t().openInbox)}</a>`;
}

function suggestion(title) {
  if (state.lang === "ar") return `ماذا تقول الوثائق عن ${title}؟`;
  if (state.lang === "fr") return `Que disent les documents au sujet de « ${title} » ?`;
  return `What do the documents say about ${title}?`;
}

function restartPanelMotion() {
  for (const panel of [els.ask, els.library, els.doc]) {
    panel.classList.remove("panel");
    void panel.offsetWidth;
    panel.classList.add("panel");
  }
}

function renderRoute() {
  const route = parseRoute();
  els.ask.hidden = route.name !== "ask";
  els.library.hidden = route.name !== "library";
  els.doc.hidden = route.name !== "doc";
  for (const name of ["ask", "library"]) {
    const link = document.querySelector(`[data-nav="${name}"]`);
    if (route.name === name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (route.name === "library") renderLibrary();
  if (route.name === "doc") renderDoc(route.path);
}

function parseRoute() {
  const raw = (location.hash || "#/ask").replace(/^#/, "");
  const [path, query] = raw.split("?");
  const params = new URLSearchParams(query || "");
  if (path.startsWith("/doc")) return { name: "doc", path: params.get("path") || "" };
  if (path.startsWith("/library")) return { name: "library" };
  return { name: "ask" };
}

async function onSubmit(event) {
  event.preventDefault();
  if (state.busy) return;
  const question = els.question.value.trim();
  if (!question) return;
  els.question.value = "";
  els.stage.classList.add("is-chatting");
  state.messages.push({ role: "user", text: question });
  renderThread();
  state.busy = true;
  els.send.disabled = true;
  const pending = { role: "assistant", kind: "pending" };
  state.messages.push(pending);
  renderThread();

  const chunks = state.corpus.chunks || [];
  const query = searchQuery(state.previousQuestions, question);
  const hits = chunks.length ? search(chunks, query) : [];
  state.previousQuestions.push(question);

  try {
    if (!chunks.length) {
      replacePending({ role: "assistant", kind: "local", localKind: "empty" });
      return;
    }
    if (!hits.length) {
      replacePending({ role: "assistant", kind: "local", localKind: "nomatch" });
      return;
    }
    if (!config.apiKey || asksToday() >= DAILY_LIMIT) {
      replacePending({
        role: "assistant",
        kind: "passages",
        lead: !config.apiKey ? t().passagesNoKey : t().quota,
        chunks: hits,
        broad: hits.some((hit) => hit.broad),
        query,
      });
      return;
    }
    const payload = await askGemini(question, hits);
    const parsed = parseAnswer(answerTextFromGemini(payload), hits.map((hit) => hit.path));
    recordAsk();
    replacePending({
      role: "assistant",
      kind: "answer",
      answer: parsed.answer,
      chunks: hits.filter((hit) => parsed.refused || parsed.citations.includes(hit.path) || parsed.citations.length === 0),
      query,
      broad: hits.some((hit) => hit.broad),
    });
  } catch (error) {
    replacePending({
      role: "assistant",
      kind: "passages",
      lead: `${t().error} ${error.message || ""}`.trim(),
      chunks: hits,
      query,
      broad: hits.some((hit) => hit.broad),
    });
  } finally {
    state.busy = false;
    els.send.disabled = false;
    renderFineprint();
    els.question.focus();
  }
}

function replacePending(message) {
  const index = state.messages.findIndex((item) => item.kind === "pending");
  if (index === -1) state.messages.push(message);
  else state.messages.splice(index, 1, message);
  renderThread();
}

function renderThread() {
  const text = t();
  if (state.messages.length) {
    els.stage.classList.add("is-chatting");
    els.suggestions.hidden = true;
    els.emptyNote.hidden = true;
  }
  els.thread.innerHTML = state.messages
    .map((message, index) => {
      const style = `style="--delay:${Math.min(index * 40, 160)}ms"`;
      if (message.role === "user") return `<div class="bubble user" ${style}>${escapeHtml(message.text)}</div>`;
      if (message.kind === "pending") {
        return `<div class="bubble assistant pending" ${style}><p class="lead">${escapeHtml(text.thinking)}</p></div>`;
      }
      if (message.kind === "local") {
        return `<div class="bubble assistant" ${style}><p>${escapeHtml(localAnswer(message.localKind, state.lang))}</p></div>`;
      }
      if (message.kind === "answer") {
        return `<div class="bubble assistant" ${style}><div class="doc-body">${renderMarkdown(message.answer)}</div>${passageBlock(message, text)}</div>`;
      }
      return `<div class="bubble assistant" ${style}><p class="lead">${escapeHtml(message.lead || "")}</p>${passageBlock(message, text)}</div>`;
    })
    .join("");
  const last = els.thread.lastElementChild;
  if (last) last.scrollIntoView({ block: "center", inline: "nearest" });
}

function passageBlock(message, text) {
  const chunks = message.chunks || [];
  if (!chunks.length) return "";
  const lead = message.broad ? `<p class="lead">${escapeHtml(text.broadLead)}</p>` : "";
  const cards = chunks
    .map((chunk) => {
      const href = `#/doc?path=${encodeURIComponent(chunk.path)}`;
      return `<article class="passage"><h3><a href="${href}">${escapeHtml(chunk.title)}</a></h3><p class="meta">${escapeHtml(chunk.heading || text.sourceDoc)}</p><p class="snippet">${highlight(chunk.text, message.query || "")}</p></article>`;
    })
    .join("");
  return `${lead}<details class="passages" open><summary>${escapeHtml(text.passagesTitle)}</summary>${cards}</details>`;
}

function highlight(text, query) {
  let safe = escapeHtml(text);
  for (const token of contentTokens(query)) {
    const pattern = new RegExp(`(${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "giu");
    safe = safe.replace(pattern, "<mark>$1</mark>");
  }
  return safe;
}

async function askGemini(question, hits) {
  const body = geminiBody(question, hits);
  const models = [...new Set([config.model, "gemini-3.8-flash", "gemini-flash-latest"].filter(Boolean))];
  let last = null;
  for (const model of models) {
    last = await postModel(model, body);
    if (last.ok) return last.payload;
    if (last.status === 400 && body.generationConfig.thinkingConfig) {
      const retryBody = JSON.parse(JSON.stringify(body));
      delete retryBody.generationConfig.thinkingConfig;
      const retry = await postModel(model, retryBody);
      if (retry.ok) return retry.payload;
      last = retry;
    }
    if (last.status !== 404) break;
  }
  throw new Error(last?.message || "Gemini could not answer.");
}

async function postModel(model, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, status: response.status, message: payload?.error?.message || `Gemini returned ${response.status}.` };
    }
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, status: 0, message: error.name === "AbortError" ? "The request took too long." : "The browser could not reach Gemini." };
  } finally {
    clearTimeout(timer);
  }
}

function dayStamp() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function asksToday() {
  return Number(localStorage.getItem(`qss-asks-${dayStamp()}`) || "0");
}

function recordAsk() {
  localStorage.setItem(`qss-asks-${dayStamp()}`, String(asksToday() + 1));
}

function renderLibrary() {
  const text = t();
  const articles = state.corpus.articles || [];
  if (!articles.length) {
    els.library.innerHTML = `<div class="empty"><h2>${escapeHtml(text.emptyLibraryTitle)}</h2><p>${escapeHtml(text.emptyLibraryBody)}</p><p><a href="${INBOX_URL}">${escapeHtml(text.openInbox)}</a></p></div>`;
    return;
  }
  const guides = articles.filter((article) => article.kind === "wiki");
  const sources = articles.filter((article) => article.kind === "raw");
  els.library.innerHTML = `<div class="library">${section(text.guides, guides, text.guide, text)}${section(text.sources, sources, text.sourceDoc, text)}</div>`;
}

function section(title, articles, kicker, text) {
  if (!articles.length) return "";
  const cards = articles
    .map((article) => {
      const href = `#/doc?path=${encodeURIComponent(article.path)}`;
      const updated = article.updated ? `${text.updated} ${article.updated}` : "";
      return `<a class="card" href="${href}"><span class="kicker">${escapeHtml(kicker)}</span><h3>${escapeHtml(article.title)}</h3><p>${escapeHtml(article.summary || "")}</p><p>${escapeHtml(updated)}</p></a>`;
    })
    .join("");
  return `<section class="group"><h2>${escapeHtml(title)}</h2><div class="cards">${cards}</div></section>`;
}

async function renderDoc(rawPath) {
  const text = t();
  const path = safeDocPath(rawPath);
  if (!path) {
    els.doc.innerHTML = `<p>${escapeHtml(text.notFound)}</p>`;
    return;
  }
  const back = `<a class="back" href="#/library">${escapeHtml(text.back)}</a>`;
  if (!path.endsWith(".md")) {
    const href = `./${path.split("/").map(encodeURIComponent).join("/")}`;
    els.doc.innerHTML = `${back}<article class="doc"><h1>${escapeHtml(path.split("/").pop())}</h1><p><a href="${href}">${escapeHtml(text.download)}</a></p></article>`;
    return;
  }
  const href = `./${path.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(href);
  if (!response.ok) {
    els.doc.innerHTML = `${back}<p>${escapeHtml(text.notFound)}</p>`;
    return;
  }
  const markdown = await response.text();
  const banner = path.startsWith("raw/") ? `<p class="banner">${escapeHtml(text.sourceBanner)}</p>` : "";
  els.doc.innerHTML = `${back}<article class="doc">${banner}<div class="doc-body">${renderMarkdown(markdown, { from: path })}</div></article>`;
}
