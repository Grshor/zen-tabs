#!/usr/bin/env bun
// plan-fresh.mjs — вписать в план факт: «эта вкладка уже открыта в новом пространстве».
//
//   bun bin/plan-fresh.mjs            # показать, что изменится (ничего не пишет)
//   bun bin/plan-fresh.mjs --write    # записать plan.json
//
// План — снимок на момент расчёта, а перенос идёт после него: пока пользователь
// раскладывает вкладки, копии уже живут в новых пространствах. Поле openedIn
// говорит попапу, какие вкладки старого пространства можно закрывать. Считаем по
// файлу сессии Zen, а не по памяти расширения: её хранилище живёт отдельно и
// теряется, если расширение поставить заново.

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

import { findZenSessions, mozLz4Decode } from "./session.mjs";

const require = createRequire(import.meta.url);
const core = require("../extension/core.js");

const PLAN = process.env.PLAN_FILE || join(homedir(), ".cache/zen-tabs/plan.json");
const shouldWrite = process.argv.includes("--write");

const sessions = await findZenSessions();
if (!sessions) throw new Error("не нашёл zen-sessions.jsonlz4 в ~/.zen");
const plan = JSON.parse(await readFile(PLAN, "utf8"));
const zen = JSON.parse(Buffer.from(mozLz4Decode(await readFile(sessions.path))).toString("utf8"));

const spaceName = new Map((zen.spaces || []).map((space) => [space.uuid, space.name]));
const targets = new Set(plan.spaces.map((space) => space.name));
const key = (url) => core.normalizeUrl(url);

/** Открытые вкладки: где лежит и по какой ссылке. */
const live = [];
for (const tab of zen.tabs || []) {
  const entry = tab.entries?.[Math.max(0, (tab.index || 1) - 1)] || tab.entries?.[tab.entries.length - 1] || {};
  const url = entry.url || "";
  if (!url || /^about:/.test(url)) continue;
  live.push({ url, space: spaceName.get(tab.zenWorkspace) || "(без пространства)" });
}

/** В каких пространствах открыта ссылка: url → набор имён. */
const openIn = new Map();
for (const tab of live) {
  const k = key(tab.url);
  if (!openIn.has(k)) openIn.set(k, new Set());
  openIn.get(k).add(tab.space);
}

let touched = 0;
for (const item of plan.assignments) {
  // Копия считается копией только в новом пространстве и не в том, откуда вкладка родом.
  const places = [...(openIn.get(key(item.url)) || [])].filter((name) => targets.has(name) && name !== item.from).sort();
  if (places.length) {
    if (JSON.stringify(item.openedIn || []) !== JSON.stringify(places)) touched++;
    item.openedIn = places;
  } else {
    if (item.openedIn) touched++;
    delete item.openedIn;
  }
}

const assignmentFor = new Map(plan.assignments.map((item) => [key(item.url), item]));

console.log(`сессия: ${sessions.path}`);
console.log(`план:  ${PLAN}`);
console.log(`вкладок в плане с открытой копией: ${plan.assignments.filter((item) => item.openedIn).length}\n`);

// Главный вопрос: сколько вкладок каждого пространства уже можно закрывать.
const bySpace = new Map();
for (const tab of live) {
  const row = bySpace.get(tab.space) || { total: 0, ready: 0, nowhere: 0 };
  row.total++;
  const item = assignmentFor.get(key(tab.url));
  const copies = (item?.openedIn || []).filter((name) => name !== tab.space);
  if (copies.length) row.ready++;
  else if (!item) row.nowhere++;
  bySpace.set(tab.space, row);
}
for (const [name, row] of [...bySpace].sort((a, b) => b[1].total - a[1].total)) {
  const rest = row.total - row.ready;
  const note = row.ready ? `можно закрыть ${row.ready}, останется ${rest}` : `закрывать нечего — копий нет`;
  console.log(`  ${String(row.total).padStart(4)} вкладок  ${name}: ${note}${row.nowhere ? ` (вне плана: ${row.nowhere})` : ""}`);
}

if (shouldWrite) {
  await writeFile(PLAN, JSON.stringify(plan, null, 2) + "\n");
  console.log(`\nзаписано, изменено записей: ${touched}. Не забудь пересобрать .xpi: bun bin/make-xpi.sh`);
} else {
  console.log(`\nсухой прогон: изменилось бы записей ${touched} (с --write запишется)`);
}
