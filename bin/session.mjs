// session.mjs — читает открытые вкладки прямо из хранилища сессий Zen, без браузера.
// Формат Firefox: mozlz4 = 8 байт магии + uint32 размера + LZ4-блок. Зависимостей нет.
//
//   bun bin/session.mjs            # список вкладок
//   bun bin/session.mjs --json     # то же машинно-читаемо

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAGIC = "mozLz40";

function lz4BlockDecode(input, outSize) {
  const out = new Uint8Array(outSize);
  let i = 0;
  let o = 0;
  while (i < input.length) {
    const token = input[i++];
    let literalLength = token >> 4;
    if (literalLength === 15) {
      let byte;
      do {
        byte = input[i++];
        literalLength += byte;
      } while (byte === 255);
    }
    out.set(input.subarray(i, i + literalLength), o);
    i += literalLength;
    o += literalLength;
    if (i >= input.length) break;

    const offset = input[i] | (input[i + 1] << 8);
    i += 2;
    if (offset === 0 || offset > o) throw new Error("lz4: битое смещение");
    let matchLength = token & 0x0f;
    if (matchLength === 15) {
      let byte;
      do {
        byte = input[i++];
        matchLength += byte;
      } while (byte === 255);
    }
    matchLength += 4;
    let source = o - offset;
    for (let k = 0; k < matchLength; k++) out[o++] = out[source++];
  }
  return out.subarray(0, o);
}

/** Распаковать mozlz4 (sessionstore Firefox/Zen). */
export function mozLz4Decode(buffer) {
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(...bytes.subarray(0, MAGIC.length));
  if (magic !== MAGIC) throw new Error(`не mozlz4: ${JSON.stringify(magic)}`);
  const size = new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32(0, true);
  return lz4BlockDecode(bytes.subarray(12), size);
}

/** Самый свежий файл сессии среди профилей Zen. */
export async function findSessionFile(profilesRoot = join(homedir(), ".zen")) {
  const candidates = [];
  let entries = [];
  try {
    entries = await readdir(profilesRoot, { withFileTypes: true });
  } catch {
    throw new Error(`нет каталога профилей: ${profilesRoot}`);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const rel of ["sessionstore-backups/recovery.jsonlz4", "sessionstore-backups/previous.jsonlz4", "sessionstore.jsonlz4"]) {
      const path = join(profilesRoot, entry.name, rel);
      try {
        const info = await stat(path);
        candidates.push({ path, mtime: info.mtimeMs });
      } catch {
        /* нет файла — не кандидат */
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ?? null;
}

/** Открытые вкладки: id — порядковый номер, как их видит группировка. */
export async function readZenTabs({ file, includeAbout = false } = {}) {
  const found = file ? { path: file } : await findSessionFile();
  if (!found) throw new Error("не нашёл sessionstore в ~/.zen");
  const raw = JSON.parse(Buffer.from(mozLz4Decode(await readFile(found.path))).toString("utf8"));
  const tabs = [];
  (raw.windows || []).forEach((window, windowIndex) => {
    for (const tab of window.tabs || []) {
      if (tab.hidden) continue;
      const entries = tab.entries || [];
      const entry = entries[Math.max(0, (tab.index || 1) - 1)] || entries[entries.length - 1] || {};
      const url = entry.url || "";
      if (!includeAbout && /^(about:|chrome:|resource:|moz-extension:)/.test(url)) continue;
      tabs.push({
        id: tabs.length + 1,
        title: (entry.title || "").trim(),
        url,
        pinned: Boolean(tab.pinned),
        window: windowIndex + 1,
      });
    }
  });
  return { tabs, file: found.path };
}

if (import.meta.main) {
  const asJson = process.argv.includes("--json");
  const includeAbout = process.argv.includes("--all");
  try {
    const { tabs, file } = await readZenTabs({ includeAbout });
    if (asJson) {
      console.log(JSON.stringify({ file, count: tabs.length, tabs }, null, 2));
    } else {
      console.log(`${file}\nвкладок: ${tabs.length}\n`);
      for (const tab of tabs) {
        console.log(`${String(tab.id).padStart(3)}${tab.pinned ? " ★" : "  "} ${tab.title || "(без заголовка)".padEnd(30)} — ${tab.url}`);
      }
    }
  } catch (error) {
    console.error(`ошибка: ${error?.message || error}`);
    process.exit(1);
  }
}
