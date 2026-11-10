/** Rank published passages for a question. No network, no model. */

const STOP = new Set(
  `a an the of to and or for in on at by from with about what which who whom whose how when where why is are was were be been being do does did doing can could should would will just than then into over under again further once here there all any both each few more most other some such no nor not only own same so too very you your yours we us our ours they them their i me my it its this that these those as if but because until while
le la les de des du un une et ou pour dans sur par avec sans que qui quoi dont est sont ete etre ce cet cette ces il elle ils elles nous vous je tu on ne pas plus moins au aux
في من على إلى الى عن هل ما ماذا لماذا كيف هو هي هم هن هذا هذه ذلك تلك ان أن إن كان كانت يكون تكون تم قد لا لم لن`.split(/\s+/),
);

/** Same idea in English, French, and Arabic so a question can find a file written in another language. */
const SYNONYM_GROUPS = [
  ["committee", "committees", "parent", "parents", "community", "comité", "comite", "parents", "لجنة", "لجان", "الأهل", "اهل", "أولياء", "اولياء"],
  ["law", "laws", "legal", "regulation", "regulations", "rule", "rules", "statute", "decree", "loi", "lois", "règlement", "reglement", "décret", "decret", "قانون", "القوانين", "مرسوم", "المراسيم", "قرار", "القرارات", "نظام", "الأنظمة"],
  ["school", "schools", "private", "école", "ecole", "écoles", "ecoles", "مدرسة", "المدارس", "خاصة", "الخاصة"],
  ["budget", "fee", "fees", "tuition", "dues", "budget", "budget", "frais", "scolaire", "موازنة", "الموازنة", "قسط", "أقساط", "الاقساط", "رسوم"],
  ["member", "members", "elect", "election", "vote", "membre", "élection", "election", "أعضاء", "اعضاء", "انتخاب", "انتخابية"],
  ["minutes", "meeting", "meetings", "assemblée", "assemblee", "réunion", "reunion", "محضر", "اجتماع", "اجتماعات"],
  ["qss", "qss"],
];

const PRONOUNS = new Set(["that", "this", "those", "them", "it", "they", "ce", "cette", "cela", "ça", "ذلك", "هذا", "هذه"]);

export function tokenize(text) {
  return (String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(
    (token) => token.length > 1 || /\p{N}/u.test(token),
  );
}

export function contentTokens(text) {
  return [...new Set(tokenize(text).filter((token) => !STOP.has(token) && token.length > 2))];
}

export function expandQueryTokens(query) {
  const base = tokenize(query).filter((token) => !STOP.has(token));
  const expanded = new Set(base);
  for (const token of base) {
    for (const group of SYNONYM_GROUPS) {
      if (group.includes(token)) {
        for (const synonym of group) expanded.add(synonym);
      }
    }
  }
  return [...expanded];
}

export function scriptProfile(text) {
  const tokens = tokenize(text);
  let arabic = 0;
  let latin = 0;
  for (const token of tokens) {
    if (/[\u0600-\u06FF]/.test(token)) arabic += 1;
    else if (/[a-z]/i.test(token)) latin += 1;
  }
  return { arabic, latin, total: tokens.length };
}

export function scriptsMismatch(query, chunks) {
  const question = scriptProfile(query);
  const sample = (chunks || [])
    .slice(0, 12)
    .map((chunk) => `${chunk.title || ""} ${chunk.text || ""}`)
    .join(" ");
  const corpus = scriptProfile(sample);
  if (!question.total || !corpus.total) return false;
  const questionArabic = question.arabic >= question.latin;
  const corpusArabic = corpus.arabic >= corpus.latin;
  return questionArabic !== corpusArabic;
}

export function search(chunks, query, limit = 6) {
  const list = Array.isArray(chunks) ? chunks : [];
  const content = expandQueryTokens(query);
  if (!content.length) return broadOverview(list, limit);
  if (!list.length) return [];

  const docs = list.map((chunk) => tokenize(`${chunk.title} ${chunk.title} ${chunk.heading} ${chunk.text}`));
  const df = new Map();
  for (const doc of docs) {
    for (const token of new Set(doc)) df.set(token, (df.get(token) || 0) + 1);
  }
  const total = docs.length;
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / total || 1;
  const k1 = 1.2;
  const b = 0.75;
  const queryCount = new Map();
  for (const token of content) queryCount.set(token, (queryCount.get(token) || 0) + 1);

  const scored = [];
  list.forEach((chunk, index) => {
    const doc = docs[index];
    const tf = new Map();
    for (const token of doc) tf.set(token, (tf.get(token) || 0) + 1);
    let score = 0;
    let overlap = 0;
    for (const [term, count] of queryCount) {
      const frequency = tf.get(term) || 0;
      if (!frequency) continue;
      overlap += 1;
      const documentsWithTerm = df.get(term) || 0;
      const idf = Math.log(1 + (total - documentsWithTerm + 0.5) / (documentsWithTerm + 0.5));
      const numerator = frequency * (k1 + 1);
      const denominator = frequency + k1 * (1 - b + (b * doc.length) / average);
      score += idf * (numerator / denominator) * count;
    }
    if (!overlap) return;
    if (chunk.kind === "wiki") score *= 1.25;
    scored.push({ ...chunk, score, broad: false, crossLingual: false });
  });
  scored.sort((left, right) => right.score - left.score);
  return scored.slice(0, limit);
}

export function hasDomainSignal(query) {
  const base = new Set(tokenize(query).filter((token) => !STOP.has(token)));
  return expandQueryTokens(query).some((token) => !base.has(token));
}

/**
 * Prefer keyword hits. If the question language does not match the files,
 * and the question looks committee-related, fall back to opening passages
 * so Gemini can answer in the asker's language.
 */
export function retrieve(chunks, query, { limit = 8, allowCrossLingual = true } = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  if (!list.length) return [];
  const hits = search(list, query, limit);
  if (hits.length) return hits;
  if (!allowCrossLingual || !scriptsMismatch(query, list) || !hasDomainSignal(query)) return [];
  return crossLingualFallback(list, limit);
}

export function crossLingualFallback(chunks, limit = 8) {
  const list = Array.isArray(chunks) ? chunks : [];
  if (!list.length) return [];
  const byPath = new Map();
  for (const chunk of list) {
    const bucket = byPath.get(chunk.path) || [];
    bucket.push(chunk);
    byPath.set(chunk.path, bucket);
  }
  const picked = [];
  for (const bucket of byPath.values()) {
    const opening = bucket.slice(0, 4);
    for (const chunk of opening) {
      picked.push({ ...chunk, score: 0, broad: true, crossLingual: true });
      if (picked.length >= limit) return picked;
    }
  }
  if (picked.length) return picked;
  return list.slice(0, limit).map((chunk) => ({ ...chunk, score: 0, broad: true, crossLingual: true }));
}

function broadOverview(chunks, limit) {
  const overviews = chunks.filter((chunk) => chunk.kind === "wiki" && /^overview$/i.test(chunk.heading || ""));
  const pool = overviews.length ? overviews : chunks.filter((chunk) => chunk.kind === "wiki");
  const source = pool.length ? pool : chunks;
  return source.slice(0, limit).map((chunk) => ({ ...chunk, score: 0, broad: true, crossLingual: false }));
}

export function searchQuery(previousQuestions, question) {
  const words = tokenize(question);
  const tokens = words.filter((token) => !STOP.has(token));
  const pronoun = words.some((word) => PRONOUNS.has(word));
  // Only a thin follow-up ("what about that?") should inherit the previous question.
  // A new question with its own words must not pull the last topic back in.
  if ((tokens.length <= 1 || pronoun) && previousQuestions.length) {
    return `${previousQuestions[previousQuestions.length - 1]} ${question}`;
  }
  return question;
}
