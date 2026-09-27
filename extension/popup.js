"use strict";
// popup.js — интерфейс. Вся арифметика в core.js, здесь только DOM и вызовы браузера.
// Работает и в Firefox (browser.*), и в Chromium (chrome.*) — второй нужен для проверки.

const api = typeof browser !== "undefined" ? browser : chrome;
const core = globalThis.ZenTabs;

const el = {
  status: document.getElementById("status"),
  meta: document.getElementById("meta"),
  byModel: document.getElementById("byModel"),
  byDomain: document.getElementById("byDomain"),
  apply: document.getElementById("apply"),
  clear: document.getElementById("clear"),
  plan: document.getElementById("plan"),
  groupList: document.getElementById("groupList"),
  leftovers: document.getElementById("leftovers"),
  leftoverList: document.getElementById("leftoverList"),
  duplicates: document.getElementById("duplicates"),
  dupeList: document.getElementById("dupeList"),
  dupeCount: document.getElementById("dupeCount"),
  closeDupes: document.getElementById("closeDupes"),
  skipPinned: document.getElementById("skipPinned"),
  modelsState: document.getElementById("modelsState"),
  modelsHint: document.getElementById("modelsHint"),
  modelsFull: document.getElementById("modelsFull"),
  modelsDecider: document.getElementById("modelsDecider"),
  modelsStop: document.getElementById("modelsStop"),
};

const CTL_URL = "http://127.0.0.1:8096";
const MODEL_LABELS = { fast: "воркер", think: "ризонер", decider: "решатель" };

const state = { tabs: [], plan: null, duplicates: [] };
const COLOR_HEX = {
  blue: "#4f7cff",
  purple: "#9a6bff",
  cyan: "#39c5d8",
  green: "#4fc47f",
  yellow: "#d8c34a",
  orange: "#e08b3c",
  red: "#e05555",
  pink: "#e26bb0",
};

function setStatus(text) {
  el.status.textContent = text;
}

function setBusy(busy) {
  for (const button of [el.byModel, el.byDomain, el.apply, el.clear]) button.disabled = busy;
}

function titleOf(id) {
  const tab = state.tabs.find((t) => t.id === id);
  return tab ? tab.title || tab.url : `вкладка ${id}`;
}

async function loadTabs() {
  const tabs = await api.tabs.query({ currentWindow: true });
  state.tabs = tabs
    .filter((tab) => !String(tab.url || "").startsWith(location.origin))
    .map((tab) => ({
      id: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      pinned: Boolean(tab.pinned),
      active: Boolean(tab.active),
    }));
  setStatus(`Открыто вкладок: ${state.tabs.length}.`);
  el.meta.textContent = api.tabs.group ? "" : "группы недоступны: только порядок";
  renderDuplicates(core.findDuplicates(state.tabs));
}

function renderDuplicates(duplicates) {
  state.duplicates = duplicates;
  el.duplicates.hidden = !duplicates.length;
  if (!duplicates.length) return;
  const surplus = duplicates.reduce((sum, group) => sum + group.tabs.length - 1, 0);
  el.dupeCount.textContent = `(${surplus})`;
  el.dupeList.replaceChildren(
    ...duplicates.map((group) => {
      const item = document.createElement("li");
      item.innerHTML = `<div class="group-name">${escapeHtml(core.hostOf(group.tabs[0].url))}</div>`;
      const lines = group.tabs.map((tab) => `${tab.active ? "★ " : ""}${tab.title || tab.url}`);
      item.insertAdjacentHTML("beforeend", `<div class="tab-titles">${escapeHtml(lines.join("\n"))}</div>`);
      return item;
    })
  );
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

/**
 * Пульт локальных моделей (:8096, служба zen-tabs-ctl). Единственное место, где
 * расширение не читает, а запускает: сам llama-server поднимает `lm` в
 * ~/Projects/localmix, пульт только нажимает кнопку и отдаёт состояние.
 */
async function ctl(path, options = {}) {
  const response = await fetch(CTL_URL + path, {
    ...options,
    headers: { "X-Zen-Tabs": "1", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

let modelsTimer = null;

function renderModels(status) {
  const names = Object.keys(status.models || {});
  const up = names.filter((name) => status.models[name]);
  const down = names.filter((name) => !status.models[name]);
  el.modelsState.textContent = !up.length
    ? "не подняты"
    : down.length
      ? `на GPU: ${up.map((name) => MODEL_LABELS[name] || name).join(", ")}`
      : "все три на GPU";

  const vram = status.vram?.usedMiB ? `${(status.vram.usedMiB / 1024).toFixed(1)} GB VRAM занято` : "";
  if (status.job) {
    el.modelsHint.textContent = `${status.job.what === "stop" ? "останавливаю" : "поднимаю"} (${status.job.seconds} с)…`;
  } else {
    el.modelsHint.textContent =
      [down.length ? `ждут запуска: ${down.map((name) => MODEL_LABELS[name] || name).join(", ")}` : "", vram]
        .filter(Boolean)
        .join(" · ");
  }

  const busy = Boolean(status.job);
  el.modelsFull.disabled = busy;
  el.modelsDecider.disabled = busy;
  el.modelsStop.disabled = busy || !up.length;
}

async function loadModels() {
  clearTimeout(modelsTimer);
  let status;
  try {
    status = await ctl("/status");
  } catch (error) {
    el.modelsState.textContent = "пульт не отвечает";
    el.modelsHint.textContent = `${error.message} · служба: systemctl --user status zen-tabs-ctl`;
    for (const button of [el.modelsFull, el.modelsDecider, el.modelsStop]) button.disabled = true;
    return;
  }
  renderModels(status);
  // Подъём трёх моделей — секунды; следим за ним из попапа, пока он открыт.
  if (status.job) modelsTimer = setTimeout(loadModels, 1500);
}

async function runCtl(action, body) {
  for (const button of [el.modelsFull, el.modelsDecider, el.modelsStop]) button.disabled = true;
  try {
    await ctl(action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  } catch (error) {
    el.modelsHint.textContent = `не вышло: ${error.message}`;
  }
  await loadModels();
}

el.modelsFull.addEventListener("click", () => runCtl("/start", { what: "full" }));
el.modelsDecider.addEventListener("click", () => runCtl("/start", { what: "decider" }));
el.modelsStop.addEventListener("click", () => runCtl("/stop"));

function renderPlan(plan) {
  state.plan = plan;
  el.plan.hidden = false;
  el.leftovers.hidden = !plan.leftovers.length;
  el.groupList.replaceChildren(
    ...plan.groups.map((group, index) => {
      const call = core.groupingCalls(plan.groups)[index];
      const item = document.createElement("li");
      const preview = group.tabIds.slice(0, 4).map(titleOf).join(" · ");
      const more = group.tabIds.length > 4 ? ` и ещё ${group.tabIds.length - 4}` : "";
      item.innerHTML =
        `<label><input type="checkbox" checked data-group="${index}" />` +
        `<span><span class="swatch" style="background:${COLOR_HEX[call.color]}"></span>` +
        `<span class="group-name">${escapeHtml(group.name)}</span> (${group.tabIds.length})` +
        `<div class="tab-titles">${escapeHtml(preview)}${escapeHtml(more)}</div></span></label>`;
      return item;
    })
  );
  el.leftoverList.replaceChildren(
    ...plan.leftovers.map((id) => {
      const item = document.createElement("li");
      item.textContent = titleOf(id);
      return item;
    })
  );
}

async function runModel() {
  setBusy(true);
  setStatus("Спрашиваю локальную модель…");
  try {
    const result = await core.plan(state.tabs, {
      endpoint: core.DEFAULT_ENDPOINT,
      onProgress: ({ chunk, chunks }) => setStatus(`Модель разбирает вкладки… ${chunk} из ${chunks}`),
    });
    if (!result.groups.length) {
      setStatus(result.errors[0] ? `Модель не помогла: ${result.errors[0]}` : "Модель не вернула групп.");
      if (result.errors[1]) el.meta.textContent = result.errors[1];
      return;
    }
    renderPlan(result);
    setStatus(`Модель разложила вкладки за ${(result.ms / 1000).toFixed(1)} с.`);
    el.meta.textContent = `${result.usage.prompt_tokens}+${result.usage.completion_tokens} токенов`;
    if (result.errors.length) el.meta.textContent += " · часть вкладок не разобрана";
  } catch (error) {
    setStatus(`Ошибка: ${error?.message || error}. Сервер на 127.0.0.1:8091 запущен?`);
  } finally {
    setBusy(false);
  }
}

function runDomains() {
  const pinned = el.skipPinned.checked ? state.tabs.filter((t) => !t.pinned) : state.tabs;
  const result = core.groupByDomain(pinned);
  if (!result.groups.length) {
    setStatus("Групп по доменам не набралось — везде разные сайты.");
    return;
  }
  renderPlan({ ...result, errors: [], usage: {}, ms: 0 });
  setStatus(`Сгруппировано по домену: ${result.groups.length} групп.`);
}

function selectedGroups() {
  const checks = [...el.groupList.querySelectorAll("input[data-group]")];
  return checks
    .filter((input) => input.checked)
    .map((input) => state.plan.groups[Number(input.dataset.group)]);
}

async function applyPlan() {
  const groups = selectedGroups();
  if (!groups.length) {
    setStatus("Ни одна группа не выбрана.");
    return;
  }
  setBusy(true);
  setStatus("Раскладываю…");
  try {
    const calls = core.groupingCalls(groups);
    let message;
    if (api.tabs.group) {
      for (const call of calls) {
        const groupId = await api.tabs.group({ tabIds: call.tabIds });
        if (api.tabGroups) await api.tabGroups.update(groupId, { title: call.name, color: call.color, collapsed: false });
      }
      message = `Собрано групп: ${calls.length}.`;
    } else {
      const order = core.adjacencyOrder(groups);
      let index = 0;
      for (const tabId of order) await api.tabs.move(tabId, { index: index++ });
      message = `Вкладки переставлены подряд: ${order.length} (группы этот браузер не умеет).`;
    }
    setBusy(false);
    await loadTabs();
    setStatus(message);
  } catch (error) {
    setStatus(`Не удалось применить: ${error?.message || error}`);
    setBusy(false);
  }
}

async function closeDuplicates() {
  const surplus = state.duplicates.flatMap((group) => group.tabs.filter((tab) => !tab.active && !tab.pinned).slice(1));
  if (!surplus.length) {
    setStatus("Лишних дубликатов нет (закреплённые и активные не трогаю).");
    return;
  }
  setBusy(true);
  const removed = surplus.map((tab) => tab.id);
  try {
    await api.tabs.remove(removed);
    setBusy(false);
    await loadTabs();
    setStatus(`Закрыто вкладок: ${removed.length}.`);
  } catch (error) {
    setStatus(`Не удалось закрыть: ${error?.message || error}`);
    setBusy(false);
  }
}

function clearPlan() {
  state.plan = null;
  el.plan.hidden = true;
  el.leftovers.hidden = true;
  setStatus("План сброшен.");
}

// --- пространства: применение плана (режим B: очередь переносов) --------------
// План считает CLI (lm plan) и раздаёт с 127.0.0.1:8093. Расширение по нему:
//   «открыть здесь»    — открывает в текущем (новом) пространстве те вкладки, которые
//                        должны в нём жить, и запоминает их как перенесённые;
//   «закрыть перенесённые» — в старом пространстве закрывает те, что уже открыты в новом.
// Порядок именно такой: сначала открыть в целевом, потом закрыть в исходном, иначе
// вкладки потеряются.

const PLAN_URL = "http://127.0.0.1:8093/plan.json";

const spaces = {
  section: document.getElementById("spaces"),
  status: document.getElementById("planStatus"),
  pick: document.getElementById("spacePick"),
  counts: document.getElementById("spaceCounts"),
  pullIn: document.getElementById("pullIn"),
  pushOut: document.getElementById("pushOut"),
};

async function loadPlan() {
  spaces.section.hidden = false;
  try {
    const stored = await api.storage.local.get(["migrated", "space"]);
    state.migrated = stored.migrated || {};
    state.space = stored.space || "";
    const plan = await fetchPlan();
    if (!plan) throw new Error("ни вложенного плана, ни сервера");
    state.plan = plan;
    state.planSource = state.planFromServer ? "с сервера" : "вложенный";
    spaces.status.textContent =
      `план от ${(state.plan.generatedAt || "").slice(0, 16).replace("T", " ")} (${state.planSource}): ` +
      `вкладок ${state.plan.totalTabs}, переносов ${state.plan.moves}`;
    const names = [...new Set([...state.plan.spaces.map((s) => s.name), ...state.plan.assignments.map((a) => a.from)])];
    spaces.pick.replaceChildren(...names.map((name) => new Option(name, name)));
    spaces.pick.value = state.space || guessSpace();
    renderSpaces();
  } catch (error) {
    spaces.status.textContent = `план не найден: ${error?.message || error}. Запусти раздачу: lm plan-serve`;
    spaces.pullIn.disabled = true;
    spaces.pushOut.disabled = true;
  }
}

/**
 * План берём из двух источников и выбираем свежайший: файл внутри расширения
 * (работает всегда, но стареет) и локальный сервер (свежий, но зависит от сети).
 */
async function fetchPlan() {
  let best = null;
  let fromServer = false;
  let serverError = null;
  try {
    const response = await fetch(api.runtime.getURL("plan.json"), { cache: "no-store" });
    if (response.ok) best = await response.json();
  } catch {
    /* вложенного плана может не быть — это нормально */
  }
  try {
    const response = await fetch(PLAN_URL, { cache: "no-store" });
    if (response.ok) {
      const fresh = await response.json();
      if (!best || new Date(fresh.generatedAt) > new Date(best.generatedAt)) {
        best = fresh;
        fromServer = true;
      }
    }
  } catch (error) {
    serverError = error;
  }
  state.planFromServer = fromServer;
  state.planServerError = serverError;
  return best;
}

function assignmentFor(url) {
  if (!state.plan) return null;
  const key = core.normalizeUrl(url);
  return state.plan.assignments.find((a) => core.normalizeUrl(a.url) === key) || null;
}

/** Угадать текущее пространство: в новом оно равно to у большинства вкладок, в старом — from. */
function guessSpace() {
  if (!state.plan) return "";
  const target = new Map();
  const source = new Map();
  for (const tab of state.tabs) {
    const hit = assignmentFor(tab.url);
    if (!hit) continue;
    if (hit.toName) target.set(hit.toName, (target.get(hit.toName) || 0) + 1);
    source.set(hit.from, (source.get(hit.from) || 0) + 1);
  }
  const best = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0] || ["", 0];
  const [targetName, targetVotes] = best(target);
  const [sourceName, sourceVotes] = best(source);
  // Сравниваем голоса, а не порог: в старом пространстве вкладок по плану больше,
  // потому что часть из них уже переехала и перестала быть видимой.
  if (targetVotes && targetVotes >= Math.max(3, sourceVotes)) return targetName;
  return sourceName;
}

/**
 * Вкладки текущего пространства, которые уже открыты в новом, — их и закрываем.
 * Опор две: openedIn из плана (посчитан по файлу сессии Zen) и отметки самого
 * расширения, проставленные при «Открыть здесь N». Одной памяти расширения мало:
 * её хранилище теряется, если расширение поставить заново.
 */
function closableTabs(name) {
  return state.tabs.filter((tab) => {
    if (tab.pinned) return false;
    const hit = assignmentFor(tab.url);
    if (!hit) return false;
    if (hit.toName === name) return false; // тут вкладка и должна жить
    if ((hit.openedIn || []).some((space) => space !== name)) return true;
    return Boolean(state.migrated[core.normalizeUrl(tab.url)]);
  });
}

function renderSpaces() {
  if (!state.plan) return;
  const name = spaces.pick.value;
  const isTarget = state.plan.spaces.some((s) => s.name === name);
  const incoming = state.plan.assignments.filter((a) => a.toName === name && a.from !== name);
  const pending = incoming.filter((a) => !state.migrated[core.normalizeUrl(a.url)]);
  const closable = closableTabs(name);

  if (isTarget) {
    spaces.counts.textContent = `сюда переезжает ${incoming.length}, из них ещё не открыто ${pending.length}`;
    spaces.pullIn.textContent = `Открыть здесь ${pending.length}`;
    spaces.pullIn.hidden = false;
    spaces.pushOut.hidden = true;
    spaces.pullIn.disabled = !pending.length;
  } else {
    // Считаем по факту, а не по записям плана: после удаления старых пространств Zen
    // сваливает их вкладки сюда, и «откуда» у них совсем другое.
    const rest = state.tabs.length - closable.length;
    spaces.counts.textContent = `вкладок ${state.tabs.length}: уже живут в новых пространствах ${closable.length}, останется ${rest}`;
    spaces.pushOut.textContent = `Закрыть перенесённые ${closable.length}`;
    spaces.pullIn.hidden = true;
    spaces.pushOut.hidden = false;
    spaces.pushOut.disabled = !closable.length;
  }
}

async function pullIn() {
  const name = spaces.pick.value;
  const pending = state.plan.assignments.filter(
    (a) => a.toName === name && a.from !== name && !state.migrated[core.normalizeUrl(a.url)]
  );
  if (!pending.length) return;
  setStatus(`Открываю ${pending.length} вкладок в «${name}»…`);
  const byGroup = new Map();
  for (const item of pending) {
    const tab = await api.tabs.create({ url: item.url, active: false });
    state.migrated[core.normalizeUrl(item.url)] = Date.now();
    const group = item.group || "прочее";
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(tab.id);
  }
  await api.storage.local.set({ migrated: state.migrated });

  // Группы внутри пространства — по подтемам из плана: пространство = тема, группы = подтемы.
  let madeGroups = 0;
  if (api.tabs.group) {
    const calls = core.groupingCalls(
      [...byGroup.entries()].filter(([, ids]) => ids.length >= 2).map(([groupName, tabIds]) => ({ name: groupName, tabIds }))
    );
    for (const call of calls) {
      try {
        const groupId = await api.tabs.group({ tabIds: call.tabIds });
        if (api.tabGroups) await api.tabGroups.update(groupId, { title: call.name, color: call.color, collapsed: false });
        madeGroups++;
      } catch {
        /* вкладки останутся без группы — не повод срывать перенос */
      }
    }
  }

  await loadTabs();
  renderSpaces();
  setStatus(
    `Открыто ${pending.length} вкладок в «${name}»${madeGroups ? `, собрано групп по подтемам: ${madeGroups}` : ""}. ` +
      "Теперь зайди в исходное пространство и закрой перенесённые."
  );
}

async function pushOut() {
  const name = spaces.pick.value;
  const targets = closableTabs(name);
  if (!targets.length) return;
  setStatus(`Закрываю ${targets.length} перенесённых вкладок…`);
  await api.tabs.remove(targets.map((tab) => tab.id));
  // Отметки не снимаем: они значат «эта ссылка уже открыта в новом пространстве»,
  // и по ним же считается, что ещё предстоит открыть. Снять — значит предложить
  // открыть её заново.
  await loadTabs();
  renderSpaces();
  const rest = state.tabs.length;
  setStatus(
    `Закрыто ${targets.length}. Эти вкладки живут в своих новых пространствах. ` +
      (rest ? `В этом пространстве осталось ${rest} вкладок.` : "Пространство пустое — можно удалять.")
  );
}

spaces.pick.addEventListener("change", () => {
  state.space = spaces.pick.value;
  api.storage.local.set({ space: state.space });
  renderSpaces();
});
spaces.pullIn.addEventListener("click", pullIn);
spaces.pushOut.addEventListener("click", pushOut);

el.byModel.addEventListener("click", runModel);
el.byDomain.addEventListener("click", runDomains);
el.apply.addEventListener("click", applyPlan);
el.clear.addEventListener("click", clearPlan);
el.closeDupes.addEventListener("click", closeDuplicates);

loadTabs().then(loadPlan);
loadModels();
