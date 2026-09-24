#!/usr/bin/env bun
// spaces.mjs — инвентарь пространств Zen: сколько их, что в них, что устарело.
//
//   bun bin/spaces.mjs                 # таблица по пространствам
//   bun bin/spaces.mjs --classify      # + категории вкладок локальной моделью
//   bun bin/spaces.mjs --json          # машинно-читаемо
//
// Даёт то, чего расширение не видит: имена и иконки пространств (zen-sessions.jsonlz4),
// время последней активности вкладки (lastAccessed) и состав по категориям.

import { createRequire } from "node:module";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { mozLz4Decode } from "./session.mjs";

const require = createRequire(import.meta.url);
const core = require("../extension/core.js");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const classify = args.includes("--classify");
const topN = Number(args[args.indexOf("--top") + 1]) || 3;

/** Самый свежий файл zen-sessions.jsonlz4 среди профилей. */
async function findSessions(profilesRoot = join(homedir(), ".zen")) {
  const candidates = [];
  for (const entry of await readdir(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(profilesRoot, entry.name, "zen-sessions.jsonlz4");
    try {
      candidates.push({ path, mtime: (await stat(path)).mtimeMs });
    } catch {
      /* нет файла — не кандидат */
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) throw new Error("не нашёл zen-sessions.jsonlz4 в ~/.zen");
  return candidates[0];
}

const currentUrl = (tab) => {
  const entries = tab.entries || [];
  const entry = entries[Math.max(0, (tab.index || 1) - 1)] || entries[entries.length - 1] || {};
  return { url: entry.url || "", title: (entry.title || "").trim() };
};

const DAY = 86400_000;

async function main() {
  const file = await findSessions();
  const zen = JSON.parse(Buffer.from(mozLz4Decode(await readFile(file.path))).toString("utf8"));
  const spaces = new Map((zen.spaces || []).map((space) => [space.uuid, space]));
  const groups = new Map((zen.groups || []).map((group) => [group.id, group]));

  const tabs = [];
  for (const tab of zen.tabs || []) {
    const { url, title } = currentUrl(tab);
    if (!url || /^about:(blank|newtab|home)$/.test(url)) continue;
    tabs.push({
      id: tabs.length + 1,
      title,
      url,
      space: tab.zenWorkspace || "(без пространства)",
      group: tab.groupId,
      pinned: Boolean(tab.pinned),
      lastAccessed: tab.lastAccessed || 0,
    });
  }

  // Категории: одна разметка на все вкладки, дальше — разного рода сводки.
  let categoryOf = new Map();
  if (classify) {
    const plan = await core.plan(tabs.map(({ id, title, url }) => ({ id, title, url })));
    for (const group of plan.groups) for (const id of group.tabIds) categoryOf.set(id, group.name);
    if (plan.errors.length) console.error(`! ${plan.errors.length} ошибок разбора`);
  }

  const rows = [];
  for (const [uuid, space] of spaces) {
    const own = tabs.filter((tab) => tab.space === uuid);
    if (!own.length) {
      rows.push({ uuid, name: space.name, icon: space.icon, tabs: 0, pinned: 0, idleDays: null, domains: [], categories: {}, groups: [] });
      continue;
    }
    const domains = [...own.reduce((map, tab) => map.set(core.hostOf(tab.url), (map.get(core.hostOf(tab.url)) || 0) + 1), new Map())]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([host, count]) => `${host} (${count})`);
    const categories = {};
    if (classify) {
      for (const tab of own) {
        const name = categoryOf.get(tab.id) || "без категории";
        categories[name] = (categories[name] || 0) + 1;
      }
    }
    const groupNames = [...new Set(own.map((tab) => groups.get(tab.group)?.name).filter(Boolean))];
    const newest = Math.max(...own.map((tab) => tab.lastAccessed));
    rows.push({
      uuid,
      name: space.name,
      icon: space.icon,
      tabs: own.length,
      pinned: own.filter((tab) => tab.pinned).length,
      idleDays: newest ? Math.round((Date.now() - newest) / DAY) : null,
      domains,
      categories: Object.fromEntries(Object.entries(categories).sort((a, b) => b[1] - a[1])),
      groups: groupNames,
    });
  }
  rows.sort((a, b) => b.tabs - a.tabs);

  // Вкладки, открытые сразу в нескольких пространствах.
  const duplicates = core.findDuplicates(tabs).map((dup) => ({
    url: dup.key,
    spaces: [...new Set(dup.tabs.map((tab) => spaces.get(tab.space)?.name || tab.space))],
  })).filter((dup) => dup.spaces.length > 1);

  // Похожесть пространств по составу категорий — материал для слияния.
  const similar = [];
  if (classify) {
    const vector = (row) => {
      const total = Object.values(row.categories).reduce((sum, n) => sum + n, 0) || 1;
      return new Map(Object.entries(row.categories).map(([k, n]) => [k, n / total]));
    };
    const cosine = (a, b) => {
      let dot = 0, na = 0, nb = 0;
      for (const [k, v] of a) { na += v * v; dot += v * (b.get(k) || 0); }
      for (const v of b.values()) nb += v * v;
      return na && nb ? dot / Math.sqrt(na * nb) : 0;
    };
    const vectors = rows.filter((row) => row.tabs >= 3).map((row) => ({ row, vec: vector(row) }));
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        similar.push({ a: vectors[i].row, b: vectors[j].row, score: cosine(vectors[i].vec, vectors[j].vec) });
      }
    }
    similar.sort((x, y) => y.score - x.score);
  }

  if (asJson) {
    console.log(JSON.stringify({ file: file.path, spaces: rows, duplicates, similar: similar.slice(0, 12).map(({ a, b, score }) => ({ a: a.name, b: b.name, score: Number(score.toFixed(3)) })) }, null, 2));
    return;
  }

  const total = tabs.length;
  const active = rows.filter((row) => row.tabs).length;
  console.log(`файл: ${file.path}`);
  console.log(`вкладок: ${total}, пространств: ${rows.length} (непустых ${active})\n`);
  console.log(`${"пространство".padEnd(22)} ${"вкладок".padStart(7)} ${"закреп".padStart(6)} ${"простой".padStart(8)}  состав`);
  for (const row of rows) {
    const idle = row.idleDays === null ? "—" : row.idleDays === 0 ? "сегодня" : `${row.idleDays} дн`;
    const detail = classify
      ? Object.entries(row.categories).slice(0, 4).map(([name, n]) => `${name} ${n}`).join(", ")
      : row.domains.slice(0, 2).join(", ");
    const label = (row.icon ? row.icon + " " : "") + row.name;
    console.log(`${(label.length > 22 ? label.slice(0, 21) + "…" : label).padEnd(22)} ${String(row.tabs).padStart(7)} ${String(row.pinned).padStart(6)} ${idle.padStart(8)}  ${detail}`);
  }
  if (duplicates.length) {
    console.log(`\nвкладок, открытых в нескольких пространствах: ${duplicates.length}`);
    for (const dup of duplicates.slice(0, 8)) console.log(`  ${core.hostOf(dup.url)} — ${dup.spaces.join(" + ")}`);
  }
  if (classify) {
    console.log("\nсамые похожие пары пространств (по составу категорий):");
    for (const { a, b, score } of similar.slice(0, 8)) console.log(`  ${score.toFixed(2)}  ${a.name} (${a.tabs}) ↔ ${b.name} (${b.tabs})`);
  }
}

await main();
