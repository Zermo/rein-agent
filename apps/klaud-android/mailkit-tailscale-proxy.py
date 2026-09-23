#!/usr/bin/env python3
"""Forward Tailscale :8766 to the loopback Mailkit engine. No extra bind in Mailkit itself."""
from __future__ import annotations

import socket
import threading

LISTEN = ("100.99.34.52", 8766)
ORIGIN = ("127.0.0.1", 8766)


def pipe(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle(client: socket.socket) -> None:
    upstream = socket.create_connection(ORIGIN, timeout=8)
    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    pipe(upstream, client)
    for s in (client, upstream):
        try:
            s.close()
        except OSError:
            pass


def main() -> None:
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(LISTEN)
    server.listen(64)
    while True:
        client, _ = server.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
