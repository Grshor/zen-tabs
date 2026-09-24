#!/usr/bin/env python3
"""serve-plan.py — раздача плана пространств Zen расширению.

Отличие от `python3 -m http.server` ровно одно, но решающее: этот сервер отдаёт
CORS-заголовки. Без них запрос из расширения к 127.0.0.1:8093 падает с
«Network error when attempting to fetch resource», хотя curl с той же машины
спокойно получает 200 — именно на это мы и наткнулись.

    serve-plan.py [порт] [каталог]
"""
import functools
import http.server
import socketserver
import sys


class PlanHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        # План обновляется подменой файла — кэш только мешает.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass  # тишина в журнале службы


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8093
    directory = sys.argv[2] if len(sys.argv) > 2 else "."
    PlanHandler.extensions_map = dict(PlanHandler.extensions_map)
    PlanHandler.extensions_map[".json"] = "application/json"
    socketserver.TCPServer.allow_reuse_address = True
    handler = functools.partial(PlanHandler, directory=directory)
    with socketserver.TCPServer(("127.0.0.1", port), handler) as server:
        print(f"план раздаётся: http://127.0.0.1:{port}/plan.json из {directory}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
