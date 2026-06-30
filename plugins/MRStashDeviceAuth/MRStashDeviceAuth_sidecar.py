#!/usr/bin/env python3
"""
MRStashDeviceAuth Sidecar — MRStashDeviceAuth_sidecar.py  v0.4.0

Flask HTTP server that runs inside the Stash Docker container on port 9997
(configurable). Stash executes this via the plugin task system.

Changelog v0.4.0
----------------
- SECURITY: Admin endpoints (/pending, /devices, /pair/approve, /pair/deny,
  /revoke, /logs) now require an X-Admin-Secret header. The secret is
  generated on first boot, persisted to admin_secret.txt (0600), and exposed
  to the Stash UI via a plugin asset file that only authenticated Stash
  sessions can read.
- The public management HTML UI has been removed. The root page is now a
  static stub directing users to open Stash. All device management happens
  inside a modal in the Stash SPA (MRStashDeviceAuth.js).
- /pair/approve, /pair/deny, /revoke now return JSON instead of redirecting,
  and accept both JSON and form bodies for backward compatibility.
- Streaming, screenshot, graphql proxy, /pair, /pair/status, /auth/validate,
  and /health remain unauthenticated or device-token-gated as before — they
  are either the pairing bootstrap or gated by the per-device UUID token.

Endpoints
---------
  Open (intentionally):
    GET  /health                    Liveness check
    GET  /                          Static info stub
    POST /pair                      Request a pairing code
    GET  /pair/status?code=...      Headset polls for approval
    POST /auth/validate             Headset validates stored token
    POST /graphql                   Authenticated GraphQL proxy (device token)
    GET  /stream/<scene_id>         Authenticated stream proxy (device token)
    GET  /screenshot/<scene_id>     Authenticated screenshot proxy (device token)
    GET  /preview/<scene_id>        Authenticated preview proxy (device token)

  Admin-secret gated:
    GET  /logs?n=<lines>            Tail sidecar.log
    GET  /pending                   List pending pairing codes
    GET  /devices                   List paired devices
    POST /pair/approve              Approve a pairing code
    POST /pair/deny                 Deny a pairing code
    POST /revoke                    Revoke a device token

Auth model
----------
  Headset       → Authorization: Bearer <device-token-uuid>
                  or ?token=<uuid> (for VideoPlayer stream URLs)
  Stash UI      → X-Admin-Secret: <64-hex-secret>
                  Secret is read from a plugin asset file that only
                  authenticated Stash users can fetch.
"""

import json
import hmac
import os
import random
import re
import subprocess
import sys
import tempfile
import time
import threading
import uuid
import logging
import signal
import atexit
from collections import deque
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="[MRStashDeviceAuth] %(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("MRStashDeviceAuth")

def _pip_hint() -> str:
    if sys.platform == "win32":
        return "pip install flask requests pyyaml"
    return "pip3 install flask requests pyyaml --break-system-packages"

try:
    import yaml
    import requests
    from flask import Flask, Response, jsonify, request, stream_with_context, abort, redirect
    log.info("All dependencies imported successfully.")
except ImportError as exc:
    logging.basicConfig()
    logging.getLogger("MRStashDeviceAuth").error(
        "Missing dependency — run: %s\n%s", _pip_hint(), exc
    )
    sys.exit(1)

try:
    from PIL import Image
    import io
    HAS_PILLOW = True
except ImportError:
    HAS_PILLOW = False
    pillow_hint = "pip install Pillow" if sys.platform == "win32" else "pip3 install Pillow --break-system-packages"
    log.warning("Pillow not installed — screenshot resizing disabled. Run: %s", pillow_hint)

# ---------------------------------------------------------------------------
# Paths & constants
# ---------------------------------------------------------------------------
PLUGIN_DIR        = Path(__file__).parent.resolve()
PAIRING_FILE      = PLUGIN_DIR / "pairing.json"
LOG_FILE          = PLUGIN_DIR / "sidecar.log"
PID_FILE = Path(tempfile.gettempdir()) / "stashvr_sidecar.pid"
ADMIN_SECRET_FILE = PLUGIN_DIR / "admin_secret.txt"
ASSETS_DIR        = PLUGIN_DIR / "assets"
ADMIN_SECRET_ASSET = ASSETS_DIR / "admin_secret.json"

def _default_stash_config_path() -> Path:
    if sys.platform == "win32":
        return Path.home() / ".stash" / "config.yml"
    return Path("/root/.stash/config.yml")

STASH_CONFIG_PATH = Path(os.environ.get("STASH_CONFIG", str(_default_stash_config_path())))
STASH_BASE        = "http://localhost:9999"
STASH_GRAPHQL_URL = f"{STASH_BASE}/graphql"

CODE_TTL_SECONDS     = 300
APPROVED_TTL_SECONDS = 60
DEFAULT_PORT         = 9997
STREAM_CHUNK_SIZE    = 1024 * 64
LOG_MAX_LINES        = 1000

# ---------------------------------------------------------------------------
# In-memory state
# ---------------------------------------------------------------------------
pending_codes:  dict = {}   # code  -> {device_name, expires_at}
approved_codes: dict = {}   # code  -> {token, device_name, approved_at}
devices:        dict = {}   # token -> {device_name, paired_at, last_seen}
state_lock = threading.Lock()

ADMIN_SECRET: str = ""  # set in main()


# ---------------------------------------------------------------------------
# Admin secret management
# ---------------------------------------------------------------------------

def _load_or_create_admin_secret() -> str:
    """
    Read admin_secret.txt, or generate a new 64-char hex secret if the file
    doesn't exist or is empty. Also writes the secret to a plugin asset file
    so the Stash UI (via authenticated /plugin/MRStashDeviceAuth/assets/ path)
    can read it.
    """
    secret = ""
    if ADMIN_SECRET_FILE.exists():
        try:
            secret = ADMIN_SECRET_FILE.read_text().strip()
        except Exception as exc:
            log.warning("Could not read admin secret file: %s — regenerating.", exc)

    if not secret:
        secret = uuid.uuid4().hex + uuid.uuid4().hex  # 64 hex chars
        try:
            ADMIN_SECRET_FILE.write_text(secret)
            os.chmod(ADMIN_SECRET_FILE, 0o600)
            log.info("Generated new admin secret at %s", ADMIN_SECRET_FILE)
        except Exception as exc:
            log.error("Could not write admin secret: %s", exc)

    # Mirror the secret into the plugin assets dir so the Stash UI can fetch it.
    # This path is served by Stash itself, gated by the normal Stash session.
    try:
        ASSETS_DIR.mkdir(exist_ok=True)
        ADMIN_SECRET_ASSET.write_text(json.dumps({"secret": secret}))
        try:
            os.chmod(ADMIN_SECRET_ASSET, 0o600)
        except Exception:
            pass
    except Exception as exc:
        log.warning("Could not write admin secret asset: %s", exc)

    return secret


def require_admin(fn):
    """Decorator: require a valid X-Admin-Secret header."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        provided = request.headers.get("X-Admin-Secret", "")
        if not ADMIN_SECRET or not provided:
            return jsonify({"error": "admin auth required"}), 401
        if not hmac.compare_digest(provided, ADMIN_SECRET):
            return jsonify({"error": "admin auth required"}), 401
        return fn(*args, **kwargs)
    return wrapper


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def _load_devices() -> dict:
    if PAIRING_FILE.exists():
        try:
            return json.loads(PAIRING_FILE.read_text())
        except Exception as exc:
            log.warning("Could not read pairing.json: %s — starting fresh.", exc)
    return {}


def _save_devices() -> None:
    PAIRING_FILE.write_text(json.dumps(devices, indent=2))


# ---------------------------------------------------------------------------
# Stash API key
# ---------------------------------------------------------------------------

def _read_stash_api_key():
    try:
        cfg = yaml.safe_load(STASH_CONFIG_PATH.read_text())
        return cfg.get("api_key") or None
    except FileNotFoundError:
        log.warning("Stash config not found at %s", STASH_CONFIG_PATH)
    except Exception as exc:
        log.warning("Could not read Stash config: %s", exc)
    return None


def _stash_headers() -> dict:
    h = {"Content-Type": "application/json"}
    key = _read_stash_api_key()
    if key:
        h["ApiKey"] = key
    return h


# ---------------------------------------------------------------------------
# Scene stream URL helpers
# ---------------------------------------------------------------------------

def _get_scene_streams(scene_id: str):
    query = """
    query FindScene($id: ID!) {
      findScene(id: $id) {
        id
        paths { stream }
        sceneStreams { url label mime_type }
        files { width height video_codec }
      }
    }
    """
    try:
        resp = requests.post(
            STASH_GRAPHQL_URL,
            json={"query": query, "variables": {"id": scene_id}},
            headers=_stash_headers(),
            timeout=10,
        )
        payload = resp.json()
        if "errors" in payload:
            log.warning("GraphQL errors in _get_scene_streams for scene %s: %s", scene_id, payload["errors"])

        data = payload.get("data")
        if not data or not data.get("findScene"):
            log.warning("findScene returned null for scene %s", scene_id)
            return None

        scene = data["findScene"]
        raw_stream = scene["paths"]["stream"]
        clean_stream = re.sub(r"[?&]apikey=[^&]*", "", raw_stream).rstrip("?&")

        return {
            "direct":          clean_stream,
            "direct_with_key": raw_stream,
            "streams":         scene.get("sceneStreams") or [],
            "files":           scene.get("files") or [],
        }
    except Exception as exc:
        log.warning("Could not resolve streams for scene %s: %s", scene_id, exc, exc_info=True)
        return None


def _get_scene_stream_url(scene_id: str):
    info = _get_scene_streams(scene_id)
    if not info:
        return None
    return info["direct"]


def _get_scene_preview_url(scene_id: str):
    """Resolve the MP4 preview URL for a scene via GraphQL."""
    query = """
    query FindScene($id: ID!) {
      findScene(id: $id) {
        id
        paths { preview }
      }
    }
    """
    try:
        resp = requests.post(
            STASH_GRAPHQL_URL,
            json={"query": query, "variables": {"id": scene_id}},
            headers=_stash_headers(),
            timeout=10,
        )
        payload = resp.json()
        if "errors" in payload:
            log.warning("GraphQL errors in _get_scene_preview_url for scene %s: %s",
                        scene_id, payload["errors"])
        data = payload.get("data")
        if not data or not data.get("findScene"):
            return None
        preview = data["findScene"]["paths"].get("preview")
        if not preview:
            return None
        # Strip any leaked apikey query param the way _get_scene_streams does
        return re.sub(r"[?&]apikey=[^&]*", "", preview).rstrip("?&")
    except Exception as exc:
        log.warning("Could not resolve preview for scene %s: %s", scene_id, exc, exc_info=True)
        return None

# ---------------------------------------------------------------------------
# Token validation
# ---------------------------------------------------------------------------

def _validate_token(token_id: str) -> bool:
    with state_lock:
        if token_id not in devices:
            return False
        devices[token_id]["last_seen"] = datetime.now(timezone.utc).isoformat()
        _save_devices()
    return True


def _extract_token() -> str:
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    xdt = request.headers.get("X-Device-Token", "").strip()
    if xdt:
        return xdt
    return request.args.get("token", "").strip()


# ---------------------------------------------------------------------------
# Log tail helper
# ---------------------------------------------------------------------------

def _tail_log(n: int):
    n = min(max(1, n), LOG_MAX_LINES)
    if not LOG_FILE.exists():
        return ["(log file not found)"]
    try:
        buf: deque = deque(maxlen=n)
        with LOG_FILE.open("r", errors="replace") as fh:
            for line in fh:
                buf.append(line.rstrip("\n"))
        return list(buf)
    except Exception as exc:
        log.warning("Could not read log file: %s", exc)
        return [f"(error reading log: {exc})"]


# ---------------------------------------------------------------------------
# State helpers
# ---------------------------------------------------------------------------

def _purge_expired_codes() -> None:
    now = time.time()
    for c in [c for c, info in pending_codes.items() if info["expires_at"] < now]:
        del pending_codes[c]


def _purge_approved_codes() -> None:
    now = time.time()
    for c in [c for c, info in approved_codes.items()
              if now - info["approved_at"] > APPROVED_TTL_SECONDS]:
        del approved_codes[c]


def _get_code_from_request() -> str:
    """Accept code from either JSON body or form body."""
    if request.is_json:
        body = request.get_json(silent=True) or {}
        return str(body.get("code", "")).strip()
    return (request.form.get("code") or "").strip()


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__)


@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = (
        "Content-Type, Authorization, X-Device-Token, X-Admin-Secret"
    )
    return response


@app.route("/", methods=["OPTIONS"])
@app.route("/<path:path>", methods=["OPTIONS"])
def options_handler(path=""):
    return "", 204


# ── Public / info ─────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    key = _read_stash_api_key()
    return jsonify({"status": "ok", "pid": os.getpid(), "stash_key_set": bool(key)})


_STUB_HTML = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>MRStashDeviceAuth</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#0e0e12;color:#d4d4d8;
     padding:2rem;max-width:40rem;margin:auto;line-height:1.6}
h1{color:#fff;font-size:1.4rem;margin-bottom:.5rem}
p{color:#a1a1aa}
code{background:#18181f;padding:.15rem .4rem;border-radius:4px;font-size:.85em}
</style></head><body>
<h1>MRStashDeviceAuth Sidecar</h1>
<p>This service is managed from inside Stash. Open Stash in your browser,
sign in, and click the <strong>device auth</strong> icon in the top navigation bar
to manage pairing requests and paired devices.</p>
<p>Device streaming endpoints (<code>/stream</code>, <code>/graphql</code>) remain
available to headsets with a valid device token.</p>
</body></html>"""


@app.get("/")
def root():
    return _STUB_HTML, 200, {"Content-Type": "text/html; charset=utf-8"}


# ── Admin: logs ───────────────────────────────────────────────────────────────

@app.get("/logs")
@require_admin
def get_logs():
    try:
        n = int(request.args.get("n", 150))
    except (TypeError, ValueError):
        n = 150
    lines = _tail_log(n)
    return jsonify({"lines": lines, "total": len(lines)})


# ── Pairing (open: /pair and /pair/status) ───────────────────────────────────

@app.post("/pair")
def pair():
    body = request.get_json(silent=True) or {}
    device_name = str(body.get("device_name", "Unknown Device")).strip()[:64]
    code = f"{random.randint(0, 999999):06d}"
    expires_at = time.time() + CODE_TTL_SECONDS

    with state_lock:
        _purge_expired_codes()
        pending_codes[code] = {"device_name": device_name, "expires_at": expires_at}

    log.info("Pairing code %s issued for device '%s'", code, device_name)
    return jsonify({"code": code, "expires_in": CODE_TTL_SECONDS})


@app.get("/pair/status")
def pair_status():
    code = request.args.get("code", "").strip()
    if not code:
        return jsonify({"error": "code query param required"}), 400

    with state_lock:
        _purge_expired_codes()
        _purge_approved_codes()

        if code in approved_codes:
            entry = approved_codes[code]
            if entry.get("denied"):
                return jsonify({"status": "denied"})
            return jsonify({"status": "approved", "token": entry["token"]})

        if code in pending_codes:
            return jsonify({"status": "pending"})

    return jsonify({"status": "expired"})


# ── Admin: pairing approval ──────────────────────────────────────────────────

@app.post("/pair/approve")
@require_admin
def approve():
    code = _get_code_from_request()
    with state_lock:
        _purge_expired_codes()
        entry = pending_codes.pop(code, None)

    if entry is None:
        return jsonify({"error": "Invalid or expired code"}), 400

    token = str(uuid.uuid4())
    record = {
        "device_name": entry["device_name"],
        "paired_at":   datetime.now(timezone.utc).isoformat(),
        "last_seen":   None,
    }

    with state_lock:
        approved_codes[code] = {
            "token":       token,
            "device_name": entry["device_name"],
            "approved_at": time.time(),
        }
        devices[token] = record
        _save_devices()

    log.info("Device '%s' approved — token %s…", entry["device_name"], token[:8])
    return jsonify({
        "status":      "approved",
        "device_name": entry["device_name"],
        "token_hint":  token[:8],
    })


@app.post("/pair/deny")
@require_admin
def deny():
    code = _get_code_from_request()
    with state_lock:
        pending_codes.pop(code, None)
        approved_codes[code] = {
            "token":       None,
            "device_name": "",
            "approved_at": time.time(),
            "denied":      True,
        }
    log.info("Pairing code %s denied", code)
    return jsonify({"status": "denied"})


# ── Auth validate (device-token gated) ───────────────────────────────────────

@app.route("/auth/validate", methods=["GET", "POST"])
def auth_validate():
    token_id = _extract_token()
    if not _validate_token(token_id):
        return jsonify({"status": "invalid"}), 401

    api_key = _read_stash_api_key()
    external_host = request.host.split(":")[0]
    stash_url = f"http://{external_host}:9999"

    return jsonify({
        "status":    "valid",
        "stash_url": stash_url,
        "api_key":   api_key or "",
    })


# ── Admin: device management ─────────────────────────────────────────────────

@app.get("/devices")
@require_admin
def list_devices():
    with state_lock:
        result = [
            {
                "device_name": v["device_name"],
                "paired_at":   v["paired_at"],
                "last_seen":   v["last_seen"],
                "token_hint":  k[:8] + "…",
                "token_id":    k,
            }
            for k, v in devices.items()
        ]
    return jsonify(result)


@app.get("/pending")
@require_admin
def list_pending():
    with state_lock:
        _purge_expired_codes()
        result = [
            {
                "code":        code,
                "device_name": info["device_name"],
                "expires_in":  max(0, int(info["expires_at"] - time.time())),
            }
            for code, info in pending_codes.items()
        ]
    return jsonify(result)


@app.post("/revoke")
@require_admin
def revoke():
    body = request.get_json(silent=True) or {}
    token_id = body.get("token_id", "")
    with state_lock:
        if token_id not in devices:
            return jsonify({"error": "Unknown device"}), 404
        name = devices.pop(token_id)["device_name"]
        _save_devices()
    log.info("Device '%s' revoked.", name)
    return jsonify({"status": "revoked", "device_name": name})


# ── GraphQL proxy (device-token gated) ───────────────────────────────────────

@app.post("/graphql")
def graphql_proxy():
    token_id = _extract_token()
    if not _validate_token(token_id):
        abort(401, description="Invalid or missing device token.")

    headers = {
        "Content-Type": "application/json",
        **({} if not _read_stash_api_key() else {"ApiKey": _read_stash_api_key()}),
    }

    try:
        resp = requests.post(
            STASH_GRAPHQL_URL,
            data=request.get_data(),
            headers=headers,
            timeout=30,
        )
        return (resp.content, resp.status_code, {"Content-Type": "application/json"})
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "Could not reach Stash GraphQL endpoint"}), 502
    except requests.exceptions.Timeout:
        return jsonify({"error": "Stash GraphQL request timed out"}), 504


# ── Stream proxy (device-token gated) ────────────────────────────────────────

_FORWARD_RESPONSE_HEADERS = {
    "Content-Type", "Content-Length", "Content-Range",
    "Accept-Ranges", "Cache-Control", "Last-Modified", "ETag",
}


@app.get("/stream/<scene_id>")
def stream_proxy(scene_id: str):
    token_id = _extract_token()
    if not _validate_token(token_id):
        abort(401, description="Invalid or missing device token.")

    stream_url = _get_scene_stream_url(scene_id)
    if stream_url is None:
        return jsonify({"error": f"Scene {scene_id} not found or not streamable"}), 404

    upstream_headers = {}
    if "Range" in request.headers:
        upstream_headers["Range"] = request.headers["Range"]
    api_key = _read_stash_api_key()
    if api_key:
        upstream_headers["ApiKey"] = api_key

    try:
        upstream = requests.get(
            stream_url,
            headers=upstream_headers,
            stream=True,
            timeout=(5, None),
        )
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "Could not reach Stash stream endpoint"}), 502

    response_headers = {
        k: v for k, v in upstream.headers.items()
        if k in _FORWARD_RESPONSE_HEADERS
    }
    response_headers.setdefault("Accept-Ranges", "bytes")

    def generate():
        try:
            for chunk in upstream.iter_content(chunk_size=STREAM_CHUNK_SIZE):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return Response(
        stream_with_context(generate()),
        status=upstream.status_code,
        headers=response_headers,
    )


@app.get("/screenshot/<scene_id>")
def screenshot_proxy(scene_id: str):
    token_id = _extract_token()
    if not _validate_token(token_id):
        abort(401, description="Invalid or missing device token.")

    screenshot_url = f"{STASH_BASE}/scene/{scene_id}/screenshot"
    upstream_headers = {}
    api_key = _read_stash_api_key()
    if api_key:
        upstream_headers["ApiKey"] = api_key

    t = request.args.get("t")
    if t:
        screenshot_url += f"?t={t}"

    max_w = request.args.get("width", type=int)

    try:
        upstream = requests.get(
            screenshot_url,
            headers=upstream_headers,
            stream=not max_w,
            timeout=(5, 30),
        )
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "Could not reach Stash screenshot endpoint"}), 502

    if max_w and upstream.status_code == 200 and HAS_PILLOW:
        try:
            import io as _io
            img = Image.open(_io.BytesIO(upstream.content))
            if img.width > max_w:
                ratio  = max_w / img.width
                new_h  = int(img.height * ratio)
                img    = img.resize((max_w, new_h), Image.LANCZOS)
            buf = _io.BytesIO()
            img.save(buf, format="JPEG", quality=85)
            buf.seek(0)
            data = buf.read()
            return Response(
                data,
                status=200,
                headers={
                    "Content-Type":   "image/jpeg",
                    "Content-Length": str(len(data)),
                    "Cache-Control":  upstream.headers.get("Cache-Control", "max-age=3600"),
                },
            )
        except Exception as exc:
            log.warning("Resize failed for scene %s: %s — sending original", scene_id, exc)

    _SCREENSHOT_FORWARD_HEADERS = {
        "Content-Type", "Content-Length", "Cache-Control",
        "Last-Modified", "ETag",
    }
    response_headers = {
        k: v for k, v in upstream.headers.items()
        if k in _SCREENSHOT_FORWARD_HEADERS
    }

    def generate():
        try:
            for chunk in upstream.iter_content(chunk_size=STREAM_CHUNK_SIZE):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return Response(
        stream_with_context(generate()),
        status=upstream.status_code,
        headers=response_headers,
    )

@app.get("/preview/<scene_id>")
def preview_proxy(scene_id: str):
    token_id = _extract_token()
    if not _validate_token(token_id):
        abort(401, description="Invalid or missing device token.")

    preview_url = _get_scene_preview_url(scene_id)
    if preview_url is None:
        # 404 without a body so the client can quietly fall back to the still
        return ("", 404)

    upstream_headers = {}
    if "Range" in request.headers:
        upstream_headers["Range"] = request.headers["Range"]
    api_key = _read_stash_api_key()
    if api_key:
        upstream_headers["ApiKey"] = api_key

    try:
        upstream = requests.get(
            preview_url,
            headers=upstream_headers,
            stream=True,
            timeout=(5, None),
        )
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "Could not reach Stash preview endpoint"}), 502

    response_headers = {
        k: v for k, v in upstream.headers.items()
        if k in _FORWARD_RESPONSE_HEADERS
    }
    response_headers.setdefault("Accept-Ranges", "bytes")
    # Previews are immutable per scene/regen — let the client cache aggressively
    response_headers.setdefault("Cache-Control", "max-age=86400")

    def generate():
        try:
            for chunk in upstream.iter_content(chunk_size=STREAM_CHUNK_SIZE):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return Response(
        stream_with_context(generate()),
        status=upstream.status_code,
        headers=response_headers,
    )

# ---------------------------------------------------------------------------
# PID management
# ---------------------------------------------------------------------------

def _write_pid() -> None:
    PID_FILE.write_text(str(os.getpid()))


def _remove_pid() -> None:
    PID_FILE.unlink(missing_ok=True)


def _pid_is_running(pid: int) -> bool:
    if sys.platform == "win32":
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

def _check_already_running() -> bool:
    if not PID_FILE.exists():
        return False
    try:
        pid = int(PID_FILE.read_text().strip())
    except ValueError:
        PID_FILE.unlink(missing_ok=True)
        return False
    if pid == os.getpid():
        return False
    if not _pid_is_running(pid):
        PID_FILE.unlink(missing_ok=True)
        return False
    return True

# ---------------------------------------------------------------------------
# Config from Stash's stdin JSON
# ---------------------------------------------------------------------------

def _get_port(stash_input: dict) -> int:
    try:
        return int(
            stash_input.get("args", {})
            .get("settings", {})
            .get("sidecar_port", DEFAULT_PORT)
        )
    except (TypeError, ValueError):
        return DEFAULT_PORT


def _get_stash_base(stash_input: dict) -> str:
    conn = stash_input.get("server_connection", {})
    scheme = conn.get("Scheme", "http")
    host   = conn.get("Host", "0.0.0.0")
    port   = conn.get("Port", 9999)
    if host in ("0.0.0.0", ""):
        host = "localhost"
    return f"{scheme}://{host}:{port}"


def _spawn_detached_child(stash_input: dict) -> None:
    """
    Re-launch this script as a fully detached background process that will
    outlive the current (Stash-invoked) process, on both Windows and Unix.
    The original stdin JSON from Stash is handed off via a temp file, since
    a freshly spawned subprocess can't read the parent's already-consumed stdin.
    """
    config_file = Path(tempfile.gettempdir()) / f"mrstash_sidecar_input_{os.getpid()}_{uuid.uuid4().hex[:8]}.json"
    config_file.write_text(json.dumps(stash_input))

    cmd = [sys.executable, str(Path(__file__).resolve()), "--child", "--config-file", str(config_file)]
    kwargs = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if sys.platform == "win32":
        DETACHED_PROCESS = 0x00000008
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        kwargs["creationflags"] = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True  # equivalent of setsid — detaches from controlling terminal

    subprocess.Popen(cmd, **kwargs)

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    global STASH_BASE, STASH_GRAPHQL_URL, ADMIN_SECRET, devices

    is_child = "--child" in sys.argv

    if is_child:
        # This is the detached background process — read the config that
        # the parent invocation cached for us, since our own stdin is empty.
        stash_input = {}
        try:
            idx = sys.argv.index("--config-file")
            config_path = Path(sys.argv[idx + 1])
            stash_input = json.loads(config_path.read_text())
        except Exception as exc:
            log.warning("Could not read cached config: %s", exc)
        finally:
            try:
                config_path.unlink(missing_ok=True)
            except Exception:
                pass

        # We have no console once detached — log to file instead.
        file_handler = logging.FileHandler(LOG_FILE)
        file_handler.setFormatter(logging.Formatter(
            "[MRStashDeviceAuth] %(asctime)s %(levelname)s %(message)s",
            "%Y-%m-%d %H:%M:%S",
        ))
        log.addHandler(file_handler)
    else:
        # Initial invocation from Stash: read the one-shot JSON config off stdin.
        try:
            stash_input_fd = sys.stdin.fileno()
            raw = os.read(stash_input_fd, 65536)
            stash_input = json.loads(raw) if raw.strip() else {}
        except Exception:
            stash_input = {}
        finally:
            devnull = open(os.devnull, 'r')
            os.dup2(devnull.fileno(), 0)
            sys.stdin = devnull

        if _check_already_running():
            log.info("Sidecar already running (PID %s). Exiting.",
                      PID_FILE.read_text().strip())
            sys.exit(0)

        log.info("Spawning detached sidecar process…")
        _spawn_detached_child(stash_input)
        log.info("Detached process launched — this task invocation is done.")
        sys.exit(0)

    # --- Everything below this point runs only inside the detached child ---

    STASH_BASE = _get_stash_base(stash_input)
    STASH_GRAPHQL_URL = f"{STASH_BASE}/graphql"
    log.info("Stash internal URL: %s", STASH_BASE)

    ADMIN_SECRET = _load_or_create_admin_secret()
    log.info("Admin secret loaded (len=%d)", len(ADMIN_SECRET))

    devices = _load_devices()

    port = _get_port(stash_input)
    log.info("Starting MRStashDeviceAuth sidecar on :%d (PID %d)", port, os.getpid())

    _write_pid()
    atexit.register(_remove_pid)

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: sys.exit(0))

    try:
        from werkzeug.serving import make_server
        server = make_server("0.0.0.0", port, app, threaded=True)
        log.info("Sidecar listening on %s:%d", *server.server_address)
        server.serve_forever()
    except OSError as exc:
        log.error("FAILED to bind port %d: %s", port, exc)
        raise
    except BaseException as exc:
        log.error("Unexpected error starting Flask: %s", exc, exc_info=True)
        raise

if __name__ == "__main__":
    main()