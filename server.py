#!/usr/bin/env python3
"""rocket-snake: local backend that drafts Rocket.Chat replies with headless Claude Code (+ Onyx)."""

import datetime as dt
import json
import os
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "0.8.0"

ENV_FILE = Path(os.environ.get("RS_ENV_FILE", "~/.config/rocket-snake/env")).expanduser()
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

HOST, PORT = "127.0.0.1", int(os.environ.get("RS_PORT", "8787"))
MODEL = os.environ.get("RS_MODEL", "sonnet")
USE_ONYX = os.environ.get("RS_ONYX", "0") == "1"
TIMEOUT = int(os.environ.get("RS_TIMEOUT", "90"))
ONYX_TIMEOUT = int(os.environ.get("RS_ONYX_TIMEOUT", "150"))
DAILY_BUDGET_USD = float(os.environ.get("RS_DAILY_BUDGET_USD", "2"))
USAGE_LOG = Path(os.environ.get("RS_USAGE_LOG", "~/.local/state/rocket-snake/usage.jsonl")).expanduser()
PERSONA = os.environ.get("RS_PERSONA", "a software engineer")
ORG = os.environ.get("RS_ORG", "the company")
ONYX_URL = os.environ.get("RS_ONYX_URL", "")
ONYX_KEY_CMD = os.environ.get("RS_ONYX_KEY_CMD", "")
ROCKET_URL = os.environ.get("RS_ROCKET_URL", "").rstrip("/")
USERSCRIPT = Path(__file__).with_name("rocket-snake.user.js")

BASE = """You draft chat replies for {me}, {persona} at {org}, in Rocket.Chat.
Write in the language of the conversation (usually French), in {me}'s voice: direct, concise, no fluff,
no greetings unless the conversation calls for it. Never invent internal facts (hosts, procedures, decisions).
Address people only by the names shown in the conversation (or @username); never guess a first name.
If the user provided a draft, improve it rather than starting over.
"""

FAST = BASE + """Return 2 or 3 alternative replies, from shortest to most detailed.
Output ONLY a JSON object, no prose, no code fence:
{{"suggestions": ["...", "..."]}}"""

ONYX = BASE + """If answering the last messages needs internal {org} knowledge (procedures, infra, past
decisions, repos), search Onyx with search_indexed_documents (one or two short keyword queries, always with
skip_query_expansion: true), then return at most 2
replies grounded in what you found, and list the documents you used (title or URL) in `sources`.
If no internal knowledge is needed, or Onyx has nothing relevant, return empty lists without guessing.
Output ONLY a JSON object, no prose, no code fence:
{{"suggestions": ["..."], "sources": ["..."]}}"""


def onyx_mcp_config():
    if not ONYX_URL or not ONYX_KEY_CMD:
        raise RuntimeError("RS_ONYX=1 requires RS_ONYX_URL and RS_ONYX_KEY_CMD")
    key = subprocess.run(ONYX_KEY_CMD, shell=True, capture_output=True, text=True, check=True,
                         timeout=120).stdout.strip()
    fd, path = tempfile.mkstemp(prefix="rocket-snake-mcp-", suffix=".json")
    with os.fdopen(fd, "w") as f:
        json.dump({"mcpServers": {"onyxkb": {
            "type": "http",
            "url": ONYX_URL,
            "headers": {"Authorization": f"Bearer {key}"},
        }}}, f)
    return path


MCP_CONFIG = None
MCP_LOCK = threading.Lock()


def mcp_config():
    global MCP_CONFIG
    with MCP_LOCK:
        if MCP_CONFIG is None:
            MCP_CONFIG = onyx_mcp_config()
        return MCP_CONFIG

LOG_LOCK = threading.Lock()


def log_usage(entry):
    with LOG_LOCK:
        USAGE_LOG.parent.mkdir(parents=True, exist_ok=True)
        with USAGE_LOG.open("a") as f:
            f.write(json.dumps(entry) + "\n")


def usage_stats():
    today = dt.date.today()
    stats = {"today": {"calls": 0, "cost_usd": 0.0}, "week": {"calls": 0, "cost_usd": 0.0}}
    if USAGE_LOG.exists():
        for line in USAGE_LOG.read_text().splitlines():
            e = json.loads(line)
            age = (today - dt.date.fromisoformat(e["ts"][:10])).days
            for period, max_age in (("today", 0), ("week", 6)):
                if age <= max_age:
                    stats[period]["calls"] += 1
                    stats[period]["cost_usd"] += e.get("cost_usd") or 0
    for p in stats.values():
        p["cost_usd"] = round(p["cost_usd"], 3)
    stats["daily_budget_usd"] = DAILY_BUDGET_USD
    stats["server_version"] = VERSION
    stats["onyx_enabled"] = USE_ONYX
    return stats


def build_prompt(req):
    lines = [f"[{m.get('ts', '')}] {m.get('u', '?')}: {m.get('msg', '')}" for m in req.get("messages", [])]
    prompt = f"Room: {req.get('room', '?')}\nConversation (oldest first):\n" + "\n".join(lines)
    if req.get("draft"):
        prompt += f"\n\nDraft from {req.get('me', 'me')} to improve:\n{req['draft']}"
    return prompt


def parse_result(text, fallback):
    try:
        data = json.loads(text[text.index("{"):text.rindex("}") + 1])
        if isinstance(data.get("suggestions"), list):
            return data
    except ValueError:
        pass
    return {"suggestions": [text.strip()] if fallback else [], "sources": []}


def suggest(req):
    onyx = bool(req.get("onyx"))
    cmd = [
        "claude", "-p",
        "--output-format", "json",
        "--model", MODEL,
        "--no-session-persistence",
        "--tools", "",
        "--strict-mcp-config",
        "--setting-sources", "",
        "--system-prompt", (ONYX if onyx else FAST).format(me=req.get("me", "me"), persona=PERSONA, org=ORG),
    ]
    if onyx:
        cmd += ["--mcp-config", mcp_config(), "--allowedTools", "mcp__onyxkb__search_indexed_documents"]
    out = subprocess.run(cmd, input=build_prompt(req), capture_output=True, text=True,
                         timeout=ONYX_TIMEOUT if onyx else TIMEOUT)
    res = json.loads(out.stdout)
    if res.get("is_error"):
        raise RuntimeError(res.get("result", "claude error"))
    data = parse_result(res.get("result", ""), fallback=not onyx)
    data["cost_usd"] = res.get("total_cost_usd")
    usage = res.get("usage", {})
    log_usage({
        "ts": dt.datetime.now().isoformat(timespec="seconds"),
        "kind": req.get("kind", "manual"),
        "onyx": onyx,
        "model": MODEL,
        "cost_usd": data["cost_usd"],
        "duration_s": round(res.get("duration_ms", 0) / 1000, 1),
        "input_tokens": sum(usage.get(k, 0) for k in
                            ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")),
        "output_tokens": usage.get("output_tokens", 0),
    })
    return data


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _allowed(self):
        # Custom header forces a CORS preflight we never answer: only the userscript can call us.
        return self.headers.get("X-Rocket-Snake") == "1"

    def _send_userscript(self):
        url = f"http://{HOST}:{PORT}/rocket-snake.user.js"
        header = f"// @updateURL    {url}\n// @downloadURL  {url}\n// ==/UserScript=="
        script = USERSCRIPT.read_text().replace("// ==/UserScript==", header, 1)
        if ROCKET_URL:
            script = script.replace("https://chat.example.com/*", f"{ROCKET_URL}/*")
        payload = script.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/javascript; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/rocket-snake.user.js":
            return self._send_userscript()
        if self.path != "/stats" or not self._allowed():
            return self._send(404, {"error": "not found"})
        self._send(200, usage_stats())

    def do_POST(self):
        if self.path != "/suggest" or not self._allowed():
            return self._send(404, {"error": "not found"})
        t0 = time.time()
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            if req.get("onyx") and not USE_ONYX:
                return self._send(200, {"suggestions": [], "disabled": True})
            stats = usage_stats()
            if req.get("kind", "manual") != "manual" and stats["today"]["cost_usd"] >= DAILY_BUDGET_USD:
                return self._send(429, {"error": "daily budget reached", "usage": stats})
            data = suggest(req)
            data["duration_s"] = round(time.time() - t0, 1)
            data["usage"] = usage_stats()
            self._send(200, data)
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": str(e)})


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: exit(0))
    print(f"rocket-snake v{VERSION} on http://{HOST}:{PORT} (model={MODEL}, onyx={'on' if USE_ONYX else 'off'}, "
          f"budget=${DAILY_BUDGET_USD}/day, log={USAGE_LOG})", flush=True)
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    finally:
        if MCP_CONFIG:
            os.unlink(MCP_CONFIG)
