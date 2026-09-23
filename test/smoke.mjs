#!/usr/bin/env bun
// smoke.mjs — проверка ядра на настоящих вкладках: инварианты раскладки, дубликаты, живой вызов модели.
// Запуск: bun test/smoke.mjs [--no-model]

import { createRequire } from "node:module";

import { readZenTabs } from "../bin/session.mjs";

const require = createRequire(import.meta.url);
const core = require("../extension/core.js");

let failed = 0;
function check(name, condition, detail = "") {
  const mark = condition ? "ok  " : "ФЕЙЛ";
  if (!condition) failed++;
  console.log(`${mark} ${name}${detail ? `: ${detail}` : ""}`);
}

// 1. Разбор ответа модели: мусор вокруг JSON, выдуманные номера, повторные номера.
const parsed = core.parsePlan(
  core.extractJson('Вот ответ:\n```json\n{"groups":[{"name":"код","tabs":[1,2,99]},{"name":"код","tabs":[2]},{"name":"почта","tabs":[3]}]}\n```'),
  new Set([1, 2, 3])
);
check(
  "парсер отбрасывает выдуманные номера и повторы",
  parsed.groups.length === 2 && parsed.groups[0].tabIds.join() === "1,2" && parsed.groups[1].tabIds.join() === "3",
  JSON.stringify(parsed.groups)
);
check("парсер переживает текст без JSON", core.extractJson("извините, не могу") === null);

// 1b. Категории: строки «номер: категория» в разном оформлении + сведение синонимов.
const labels = core.parseTaxonomy(
  "1: видео\n2) Код\n3. покупки, разное\n4 - учёба\nномер: 5: github\n6: games\n7: что-то неведомое",
  new Set([1, 2, 3, 4, 5, 6, 7, 8])
);
check(
  "категории разбираются, синонимы сводятся к списку",
  labels.get(1) === "видео" &&
    labels.get(2) === "код" &&
    labels.get(3) === "покупки" &&
    labels.get(4) === "учёба" &&
    labels.get(5) === "код" &&
    labels.get(6) === "игры" &&
    labels.get(7) === "разное",
  JSON.stringify([...labels])
);
check("ответ без строк с номерами не даёт категорий", core.parseTaxonomy("не могу помочь", new Set([1])).size === 0);

// 1c. Усечённый ответ модели всё равно разбирается.
const salvaged = core.salvageGroups('{"groups":[{"name":"код","tabs":[1,2,3]},{"name":"видео","tabs":[4,5');
check("усечённый JSON спасается частично", salvaged.length >= 1 && salvaged[0].tabIds.join() === "1,2,3", JSON.stringify(salvaged));

// 2. Дубликаты: utm-хвосты и якоря не должны считаться разными страницами.
const dupeInput = [
  { id: 1, title: "Статья", url: "https://example.com/post?utm_source=x#part2" },
  { id: 2, title: "Статья (ещё раз)", url: "https://example.com/post" },
  { id: 3, title: "Другая", url: "https://example.com/other" },
];
const dupes = core.findDuplicates(dupeInput);
check("дубликаты находятся с учётом utm и якоря", dupes.length === 1 && dupes[0].tabs.length === 2, JSON.stringify(dupes.map((d) => d.key)));

// 3. Группировка по домену покрывает каждую вкладку ровно один раз.
const { tabs } = await readZenTabs();
const domain = core.groupByDomain(tabs);
const covered = [...domain.groups.flatMap((g) => g.tabIds), ...domain.leftovers].sort((a, b) => a - b);
check(
  "группировка по домену покрывает все вкладки ровно раз",
  covered.length === tabs.length && covered.every((id, index) => id === index + 1),
  `вкладок ${tabs.length}, покрыто ${covered.length}`
);

// 4. Живой прогон модели на реальных вкладках.
if (!process.argv.includes("--no-model")) {
  console.log(`\n— модель на ${tabs.length} настоящих вкладках —`);
  const plan = await core.plan(tabs);
  const ids = plan.groups.flatMap((g) => g.tabIds);
  check("модель вернула хотя бы одну группу", plan.groups.length > 0, `${plan.groups.length} групп за ${(plan.ms / 1000).toFixed(1)} с`);
  check("ни одна вкладка не попала в две группы", new Set(ids).size === ids.length);
  check("все номера внутри диапазона вкладок", ids.every((id) => id >= 1 && id <= tabs.length));
  say(plan, tabs);
  for (const error of plan.errors) console.log(`! ${error}`);
}

// 5. План должен возвращать исходные id вкладок, а не порядковые номера: иначе браузер
//    не найдёт вкладку при применении (этот баг ловился живьём в расширении).
if (!process.argv.includes("--no-model")) {
  const fakeTabs = [
    { id: 9001, title: "Pull request #128", url: "http://x/pr" },
    { id: 9002, title: "Купить кофемолку — Ozon", url: "http://x/shop" },
  ];
  const plan = await core.plan(fakeTabs);
  const ids = [...plan.groups.flatMap((g) => g.tabIds), ...plan.leftovers];
  check("план возвращает исходные id вкладок", ids.every((id) => id === 9001 || id === 9002), JSON.stringify(ids));
}

function say(plan, tabs) {
  for (const group of plan.groups) {
    const names = group.tabIds.slice(0, 3).map((id) => tabs[id - 1]?.title || tabs[id - 1]?.url);
    console.log(`  ■ ${group.name} (${group.tabIds.length}): ${names.join(" · ")}`);
  }
  if (plan.leftovers.length) console.log(`  □ вне групп: ${plan.leftovers.length}`);
}

console.log(failed ? `\nпровалено проверок: ${failed}` : "\nвсе проверки прошли");
process.exit(failed ? 1 : 0);
