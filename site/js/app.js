import { STRINGS, detectLanguage } from "./i18n.js";
import { renderMarkdown, escapeHtml, safeDocPath } from "./markdown.js";
import { retrieve, searchQuery, contentTokens } from "./retrieve.js";
import { localAnswer, geminiBody, parseAnswer, answerTextFromGemini } from "./ground.js";

const DAILY_LIMIT = 20;
const config = window.QSS_CONFIG || { apiKey: "", model: "gemini-3.8-flash", sample: false };

const state = {
  lang: "en",
  corpus: { articles: [], chunks: [], sample: false },
  content: { tasks: {} },
  busy: false,
  previousQuestions: [],
};

const els = {
  form: document.getElementById("ask-form"),
  question: document.getElementById("question"),
  suggestions: document.getElementById("suggestions"),
  answer: document.getElementById("answer"),
  answerStatus: document.getElementById("answer-status"),
  answerBody: document.getElementById("answer-body"),
  answerSources: document.getElementById("answer-sources"),
  taskList: document.getElementById("task-list"),
  libraryList: document.getElementById("library-list"),
  pageTitle: document.getElementById("page-title"),
  pageMeta: document.getElementById("page-meta"),
  pageBody: document.getElementById("page-body"),
  ask: document.getElementById("panel-ask"),
  library: document.getElementById("panel-library"),
  page: document.getElementById("panel-page"),
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
      renderTasks();
      renderRoute();
    });
  });
  document.querySelectorAll("[data-scroll]").forEach((link) => {
    link.addEventListener("click", (event) => {
      const id = link.getAttribute("data-scroll");
      const route = parseRoute();
      if (route.name !== "ask") {
        location.hash = `#/${id}`;
        return;
      }
      event.preventDefault();
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
      history.replaceState(null, "", `#${id}`);
    });
  });
  window.addEventListener("hashchange", renderRoute);
  await Promise.all([loadCorpus(), loadContent()]);
  renderSuggestions();
  renderTasks();
  renderRoute();
}

async function loadCorpus() {
  try {
    const response = await fetch("./corpus.json");
    if (response.ok) state.corpus = await response.json();
  } catch {
    state.corpus = { articles: [], chunks: [], sample: false };
  }
}

async function loadContent() {
  try {
    const response = await fetch("./content.json");
    if (response.ok) state.content = await response.json();
  } catch {
    state.content = { tasks: {} };
  }
}

function t() {
  return STRINGS[state.lang] || STRINGS.en;
}

function applyLanguage() {
  const text = t();
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.lang === "ar" ? "rtl" : "ltr";
  document.body.dir = document.documentElement.dir;
  document.title = text.brand;
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.getAttribute("data-i18n");
    if (text[key] != null) node.textContent = text[key];
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    const key = node.getAttribute("data-i18n-placeholder");
    if (text[key] != null) node.setAttribute("placeholder", text[key]);
  });
  document.querySelectorAll("[data-lang]").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.lang === state.lang ? "true" : "false");
  });
  renderSuggestions();
}

function renderSuggestions() {
  const text = t();
  const items = text.suggestions || [];
  els.suggestions.innerHTML = items
    .map(
      (question) =>
        `<button type="button" class="suggestion" data-q="${escapeHtml(question)}">${escapeHtml(question)}</button>`,
    )
    .join("");
  els.suggestions.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      els.question.value = button.dataset.q;
      els.question.focus();
    });
  });
}

function renderTasks() {
  const tasks = (state.content.tasks && state.content.tasks[state.lang]) || state.content.tasks?.en || [];
  if (!tasks.length) {
    els.taskList.innerHTML = "";
    return;
  }
  els.taskList.innerHTML = tasks
    .map(
      (task) =>
        `<article class="task-item"><h3>${escapeHtml(task.title || "")}</h3><p>${escapeHtml(task.body || "")}</p></article>`,
    )
    .join("");
}

function parseRoute() {
  const raw = (location.hash || "#/").replace(/^#/, "");
  if (raw === "about" || raw === "mission" || raw === "tasks") return { name: "ask", scroll: raw };
  const [path, query] = raw.split("?");
  const params = new URLSearchParams(query || "");
  if (path.startsWith("/page") || path.startsWith("/doc")) return { name: "page", path: params.get("path") || "" };
  if (path.startsWith("/library")) return { name: "library" };
  if (path.startsWith("/about")) return { name: "ask", scroll: "about" };
  if (path.startsWith("/mission")) return { name: "ask", scroll: "mission" };
  if (path.startsWith("/tasks")) return { name: "ask", scroll: "tasks" };
  return { name: "ask" };
}

function renderRoute() {
  const route = parseRoute();
  els.ask.hidden = route.name !== "ask";
  els.library.hidden = route.name !== "library";
  els.page.hidden = route.name !== "page";
  els.ask.classList.toggle("is-active", route.name === "ask");
  document.querySelectorAll("[data-route]").forEach((link) => {
    const target = link.getAttribute("data-route");
    if (target === route.name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (route.name === "library") renderLibrary();
  if (route.name === "page") renderPage(route.path);
  if (route.name === "ask" && route.scroll) {
    requestAnimationFrame(() => {
      document.getElementById(route.scroll)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}

async function onSubmit(event) {
  event.preventDefault();
  if (state.busy) return;
  const question = els.question.value.trim();
  if (!question) return;

  const submit = els.form.querySelector('button[type="submit"]');
  state.busy = true;
  if (submit) submit.disabled = true;
  showAnswer({ status: t().answerThinking, body: "", sources: [] });

  const chunks = state.corpus.chunks || [];
  const query = searchQuery(state.previousQuestions, question);
  const hits = chunks.length ? retrieve(chunks, query) : [];
  state.previousQuestions.push(question);

  try {
    if (!chunks.length) {
      showAnswer({ status: "", body: localAnswer("empty", state.lang), sources: [] });
      return;
    }
    if (!hits.length) {
      showAnswer({ status: "", body: localAnswer("nomatch", state.lang), sources: [] });
      return;
    }
    if (!config.apiKey || asksToday() >= DAILY_LIMIT) {
      const status = !config.apiKey ? t().answerLocal : t().answerQuota;
      showAnswer({
        status,
        body: hits.map((hit) => hit.text).join("\n\n"),
        sources: hits,
        query,
      });
      return;
    }
    const payload = await askGemini(question, hits);
    const parsed = parseAnswer(
      answerTextFromGemini(payload),
      hits.map((hit) => hit.path),
    );
    recordAsk();
    const cited = hits.filter(
      (hit) => parsed.refused || parsed.citations.includes(hit.path) || parsed.citations.length === 0,
    );
    showAnswer({
      status: "",
      bodyHtml: renderMarkdown(parsed.answer),
      sources: cited,
      query,
    });
  } catch (error) {
    showAnswer({
      status: `${t().answerError} ${error.message || ""}`.trim(),
      body: hits.map((hit) => hit.text).join("\n\n"),
      sources: hits,
      query,
    });
  } finally {
    state.busy = false;
    if (submit) submit.disabled = false;
    els.answer.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function showAnswer({ status, body = "", bodyHtml = "", sources = [], query = "" }) {
  els.answer.hidden = false;
  els.answerStatus.textContent = status || "";
  if (bodyHtml) els.answerBody.innerHTML = bodyHtml;
  else els.answerBody.textContent = body;
  if (!sources.length) {
    els.answerSources.innerHTML = "";
    return;
  }
  const label = escapeHtml(t().answerSources);
  els.answerSources.innerHTML =
    `<p><strong>${label}</strong></p>` +
    sources
      .map((source) => {
        const href = `#/page?path=${encodeURIComponent(source.path)}`;
        const snippet = highlight(source.text.slice(0, 220), query);
        return `<div><a href="${href}">${escapeHtml(source.title || source.path)}</a><p>${snippet}${source.text.length > 220 ? "…" : ""}</p></div>`;
      })
      .join("");
}

function highlight(text, query) {
  let safe = escapeHtml(text);
  for (const token of contentTokens(query || "")) {
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
    if (last.status === 400 && body.generationConfig?.thinkingConfig) {
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
    return {
      ok: false,
      status: 0,
      message: error.name === "AbortError" ? "The request took too long." : "The browser could not reach Gemini.",
    };
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
    els.libraryList.innerHTML = `<p>${escapeHtml(text.emptyLibrary)}</p>`;
    return;
  }
  els.libraryList.innerHTML = articles
    .map((article) => {
      const href = `#/page?path=${encodeURIComponent(article.path)}`;
      const meta = article.updated ? `${text.updated} ${article.updated}` : article.kind || "";
      return `<a class="library-item" href="${href}"><strong>${escapeHtml(article.title)}</strong><span>${escapeHtml(meta)}</span></a>`;
    })
    .join("");
}

async function renderPage(rawPath) {
  const text = t();
  const path = safeDocPath(rawPath);
  if (!path) {
    els.pageTitle.textContent = text.notFound;
    els.pageMeta.textContent = "";
    els.pageBody.textContent = "";
    return;
  }
  const article = (state.corpus.articles || []).find((item) => item.path === path);
  els.pageTitle.textContent = article?.title || path.split("/").pop();
  els.pageMeta.textContent = article?.updated ? `${text.updated} ${article.updated}` : text.sourceDoc;
  if (!path.endsWith(".md")) {
    const href = `./${path.split("/").map(encodeURIComponent).join("/")}`;
    els.pageBody.innerHTML = `<p><a href="${href}">${escapeHtml(path)}</a></p>`;
    return;
  }
  const href = `./${path.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(href);
  if (!response.ok) {
    els.pageBody.textContent = text.notFound;
    return;
  }
  const markdown = await response.text();
  els.pageBody.innerHTML = renderMarkdown(markdown, { from: path });
}
