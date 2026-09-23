// make-chrome.mjs — собрать копию расширения для Chromium (нужна для живой проверки в браузере;
// для Zen используется extension/manifest.json как есть).
//
//   bun bin/make-chrome.mjs        # → .build/chrome/ + печатает ID расширения
//
// Ключ фиксирован, поэтому ID расширения постоянный — по нему открывается chrome-extension://<id>/popup.html.

import { generateKeyPairSync, createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "extension");
const target = join(root, ".build/chrome");
const keyPath = join(root, ".build/chrome-key.der");

async function publicKeyDer() {
  try {
    return await readFile(keyPath);
  } catch {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const der = publicKey.export({ type: "spki", format: "der" });
    await mkdir(dirname(keyPath), { recursive: true });
    await writeFile(keyPath, der);
    return der;
  }
}

function extensionId(der) {
  const digest = createHash("sha256").update(der).digest().subarray(0, 16);
  return [...digest].map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))).join("");
}

const der = await publicKeyDer();
const id = extensionId(der);

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
await rm(join(target, "manifest.chrome.json"), { force: true });

const chromeManifest = JSON.parse(await readFile(join(source, "manifest.chrome.json"), "utf8"));
chromeManifest.key = der.toString("base64");
await writeFile(join(target, "manifest.json"), JSON.stringify(chromeManifest, null, 2));

console.log(target);
console.log(`https:// — ID: ${id}`);
console.log(`chrome-extension://${id}/popup.html`);
