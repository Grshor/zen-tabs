#!/bin/sh
# make-xpi.sh — собрать расширение в .xpi для постоянной установки в Zen.
#
#   ./bin/make-xpi.sh                 → zen-tabs@local.xpi в корне проекта
#   ./bin/make-xpi.sh /куда/положить
#
# Почему это работает в Zen: в его сборке MOZ_REQUIRE_SIGNING = false, а
# xpinstall.signatures.required по умолчанию false — то есть подпись не проверяется.
# Установка: about:addons → шестерёнка → «Install Add-on From File…» → этот файл
# (или просто перетащить .xpi в окно браузера).
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$DIR/zen-tabs@local.xpi}"

command -v zip >/dev/null 2>&1 || { echo "нужен пакет zip" >&2; exit 1; }
[ -f "$DIR/extension/manifest.json" ] || { echo "нет $DIR/extension/manifest.json" >&2; exit 1; }

rm -f "$OUT"
(cd "$DIR/extension" && zip -q -r "$OUT" . -x "manifest.chrome.json" -x "*.swp" -x "*~")

echo "собран: $OUT"
unzip -l "$OUT" | tail -3
