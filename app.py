# -*- coding: utf-8 -*-
"""拾光 · 本地生图工作台

运行:  python app.py  → 自动打开 http://127.0.0.1:7860
依赖:  flask  (pip install -r requirements.txt)
配置:  config.json（名称 / 主题 / 中转站列表），页面里可改
"""
import base64
import json
import mimetypes
import ssl
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

APP_VERSION = "1.0.1"
APP_AUTHOR = "lmz-666-lmz"

# One source of truth for the parameter contract used by the UI and the
# upstream request filter.  Unknown models intentionally use the generic
# compatible profile instead of being rejected.
MODEL_CAPABILITIES = {
    "gpt-image": {
        "family": "GPT Image", "text_to_image": True, "image_to_image": True,
        "supported_sizes": ["1024x1024", "1536x1024", "1024x1536"],
        "quality": True, "background": True, "style": False, "n": True,
    },
    "dall-e": {
        "family": "DALL-E", "text_to_image": True, "image_to_image": False,
        "supported_sizes": ["1024x1024", "1536x1024", "1024x1536"],
        "quality": True, "background": False, "style": True, "n": True,
    },
    "nano-banana": {
        "family": "Nano Banana", "text_to_image": True, "image_to_image": True,
        "supported_sizes": ["1024x1024", "1536x1024", "1024x1536"],
        "quality": False, "background": False, "style": False, "n": True,
    },
    "banana": {
        "family": "Nano Banana", "text_to_image": True, "image_to_image": True,
        "supported_sizes": ["1024x1024", "1536x1024", "1024x1536"],
        "quality": False, "background": False, "style": False, "n": True,
    },
    "gemini image": {
        "family": "Gemini Image", "text_to_image": True, "image_to_image": True,
        "supported_sizes": ["1024x1024", "1536x1024", "1024x1536"],
        "quality": False, "background": False, "style": False, "n": True,
    },
    "seedream": {
        "family": "Seedream", "text_to_image": True, "image_to_image": True,
        "supported_sizes": ["1024x1024", "1536x1024", "1024x1536"],
        "quality": False, "background": False, "style": False, "n": True,
    },
    "flux": {
        "family": "FLUX", "text_to_image": True, "image_to_image": True,
        "supported_sizes": ["1024x1024", "1536x1024", "1024x1536"],
        "quality": False, "background": False, "style": False, "n": True,
    },
    "grok image": {
        "family": "Grok Image", "text_to_image": True, "image_to_image": True,
        "supported_sizes": ["1024x1024", "1536x1024", "1024x1536"],
        "quality": False, "background": False, "style": False, "n": True,
    },
    "image": {
        "family": "Image Compatible", "text_to_image": True, "image_to_image": True,
        "supported_sizes": ["1024x1024", "1536x1024", "1024x1536"],
        "quality": False, "background": False, "style": False, "n": True,
    },
    "generic": {
        "family": "Generic OpenAI Compatible", "text_to_image": True, "image_to_image": True,
        "supported_sizes": ["1024x1024", "1536x1024", "1024x1536"],
        "quality": False, "background": False, "style": False, "n": True,
    },
}

CAPABILITY_MATCHERS = (
    ("gpt-image", "gpt-image"), ("dall-e", "dall-e"), ("nano-banana", "nano-banana"),
    ("banana", "banana"), ("gemini image", "gemini"), ("seedream", "seedream"),
    ("flux", "flux"), ("grok image", "grok image"), ("image", "image"),
)

HEALTH_TTL = 45
HEALTH_STATES = ("unchecked", "healthy", "slow", "rate_limited", "unavailable")
MAX_REFERENCE_BYTES = 10 * 1024 * 1024
REFERENCE_MIMES = {"image/png", "image/jpeg", "image/webp"}

BASE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = BASE_DIR / "outputs"
OUTPUT_DIR.mkdir(exist_ok=True)
CONFIG_PATH = BASE_DIR / "config.json"

DEFAULT_CONFIG = {
    "name": "拾光",
    "theme": "darkroom",
    "providers": [],
    "active_provider": "",
    "failover_enabled": False,
}
THEMES = ("darkroom", "ink", "paper")


def _new_id() -> str:
    return f"provider_{uuid.uuid4().hex[:8]}"


def capability_for(model: str | None) -> dict:
    """Match aliases/substrings so relay-renamed model ids still adapt."""
    name = (model or "").strip().lower()
    for key, matcher in CAPABILITY_MATCHERS:
        if matcher in name:
            return {**MODEL_CAPABILITIES[key], "key": key}
    return {**MODEL_CAPABILITIES["generic"], "key": "generic"}


def public_provider(provider: dict) -> dict:
    """Never send API keys to the browser or include them in health payloads."""
    return {
        "id": provider.get("id", ""), "name": provider.get("name", ""),
        "api_base": provider.get("api_base", ""), "models": list(provider.get("models") or []),
        "health": dict(provider.get("health") or {"status": "unchecked"}),
        "has_key": bool(provider.get("api_key")),
    }


def save_config_dict(cfg: dict):
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def _migrate(cfg: dict) -> bool:
    """旧版单 api_base/api_key 自动迁移为 providers 列表。返回是否有改动。"""
    changed = False
    providers = cfg.get("providers")
    if not isinstance(providers, list):
        cfg["providers"] = []
        changed = True
    if not cfg["providers"] and (cfg.get("api_base") or cfg.get("api_key")):
        cfg["providers"].append({
            "id": _new_id(),
            "name": "默认中转",
            "api_base": cfg.get("api_base") or "",
            "api_key": cfg.get("api_key") or "",
            "models": [],
        })
        changed = True
    for p in cfg["providers"]:
        if not p.get("id"):
            p["id"] = _new_id()
            changed = True
        for field, default in (("name", "未命名中转"), ("api_base", ""), ("api_key", ""), ("models", []),
                               ("health", {"status": "unchecked"})):
            if field not in p:
                p[field] = default
                changed = True
        if not isinstance(p.get("health"), dict):
            p["health"] = {"status": "unchecked"}
            changed = True
        p["health"].setdefault("status", "unchecked")
    ids = {p["id"] for p in cfg["providers"]}
    if cfg.get("active_provider") not in ids:
        cfg["active_provider"] = cfg["providers"][0]["id"] if cfg["providers"] else ""
        changed = True
    for legacy in ("api_base", "api_key"):
        if legacy in cfg:
            del cfg[legacy]
            changed = True
    if "failover_enabled" not in cfg:
        cfg["failover_enabled"] = False
        changed = True
    return changed


def save_config():
    save_config_dict(config)


def _load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    before = None
    if CONFIG_PATH.exists():
        raw_text = None
        try:
            raw_text = CONFIG_PATH.read_text(encoding="utf-8")
            before = json.loads(raw_text)
            cfg.update(before)
        except Exception:
            pass  # 配置文件损坏时回退默认
    if _migrate(cfg) or before is None:
        save_config_dict(cfg)
    return cfg


config = _load_config()


def active_provider() -> dict | None:
    pid = config.get("active_provider")
    for p in config["providers"]:
        if p["id"] == pid:
            return p
    return config["providers"][0] if config["providers"] else None


app = Flask(__name__, static_folder="static", static_url_path="/static")


tls_note = None  # 本请求内若跳过了证书校验，记录提示语


def _fetch(req: urllib.request.Request, timeout: int):
    """发起请求。证书校验失败时（过期/自签名的小站很常见）自动跳过重试。返回 (字节, Content-Type)。"""
    global tls_note
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read(), resp.headers.get("Content-Type", "")
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", None)
        is_cert_err = isinstance(reason, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(reason)
        if not is_cert_err:
            raise
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        tls_note = "该中转站的 HTTPS 证书已过期或无效，已自动跳过证书校验；密钥仍按原样发送，请注意风险"
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return resp.read(), resp.headers.get("Content-Type", "")


def upstream(path: str, payload: dict | None = None, timeout: int = 300,
             base: str | None = None, key: str | None = None):
    """请求中转站 API。"""
    global tls_note
    tls_note = None
    prov = active_provider() or {}
    base = (base if base is not None else prov.get("api_base", "")).rstrip("/")
    if base.endswith("/v1"):  # 兼容用户粘贴带 /v1 的地址，避免拼出 /v1/v1
        base = base[:-3]
    key = key if key is not None else prov.get("api_key", "")
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",  # 上游会 403 python-urllib 默认 UA
    }
    req = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers,
        method="POST" if payload is not None else "GET",
    )
    data, _ = _fetch(req, timeout)
    return json.loads(data)



def with_tls_note(payload: dict) -> dict:
    if tls_note:
        payload["warning"] = tls_note
    return payload

def friendly_error(e: Exception) -> str:
    """把上游异常翻译成可操作的中文提示。"""
    if isinstance(e, urllib.error.HTTPError):
        head = {
            401: "API Key 无效或已过期，请检查密钥是否填对",
            403: "没有访问权限（HTTP 403），请确认密钥可用或切换其他中转站",
            404: "接口不存在（HTTP 404），请检查中转站地址是否正确",
            429: "请求太频繁或额度不足（HTTP 429），请稍后再试",
        }.get(e.code, f"当前中转站不可用（HTTP {e.code}），请稍后重试或切换其他服务")
        return head
    if isinstance(e, urllib.error.URLError):
        reason = getattr(e, "reason", e)
        if isinstance(reason, TimeoutError):
            return "连接中转站超时，请检查网络后重试"
        return f"无法连接到中转站，请检查 API 地址与网络（{reason}）"
    if isinstance(e, TimeoutError):
        return "请求超时，模型可能正忙，请稍后再试或换个模型"
    return f"生成失败：{e}"


def error_status(e: Exception) -> str:
    if isinstance(e, urllib.error.HTTPError):
        if e.code == 429:
            return "rate_limited"
        if e.code in (502, 503, 504):
            return "unavailable"
        return "unavailable"
    if isinstance(e, urllib.error.URLError):
        reason = getattr(e, "reason", None)
        if isinstance(reason, TimeoutError) or "timed out" in str(reason).lower():
            return "slow"
        return "unavailable"
    if isinstance(e, TimeoutError):
        return "slow"
    return "unavailable"


def is_safe_failover_error(e: Exception) -> bool:
    """Only retry errors that prove the request did not complete upstream."""
    if isinstance(e, urllib.error.HTTPError):
        return e.code in (429, 502, 503, 504)
    if isinstance(e, urllib.error.URLError):
        reason = getattr(e, "reason", None)
        return not isinstance(reason, TimeoutError) and "timed out" not in str(reason).lower()
    return False


def set_health(prov: dict, status: str, latency_ms: int | None = None, error: str | None = None):
    record = {"status": status, "checked_at": int(time.time())}
    if latency_ms is not None:
        record["latency_ms"] = latency_ms
    if error:
        record["error"] = error
    prov["health"] = record
    save_config()


def check_provider_health(prov: dict, force: bool = False) -> dict:
    if not prov or not prov.get("api_base") or not prov.get("api_key"):
        return {"status": "unavailable", "error": "未配置地址或密钥"}
    existing = prov.get("health") or {}
    if not force and existing.get("checked_at") and time.time() - existing["checked_at"] < HEALTH_TTL:
        return existing
    started = time.perf_counter()
    try:
        upstream("/v1/models", base=prov["api_base"], key=prov["api_key"], timeout=20)
        latency = round((time.perf_counter() - started) * 1000)
        status = "slow" if latency >= 1500 else "healthy"
        set_health(prov, status, latency)
    except Exception as e:
        status = "rate_limited" if isinstance(e, urllib.error.HTTPError) and e.code == 429 else "unavailable"
        set_health(prov, status, round((time.perf_counter() - started) * 1000), friendly_error(e))
    return prov.get("health") or {"status": "unavailable"}


@app.get("/")
def index():
    return send_from_directory("static", "index.html")



# ---------- 设置 ----------
def settings_payload():
    return {
        "name": config["name"],
        "theme": config["theme"],
        "providers": [public_provider(p) for p in config["providers"]],
        "active_provider": config["active_provider"],
        "failover_enabled": bool(config.get("failover_enabled", False)),
        "version": APP_VERSION,
        "author": APP_AUTHOR,
    }


@app.get("/api/settings")
def get_settings():
    return jsonify(settings_payload())


@app.post("/api/settings")
def set_settings():
    """部分更新：只改请求里出现的字段。主题点击即存，名称单独保存。"""
    body = request.get_json(force=True)
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "名称不能为空"}), 400
        config["name"] = name
    if "theme" in body:
        if body["theme"] not in THEMES:
            return jsonify({"error": "未知主题"}), 400
        config["theme"] = body["theme"]
    if "failover_enabled" in body:
        config["failover_enabled"] = bool(body["failover_enabled"])
    save_config()
    return jsonify(settings_payload())


# ---------- 中转站管理 ----------
def _validate_provider_body(body: dict):
    name = (body.get("name") or "").strip()
    api_base = (body.get("api_base") or "").strip().rstrip("/")
    api_key = (body.get("api_key") or "").strip()
    if not name:
        return None, "名称不能为空"
    if not api_base.startswith(("http://", "https://")):
        return None, "API 地址需以 http:// 或 https:// 开头"
    if not api_key:
        return None, "密钥不能为空"
    return {"name": name, "api_base": api_base, "api_key": api_key}, None


@app.post("/api/providers")
def upsert_provider():
    """新增或编辑中转站；新增后自动启用。地址/密钥变更时清空已缓存模型。"""
    body = request.get_json(force=True)
    fields, err = _validate_provider_body(body)
    if err:
        # Editing an existing provider may leave the key blank to keep it.
        pid = (body.get("id") or "").strip()
        if not pid or body.get("api_key", "").strip():
            return jsonify({"error": err}), 400
        target = next((p for p in config["providers"] if p["id"] == pid), None)
        if not target:
            return jsonify({"error": err}), 400
        name = (body.get("name") or "").strip()
        api_base = (body.get("api_base") or "").strip().rstrip("/")
        if not name or not api_base.startswith(("http://", "https://")):
            return jsonify({"error": err}), 400
        fields = {"name": name, "api_base": api_base, "api_key": target.get("api_key", "")}
    pid = (body.get("id") or "").strip()
    if pid:
        target = next((p for p in config["providers"] if p["id"] == pid), None)
        if not target:
            return jsonify({"error": "中转站不存在"}), 404
        if target["api_base"] != fields["api_base"] or target["api_key"] != fields["api_key"]:
            target["models"] = []
            drop_models_cache(target["api_base"], target["api_key"])
            target["health"] = {"status": "unchecked"}
        target.update(fields)
    else:
        entry = {"id": _new_id(), **fields, "models": []}
        config["providers"].append(entry)
        config["active_provider"] = entry["id"]
    save_config()
    return jsonify(settings_payload())


@app.post("/api/providers/delete")
def delete_provider():
    pid = (request.get_json(force=True).get("id") or "").strip()
    idx = next((i for i, p in enumerate(config["providers"]) if p["id"] == pid), -1)
    if idx < 0:
        return jsonify({"error": "中转站不存在"}), 404
    removed = config["providers"].pop(idx)
    drop_models_cache(removed["api_base"], removed["api_key"])
    if config["active_provider"] == pid:
        config["active_provider"] = config["providers"][0]["id"] if config["providers"] else ""
    save_config()
    return jsonify(settings_payload())


@app.post("/api/providers/activate")
def activate_provider():
    """切换中转站并尽力刷新其模型列表；失败时回退该站缓存的模型。"""
    pid = (request.get_json(force=True).get("id") or "").strip()
    if not any(p["id"] == pid for p in config["providers"]):
        return jsonify({"error": "中转站不存在"}), 404
    config["active_provider"] = pid
    save_config()
    models, error = fetch_models_for(active_provider())
    payload = settings_payload()
    payload.update({"models": models})
    if error:
        payload["warning"] = error
    return jsonify(with_tls_note(payload))


# ---------- 模型 ----------
_models_cache = {"key": None, "models": [], "ts": 0.0}


def drop_models_cache(base: str, key: str):
    if _models_cache["key"] == ((base or "").rstrip("/"), key or ""):
        _models_cache.update({"key": None, "models": [], "ts": 0.0})


def fetch_models_for(prov: dict | None):
    """返回 (models, error)。成功时把结果持久化到该中转站；失败时回退其缓存。"""
    if not prov or not prov["api_base"] or not prov["api_key"]:
        return [], "请先填写 API 地址和密钥"
    now = time.time()
    cache_key = (prov["api_base"], prov["api_key"])
    if _models_cache["key"] == cache_key and now - _models_cache["ts"] < 600:
        return _models_cache["models"], None
    try:
        ids = [m["id"] for m in upstream("/v1/models", base=prov["api_base"], key=prov["api_key"], timeout=20).get("data", [])]
        kw = ("image", "banana", "seedream", "kling", "dall", "flux")
        result = sorted(i for i in ids if any(k in i.lower() for k in kw))
        _models_cache.update({"key": cache_key, "models": result, "ts": now})
        if result != prov.get("models"):
            prov["models"] = result
            save_config()
        return result, None
    except Exception as e:
        # 上游抖动时回退持久化的模型列表，避免页面列表突然清空
        if prov.get("models"):
            return list(prov["models"]), friendly_error(e)
        return [], friendly_error(e)


@app.get("/api/models")
def models():
    result, error = fetch_models_for(active_provider())
    if error and not result:
        return jsonify({"error": error}), 502
    payload = {"models": result}
    if error:
        payload["warning"] = error
    return jsonify(with_tls_note(payload))


@app.post("/api/test")
def test_conn():
    """测试连接：优先用请求里的地址/密钥（表单值，不必先保存），也可指定 provider_id。"""
    body = request.get_json(silent=True) or {}
    base = (body.get("api_base") or "").strip().rstrip("/")
    key = (body.get("api_key") or "").strip()
    pid = (body.get("provider_id") or "").strip()
    prov = None
    if pid:
        prov = next((p for p in config["providers"] if p["id"] == pid), None)
        if not prov:
            return jsonify({"ok": False, "error": "中转站不存在"})
    elif not base and not key:
        prov = active_provider()  # 空参 = 测试当前使用中的中转站
    if prov:
        base, key = prov["api_base"], prov["api_key"]
    if not base.startswith(("http://", "https://")):
        return jsonify({"ok": False, "error": "请先填写 API 地址"})
    if not key:
        return jsonify({"ok": False, "error": "请先填写密钥"})
    try:
        data = upstream("/v1/models", base=base, key=key, timeout=20)
        return jsonify(with_tls_note({"ok": True, "models": len(data.get("data", []))}))
    except Exception as e:
        return jsonify({"ok": False, "error": friendly_error(e)})


@app.post("/api/providers/health")
def provider_health():
    """Cheap /v1/models probe; cached for HEALTH_TTL seconds and never generates."""
    body = request.get_json(silent=True) or {}
    pid = (body.get("provider_id") or "").strip()
    targets = config["providers"] if not pid else [p for p in config["providers"] if p["id"] == pid]
    if pid and not targets:
        return jsonify({"error": "中转站不存在"}), 404
    force = bool(body.get("force"))
    statuses = [dict(check_provider_health(p, force=force), provider_id=p["id"], provider_name=p["name"])
                for p in targets]
    return jsonify({"providers": statuses, "settings": settings_payload()})


@app.get("/api/capabilities")
def capabilities():
    return jsonify({"capabilities": MODEL_CAPABILITIES, "matchers": CAPABILITY_MATCHERS})


# ---------- 生成 ----------
def upstream_multipart(path: str, fields: dict, file_field: str, filename: str,
                       blob: bytes, mime: str, timeout: int = 300,
                       base: str | None = None, key: str | None = None):
    """Small stdlib-only multipart encoder for OpenAI-compatible image edits."""
    global tls_note
    tls_note = None
    prov = active_provider() or {}
    base = (base if base is not None else prov.get("api_base", "")).rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    key = key if key is not None else prov.get("api_key", "")
    boundary = f"----ImageStudio{uuid.uuid4().hex}"
    chunks = []
    for name, value in fields.items():
        chunks.extend([f"--{boundary}\r\n".encode(),
                       f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                       str(value).encode(), b"\r\n"])
    chunks.extend([f"--{boundary}\r\n".encode(),
                   f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'.encode(),
                   f"Content-Type: {mime}\r\n\r\n".encode(), blob, b"\r\n",
                   f"--{boundary}--\r\n".encode()])
    req = urllib.request.Request(
        f"{base}{path}", data=b"".join(chunks), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": f"multipart/form-data; boundary={boundary}",
                 "User-Agent": "Mozilla/5.0"},
    )
    data, _ = _fetch(req, timeout)
    return json.loads(data)


def _ext_from(content_type: str, url: str) -> str:
    ct = (content_type or "").lower()
    if "png" in ct: return ".png"
    if "jpeg" in ct or "jpg" in ct: return ".jpg"
    if "webp" in ct: return ".webp"
    low = url.lower().split("?")[0]
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        if low.endswith(ext): return ext
    return ".png"


def _persist_image_results(data: dict, payload: dict, prov: dict, elapsed: float,
                           extra_meta: dict | None = None):
    items = data.get("data") or []
    if not items:
        raise ValueError("上游未返回图片")
    extra_meta = extra_meta or {}
    results = []
    for i, item in enumerate(items):
        meta = {"model": payload["model"], "provider": prov["name"], "provider_id": prov["id"],
                "elapsed": elapsed, "prompt": payload["prompt"], "size": payload.get("size", ""),
                "created": int(time.time()), "created_time": time.strftime("%Y-%m-%d %H:%M:%S"),
                "mode": extra_meta.get("mode", "text-to-image"),
                "reference_used": bool(extra_meta.get("reference_used", False)),
                "reference_name": extra_meta.get("reference_name", ""),
                "failover": bool(extra_meta.get("failover", False)),
                "failover_from": extra_meta.get("failover_from", "")}
        if item.get("b64_json"):
            name = f"{time.strftime('%Y%m%d_%H%M%S')}_{i}.webp"
            blob = base64.b64decode(item["b64_json"])
            (OUTPUT_DIR / name).write_bytes(blob)
            (OUTPUT_DIR / f"{name}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
            results.append({"url": f"/outputs/{name}", "name": name, **meta})
        elif item.get("url"):
            req = urllib.request.Request(item["url"], headers={"User-Agent": "Mozilla/5.0"})
            try:
                blob, ct = _fetch(req, 120)
                name = f"{time.strftime('%Y%m%d_%H%M%S')}_{i}{_ext_from(ct, item['url'])}"
                (OUTPUT_DIR / name).write_bytes(blob)
                (OUTPUT_DIR / f"{name}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
                results.append({"url": f"/outputs/{name}", "name": name, **meta})
            except Exception as e:
                results.append({"url": item["url"], "name": None, "fetch_error": friendly_error(e)})
    return results


def _filtered_payload(body: dict, model: str, cap: dict) -> dict:
    payload = {"model": model, "prompt": (body.get("prompt") or "").strip()}
    if cap.get("supported_sizes") and body.get("size") in cap["supported_sizes"]:
        payload["size"] = body["size"]
    else:
        payload["size"] = cap.get("supported_sizes", ["1024x1024"])[0]
    if cap.get("n"):
        try:
            payload["n"] = min(4, max(1, int(body.get("n", 1))))
        except (TypeError, ValueError):
            payload["n"] = 1
    for key in ("quality", "background", "style"):
        if cap.get(key) and body.get(key):
            payload[key] = body[key]
    return payload


def _reference_file():
    image = request.files.get("image")
    if not image or not image.filename:
        return None, "请选择参考图"
    mime = (image.mimetype or mimetypes.guess_type(image.filename)[0] or "").lower()
    if mime not in REFERENCE_MIMES:
        return None, "参考图仅支持 PNG、JPEG 或 WEBP"
    blob = image.read(MAX_REFERENCE_BYTES + 1)
    if not blob:
        return None, "参考图为空"
    if len(blob) > MAX_REFERENCE_BYTES:
        return None, "参考图过大，请控制在 10MB 以内"
    return (image.filename, mime, blob), None


def _providers_for_model(model: str, primary: dict):
    return [p for p in config["providers"] if p["id"] != primary["id"] and model in (p.get("models") or [])]


@app.post("/api/generate")
def generate():
    prov = active_provider()
    if not prov or not prov.get("api_base") or not prov.get("api_key"):
        return jsonify({"error": "还没有可用的中转站，请在设置里添加并填写地址和密钥"}), 400
    is_multipart = request.mimetype == "multipart/form-data"
    body = request.form.to_dict() if is_multipart else (request.get_json(silent=True) or {})
    prompt = (body.get("prompt") or "").strip()
    model = (body.get("model") or "fal-gpt-image-2").strip()
    if not prompt:
        return jsonify({"error": "提示词不能为空"}), 400
    cap = capability_for(model)
    reference = None
    if is_multipart:
        reference, error = _reference_file()
        if error:
            return jsonify({"error": error}), 400
        if not cap.get("image_to_image"):
            return jsonify({"error": "当前模型暂未声明参考图能力"}), 400
    payload = _filtered_payload(body, model, cap)
    mode = "image-to-image" if reference else "text-to-image"
    path = "/v1/images/edits" if reference else "/v1/images/generations"

    def call(target):
        if reference:
            return upstream_multipart(path, payload, "image", reference[0], reference[2], reference[1],
                                       base=target["api_base"], key=target["api_key"])
        return upstream(path, payload, base=target["api_base"], key=target["api_key"])

    failover = False
    failover_from = ""
    started = time.time()
    try:
        data = call(prov)
        set_health(prov, "healthy", round((time.time() - started) * 1000))
    except Exception as primary_error:
        set_health(prov, error_status(primary_error), round((time.time() - started) * 1000), friendly_error(primary_error))
        if not config.get("failover_enabled") or not is_safe_failover_error(primary_error):
            return jsonify({"error": friendly_error(primary_error)}), 502
        candidates = _providers_for_model(model, prov)
        if not candidates:
            return jsonify({"error": f"主中转站失败，备用站没有同名模型（{model}）"}), 502
        backup = candidates[0]  # at most one fallback request
        try:
            started = time.time()
            data = call(backup)
            set_health(backup, "healthy", round((time.time() - started) * 1000))
            failover, failover_from = True, prov["name"]
            config["active_provider"] = backup["id"]
            save_config()
            prov = backup
        except Exception as backup_error:
            set_health(backup, error_status(backup_error), round((time.time() - started) * 1000), friendly_error(backup_error))
            return jsonify({"error": f"主线路与备用线路均不可用：{friendly_error(backup_error)}"}), 502

    elapsed = round(time.time() - started, 1)
    try:
        images = _persist_image_results(data, payload, prov, elapsed, {
            "mode": mode, "reference_used": bool(reference),
            "reference_name": reference[0] if reference else "",
            "failover": failover, "failover_from": failover_from,
        })
    except ValueError as e:
        return jsonify({"error": str(e)}), 502
    response = {"images": images, "elapsed": elapsed, "model": model, "prompt": prompt,
                "provider": prov["name"], "provider_id": prov["id"], "mode": mode,
                "failover": failover, "failover_from": failover_from}
    if failover:
        response["notice"] = f"主线路「{failover_from}」暂时不可用，已通过「{prov['name']}」完成生成"
    return jsonify(with_tls_note(response))


# ---------- 历史与筛选 ----------
_RANGE_SPANS = {"today": 86400, "week": 7 * 86400}


def _read_meta(p: Path) -> dict:
    sidecar = p.with_name(p.name + ".json")
    if sidecar.exists():
        try:
            return json.loads(sidecar.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


@app.get("/api/history")
def history():
    page = max(1, request.args.get("page", 1, type=int))
    page_size = min(48, max(1, request.args.get("page_size", 12, type=int)))
    q = (request.args.get("q") or "").strip().lower()
    model_kw = (request.args.get("model") or "").strip().lower()
    provider_name = (request.args.get("provider") or "").strip()
    rng = request.args.get("range") or "all"
    sort = request.args.get("sort") or "newest"
    now = time.time()

    entries = []
    model_facets, provider_facets = set(), set()
    files = sorted(
        (p for pat in ("*.webp", "*.png", "*.jpg", "*.jpeg", "*.gif") for p in OUTPUT_DIR.glob(pat)),
        key=lambda p: p.name, reverse=True,
    )
    for p in files:
        try:
            mtime = p.stat().st_mtime
        except OSError:
            continue
        meta = _read_meta(p)
        created = float(meta.get("created") or mtime)
        m, pv = meta.get("model", ""), meta.get("provider", "")
        if m:
            model_facets.add(m)
        if pv:
            provider_facets.add(pv)
        if q and q not in meta.get("prompt", "").lower():
            continue
        if model_kw and model_kw not in m.lower():
            continue
        if provider_name and pv != provider_name:
            continue
        if rng in _RANGE_SPANS and now - created > _RANGE_SPANS[rng]:
            continue
        entries.append((p, meta))

    if sort == "fastest":
        entries.sort(key=lambda e: (e[1].get("elapsed") is None, e[1].get("elapsed") or 0))
    elif sort == "model":
        entries.sort(key=lambda e: e[1].get("model", ""))
    else:
        entries.sort(key=lambda e: e[0].name, reverse=True)

    total = len(entries)
    pages = max(1, -(-total // page_size))
    page = min(page, pages)

    items = []
    for p, meta in entries[(page - 1) * page_size : page * page_size]:
        try:
            mtime = p.stat().st_mtime
        except OSError:
            continue  # 扫描间隙被删除的文件直接跳过，不让整页 500
        items.append({
            "name": p.name,
            "url": f"/outputs/{p.name}",
            "mtime": mtime,
            "model": meta.get("model", ""),
            "provider": meta.get("provider", ""),
            "provider_id": meta.get("provider_id", ""),
            "elapsed": meta.get("elapsed"),
            "prompt": meta.get("prompt", ""),
            "size": meta.get("size", ""),
            "mode": meta.get("mode", "text-to-image"),
            "reference_used": bool(meta.get("reference_used", False)),
            "reference_name": meta.get("reference_name", ""),
            "failover": bool(meta.get("failover", False)),
            "failover_from": meta.get("failover_from", ""),
            "created_time": meta.get("created_time", time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(mtime))),
        })
    return jsonify({
        "items": items, "page": page, "pages": pages, "total": total,
        "facets": {"models": sorted(model_facets), "providers": sorted(provider_facets)},
    })


@app.post("/api/delete")
def delete():
    name = (request.get_json(force=True).get("name") or "").strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        return jsonify({"error": "无效文件名"}), 400
    for suffix in ("", ".json"):
        f = OUTPUT_DIR / (name + suffix)
        if f.exists():
            f.unlink()
    return jsonify({"ok": True})


@app.get("/outputs/<path:name>")
def outputs(name):
    return send_from_directory(OUTPUT_DIR, name)


if __name__ == "__main__":
    import threading
    import webbrowser

    threading.Timer(1.0, lambda: webbrowser.open("http://127.0.0.1:7860")).start()
    print(f"「{config['name']}」运行中: http://127.0.0.1:7860  (Ctrl+C 退出)")
    app.run(host="127.0.0.1", port=7860, debug=False)
