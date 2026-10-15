"""Universal Prompt Forge: write image prompts for many models via Ollama.

Profiles (system prompts, slots, forbidden words) live in data/prompt_presets.json.
"""
import asyncio
import json
import os
import queue
import re
import socket
import threading
import time
from urllib import error as urlerror
from urllib import request as urlrequest

BUNDLE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "data", "prompt_presets.json")

OLLAMA_URL = os.environ.get("PROMPT_FORGE_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
DEFAULT_TIMEOUT = 600
CANCEL_POLL = 0.5


def log(message):
    print(f"\033[38;5;136m[Prompt Forge]\033[0m {message}")


_bundle_cache = {"mtime": None, "data": None}


def load_bundle(path=BUNDLE_PATH):
    mtime = os.path.getmtime(path)
    if _bundle_cache["mtime"] != mtime:
        with open(path, "r", encoding="utf-8") as fh:
            _bundle_cache["data"] = json.load(fh)
        _bundle_cache["mtime"] = mtime
    return _bundle_cache["data"]


class ForgeError(Exception):
    def __init__(self, code, message, raw=None):
        super().__init__(message)
        self.code, self.message, self.raw = code, message, raw


_REQUEST_LOCK = threading.RLock()
_CANCELS = {}
_active_http = {}
_LOADED_MODELS = set()


def _one_draft(function):
    def call(*args, **kwargs):
        if not _REQUEST_LOCK.acquire(blocking=False):
            raise ForgeError("busy", "Another Forge run is active.")
        try:
            return function(*args, **kwargs)
        finally:
            _REQUEST_LOCK.release()
    call.__name__ = function.__name__
    return call


def cancel(request_id):
    rid = str(request_id or "")
    event = _CANCELS.get(rid)
    if event is None:
        return False
    event.set()
    resp = _active_http.get(rid)
    if resp is not None:
        try:
            resp.close()
        except Exception:
            pass
        try:
            sock = getattr(getattr(resp, "fp", None), "raw", None)
            sock = getattr(sock, "_sock", None)
            if sock is not None:
                sock.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
    return True


_THINK = re.compile(r"<think>.*?</think>", re.S)


def _http(url, payload=None, timeout=15):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urlrequest.Request(url, data=data,
                             headers={"Content-Type": "application/json"})
    with urlrequest.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode() or "{}")


def _stream_lines(url, payload, timeout, cancel_event, request_id=None):
    req = urlrequest.Request(url, data=json.dumps(payload).encode(),
                             headers={"Content-Type": "application/json"})
    resp = urlrequest.urlopen(req, timeout=timeout)
    if request_id:
        _active_http[request_id] = resp

    q = queue.Queue()
    _END = object()

    def reader():
        try:
            for raw in resp:
                q.put(raw)
        except Exception as exc:
            q.put(exc)
        finally:
            q.put(_END)

    reader_thread = threading.Thread(target=reader, daemon=True,
                                     name=f"pf-reader-{request_id or 'x'}")
    reader_thread.start()

    try:
        while True:
            if cancel_event is not None and cancel_event.is_set():
                raise ForgeError("cancelled", "Cancelled.")
            try:
                item = q.get(timeout=CANCEL_POLL)
            except queue.Empty:
                continue
            if item is _END:
                break
            if isinstance(item, Exception):
                if cancel_event is not None and cancel_event.is_set():
                    raise ForgeError("cancelled", "Cancelled.")
                raise item
            line = item.decode("utf-8", "replace").strip()
            if line:
                yield line
    finally:
        if request_id:
            _active_http.pop(request_id, None)
        try:
            resp.close()
        except Exception:
            pass


def list_models():
    out = []
    try:
        data = _http(OLLAMA_URL + "/api/tags")
    except (urlerror.URLError, TimeoutError, OSError) as exc:
        raise ForgeError("backend", f"Could not reach Ollama at {OLLAMA_URL}: {exc}")
    for m in data.get("models", []):
        details = m.get("details") or {}
        families = " ".join([details.get("family") or "",
                             *(details.get("families") or [])]).lower()
        if "bert" in families or "embed" in m["name"].lower():
            continue
        params = details.get("parameter_size")
        label = m["name"] + (f" ({params})" if params else "")
        out.append({"id": f"ollama:{m['name']}", "label": label})
    return out


def _loaded_now():
    try:
        return {m["name"] for m in _http(OLLAMA_URL + "/api/ps").get("models", [])}
    except Exception:
        return set()


def _unload(name):
    try:
        _http(OLLAMA_URL + "/api/generate",
              {"model": name, "keep_alive": 0}, timeout=30)
    except Exception as exc:
        log(f"unload of {name} failed: {exc}")
    return name not in _loaded_now()


def unload_forge_models():
    with _REQUEST_LOCK:
        for name in list(_LOADED_MODELS):
            if name in _loaded_now():
                log(f"{name} was still loaded; unloading")
                _unload(name)
        _LOADED_MODELS.clear()


def _chat(name, system, user, cancel_event, *, num_ctx, temperature, top_p, request_id=None):
    payload = {
        "model": name,
        "stream": True,
        "think": False,
        "keep_alive": 0,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "options": {
            "num_ctx": num_ctx,
            "num_predict": 3500,
            "temperature": temperature,
            "top_p": top_p,
        },
    }
    parts, stats = [], {}
    for line in _stream_lines(OLLAMA_URL + "/api/chat", payload,
                              DEFAULT_TIMEOUT, cancel_event, request_id):
        chunk = json.loads(line)
        if chunk.get("error"):
            raise ForgeError("backend", f"Ollama: {chunk['error']}")
        parts.append((chunk.get("message") or {}).get("content") or "")
        if chunk.get("done"):
            stats = {
                "prompt_tokens": chunk.get("prompt_eval_count"),
                "output_tokens": chunk.get("eval_count"),
            }
    return "".join(parts), stats


def _title_case(value):
    return str(value).replace("_", " ").title()


def build_user_message(profile, brief, creativity, detail):
    lines = [f'Brief: "{str(brief).strip()}"']

    preset = profile.get("creativity_presets", {}).get(creativity)
    if preset and preset.get("rule"):
        lines.append(f"Creativity - {_title_case(creativity)}. {preset['rule']}")

    table = profile.get("detail_levels", {})
    default_detail = profile.get("default_detail", 3)
    entry = table.get(str(detail)) or table.get(str(default_detail))
    if entry and entry.get("rule"):
        level = detail if str(detail) in table else default_detail
        lines.append(f"Detail level {level} of {len(table)} - "
                     f"{entry.get('label', level)}. {entry['rule']}")

    slots = profile.get("slots") or {}
    if slots:
        lines.append("")
        lines.append("Slot guide (write in this order):")
        for slot, note in slots.items():
            lines.append(f"- {slot}: {note}")

    forbidden = profile.get("forbidden") or []
    if forbidden:
        lines.append("")
        lines.append("Never include: " + ", ".join(forbidden) + ".")
    return "\n".join(lines)


def _clean_output(raw, profile):
    text = _THINK.sub("", str(raw or "")).strip()
    text = re.sub(r"^```[^\n]*\n|\n```$", "", text).strip()
    text = re.split(
        r"\n(?=(?:Steps|CFG|Sampler|Seed|Size|Negative prompt)\s*:)",
        text,
    )[0].strip()
    limit = int(profile.get("max_output_chars", 4000))
    if len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0]
    return text


@_one_draft
def generate(body):
    request_id = str(body.get("request_id") or "")
    stop = threading.Event()
    if request_id:
        _CANCELS[request_id] = stop

    try:
        bundle = load_bundle()
        profile_id = str(body.get("profile") or "custom").lower()
        profile = bundle["profiles"].get(profile_id)
        if profile is None:
            raise ForgeError("bad_profile", f"Unknown profile: {profile_id}")

        brief = str(body.get("brief") or "").strip()
        if not brief:
            raise ForgeError("no_brief", "Write what the image should show first.")

        raw_model = str(body.get("model") or "")
        kind, _, name = raw_model.partition(":")
        if kind != "ollama" or not name:
            raise ForgeError("no_model", "Pick an Ollama model.")

        creativity = body.get("creativity") or profile.get("default_creativity", "balanced")
        if creativity not in profile.get("creativity_presets", {}):
            creativity = profile.get("default_creativity", "balanced")
        detail = body.get("detail") or profile.get("default_detail", 3)

        # Optional per-run overrides from the Custom tab
        system_prompt = str(body.get("custom_system_prompt") or "").strip() \
            or profile.get("system_prompt", "")
        custom_slots = str(body.get("custom_slots") or "").strip()
        if custom_slots:
            profile = dict(profile)
            profile["slots"] = {"Custom": custom_slots}

        user = build_user_message(profile, brief, creativity, detail)
        _LOADED_MODELS.add(name)
        started = time.time()
        try:
            raw, stats = _chat(
                name, system_prompt, user, stop,
                num_ctx=int(profile.get("num_ctx", 4096)),
                temperature=float(profile.get("temperature", 0.7)),
                top_p=float(profile.get("top_p", 0.8)),
                request_id=request_id,
            )
        finally:
            unloaded = _unload(name)
            if unloaded:
                _LOADED_MODELS.discard(name)

        if stop.is_set():
            raise ForgeError("cancelled", "Cancelled.")

        prompt = _clean_output(raw, profile)
        if not prompt:
            raise ForgeError("empty", "The model returned an empty prompt.")

        stats["seconds"] = round(time.time() - started, 1)
        return {
            "prompt": prompt,
            "profile": profile_id,
            "model": f"ollama:{name}",
            "stats": stats,
            "unloaded": unloaded,
        }
    finally:
        if request_id:
            _CANCELS.pop(request_id, None)


def register_routes():
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        return
    server = getattr(PromptServer, "instance", None)
    if server is None:
        return

    def _release():
        if server.prompt_queue.get_tasks_remaining() > 0:
            raise ForgeError("busy", "A workflow started. Draft after it finishes.")

    @server.routes.post("/forge/profiles")
    async def forge_profiles(request):
        bundle = load_bundle()
        order = bundle.get("order") or list(bundle["profiles"].keys())
        return web.json_response({
            "order": order,
            "profiles": {
                pid: {
                    "label": p.get("label", pid),
                    "creativity": list(p.get("creativity_presets", {}).keys()),
                    "detail_levels": {k: v.get("label") for k, v in p.get("detail_levels", {}).items()},
                    "default_creativity": p.get("default_creativity", "balanced"),
                    "default_detail": p.get("default_detail", 3),
                }
                for pid, p in bundle["profiles"].items()
            },
        })

    @server.routes.post("/forge/models")
    async def forge_models(request):
        try:
            models = await asyncio.to_thread(list_models)
        except ForgeError as exc:
            return web.json_response({"error": exc.code, "message": exc.message}, status=400)
        return web.json_response({"models": models})

    @server.routes.post("/forge/cancel")
    async def forge_cancel(request):
        body = await request.json()
        return web.json_response({"cancelled": cancel(body.get("request_id"))})

    @server.routes.post("/forge")
    async def forge(request):
        if server.prompt_queue.get_tasks_remaining() > 0:
            return web.json_response(
                {"error": "busy", "message": "A workflow is running. Forge before you queue, or wait."},
                status=409,
            )
        try:
            body = await request.json()
            _release()
            result = await asyncio.to_thread(generate, body)
        except ForgeError as exc:
            return web.json_response(
                {"error": exc.code, "message": exc.message, "raw": exc.raw},
                status=422,
            )
        except Exception as exc:
            log(f"failed: {exc}")
            return web.json_response({"error": "internal", "message": str(exc)}, status=500)
        log(f"{result['model']} wrote a {result['profile']} prompt in "
            f"{result['stats']['seconds']}s, unloaded={result['unloaded']}")
        return web.json_response(result)


register_routes()