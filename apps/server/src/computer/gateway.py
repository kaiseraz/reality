"""
Reality's gateway for bot computers. Runs in its own container, on two networks: the normal
bridge (internet) and the internal bot network (no internet). It does three things:

1. Forward proxy on :3128 for the bot computers. A request goes out only if its host is on
   that bot's allowlist (the domain or a subdomain of it), and only to ports 80 and 443.
   Everything else is refused with 403. Every decision is logged as an event.
2. Relays: each bot computer gets a port here (47100+) that pipes raw TCP to the bot's
   container on :8080, so Reality reaches the computer (API, live screen) without the
   computer itself being on a network with internet access.
3. Control on :47090 for Reality only (token): set slots and allowlists, read events.

Standard library only.
"""

import asyncio
import collections
import ipaddress
import json
import os
import socket
import time

TOKEN = os.environ.get("GATEWAY_TOKEN", "")
state = {"slots": {}, "allow": {}}
events = collections.deque(maxlen=1000)
seq = 0
relays = {}
ip_cache = {"at": 0.0, "map": {}}


def log(bot, kind, host):
    global seq
    seq += 1
    events.append({"seq": seq, "at": time.time(), "bot": bot, "kind": kind, "host": host})


def bot_of(ip):
    """Which bot container has this address on the bot network (cached for a few seconds)."""
    now = time.time()
    # A short-lived tool container asks within a moment of starting: an unknown address looks
    # again at once (at most once a second), or its first request would be refused.
    age = now - ip_cache["at"]
    if age > 5 or (ip not in ip_cache["map"] and age > 1):
        mapping = {}
        for name in state["allow"].keys():
            try:
                mapping[socket.gethostbyname(name)] = name
            except OSError:
                pass
        ip_cache["map"] = mapping
        ip_cache["at"] = now
    return ip_cache["map"].get(ip)


def allowed(bot, host):
    host = host.lower().rstrip(".")
    for d in state["allow"].get(bot, []):
        d = d.lower()
        if host == d or host.endswith("." + d):
            return True
    return False


async def public_address(host, port):
    """Resolves a host and returns a public address, or None for anything inside: loopback,
    private networks, link-local, the Docker host. Guards against an allowed name pointing
    at this machine (DNS rebinding)."""
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        return None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_global and not ip.is_multicast:
            return str(ip)
    return None


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def read_head(reader):
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = await reader.read(4096)
        if not chunk:
            return None, b""
        head += chunk
        if len(head) > 65536:
            return None, b""
    i = head.index(b"\r\n\r\n") + 4
    return head[:i], head[i:]


def refuse(writer, host):
    body = f"Reality: {host} is not allowed for this bot computer. Ask the user to allow it.\n".encode()
    writer.write(
        b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n"
        + f"Content-Length: {len(body)}\r\n\r\n".encode()
        + body
    )


async def proxy(reader, writer):
    peer = writer.get_extra_info("peername")
    bot = bot_of(peer[0]) if peer else None
    try:
        head, rest = await read_head(reader)
        if not head:
            writer.close()
            return
        line = head.split(b"\r\n", 1)[0].decode("latin-1")
        method, target, _ = (line.split(" ") + ["", ""])[:3]
        if method == "CONNECT":
            host, _, port = target.rpartition(":")
            port = int(port or 443)
        else:
            if not target.startswith("http://"):
                writer.close()
                return
            hostport = target[7:].split("/", 1)[0]
            host, _, port = hostport.partition(":")
            port = int(port or 80)
        host = host.strip("[]")
        if not bot or port not in (80, 443) or not allowed(bot, host):
            log(bot or "?", "denied", host)
            refuse(writer, host)
            await writer.drain()
            writer.close()
            return
        address = await public_address(host, port)
        if not address:
            log(bot, "denied", host)
            refuse(writer, host)
            await writer.drain()
            writer.close()
            return
        log(bot, "allowed", host)
        up_reader, up_writer = await asyncio.wait_for(
            asyncio.open_connection(address, port), 15
        )
        if method == "CONNECT":
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
        else:
            path = "/" + target[7:].split("/", 1)[1] if "/" in target[7:] else "/"
            lines = head.decode("latin-1").split("\r\n")
            lines[0] = f"{method} {path} HTTP/1.1"
            lines = [l for l in lines if not l.lower().startswith("proxy-")]
            up_writer.write("\r\n".join(lines).encode("latin-1"))
        if rest:
            up_writer.write(rest)
        await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))
    except Exception:
        try:
            writer.close()
        except Exception:
            pass


def relay_handler(port):
    async def handle(reader, writer):
        target = state["slots"].get(str(port))
        if not target:
            writer.close()
            return
        try:
            up_reader, up_writer = await asyncio.wait_for(
                asyncio.open_connection(target, 8080), 10
            )
        except Exception:
            writer.close()
            return
        await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))

    return handle


async def apply_slots():
    for port in list(relays):
        if port not in state["slots"]:
            relays.pop(port).close()
    for port in state["slots"]:
        if port not in relays:
            relays[port] = await asyncio.start_server(relay_handler(port), "0.0.0.0", int(port))


async def control(reader, writer):
    try:
        head, rest = await read_head(reader)
        if not head:
            writer.close()
            return
        lines = head.decode("latin-1").split("\r\n")
        method, path, _ = (lines[0].split(" ") + ["", ""])[:3]
        headers = {}
        for l in lines[1:]:
            k, _, v = l.partition(":")
            headers[k.strip().lower()] = v.strip()
        if not TOKEN or headers.get("x-token") != TOKEN:
            status, body = "403 Forbidden", {"error": "token"}
        elif method == "POST" and path == "/config":
            length = int(headers.get("content-length", "0"))
            while len(rest) < length:
                more = await reader.read(length - len(rest))
                if not more:
                    break
                rest += more
            cfg = json.loads(rest.decode() or "{}")
            state["slots"] = {str(k): v for k, v in cfg.get("slots", {}).items()}
            state["allow"] = {k: list(v) for k, v in cfg.get("allow", {}).items()}
            ip_cache["at"] = 0
            await apply_slots()
            status, body = "200 OK", {"ok": True}
        elif method == "GET" and path.startswith("/events"):
            after = int(path.partition("after=")[2] or 0)
            status, body = "200 OK", {"events": [e for e in events if e["seq"] > after]}
        else:
            status, body = "404 Not Found", {"error": "not found"}
        data = json.dumps(body).encode()
        writer.write(
            f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n".encode()
            + data
        )
        await writer.drain()
    except Exception:
        pass
    finally:
        writer.close()


async def main():
    await asyncio.start_server(proxy, "0.0.0.0", 3128)
    await asyncio.start_server(control, "0.0.0.0", 47090)
    print("gateway ready", flush=True)
    await asyncio.Event().wait()


asyncio.run(main())
