#!/usr/bin/env bun
// assign.mjs — планировщик пространств Zen: каждой вкладке → целевое пространство.
//
//   bun bin/assign.mjs --plan          # назначить по модели и напечатать план-диф
//   bun bin/assign.mjs --plan --json > ~/.cache/zen-tabs/plan.json
//   bun bin/assign.mjs --model 8094    # считать другой моделью (по умолчанию 8091)
//
// Ничего не применяет: только считает план. Вкладки не закрываются никогда —
// перенос = открыть в целевом пространстве и закрыть исходную (режим B в расширении).

import { createRequire } from "node:module";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { mozLz4Decode } from "./session.mjs";

const require = createRequire(import.meta.url);
const core = require("../extension/core.js");

// Целевые пространства: восемь тем, максимально различных по смыслу.
// Подсказки — то, по чему модель должна различать; имена короткие, потому что они
// станут заголовками пространств в Zen.
export const SPACES = [
  { id: 1, name: "код и серверы", hint: "программирование, репозитории, документация, self-hosting, инфраструктура, локальные модели, ИИ-инструменты" },
  { id: 2, name: "медиа", hint: "кино, сериалы, аниме, музыка, клипы, стримы, развлекательные видео, мемы" },
  { id: 3, name: "игры и геймдев", hint: "компьютерные игры, моды, игровые движки, разработка игр, майнкрафт" },
  { id: 4, name: "наука и мышление", hint: "математика, физика, ИИ-исследования, философия, психология, лонгриды и статьи" },
  { id: 5, name: "чтение и арт", hint: "книги, манга, комиксы, иллюстрации, картинки-референсы, визуал" },
  { id: 6, name: "покупки и быт", hint: "магазины, маркетплейсы, товары, одежда, дом, аренда, ремонт, доставка" },
  { id: 7, name: "здоровье, работа, деньги", hint: "медицина и врачи, карьера и вакансии, финансы, инвестиции, банки" },
  { id: 8, name: "железо и самоделки", hint: "компьютеры и комплектующие, девайсы, клавиатуры, DIY, электроника, гаджеты, инструменты" },
];

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const port = Number(args[args.indexOf("--model") + 1]) || 8091;
const batchSize = Number(args[args.indexOf("--batch") + 1]) || 30;
const limit = Number(args[args.indexOf("--limit") + 1]) || 0;
const sample = args.includes("--sample");

/** Свежий zen-sessions.jsonlz4. */
async function findSessions(profilesRoot = join(homedir(), ".zen")) {
  const candidates = [];
  for (const entry of await readdir(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(profilesRoot, entry.name, "zen-sessions.jsonlz4");
    try {
      candidates.push({ path, mtime: (await stat(path)).mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) throw new Error("не нашёл zen-sessions.jsonlz4");
  return candidates[0].path;
}

async function readTabs() {
  const file = await findSessions();
  const zen = JSON.parse(Buffer.from(mozLz4Decode(await readFile(file))).toString("utf8"));
  const spaces = new Map((zen.spaces || []).map((s) => [s.uuid, s.name]));
  const tabs = [];
  for (const tab of zen.tabs || []) {
    const entry = tab.entries?.[Math.max(0, (tab.index || 1) - 1)] || tab.entries?.[tab.entries.length - 1] || {};
    const url = entry.url || "";
    if (!url || /^about:/.test(url)) continue;
    tabs.push({
      id: tabs.length + 1,
      title: (entry.title || "").trim(),
      url,
      space: spaces.get(tab.zenWorkspace) || "(без пространства)",
      pinned: Boolean(tab.pinned),
    });
  }
  return { file, tabs };
}

function spacePrompt(batch, examples) {
  const options = SPACES.map((space) => {
    const sample = (examples.get(space.id) || []).slice(0, 4);
    const tail = sample.length ? ` (например: ${sample.map((s) => `«${s}»`).join(", ")})` : "";
    return `${space.id}. ${space.name} — ${space.hint}${tail}`;
  }).join("\n");
  const lines = batch.map((t) => `${t.id}. ${t.title || "(без заголовка)"} | ${core.hostOf(t.url)}`).join("\n");
  return [
    { role: "system", content: "Ты раскладываешь вкладки браузера по темам. Отвечай строго по формату." },
    {
      role: "user",
      content:
        "Для каждой вкладки выбери ОДНУ тему из списка — ту, к которой она ближе по смыслу, " +
        "а не по сайту (ютуб бывает про что угодно). Если тема непонятна — поставь 0.\n" +
        "Ориентируйся на примеры: вкладки, похожие на них, идут в ту же тему.\n\n" +
        `Темы:\n${options}\n\n` +
        "Формат ответа — одна строка на вкладку, больше ничего:\n" +
        "номер: тема\n" +
        "Пример строки: 12: 3\n\n" +
        `Вкладки:\n${lines}`,
    },
  ];
}

/** Примеры вкладок для каждой темы — из текущих пространств пользователя (карта EXPECTED). */
function buildExamples(tabs) {
  const examples = new Map();
  for (const tab of tabs) {
    const target = EXPECTED[tab.space];
    if (!target) continue;
    if (!examples.has(target)) examples.set(target, []);
    const list = examples.get(target);
    if (list.length < 4 && tab.title) list.push(tab.title.slice(0, 46));
  }
  return examples;
}

/** Ответ модели: строки «номер: N» → Map(id → число), N в пределах maxValue. */
function parseAssignments(text, validIds, maxValue = 99) {
  const result = new Map();
  for (const line of String(text || "").split("\n")) {
    const match = line.match(/^\s*(?:номер|вкладка|tab|№|#)?\s*[:\-–.)]?\s*(\d{1,4})\s*[:.)\-–]\s*(\d{1,2})\s*$/i);
    if (!match) continue;
    const id = Number(match[1]);
    const value = Number(match[2]);
    if (!validIds.has(id) || result.has(id)) continue;
    // 0 (или значение вне списка) означает «не понял» — для тем это «оставить как есть»,
    // для подтем — «прочее».
    result.set(id, value === 0 || value > maxValue ? 0 : value);
  }
  return result;
}

/** Один запрос к модели: короткий, без цепочек рассуждений. */
async function askModel(endpoint, messages, maxTokens = 700, timeoutMs = 300000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ model: "local", temperature: 0.2, max_tokens: maxTokens, messages }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data?.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

async function assign(tabs, endpoint, examples) {
  const assigned = new Map();
  let done = 0;
  let errors = 0;
  for (let start = 0; start < tabs.length; start += batchSize) {
    const batch = tabs.slice(start, start + batchSize);
    const valid = new Set(batch.map((t) => t.id));
    let text = "";
    try {
      text = await askModel(endpoint, spacePrompt(batch, examples));
    } catch {
      errors++;
      continue;
    }
    const parsed = parseAssignments(text, valid, SPACES.length);
    for (const [id, topic] of parsed) assigned.set(id, topic);
    done += parsed.size;
    process.stderr.write(`\r  пространства: ${done}/${tabs.length}${errors ? `, ошибок ${errors}` : ""}   `);
  }
  process.stderr.write("\n");
  return assigned;
}

/** Шаг 1: модель предлагает 4-6 подтем для пространства по примерам вкладок. */
async function proposeSubtopics(space, sampleTitles, endpoint) {
  const messages = [
    { role: "system", content: "Ты предлагаешь короткие подтемы для набора вкладок. Отвечай строго по формату." },
    {
      role: "user",
      content:
        `Это пространство «${space.name}» (${space.hint}). Вот примеры вкладок:\n` +
        sampleTitles.map((title, i) => `${i + 1}. ${title}`).join("\n") +
        "\n\nПредложи 4-6 коротких подтем (1-2 слова по-русски), которые покрывают такие вкладки. " +
        "Формат: одна подтема на строку, без нумерации и пояснений.",
    },
  ];
  const text = await askModel(endpoint, messages, 120);
  return text
    .split("\n")
    .map((line) => line.replace(/^[\s\-*•\d.)]+/, "").replace(/[«»"']/g, "").trim().toLowerCase())
    .filter((line) => line && line.length <= 28 && !line.includes(":"))
    .slice(0, 6);
}

function subtopicPrompt(space, names, batch) {
  const list = names.map((name, i) => `${i + 1}. ${name}`).join("\n");
  const lines = batch.map((t) => `${t.id}. ${t.title || "(без заголовка)"} | ${core.hostOf(t.url)}`).join("\n");
  return [
    { role: "system", content: "Ты раскладываешь вкладки по подтемам. Отвечай строго по формату." },
    {
      role: "user",
      content:
        `Пространство «${space.name}». Подтемы этого пространства:\n${list}\n\n` +
        "Для каждой вкладки выбери ОДИН номер подтемы из списка. Если не подходит ни одна — 0.\n" +
        "Формат ответа — одна строка на вкладку, больше ничего:\n" +
        "номер: подтема\n" +
        "Пример строки: 12: 2\n\n" +
        `Вкладки:\n${lines}`,
    },
  ];
}

/** Шаг 2: каждая вкладка пространства получает одну из предложенных подтем. */
async function subtopics(tabs, spaceOf, endpoint) {
  const labels = new Map();
  const proposed = new Map();
  const bySpace = new Map();
  for (const tab of tabs) {
    const target = spaceOf.get(tab.id);
    if (!target) continue;
    if (!bySpace.has(target)) bySpace.set(target, []);
    bySpace.get(target).push(tab);
  }
  let done = 0;
  for (const [target, own] of bySpace) {
    const space = SPACES.find((s) => s.id === target);
    const names = await proposeSubtopics(space, own.slice(0, 8).map((t) => t.title || core.hostOf(t.url)), endpoint);
    proposed.set(target, names);
    if (!names.length) {
      done += own.length;
      continue;
    }
    for (let start = 0; start < own.length; start += batchSize) {
      const batch = own.slice(start, start + batchSize);
      const valid = new Set(batch.map((t) => t.id));
      try {
        const parsed = parseAssignments(await askModel(endpoint, subtopicPrompt(space, names, batch)), valid, names.length);
        for (const [id, index] of parsed) labels.set(id, index ? names[index - 1] : "прочее");
      } catch {
        /* останется «прочее» */
      }
      done += batch.length;
      process.stderr.write(`\r  подтемы: ${done}/${tabs.length}   `);
    }
  }
  process.stderr.write("\n");
  for (const [target, names] of proposed) {
    process.stderr.write(`  ${SPACES.find((s) => s.id === target).name}: подтемы — ${names.join(", ") || "(не предложены)"}\n`);
  }
  return labels;
}

function buildPlan(tabs, spaceOf, groupOf) {
  const byTarget = new Map(SPACES.map((s) => [s.id, { space: s, tabs: [] }]));
  const moving = [];
  for (const tab of tabs) {
    const target = spaceOf.get(tab.id) || 0;
    const record = { ...tab, group: groupOf.get(tab.id) || "прочее", target };
    if (target === 0) continue;
    byTarget.get(target).tabs.push(record);
    if (SPACES.find((s) => s.id === target).name !== tab.space) moving.push(record);
  }
  return { byTarget, moving };
}

// Ожидаемая тема для каждого текущего пространства — чтобы измерять, совпадает ли
// назначение модели с ручной курацией пользователя (особенно на 5 «якорных» пространствах).
export const EXPECTED = {
  "dev tools": 1, servers: 1,
  "movies & series": 2, music: 2,
  gamedev: 3, games: 3, minecraft: 3,
  "math & science": 4, philosophy: 4,
  "novels & books": 5, "art refs": 5,
  clothes: 6, "дом": 6,
  HEALTH: 7, career: 7, finance: 7,
  hardware: 8,
};

function agreement(tabs, spaceOf) {
  let same = 0;
  let total = 0;
  const perSpace = new Map();
  for (const tab of tabs) {
    const expected = EXPECTED[tab.space];
    const got = spaceOf.get(tab.id);
    if (!expected || !got) continue;
    total++;
    const hit = got === expected;
    if (hit) same++;
    if (!perSpace.has(tab.space)) perSpace.set(tab.space, { hit: 0, total: 0 });
    const rec = perSpace.get(tab.space);
    rec.total++;
    if (hit) rec.hit++;
  }
  return { same, total, perSpace };
}

function report(plan, tabs) {
  const { byTarget, moving } = plan;
  const target = Math.round(tabs.length / SPACES.length);
  console.log(`вкладок: ${tabs.length} | целевых пространств: ${SPACES.length} | ровно было бы ~${target} на пространство`);
  console.log(`переносов: ${moving.length} (${((moving.length / tabs.length) * 100).toFixed(0)} %), не определено: ${tabs.filter((t) => !plan.spaceOf?.get(t.id)).length || 0}\n`);
  console.log(`${"пространство".padEnd(26)} ${"всего".padStart(6)} ${"остаётся".padStart(9)} ${"приезжает".padStart(9)}  откуда`);
  for (const { space, tabs: own } of byTarget.values()) {
    const incoming = own.filter((t) => t.space !== space.name);
    const sources = [...incoming.reduce((m, t) => m.set(t.space, (m.get(t.space) || 0) + 1), new Map())]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, n]) => `${name} ${n}`)
      .join(", ");
    console.log(
      `${space.name.padEnd(26)} ${String(own.length).padStart(6)} ${String(own.length - incoming.length).padStart(9)} ${String(incoming.length).padStart(9)}  ${sources}`
    );
  }
  console.log("\nчто уезжает из текущих пространств:");
  const out = new Map();
  for (const tab of moving) out.set(tab.space, (out.get(tab.space) || 0) + 1);
  for (const [name, n] of [...out.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${name}`);
  console.log("\nгруппы внутри целевых пространств:");
  for (const { space, tabs: own } of byTarget.values()) {
    const groups = [...own.reduce((m, t) => m.set(t.group, (m.get(t.group) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
    console.log(`  ${space.name}: ${groups.map(([name, n]) => `${name} ${n}`).join(", ")}`);
  }
  const agree = agreement(tabs, plan.spaceOf || new Map());
  if (agree.total) {
    console.log(`\nсовпадение с твоей текущей раскладкой: ${((agree.same / agree.total) * 100).toFixed(0)} % (${agree.same}/${agree.total})`);
    for (const [name, rec] of [...agree.perSpace.entries()].sort((a, b) => b[1].total - a[1].total)) {
      console.log(`  ${String(Math.round((rec.hit / rec.total) * 100)).padStart(3)} %  ${name} (${rec.total})`);
    }
  }
}

const { file, tabs } = await readTabs();
if (!tabs.length) throw new Error("вкладок не нашлось");
let selected = limit ? tabs.slice(0, limit) : tabs;
if (sample) {
  const stepSize = Math.max(1, Math.floor(selected.length / 40));
  selected = selected.filter((_, i) => i % stepSize === 0).slice(0, 40);
}
const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;
console.error(`файл: ${file}`);
console.error(`вкладок к разбору: ${selected.length}, модель: ${endpoint}`);
const examples = args.includes("--no-examples") ? new Map() : buildExamples(tabs);
const spaceOf = await assign(selected, endpoint, examples);
const labelOf = args.includes("--no-subtopics") ? new Map() : await subtopics(selected, spaceOf, endpoint);
const plan = buildPlan(selected, spaceOf, labelOf);
plan.spaceOf = spaceOf;

if (asJson) {
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    model: endpoint,
    sessionFile: file,
    spaces: SPACES,
    totalTabs: selected.length,
    moves: plan.moving.length,
    assignments: selected.map((t) => ({
      title: t.title,
      url: t.url,
      from: t.space,
      to: spaceOf.get(t.id) || 0,
      toName: SPACES.find((s) => s.id === (spaceOf.get(t.id) || 0))?.name || null,
      group: labelOf.get(t.id) || "прочее",
      pinned: t.pinned,
    })),
  }, null, 2));
} else {
  report(plan, selected);
}
