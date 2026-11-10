import { STRINGS, detectLanguage } from "./i18n.js";
import { renderMarkdown, escapeHtml, safeDocPath } from "./markdown.js";
import { retrieve, searchQuery, contentTokens } from "./retrieve.js";
import {
  localAnswer,
  geminiBody,
  parseAnswer,
  answerTextFromGemini,
  detectQuestionLanguage,
  HISTORY_TURN_LIMIT,
} from "./ground.js";

const DAILY_LIMIT = 20;
const SESSION_KEY = "qss-chat-messages";
const config = window.QSS_CONFIG || { apiKey: "", model: "gemini-3.8-flash", sample: false };

const state = {
  lang: "en",
  corpus: { articles: [], chunks: [], sample: false },
  content: { tasks: {} },
  busy: false,
  messages: [],
  previousQuestions: [],
};

const els = {
  form: document.getElementById("ask-form"),
  question: document.getElementById("question"),
  suggestions: document.getElementById("suggestions"),
  thread: document.getElementById("thread"),
  chatStage: document.getElementById("chat-stage"),
  newChat: document.getElementById("new-chat"),
  hero: document.querySelector(".hero"),
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
  loadSession();
  applyLanguage();
  els.form.addEventListener("submit", onSubmit);
  els.question.addEventListener("keydown", onComposerKey);
  els.newChat.addEventListener("click", clearChat);
  document.querySelectorAll("[data-lang]").forEach((button) => {
    button.addEventListener("click", () => {
      state.lang = button.dataset.lang;
      localStorage.setItem("qss-lang", state.lang);
      applyLanguage();
      renderTasks();
      renderThread();
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
  renderThread();
  renderRoute();
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    state.messages = parsed.filter((item) => item && (item.role === "user" || item.role === "assistant"));
    state.previousQuestions = state.messages.filter((item) => item.role === "user").map((item) => item.text);
  } catch {
    state.messages = [];
  }
}

function saveSession() {
  const durable = state.messages
    .filter((item) => item.kind !== "pending")
    .map((item) => ({
      role: item.role,
      text: item.text || "",
      kind: item.kind,
      sources: (item.sources || []).map((source) => ({
        path: source.path,
        title: source.title,
        text: source.text,
      })),
      query: item.query || "",
      askLang: item.askLang,
    }));
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(durable));
}

function clearChat() {
  state.messages = [];
  state.previousQuestions = [];
  sessionStorage.removeItem(SESSION_KEY);
  renderThread();
  els.question.focus();
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

function t(lang = state.lang) {
  return STRINGS[lang] || STRINGS.en;
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
  const box = els.suggestions?.closest(".suggestions");
  if (state.messages.length) {
    if (box) box.hidden = true;
    return;
  }
  if (box) box.hidden = false;
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

function onComposerKey(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.form.requestSubmit();
  }
}

async function onSubmit(event) {
  event.preventDefault();
  if (state.busy) return;
  const question = els.question.value.trim();
  if (!question) return;

  const askLang = detectQuestionLanguage(question, state.lang);
  const submit = els.form.querySelector('button[type="submit"]');
  state.busy = true;
  if (submit) submit.disabled = true;
  els.question.value = "";

  state.messages.push({ role: "user", text: question, askLang });
  state.messages.push({ role: "assistant", kind: "pending", askLang });
  renderThread();

  const chunks = state.corpus.chunks || [];
  const query = searchQuery(state.previousQuestions, question);
  const hasKey = Boolean(config.apiKey) && asksToday() < DAILY_LIMIT;
  const hits = chunks.length ? retrieve(chunks, query, { limit: 8, allowCrossLingual: true }) : [];
  state.previousQuestions.push(question);

  const history = historyForModel();

  try {
    if (!chunks.length) {
      replacePending({
        role: "assistant",
        kind: "local",
        text: localAnswer("empty", askLang),
        askLang,
      });
      return;
    }
    if (!hits.length) {
      replacePending({
        role: "assistant",
        kind: "local",
        text: localAnswer("nomatch", askLang),
        askLang,
      });
      return;
    }
    if (!hasKey) {
      const cross = hits.some((hit) => hit.crossLingual);
      const lead = !config.apiKey
        ? cross
          ? t(askLang).crossLead || localAnswer("passages", askLang)
          : localAnswer("passages", askLang)
        : localAnswer("quota", askLang);
      replacePending({
        role: "assistant",
        kind: "passages",
        text: lead,
        sources: hits,
        query,
        askLang,
      });
      return;
    }
    const payload = await askGemini(question, hits, history);
    const parsed = parseAnswer(
      answerTextFromGemini(payload),
      hits.map((hit) => hit.path),
    );
    recordAsk();
    const cited = hits.filter(
      (hit) => parsed.refused || parsed.citations.includes(hit.path) || parsed.citations.length === 0,
    );
    replacePending({
      role: "assistant",
      kind: "answer",
      text: parsed.answer,
      sources: cited,
      query,
      askLang,
    });
  } catch (error) {
    replacePending({
      role: "assistant",
      kind: "passages",
      text: `${t(askLang).answerError} ${error.message || ""}`.trim(),
      sources: hits,
      query,
      askLang,
    });
  } finally {
    state.busy = false;
    if (submit) submit.disabled = false;
    saveSession();
    els.question.focus();
  }
}

function historyForModel() {
  const completed = state.messages.filter(
    (item) =>
      item.kind !== "pending" &&
      ((item.role === "user" && item.text) ||
        (item.role === "assistant" && item.text && item.kind !== "pending")),
  );
  // Drop the user message we just appended (last user) — geminiBody adds the current question.
  const withoutCurrent = completed.slice(0, -1);
  return withoutCurrent.slice(-HISTORY_TURN_LIMIT).map((item) => ({
    role: item.role === "assistant" ? "assistant" : "user",
    text: item.text,
  }));
}

function replacePending(message) {
  const index = state.messages.findIndex((item) => item.kind === "pending");
  if (index === -1) state.messages.push(message);
  else state.messages.splice(index, 1, message);
  renderThread();
  saveSession();
}

function renderThread() {
  const chatting = state.messages.length > 0;
  els.chatStage.classList.toggle("is-chatting", chatting);
  if (els.hero) els.hero.classList.toggle("is-collapsed", chatting);
  els.newChat.hidden = !chatting;
  renderSuggestions();

  if (!chatting) {
    els.thread.innerHTML = "";
    return;
  }

  els.thread.innerHTML = state.messages
    .map((message, index) => {
      const delay = `style="--delay:${Math.min(index * 40, 160)}ms"`;
      if (message.role === "user") {
        return `<div class="bubble user" ${delay}><p>${escapeHtml(message.text)}</p></div>`;
      }
      const askLang = message.askLang || state.lang;
      if (message.kind === "pending") {
        return `<div class="bubble assistant pending" ${delay}><p class="lead">${escapeHtml(t(askLang).answerThinking)}</p></div>`;
      }
      const body =
        message.kind === "answer"
          ? `<div class="doc-body">${renderMarkdown(message.text || "")}</div>`
          : `<p>${escapeHtml(message.text || "")}</p>`;
      return `<div class="bubble assistant" ${delay} dir="${askLang === "ar" ? "rtl" : "ltr"}">${body}${sourceBlock(message, askLang)}</div>`;
    })
    .join("");

  const last = els.thread.lastElementChild;
  if (last) last.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function sourceBlock(message, askLang) {
  const sources = message.sources || [];
  if (!sources.length) return "";
  const label = escapeHtml(t(askLang).answerSources);
  const cards = sources
    .map((source) => {
      const href = `#/page?path=${encodeURIComponent(source.path)}`;
      const snippet = highlight((source.text || "").slice(0, 180), message.query || "");
      return `<a class="source-link" href="${href}"><strong>${escapeHtml(source.title || source.path)}</strong><span>${snippet}${(source.text || "").length > 180 ? "…" : ""}</span></a>`;
    })
    .join("");
  return `<details class="sources" open><summary>${label}</summary><div class="source-list">${cards}</div></details>`;
}

function highlight(text, query) {
  let safe = escapeHtml(text);
  for (const token of contentTokens(query || "")) {
    const pattern = new RegExp(`(${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "giu");
    safe = safe.replace(pattern, "<mark>$1</mark>");
  }
  return safe;
}

async function askGemini(question, hits, history) {
  const body = geminiBody(question, hits, history);
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
