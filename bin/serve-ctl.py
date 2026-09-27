#!/usr/bin/env python3
"""serve-ctl.py — пульт расширения «Разбор вкладок»: поднять/погасить локальные модели.

Раздатчик плана (:8093) отдаёт данные и открыт всем. Этот пульт запускает и
останавливает процессы, поэтому закрыт жёстче:

  • только 127.0.0.1 и только POST для действий;
  • обязательный заголовок X-Zen-Tabs — он заставляет браузер сделать preflight,
    а preflight мы разрешаем лишь страницам расширений (Origin moz-extension:// или
    chrome-extension://). Обычная веб-страница такой запрос отправить не сможет;
  • список действий фиксирован: all|full|fast|think|decider|stop. Аргументов от
    клиента нет вообще — только выбор из списка, никакой склейки команд.

    serve-ctl.py [порт]        # по умолчанию 8096

Модели те же, что в ~/Projects/localmix: их поднимает `lm`, пульт лишь нажимает
кнопку за пользователя и показывает состояние.
"""

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8096
LM = os.environ.get("LM_BIN", str(Path.home() / "Projects/localmix/lm"))
LOG = Path.home() / ".cache/zen-tabs/ctl.log"
JOB_TIMEOUT = 300  # секунд: дольше подъём трёх моделей не идёт даже на холодную
WAIT_FOR_STOP = 25  # сколько ждать доигрывающую остановку перед подъёмом

MODELS = {  # роль → порт llama-server
    "fast": 8091,
    "think": 8092,
    "decider": 8095,
}
STARTS = {"all", "full", "fast", "think", "decider"}

_lock = threading.Lock()
_job = {"what": None, "kind": None, "started": 0.0, "pid": None}


def alive(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/models", timeout=1.5):
            return True
    except (urllib.error.URLError, OSError):
        return False


def job_state() -> dict | None:
    """Что сейчас делается; заодно снимает залипший флаг."""
    with _lock:
        if not _job["what"]:
            return None
        if _job["pid"] is None or time.time() - _job["started"] > JOB_TIMEOUT:
            _job.update(what=None, kind=None, started=0.0, pid=None)
            return None
        return {"what": _job["what"], "kind": _job["kind"], "seconds": round(time.time() - _job["started"], 1)}


def wait_for(kind: str, limit: float) -> dict | None:
    """Дождаться конца операции противоположного типа.

    Нажатие «остановить», а сразу за ним «поднять» — обычный жест. Отказывать в нём
    из-за того, что остановка ещё доигрывает, значит показывать ошибку там, где всё
    в порядке. Ждём только остановку: она короткая; идущий подъём честно отбиваем.
    """
    deadline = time.time() + limit
    while True:
        busy = job_state()
        if not busy or busy["kind"] == kind or time.time() >= deadline:
            return busy
        time.sleep(0.3)


def spawn(args: list[str], kind: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as log:
        log.write(f"\n=== {time.strftime('%F %T')} {' '.join(args)}\n")
        log.flush()
        process = subprocess.Popen(args, stdout=log, stderr=log, start_new_session=True)
    with _lock:
        _job.update(what=args[-1], kind=kind, started=time.time(), pid=process.pid)

    def reap() -> None:
        process.wait()
        with _lock:
            if _job["pid"] == process.pid:
                _job.update(what=None, kind=None, started=0.0, pid=None)

    threading.Thread(target=reap, daemon=True).start()


def vram() -> dict:
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        used, total = (int(value) for value in out.split(", "))
        return {"usedMiB": used, "totalMiB": total}
    except Exception:  # nvidia-smi может отсутствовать — состояние моделей важнее
        return {}


def status() -> dict:
    servers = {name: alive(port) for name, port in MODELS.items()}
    return {
        "models": servers,
        "all": all(servers.values()),
        "any": any(servers.values()),
        "job": job_state(),
        "vram": vram(),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "zen-tabs-ctl"

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        return origin is None or origin.startswith(("moz-extension://", "chrome-extension://"))

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin")
        if origin and self._origin_ok():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # preflight: разрешаем только страницам расширений
        if not self._origin_ok():
            self._send(403, {"error": "origin не разрешён"})
            return
        self.send_response(204)
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "X-Zen-Tabs, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] != "/status":
            self._send(404, {"error": "только /status"})
            return
        if not self._origin_ok():
            self._send(403, {"error": "origin не разрешён"})
            return
        self._send(200, status())

    def do_POST(self):
        if not self._origin_ok():
            self._send(403, {"error": "origin не разрешён"})
            return
        if self.headers.get("X-Zen-Tabs") != "1":
            self._send(403, {"error": "нет заголовка X-Zen-Tabs"})
            return
        route = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "тело не JSON"})
            return

        if route == "/stop":
            busy = job_state()
            if busy:
                self._send(409, {"error": "уже выполняется", "job": busy})
                return
            spawn([LM, "stop"], "stop")
            self._send(200, {"started": "stop"})
            return

        if route == "/start":
            what = str(body.get("what") or "full")
            if what not in STARTS:
                self._send(400, {"error": f"what ∈ {sorted(STARTS)}", "got": what})
                return
            # Если доигрывает остановка — ждём её и всё равно поднимаем.
            busy = wait_for("start", WAIT_FOR_STOP)
            if busy:
                self._send(409, {"error": "уже поднимается", "job": busy})
                return
            if not Path(LM).exists():
                self._send(500, {"error": f"нет {LM}"})
                return
            spawn([LM, "start", what], "start")
            self._send(200, {"started": what})
            return

        self._send(404, {"error": "только /start и /stop"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    servers = {name: port for name, port in MODELS.items()}
    print(f"пульт локальных моделей: http://127.0.0.1:{PORT} (модели {servers}, lm={LM})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
