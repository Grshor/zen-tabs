"use strict";
// core.js — вся логика разбора вкладок. Один файл грузится двумя способами:
//   * как обычный <script> в расширении (попадает в globalThis.ZenTabs);
//   * через require() из CLI на Bun/Node.
// Зависимостей нет: ни в браузере, ни в консоли.
//
// Два режима разбора:
//   "taxonomy" (по умолчанию) — модель даёт каждой вкладке категорию из короткого списка.
//      Ответ короткий, склейка между чанками точная: 689 вкладок дают ≤12 групп и никаких
//      «код / работа с кодом / Документы и код» из разных чанков.
//   "free" — модель сама придумывает группы. Семантически богаче, но на 2B-модели
//      несогласованно между чанками и хуже переживает усечение ответа.

const DEFAULT_ENDPOINT = "http://127.0.0.1:8091/v1/chat/completions";
const DEFAULT_CHUNK = 40;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_GROUPS = 8;
const PALETTE = ["blue", "purple", "cyan", "green", "yellow", "orange", "red", "pink"];

const TAXONOMY = [
  "код",
  "документы",
  "учёба",
  "видео",
  "музыка",
  "игры",
  "покупки",
  "переписка",
  "соцсети",
  "новости",
  "поиск",
  "разное",
];

const TRACKING_PARAMS = /^(utm_|fbclid|yclid|gclid|msclkid|dclid|ref$|ref_src|spm|igshid|mc_(cid|eid))/i;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "(без адреса)";
  }
}

/** URL без якоря, без utm-хвостов и с сортированными параметрами — основа для поиска дублей. */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    return u.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return String(url || "").toLowerCase();
  }
}

/** Вкладки, ведущие на одну и ту же страницу (с точностью до utm/якоря). */
function findDuplicates(tabs) {
  const byKey = new Map();
  for (const tab of tabs) {
    const key = normalizeUrl(tab.url);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(tab);
  }
  return [...byKey.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({ key, tabs: group }))
    .sort((a, b) => b.tabs.length - a.tabs.length);
}

/** Детерминированная группировка по домену: работает без модели и мгновенно. */
function groupByDomain(tabs, { min = 2 } = {}) {
  const byHost = new Map();
  for (const tab of tabs) {
    const host = hostOf(tab.url);
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(tab);
  }
  const groups = [];
  const singles = [];
  for (const [host, group] of byHost) {
    if (group.length >= min) groups.push({ name: host, tabIds: group.map((t) => t.id) });
    else singles.push(...group.map((t) => t.id));
  }
  groups.sort((a, b) => b.tabIds.length - a.tabIds.length);
  return { groups, leftovers: singles };
}

function tabLines(numbered) {
  return numbered.map((t) => `${t.id}. ${t.title || "(без заголовка)"} | ${t.url}`).join("\n");
}

function taxonomyMessages(numbered) {
  return [
    { role: "system", content: "Ты раскладываешь вкладки браузера по категориям. Отвечай строго по формату." },
    {
      role: "user",
      content:
        "Каждой вкладке дай ровно одну категорию из списка:\n" +
        `${TAXONOMY.join(", ")}\n` +
        "Формат ответа — одна строка на вкладку, ничего больше:\n" +
        "номер: категория\n" +
        "Пример строки: 12: видео\n" +
        "Слово «номер» писать не надо, только цифру и категорию.\n\n" +
        `Вкладки:\n${tabLines(numbered)}`,
    },
  ];
}

function freeMessages(numbered) {
  return [
    { role: "system", content: "Ты аккуратный классификатор вкладок браузера. Отвечай только JSON." },
    {
      role: "user",
      content:
        "Разложи вкладки браузера по смысловым группам: в одной группе — вкладки на одну тему.\n" +
        'Ответ — ТОЛЬКО JSON вида {"groups":[{"name":"имя группы","tabs":[1,4,9]}]}\n' +
        `Правила: каждый номер ровно в одной группе; групп не больше ${MAX_GROUPS}; ` +
        "имя группы — 1-3 слова по-русски; никаких пояснений и текста вокруг JSON.\n\n" +
        `Вкладки:\n${tabLines(numbered)}`,
    },
  ];
}

/** Строки «номер: категория» → Map(номер → категория). Переживает точки, скобки и лишний текст. */
function parseTaxonomy(text, validIds) {
  const labels = new Map();
  for (const line of String(text || "").split("\n")) {
    // Модель любит добавлять префикс («номер: 12: видео») и менять разделитель — терпим оба.
    const match = line.match(/^\s*(?:номер|вкладка|tab|№|#)?\s*[:\-–.)]?\s*(\d{1,4})\s*[:.)\-–]\s*(.+?)\s*$/i);
    if (!match) continue;
    const id = Number(match[1]);
    if (!validIds.has(id) || labels.has(id)) continue;
    labels.set(id, canonicalLabel(match[2]));
  }
  return labels;
}

// Синонимы, которые 2B-модель выдаёт вместо наших категорий (в том числе по-английски).
const SYNONYMS = new Map(
  Object.entries({
    код: ["code", "coding", "dev", "development", "programming", "github", "программирование", "разработка", "репозиторий"],
    документы: ["docs", "documentation", "documents", "wiki", "вики", "документация", "справка", "книги"],
    учёба: ["study", "education", "learning", "learn", "обучение", "курс", "уроки", "статьи"],
    видео: ["video", "youtube", "anime", "аниме", "фильмы", "сериалы", "стрим", "twitch", "клипы"],
    музыка: ["music", "audio", "song", "songs", "lyrics", "песни", "треки", "альбомы"],
    игры: ["games", "game", "gaming", "игра", "игрушки", "моды", "steam"],
    покупки: ["shopping", "shop", "market", "маркет", "заказы", "товары", "озон", "маркетплейс"],
    переписка: ["chat", "mail", "email", "messages", "почта", "мессенджер", "телеграм", "telegram", "форум"],
    соцсети: ["social", "social networks", "twitter", "reddit", "vk", "соцсеть", "лента"],
    новости: ["news", "articles", "blog", "blogs", "статья", "блог", "новость"],
    поиск: ["search", "поисковик", "карты", "maps", "переводчик", "translate"],
    разное: ["other", "misc", "miscellaneous", "остальное", "прочее"],
  }).flatMap(([label, words]) => [label, ...words].map((word) => [word, label]))
);

function canonicalLabel(raw) {
  const value = String(raw).toLowerCase().replace(/[«»"'.,*]/g, "").trim();
  if (TAXONOMY.includes(value)) return value;
  const direct = SYNONYMS.get(value);
  if (direct) return direct;
  const partial = TAXONOMY.find((label) => value.includes(label) || label.includes(value));
  if (partial) return partial;
  for (const [word, label] of SYNONYMS) if (value.includes(word)) return label;
  return "разное";
}

/** Первый сбалансированный {...} из ответа модели: переживает ```json и болтовню вокруг. */
function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Спасает усечённый или склеенный ответ: вытаскивает пары имя→номера регуляркой. */
function salvageGroups(text) {
  const groups = [];
  const pattern = /"name"\s*:\s*"([^"]{1,40})"\s*,\s*"(?:tabs|tabIds|ids)"\s*:\s*\[([0-9,\s]*)\]/g;
  for (const match of String(text || "").matchAll(pattern)) {
    const tabIds = match[2]
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value));
    if (tabIds.length) groups.push({ name: match[1], tabIds });
  }
  return groups;
}

/** Проверка ответа модели: только известные номера, каждый не больше одного раза. */
function parsePlan(json, validIds) {
  const groups = [];
  const taken = new Set();
  const raw = Array.isArray(json?.groups) ? json.groups : [];
  for (const group of raw) {
    const name = String(group?.name ?? "").trim().slice(0, 40) || "Без имени";
    const listed = Array.isArray(group?.tabs) ? group.tabs : Array.isArray(group?.tabIds) ? group.tabIds : [];
    const tabIds = [];
    for (const value of listed) {
      const id = Number(value);
      if (!Number.isInteger(id) || !validIds.has(id) || taken.has(id)) continue;
      taken.add(id);
      tabIds.push(id);
    }
    if (tabIds.length) groups.push({ name, tabIds });
  }
  return { groups };
}

async function callModel(endpoint, messages, { timeoutMs, fetchImpl, maxTokens }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ model: "local", temperature: 0.2, max_tokens: maxTokens, messages }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return {
      text: data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "",
      usage: data?.usage || {},
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Разложить вкладки по смыслу локальной моделью.
 * Большие списки режутся на чанки; категории склеиваются по названию.
 * options: {mode, endpoint, chunkSize, timeoutMs, maxTokens, fetchImpl, onProgress}
 */
async function plan(tabs, options = {}) {
  const mode = options.mode === "free" ? "free" : "taxonomy";
  const endpoint = options.endpoint || DEFAULT_ENDPOINT;
  const chunkSize = options.chunkSize || DEFAULT_CHUNK;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxTokens = options.maxTokens || (mode === "taxonomy" ? 700 : 2000);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const started = Date.now();
  // Внутри промпта вкладки нумеруются подряд (1..N) — так модели проще. Наружу возвращаем
  // исходные id вкладок браузера, иначе применять план нечем.
  const numbered = tabs.map((tab, index) => ({
    id: index + 1,
    originalId: tab.id ?? index + 1,
    title: tab.title,
    url: tab.url,
  }));
  const toOriginal = (id) => numbered[id - 1].originalId;
  const merged = new Map();
  const taken = new Set();
  const errors = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  const chunks = [];
  for (let start = 0; start < numbered.length; start += chunkSize) chunks.push(numbered.slice(start, start + chunkSize));

  for (const [chunkIndex, chunk] of chunks.entries()) {
    const validIds = new Set(chunk.map((t) => t.id));
    options.onProgress?.({ chunk: chunkIndex + 1, chunks: chunks.length, from: chunk[0].id, to: chunk[chunk.length - 1].id });
    let text = "";
    try {
      const answer = await callModel(
        endpoint,
        mode === "taxonomy" ? taxonomyMessages(chunk) : freeMessages(chunk),
        { timeoutMs, fetchImpl, maxTokens }
      );
      text = answer.text;
      usage.prompt_tokens += answer.usage.prompt_tokens || 0;
      usage.completion_tokens += answer.usage.completion_tokens || 0;
    } catch (error) {
      errors.push(`вкладки ${chunk[0].id}-${chunk[chunk.length - 1].id}: ${error?.message || error}`);
      continue;
    }

    let assigned;
    if (mode === "taxonomy") {
      assigned = [...parseTaxonomy(text, validIds)].map(([id, label]) => ({ name: label, tabIds: [id] }));
    } else {
      const fromJson = parsePlan(extractJson(text), validIds).groups;
      assigned = fromJson.length ? fromJson : parsePlan({ groups: salvageGroups(text) }, validIds).groups;
    }

    if (!assigned.length) {
      errors.push(`вкладки ${chunk[0].id}-${chunk[chunk.length - 1].id}: модель не вернула разбор`);
      errors.push(`ответ модели: ${String(text).trim().slice(0, 160)}`);
      continue;
    }
    for (const group of assigned) {
      const fresh = group.tabIds.filter((id) => !taken.has(id));
      fresh.forEach((id) => taken.add(id));
      if (!fresh.length) continue;
      const key = group.name.toLowerCase();
      const existing = merged.get(key);
      if (existing) existing.tabIds.push(...fresh);
      else merged.set(key, { name: group.name, tabIds: fresh });
    }
  }

  const groups = [...merged.values()]
    .map((group) => ({ name: displayName(group.name), tabIds: group.tabIds.sort((a, b) => a - b).map(toOriginal) }))
    .sort((a, b) => b.tabIds.length - a.tabIds.length);
  return {
    mode,
    groups,
    leftovers: numbered
      .map((t) => t.id)
      .filter((id) => !taken.has(id))
      .map(toOriginal),
    errors,
    usage,
    ms: Date.now() - started,
  };
}

function displayName(label) {
  const value = String(label);
  if (value.length <= 1) return value.toUpperCase();
  return value[0].toUpperCase() + value.slice(1);
}

/** Что именно надо вызвать в браузере, чтобы применить план (чистая функция — тестируется без DOM). */
function groupingCalls(groups) {
  return groups.map((group, index) => ({
    name: group.name,
    color: PALETTE[index % PALETTE.length],
    tabIds: group.tabIds,
  }));
}

/** Раскладка вкладок «подряд, в порядке плана» — запасной путь, если браузер не умеет группы. */
function adjacencyOrder(groups) {
  return groups.flatMap((group) => group.tabIds);
}

const ZenTabs = {
  DEFAULT_ENDPOINT,
  DEFAULT_CHUNK,
  MAX_GROUPS,
  PALETTE,
  TAXONOMY,
  hostOf,
  normalizeUrl,
  findDuplicates,
  groupByDomain,
  taxonomyMessages,
  freeMessages,
  parseTaxonomy,
  canonicalLabel,
  extractJson,
  salvageGroups,
  parsePlan,
  plan,
  groupingCalls,
  adjacencyOrder,
};

if (typeof module !== "undefined" && module.exports) module.exports = ZenTabs;
if (typeof globalThis !== "undefined") globalThis.ZenTabs = ZenTabs;
