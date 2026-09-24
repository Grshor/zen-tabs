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

# План кладём внутрь расширения: попап тогда показывает его даже без локального
# сервера (сеть до 127.0.0.1 — единственное место, где он мог отвалиться).
PLAN="${PLAN_FILE:-$HOME/.cache/zen-tabs/plan.json}"
if [ -f "$PLAN" ]; then
    cp "$PLAN" "$DIR/extension/plan.json"
    echo "план вложен: $(stat -c%s "$PLAN") байт"
else
    echo "внимание: $PLAN не найден — в .xpi попадёт старый вложенный план или ничего" >&2
fi

rm -f "$OUT"
(cd "$DIR/extension" && zip -q -r "$OUT" . -x "manifest.chrome.json" -x "*.swp" -x "*~")

echo "собран: $OUT"
unzip -l "$OUT" | tail -3
