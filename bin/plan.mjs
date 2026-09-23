#!/usr/bin/env bun
// plan.mjs — разбор вкладок из командной строки (для OMP и для проверки без браузера).
//
//   bun bin/plan.mjs                 # вкладки из живого профиля Zen, через локальную модель
//   bun bin/plan.mjs --domain        # группировка по домену, без модели и мгновенно
//   bun bin/plan.mjs --json          # машинно-читаемый план
//   bun bin/plan.mjs --tabs tabs.json --limit 40
//
// Ожидается, что локальная модель поднята на 127.0.0.1:8091 (проект localmix).

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

import { readZenTabs } from "./session.mjs";

const require = createRequire(import.meta.url);
const core = require("../extension/core.js");

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const asJson = process.argv.includes("--json");
const byDomain = process.argv.includes("--domain");
const limit = Number(argValue("--limit", "0")) || 0;
const endpoint = argValue("--endpoint", core.DEFAULT_ENDPOINT);
const tabsFile = argValue("--tabs");

const { tabs, file } = tabsFile
  ? { tabs: JSON.parse(await readFile(tabsFile, "utf8")), file: tabsFile }
  : await readZenTabs();

const selected = limit ? tabs.slice(0, limit) : tabs;
const byId = new Map(selected.map((tab, index) => [index + 1, { ...tab, id: index + 1 }]));

const result = byDomain
  ? { ...core.groupByDomain([...byId.values()]), errors: [], usage: {}, ms: 0 }
  : await core.plan([...byId.values()], { endpoint });

if (asJson) {
  console.log(JSON.stringify({ file, totalTabs: selected.length, ...result }, null, 2));
} else {
  console.log(`сессия: ${file}`);
  console.log(`вкладок: ${selected.length}, режим: ${byDomain ? "по доменам" : "по смыслу (локальная модель)"}`);
  if (result.usage?.prompt_tokens) console.log(`токенов: ${result.usage.prompt_tokens} на вход, ${result.usage.completion_tokens} на выход`);
  console.log(`время: ${(result.ms / 1000).toFixed(1)} с\n`);
  for (const group of result.groups) {
    console.log(`■ ${group.name} (${group.tabIds.length})`);
    for (const id of group.tabIds) console.log(`   ${id}. ${byId.get(id)?.title || byId.get(id)?.url || "?"}`);
  }
  if (result.leftovers?.length) {
    console.log(`\n□ вне групп (${result.leftovers.length}): ${result.leftovers.join(", ")}`);
  }
  for (const error of result.errors || []) console.log(`! ${error}`);
}
