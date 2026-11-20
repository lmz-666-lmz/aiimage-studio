# -*- coding: utf-8 -*-
"""拾光 · 本地生图工作台

运行:  python app.py  → 自动打开 http://127.0.0.1:7860
依赖:  flask  (pip install -r requirements.txt)
配置:  config.json（名称 / 主题 / 中转站列表），页面里可改
"""
import base64
import json
import mimetypes
import os
import queue
import re
import ssl
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory, url_for

APP_VERSION = "1.4.0"
APP_AUTHOR = "lmz-666-lmz"

SIZE_3_2 = ["1024x1024", "1536x1024", "1024x1536"]

# 通用画幅库：中转站（new-api 系）基本都按 WxH 原样透传，尺寸统一取 16 的整数倍，
# 避免部分上游对宽高对齐敏感。size_mode=free 的模型族会全量展示这套比例；
# size_mode=fixed 的（如官方 DALL-E）只给 supported_sizes 里的官方尺寸。
SIZE_LIBRARY = [
    {"size": "1024x1024", "ratio": "1:1", "group": "方"},
    {"size": "1280x1024", "ratio": "5:4", "group": "横"},
    {"size": "1344x1008", "ratio": "4:3", "group": "横"},
    {"size": "1536x1024", "ratio": "3:2", "group": "横"},
    {"size": "1536x864", "ratio": "16:9", "group": "横"},
    {"size": "1536x768", "ratio": "2:1", "group": "宽幅"},
    {"size": "1680x720", "ratio": "21:9", "group": "宽幅"},
    {"size": "1536x512", "ratio": "3:1", "group": "宽幅"},
    {"size": "1024x1280", "ratio": "4:5", "group": "竖"},
    {"size": "1008x1344", "ratio": "3:4", "group": "竖"},
    {"size": "1024x1536", "ratio": "2:3", "group": "竖"},
    {"size": "864x1536", "ratio": "9:16", "group": "竖"},
    {"size": "768x1536", "ratio": "1:2", "group": "长幅"},
    {"size": "720x1680", "ratio": "9:21", "group": "长幅"},
]
SIZE_GROUPS = ["方", "横", "竖", "宽幅", "长幅"]

# One source of truth for the parameter contract used by the UI and the
# upstream request filter.  Unknown models intentionally use the generic
# compatible profile instead of being rejected.
#
# n_mode 决定「数量」怎么实现：
#   upstream = 该模型族支持一次多图，把 n 发给中转站，返回不足时本地补齐
#   local    = 官方接口只出 1 张（如 gpt-image / gemini / grok），不发送 n，改为分次请求
# 两种模式都会补齐到用户选定的张数，界面上的「数量」因此始终有效。
MODEL_CAPABILITIES = {
    "gpt-image": {
        "family": "GPT Image", "text_to_image": True, "image_to_image": True,
        "supported_sizes": SIZE_3_2, "size_mode": "free",
        "quality": True, "background": True, "style": False, "n": True, "n_mode": "local",
        "quality_values": ["low", "medium", "high"], "background_values": ["auto", "transparent", "opaque"],
        "notes": "官方 gpt-image 每次只返回 1 张，选择多张时会自动分次请求",
    },
    "dall-e": {
        "family": "DALL-E", "text_to_image": True, "image_to_image": False,
        "supported_sizes": ["1024x1024", "1792x1024", "1024x1792"], "size_mode": "fixed",
        "quality": True, "background": False, "style": True, "n": True, "n_mode": "upstream",
        "quality_values": ["standard", "hd"], "style_values": ["vivid", "natural"],
        "notes": "DALL-E 支持一次请求多张（n=1-4）；不支持参考图",
    },
    "nano-banana": {
        "family": "Nano Banana", "text_to_image": True, "image_to_image": True,
        "supported_sizes": SIZE_3_2, "size_mode": "free",
        "quality": False, "background": False, "style": False, "n": True, "n_mode": "local",
        "notes": "只接收提示词与画幅，多张自动分次请求",
    },
    "banana": {
        "family": "Nano Banana", "text_to_image": True, "image_to_image": True,
        "supported_sizes": SIZE_3_2, "size_mode": "free",
        "quality": False, "background": False, "style": False, "n": True, "n_mode": "local",
        "notes": "只接收提示词与画幅，多张自动分次请求",
    },
    "gemini image": {
        "family": "Gemini Image", "text_to_image": True, "image_to_image": True,
        "supported_sizes": SIZE_3_2, "size_mode": "free",
        "quality": False, "background": False, "style": False, "n": True, "n_mode": "local",
        "notes": "只接收提示词与画幅，多张自动分次请求",
    },
    "seedream": {
        "family": "Seedream", "text_to_image": True, "image_to_image": True,
        "supported_sizes": SIZE_3_2, "size_mode": "free",
        "quality": False, "background": False, "style": False, "n": True, "n_mode": "upstream",
        "notes": "支持一次多图，返回不足时自动补齐",
    },
    "flux": {
        "family": "FLUX", "text_to_image": True, "image_to_image": True,
        "supported_sizes": SIZE_3_2, "size_mode": "free",
        "quality": False, "background": False, "style": False, "n": True, "n_mode": "upstream",
        "notes": "支持一次多图，返回不足时自动补齐",
    },
    "grok image": {
        "family": "Grok Image", "text_to_image": True, "image_to_image": True,
        # xAI 官方图像接口不接受 size/quality/style；size 留空 = 不发送该字段
        "supported_sizes": [], "size_mode": "none",
        "quality": False, "background": False, "style": False, "n": True, "n_mode": "local",
        "notes": "官方接口只接收提示词，画幅与多张都由本地补齐",
    },
    "image": {
        "family": "Image Compatible", "text_to_image": True, "image_to_image": True,
        "supported_sizes": SIZE_3_2, "size_mode": "free",
        "quality": False, "background": False, "style": False, "n": True, "n_mode": "upstream",
        "notes": "按 OpenAI 兼容协议发送，返回不足时自动补齐",
    },
    "generic": {
        "family": "Generic OpenAI Compatible", "text_to_image": True, "image_to_image": True,
        "supported_sizes": SIZE_3_2, "size_mode": "free",
        "quality": False, "background": False, "style": False, "n": True, "n_mode": "upstream",
        "notes": "未识别的模型名，按 OpenAI 兼容协议发送，画幅与多张由中转站决定",
    },
}

# grok 的 matcher 用裸词 "grok"：真实模型名 grok-2-image 归一化后是
# "grok 2 image"，不含 "grok image"，按旧写法永远匹配不上
CAPABILITY_MATCHERS = (
    ("gpt-image", "gpt-image"), ("dall-e", "dall-e"), ("nano-banana", "nano-banana"),
    ("banana", "banana"), ("gemini image", "gemini"), ("seedream", "seedream"),
    ("flux", "flux"), ("grok image", "grok"), ("image", "image"),
)

HEALTH_TTL = 45
HEALTH_STATES = ("unchecked", "healthy", "slow", "rate_limited", "unavailable")
MODELS_TTL = 600
MAX_REFERENCE_BYTES = 10 * 1024 * 1024
MAX_REFERENCE_COUNT = 4
MAX_IMAGES = 4          # 一条提示词一次最多出图张数（与前端「数量」上限一致）
MAX_PROMPT_CHARS = 8000  # 提示词长度上限，防止误粘贴整篇文档
MAX_EDIT_ITEMS = 8       # 每组改图要求最多 8 项
MAX_EDIT_CHARS = 600
REFERENCE_MIMES = {"image/png", "image/jpeg", "image/webp"}
EXTENSION_PARAMS = ("negative_prompt", "seed", "cfg_scale")

BASE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = BASE_DIR / "outputs"
OUTPUT_DIR.mkdir(exist_ok=True)
CONFIG_PATH = BASE_DIR / "config.json"
# 瞬时运行状态（健康记录 / 模型缓存）与用户配置分离，避免每次生成都重写 config.json
STATE_PATH = BASE_DIR / "runtime_state.json"

CONFIG_LOCK = threading.RLock()   # 保护 config 的读改写与落盘
STATE_LOCK = threading.RLock()    # 保护 runtime state 的读改写与落盘

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
    def _norm(s: str) -> str:
        # 中转站常用 grok-image / grok_image / GPT.Image 等写法，分隔符统一成空格
        return s.strip().lower().replace("-", " ").replace("_", " ")
    name = _norm(model or "")
    for key, matcher in CAPABILITY_MATCHERS:
        if _norm(matcher) in name:
            return {**MODEL_CAPABILITIES[key], "key": key}
    return {**MODEL_CAPABILITIES["generic"], "key": "generic"}


def get_health(pid: str) -> dict:
    return dict(state["health"].get(pid) or {"status": "unchecked"})


def public_provider(provider: dict) -> dict:
    """Never send API keys to the browser or include them in health payloads."""
    return {
        "id": provider.get("id", ""), "name": provider.get("name", ""),
        "api_base": provider.get("api_base", ""), "models": list(provider.get("models") or []),
        "health": get_health(provider.get("id", "")),
        "has_key": bool(provider.get("api_key")),
    }


def _atomic_write_json(path: Path, obj: dict):
    """临时文件 + os.replace 原子落盘，写一半断电也不会留下坏文件。"""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def save_config_dict(cfg: dict):
    _atomic_write_json(CONFIG_PATH, cfg)


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
        for field, default in (("name", "未命名中转"), ("api_base", ""), ("api_key", ""), ("models", [])):
            if field not in p:
                p[field] = default
                changed = True
        # v1.0.x 把健康状态写进 config；现在只保留在运行时状态文件里
        if "health" in p:
            h = p.pop("health")
            if isinstance(h, dict) and h.get("status") not in (None, "unchecked"):
                state["health"].setdefault(p["id"], h)
            changed = True
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
    with CONFIG_LOCK:
        save_config_dict(config)


def _load_state() -> dict:
    st = {"health": {}, "models_cache": {}}
    if STATE_PATH.exists():
        try:
            loaded = json.loads(STATE_PATH.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                if isinstance(loaded.get("health"), dict):
                    st["health"] = loaded["health"]
                if isinstance(loaded.get("models_cache"), dict):
                    st["models_cache"] = loaded["models_cache"]
        except Exception:
            pass  # 状态文件损坏不影响使用，直接重建
    return st


def save_state():
    with STATE_LOCK:
        _atomic_write_json(STATE_PATH, state)


state = _load_state()


def _load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    before = None
    if CONFIG_PATH.exists():
        try:
            before = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
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

_tls_note = threading.local()  # 每请求线程独立，避免并发时证书提示串扰


def _fetch(req: urllib.request.Request, timeout: int):
    """发起请求。证书校验失败时（过期/自签名的小站很常见）自动跳过重试。返回 (字节, Content-Type)。"""
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
        _tls_note.value = "该中转站的 HTTPS 证书已过期或无效，已自动跳过证书校验；密钥仍按原样发送，请注意风险"
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return resp.read(), resp.headers.get("Content-Type", "")


def upstream(path: str, payload: dict | None = None, timeout: int = 300,
             base: str | None = None, key: str | None = None):
    """请求中转站 API。"""
    _tls_note.value = None  # 每次上游调用前重置本线程的证书提示
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
    try:
        return json.loads(data)
    except ValueError as e:
        # 中转站挂了或返回 HTML 错误页时，原始 JSONDecodeError 用户看不懂
        raise ValueError("中转站返回了无法解析的响应（可能不是 JSON）") from e


def with_tls_note(payload: dict) -> dict:
    note = getattr(_tls_note, "value", None)
    if note:
        payload["warning"] = note
    return payload

def _upstream_detail(e: urllib.error.HTTPError) -> str:
    """尽力读出上游返回的具体原因（中转站常把原因写在 error.message 里）。"""
    try:
        raw = e.read(4096)
    except Exception:
        return ""
    if not raw:
        return ""
    text = raw.decode("utf-8", "replace").strip()
    if not text:
        return ""
    try:
        data = json.loads(text)
        err = data.get("error")
        if isinstance(err, str):
            text = err
        elif isinstance(err, dict):
            text = err.get("message") or err.get("code") or text
        else:
            text = data.get("message") or data.get("msg") or text
    except Exception:
        pass  # 非 JSON 响应原样截取
    text = re.sub(r"\s+", " ", str(text)).strip()
    if not text or text in ("{}", "null"):
        return ""
    return f"：{text[:160]}"


def friendly_error(e: Exception) -> str:
    """把上游异常翻译成可操作的中文提示。"""
    if isinstance(e, urllib.error.HTTPError):
        head = {
            401: "API Key 无效或已过期，请检查密钥是否填对",
            403: "没有访问权限（HTTP 403），请确认密钥可用或切换其他中转站",
            404: "接口不存在（HTTP 404），请检查中转站地址是否正确",
            429: "请求太频繁或额度不足（HTTP 429），请稍后再试",
        }.get(e.code, f"当前中转站不可用（HTTP {e.code}），请稍后重试或切换其他服务")
        return head + _upstream_detail(e)
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
    """Only retry failures that prove the request produced no image upstream.

    401/403/404 是调用前的拒绝（密钥、权限、模型名），429 与 502/503/504 也能确定
    上游没有出图；连接被拒同理。超时与其余状态码一律不切换，避免重复计费。
    """
    if isinstance(e, urllib.error.HTTPError):
        return e.code in (401, 403, 404, 429, 502, 503, 504)
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
    with STATE_LOCK:
        state["health"][prov["id"]] = record
    save_state()


def check_provider_health(prov: dict, force: bool = False) -> dict:
    if not prov or not prov.get("api_base") or not prov.get("api_key"):
        return {"status": "unavailable", "error": "未配置地址或密钥"}
    with STATE_LOCK:
        existing = dict(state["health"].get(prov["id"]) or {})
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
    with STATE_LOCK:
        return dict(state["health"].get(prov["id"]) or {"status": "unavailable"})


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
        # 让界面上的上限与后端校验保持同一来源，避免两边写死不一致
        "limits": {
            "max_images": MAX_IMAGES,
            "max_references": MAX_REFERENCE_COUNT,
            "max_reference_mb": MAX_REFERENCE_BYTES // (1024 * 1024),
            "max_prompt_chars": MAX_PROMPT_CHARS,
        },
    }


@app.get("/api/settings")
def get_settings():
    return jsonify(settings_payload())


@app.post("/api/settings")
def set_settings():
    """部分更新：只改请求里出现的字段。主题点击即存，名称单独保存。"""
    body = request.get_json(force=True)
    with CONFIG_LOCK:
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
    pid = (body.get("id") or "").strip()
    if err:
        # Editing an existing provider may leave the key blank to keep it.
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
    with CONFIG_LOCK:
        if pid:
            target = next((p for p in config["providers"] if p["id"] == pid), None)
            if not target:
                return jsonify({"error": "中转站不存在"}), 404
            if target["api_base"] != fields["api_base"] or target["api_key"] != fields["api_key"]:
                target["models"] = []
                drop_models_cache(pid)
                with STATE_LOCK:
                    state["health"].pop(pid, None)
                save_state()
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
    with CONFIG_LOCK:
        idx = next((i for i, p in enumerate(config["providers"]) if p["id"] == pid), -1)
        if idx < 0:
            return jsonify({"error": "中转站不存在"}), 404
        config["providers"].pop(idx)
        drop_models_cache(pid)
        with STATE_LOCK:
            state["health"].pop(pid, None)
        save_state()
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
    with CONFIG_LOCK:
        config["active_provider"] = pid
        save_config()
    models, error = fetch_models_for(active_provider())
    payload = settings_payload()
    payload.update({"models": models})
    if error:
        payload["warning"] = error
    return jsonify(with_tls_note(payload))


# ---------- 模型 ----------
# 按中转站 id 各存一份缓存；旧版单条全局缓存在多站切换时会互相清空
_models_cache = {}
_models_cache_lock = threading.Lock()


def drop_models_cache(pid: str):
    with _models_cache_lock:
        _models_cache.pop(pid, None)


def fetch_models_for(prov: dict | None):
    """返回 (models, error)。成功时把结果持久化到该中转站；失败时回退其缓存。"""
    if not prov or not prov["api_base"] or not prov["api_key"]:
        return [], "请先填写 API 地址和密钥"
    now = time.time()
    pid = prov.get("id", "")
    with _models_cache_lock:
        cached = _models_cache.get(pid)
    if cached and now - cached["ts"] < MODELS_TTL:
        return list(cached["models"]), None
    try:
        ids = [m["id"] for m in upstream("/v1/models", base=prov["api_base"], key=prov["api_key"], timeout=20).get("data", [])]
        kw = ("image", "banana", "seedream", "kling", "dall", "flux", "grok",
              "sd", "stable", "cogview", "wan", "kolors", "janus", "ideogram", "recraft")
        result = sorted(i for i in ids if any(k in i.lower() for k in kw))
        with _models_cache_lock:
            _models_cache[pid] = {"models": result, "ts": now}
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
    """Cheap /v1/models probe; cached for HEALTH_TTL seconds and never generates.

    多站时并行探测：一站超时不再拖住其余站点的结果。
    """
    body = request.get_json(silent=True) or {}
    pid = (body.get("provider_id") or "").strip()
    targets = config["providers"] if not pid else [p for p in config["providers"] if p["id"] == pid]
    if pid and not targets:
        return jsonify({"error": "中转站不存在"}), 404
    force = bool(body.get("force"))

    def _check(p):
        return dict(check_provider_health(p, force=force), provider_id=p["id"], provider_name=p["name"])

    if len(targets) > 1:
        with ThreadPoolExecutor(max_workers=min(8, len(targets))) as pool:
            statuses = list(pool.map(_check, targets))
    else:
        statuses = [_check(p) for p in targets]
    return jsonify({"providers": statuses, "settings": settings_payload()})


@app.get("/api/capabilities")
def capabilities():
    return jsonify({"capabilities": MODEL_CAPABILITIES, "matchers": CAPABILITY_MATCHERS,
                    "size_library": SIZE_LIBRARY, "size_groups": SIZE_GROUPS})


# ---------- 生成 ----------
def upstream_multipart(path: str, fields: dict, files: list, timeout: int = 300,
                       base: str | None = None, key: str | None = None):
    """Small stdlib-only multipart encoder for OpenAI-compatible image edits.

    files: [(field, filename, blob, mime), ...]，多参考图时每张一个 part。
    """
    _tls_note.value = None
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
    for field, filename, blob, mime in files:
        safe_name = os.path.basename(str(filename)).replace('"', "'").replace("\r", "").replace("\n", "")
        chunks.extend([f"--{boundary}\r\n".encode(),
                       f'Content-Disposition: form-data; name="{field}"; filename="{safe_name}"\r\n'.encode(),
                       f"Content-Type: {mime}\r\n\r\n".encode(), blob, b"\r\n"])
    chunks.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        f"{base}{path}", data=b"".join(chunks), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": f"multipart/form-data; boundary={boundary}",
                 "User-Agent": "Mozilla/5.0"},
    )
    data, _ = _fetch(req, timeout)
    try:
        return json.loads(data)
    except ValueError as e:
        raise ValueError("中转站返回了无法解析的响应（可能不是 JSON）") from e


def _ext_from_blob(blob: bytes) -> str | None:
    """按文件签名识别图片，避免把错误页面或空文件存进画廊。"""
    if blob.startswith(b"\x89PNG\r\n\x1a\n"): return ".png"
    if blob.startswith(b"\xff\xd8"): return ".jpg"
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP": return ".webp"
    if blob[:3] == b"GIF": return ".gif"
    return None


def _persist_image_results(data: dict, payload: dict, prov: dict, elapsed: float,
                           extra_meta: dict | None = None):
    items = data.get("data") if isinstance(data, dict) else None
    if not isinstance(items, list) or not items:
        raise ValueError("上游未返回图片")
    extra_meta = extra_meta or {}
    results, errors = [], []
    for i, item in enumerate(items):
        meta = {"model": payload["model"], "provider": prov["name"], "provider_id": prov["id"],
                "elapsed": elapsed, "prompt": payload["prompt"], "size": payload.get("size", ""),
                "size_requested": extra_meta.get("size_requested", ""),
                "quality": payload.get("quality", ""), "background": payload.get("background", ""),
                "style": payload.get("style", ""),
                "created": int(time.time()), "created_time": time.strftime("%Y-%m-%d %H:%M:%S"),
                "mode": extra_meta.get("mode", "text-to-image"),
                "reference_used": bool(extra_meta.get("reference_used", False)),
                "reference_name": extra_meta.get("reference_name", ""),
                "reference_count": int(extra_meta.get("reference_count", 0)),
                "requested": int(extra_meta.get("requested", 1)),
                "failover": bool(extra_meta.get("failover", False)),
                "failover_from": extra_meta.get("failover_from", "")}
        meta.update({key: payload[key] for key in EXTENSION_PARAMS if key in payload})
        if extra_meta.get("edit"):
            meta["edit"] = extra_meta["edit"]
        try:
            if not isinstance(item, dict):
                raise ValueError("上游图片条目格式有误")
            if item.get("b64_json"):
                blob = base64.b64decode(item["b64_json"], validate=True)
            elif isinstance(item.get("url"), str) and item["url"].startswith(("http://", "https://")):
                req = urllib.request.Request(item["url"], headers={"User-Agent": "Mozilla/5.0"})
                blob, _ = _fetch(req, 120)
            else:
                raise ValueError("上游未提供可用的图片地址或数据")
            ext = _ext_from_blob(blob)
            if not ext:
                raise ValueError("上游返回的内容不是可识别的图片")
        except (OSError, ValueError, TypeError) as e:
            errors.append(f"第 {i + 1} 张图片读取失败：{friendly_error(e)}")
            continue
        name = f"{time.strftime('%Y%m%d_%H%M%S')}_{i}_{uuid.uuid4().hex[:8]}{ext}"
        image_path = OUTPUT_DIR / name
        with _hist_lock:
            try:
                image_path.write_bytes(blob)
                _write_meta(name, meta)
            except OSError as e:
                image_path.unlink(missing_ok=True)
                errors.append(f"第 {i + 1} 张图片保存失败：{e.strerror or e}")
                continue
        results.append({"url": f"/outputs/{name}", "name": name, **meta})
    return results, errors


def _filtered_payload(body: dict, model: str, cap: dict) -> tuple[dict, int]:
    """构造上游 payload，并返回 (payload, 期望张数)。

    只有在该模型族确实接收 n 时才把 n 发给中转站；其余情况由
    _run_generation 分次补齐，保证界面上的「数量」对用户始终真实有效。
    """
    payload = {"model": model, "prompt": (body.get("prompt") or "").strip()}
    raw_size = str(body.get("size") or "").strip().lower()
    if cap.get("size_mode") == "none":
        pass  # 该模型族（如 grok image）不接收 size，整个字段不发
    elif re.fullmatch(r"\d{2,5}x\d{2,5}", raw_size):
        # 用户显式指定的画幅原样透传，由中转站负责映射（new-api 系均支持）
        payload["size"] = raw_size
    elif cap.get("supported_sizes"):
        payload["size"] = cap["supported_sizes"][0]  # 未指定 → 该模型族默认
    # 皆无 = 该模型族没有官方尺寸可回退

    target_n = 1
    if cap.get("n"):
        try:
            target_n = min(MAX_IMAGES, max(1, int(body.get("n", 1))))
        except (TypeError, ValueError, OverflowError):
            target_n = 1
        if target_n > 1 and cap.get("n_mode", "upstream") == "upstream":
            payload["n"] = target_n
    for key in ("quality", "background", "style"):
        value = body.get(key)
        allowed = cap.get(f"{key}_values")
        if cap.get(key) and value and (not allowed or value in allowed):
            payload[key] = value
    payload.update({key: body[key] for key in EXTENSION_PARAMS if key in body})
    return payload, target_n


def _reference_files():
    """解析 multipart 里的参考图，返回 [(文件名, 类型, 字节), ...]。"""
    uploads = [f for f in request.files.getlist("image") if f and f.filename]
    if not uploads:
        return None, "请选择参考图"
    if len(uploads) > MAX_REFERENCE_COUNT:
        return None, f"参考图最多 {MAX_REFERENCE_COUNT} 张"
    references = []
    for image in uploads:
        mime = (image.mimetype or mimetypes.guess_type(image.filename)[0] or "").lower()
        if mime not in REFERENCE_MIMES:
            return None, f"参考图仅支持 PNG、JPEG 或 WEBP（{image.filename}）"
        blob = image.read(MAX_REFERENCE_BYTES + 1)
        if not blob:
            return None, f"参考图为空（{image.filename}）"
        if len(blob) > MAX_REFERENCE_BYTES:
            return None, f"参考图过大，请控制在 {MAX_REFERENCE_BYTES // (1024 * 1024)}MB 以内（{image.filename}）"
        references.append((image.filename, mime, blob))
    return references, None


def _edit_reference(body: dict):
    parent = body.get("edit_parent")
    path = _output_image_path(parent)
    if path is None:
        raise ValueError("改图原图已删除或无法读取")

    groups = {}
    for key, label in (("change", "要改什么"), ("keep", "要保留什么")):
        raw = body.get(f"edit_{key}", "")
        if not isinstance(raw, str) or len(raw) > MAX_EDIT_CHARS:
            raise ValueError(f"「{label}」最多 {MAX_EDIT_CHARS} 字")
        items = [line.strip() for line in raw.splitlines() if line.strip()]
        if len(items) > MAX_EDIT_ITEMS:
            raise ValueError(f"「{label}」最多 {MAX_EDIT_ITEMS} 项，每行一项")
        groups[key] = items
    if not groups["change"]:
        raise ValueError("请填写要改什么")

    try:
        with path.open("rb") as source:
            blob = source.read(MAX_REFERENCE_BYTES + 1)
    except OSError as exc:
        raise ValueError("改图原图已删除或无法读取") from exc
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp"}.get(_ext_from_blob(blob))
    if mime not in REFERENCE_MIMES:
        raise ValueError("改图原图仅支持 PNG、JPEG 或 WEBP")
    if len(blob) > MAX_REFERENCE_BYTES:
        raise ValueError(f"改图原图超过 {MAX_REFERENCE_BYTES // (1024 * 1024)}MB")

    edit = {"parent": parent, **groups,
            "review": {"checks": [False] * (len(groups["change"]) + len(groups["keep"])), "final": False}}
    prompt_lines = ["请修改参考图。", "要改：", *[f"- {item}" for item in groups["change"]]]
    if groups["keep"]:
        prompt_lines += ["要保留：", *[f"- {item}" for item in groups["keep"]]]
    body["prompt"] = "\n".join(prompt_lines)
    body["n"] = 1
    return edit, [(parent, mime, blob)]


def _providers_for_model(model: str, primary: dict):
    return [p for p in config["providers"] if p["id"] != primary["id"] and model in (p.get("models") or [])]


class GenError(Exception):
    """生成失败，携带给前端看的中文说明与 HTTP 状态。"""

    def __init__(self, message: str, status: int = 502, cause: Exception | None = None):
        super().__init__(message)
        self.status = status
        self.cause = cause


def _parse_generation_body():
    """从 JSON / multipart 请求解析生成参数。返回 (body, reference list|None, error)。"""
    is_multipart = request.mimetype == "multipart/form-data"
    body = request.form.to_dict() if is_multipart else request.get_json(silent=True)
    if not isinstance(body, dict):
        return None, None, "生成参数必须是 JSON 对象或参考图表单"
    for key in ("prompt", "model", "negative_prompt"):
        if body.get(key) is not None and not isinstance(body[key], str):
            return None, None, f"{key} 必须是文本"
    negative = (body.pop("negative_prompt", None) or "").strip()
    if len(negative) > MAX_PROMPT_CHARS:
        return None, None, f"反向提示词最多 {MAX_PROMPT_CHARS} 字"
    if negative:
        body["negative_prompt"] = negative
    seed = body.pop("seed", None)
    if seed not in (None, "", -1, "-1"):
        if not re.fullmatch(r"[0-9]{1,10}", str(seed)) or int(seed) > 4294967295:
            return None, None, "Seed 必须是 0 到 4294967295 的整数，或留空随机生成"
        body["seed"] = int(seed)
    cfg_scale = body.pop("cfg_scale", None)
    if cfg_scale not in (None, ""):
        try:
            cfg_scale = float(str(cfg_scale))
        except ValueError:
            return None, None, "CFG 必须是 1 到 20 的数字"
        if not 1 <= cfg_scale <= 20:
            return None, None, "CFG 必须是 1 到 20 的数字"
        body["cfg_scale"] = cfg_scale
    reference = None
    body["edit"] = None
    if any(key in body for key in ("edit_parent", "edit_change", "edit_keep")):
        if is_multipart:
            return None, None, "改图使用图库原图，请退出改图后再上传其他参考图"
        try:
            body["edit"], reference = _edit_reference(body)
        except ValueError as exc:
            return None, None, str(exc)
    elif is_multipart:
        reference, error = _reference_files()
        if error:
            return None, None, error
    return body, reference, None


def _call_with_failover(model: str, prov: dict, body: dict, call, allow_failover: bool = True,
                        should_stop=None):
    """一次上游调用（含可选的安全故障切换）。

    返回 (data, 实际使用的中转站, 切换来源名称)。失败抛 GenError，并把原始异常
    放在 .cause 上，方便调用方识别「带 n 被拒」这类可自愈的错误。
    """
    try:
        data = call(body, prov)
        set_health(prov, "healthy")
        return data, prov, ""
    except Exception as primary_error:
        # HTTPError 的响应体只能读一次：先取完整文案给健康记录，
        # 再把同一份文案抛给前端，避免第二次读为空丢失上游原因
        detail_msg = friendly_error(primary_error)
        set_health(prov, error_status(primary_error), error=detail_msg)
        if not allow_failover or not config.get("failover_enabled") or not is_safe_failover_error(primary_error):
            raise GenError(detail_msg, cause=primary_error)
        candidates = _providers_for_model(model, prov)
        if not candidates:
            raise GenError(f"主中转站失败，备用站没有同名模型（{model}）", cause=primary_error)
        backup = candidates[0]  # at most one fallback request per round
        if should_stop and should_stop():
            raise GenError(detail_msg, cause=primary_error)
        try:
            data = call(body, backup)
            set_health(backup, "healthy")
        except Exception as backup_error:
            backup_msg = friendly_error(backup_error)
            set_health(backup, error_status(backup_error), error=backup_msg)
            raise GenError(f"主线路与备用线路均不可用：{backup_msg}", cause=backup_error)
        with CONFIG_LOCK:
            if config["active_provider"] == prov["id"] and backup in config["providers"]:
                config["active_provider"] = backup["id"]
                save_config()
        return data, backup, prov["name"]


def _run_generation(model: str, payload: dict, reference: list | None, target_n: int = 1,
                    should_stop=None, fallback_size: str | None = None,
                    provider_id: str | None = None, on_images=None, edit: dict | None = None) -> dict:
    """完整生成流程：按需要出 target_n 张，调用上游、安全故障切换、持久化。

    中转站一次只返回 1 张时（gpt-image / gemini / grok 等官方接口的常态）会继续
    追加请求补齐，因此「数量」选择永远能得到对应张数；补齐过程中失败则保留已出
    的图并如实告知，不会把整次生成判为失败。

    画幅被中转站拒绝（400/422，常见于它只认官方尺寸）时，会退到该模型族的官方
    尺寸重试一次，并把「你要的尺寸」与「实际用的尺寸」都写进元数据。失败抛 GenError。
    """
    with CONFIG_LOCK:
        provider = (next((p for p in config["providers"] if p["id"] == provider_id), None)
                    if provider_id is not None else active_provider())
        prov = dict(provider) if provider else None
    if provider_id is not None and prov is None:
        raise GenError("提交任务时选择的中转站已被删除", 400)
    if not prov or not prov.get("api_base") or not prov.get("api_key"):
        raise GenError("还没有可用的中转站，请在设置里添加并填写地址和密钥", 400)
    target_n = max(1, min(MAX_IMAGES, int(target_n or 1)))
    mode = "image-to-image" if reference else "text-to-image"
    path = "/v1/images/edits" if reference else "/v1/images/generations"
    # 单张沿用 image 字段；多张按官方 edits 约定用 image[]
    file_field = "image" if reference and len(reference) == 1 else "image[]"
    files = [(file_field, fn, blob, mime) for fn, mime, blob in reference] if reference else []
    sends_n = "n" in payload   # 上游收到的 payload 里是否已经带了 n
    size_dropped = ""          # 被拒绝后回退掉的原始画幅

    def call(body, target):
        if files:
            return upstream_multipart(path, body, files, base=target["api_base"], key=target["api_key"])
        return upstream(path, body, base=target["api_base"], key=target["api_key"])

    images, errors = [], []
    failover = False
    failover_from = ""
    tls_notes = []          # 证书降级等线程本地提示要带回给前端（任务队列里没人读线程本地值）
    started = time.time()
    while len(images) < target_n:
        if should_stop and should_stop():
            break
        body = dict(payload)
        if sends_n:
            # 首轮按用户张数请求；补齐轮只要还差的张数
            body["n"] = target_n - len(images)
        else:
            body.pop("n", None)   # 上游只吃 n=1 时，补齐轮不能把 n 再带出去
        round_started = time.time()
        try:
            data, prov, switched_from = _call_with_failover(
                model, prov, body, call, allow_failover=not images, should_stop=should_stop)
        except GenError as e:
            cause = e.cause
            rejected = isinstance(cause, urllib.error.HTTPError) and cause.code in (400, 404, 422)
            if rejected and sends_n:
                # 官方 gpt-image 只接受 n=1：带 n 被拒时去掉 n 再试一次
                sends_n = False
                continue
            if rejected and body.get("size") and fallback_size and body["size"] != fallback_size:
                # 中转站不认这个画幅：退到官方尺寸重来，别让用户白等一次
                size_dropped = body["size"]
                payload = {**payload, "size": fallback_size}
                continue
            if images:   # 已经出了图，剩下的补不齐只提示，不整单失败
                errors.append(str(e))
                break
            raise
        tls = getattr(_tls_note, "value", None)
        if tls and tls not in tls_notes:
            tls_notes.append(tls)
        if switched_from:
            failover, failover_from = True, switched_from
        round_elapsed = round(time.time() - round_started, 1)
        try:
            round_images, result_errors = _persist_image_results(data, body, prov, round_elapsed, {
                "mode": mode, "reference_used": bool(reference),
                "reference_name": "、".join(fn for fn, _, _ in reference) if reference else "",
                "reference_count": len(reference) if reference else 0,
                "requested": target_n, "size_requested": size_dropped,
                "failover": failover, "failover_from": failover_from,
                "edit": edit,
            })
        except ValueError as e:
            if images:
                errors.append(str(e))
                break
            raise GenError(str(e))
        images.extend(round_images)
        if round_images and on_images:
            on_images(round_images)
        if result_errors:
            # 上游可能已经计费。保留已保存的图，由用户决定是否再试。
            errors.extend(result_errors)
            break

    if not images and not (should_stop and should_stop()):
        raise GenError(errors[0] if errors else "上游未返回图片")
    elapsed = round(time.time() - started, 1)
    response = {"images": images, "elapsed": elapsed, "model": model,
                "prompt": payload.get("prompt", ""),
                "provider": prov["name"], "provider_id": prov["id"], "mode": mode,
                "requested": target_n, "returned": len(images),
                "size": payload.get("size", ""), "size_requested": size_dropped,
                "failover": failover, "failover_from": failover_from}
    notes = []
    if failover:
        notes.append(f"主线路「{failover_from}」暂时不可用，已通过「{prov['name']}」完成生成")
    if size_dropped:
        notes.append(f"中转站不接受 {size_dropped}，已按 {payload.get('size', '')} 出图")
    if len(images) < target_n:
        notes.append(f"请求 {target_n} 张，实际得到 {len(images)} 张"
                     f"（{errors[0] if errors else '上游未返回更多图片'}）")
    elif errors:
        notes.append(errors[0])
    if tls_notes:
        notes.extend(tls_notes)
    if notes:
        response["notice"] = "；".join(notes)
    return response


@app.post("/api/generate")
def generate():
    body, reference, error = _parse_generation_body()
    if error:
        return jsonify({"error": error}), 400
    prompt = (body.get("prompt") or "").strip()
    model = (body.get("model") or "").strip()
    if not prompt:
        return jsonify({"error": "提示词不能为空"}), 400
    if len(prompt) > MAX_PROMPT_CHARS:
        return jsonify({"error": f"提示词过长（{len(prompt)} 字），请控制在 {MAX_PROMPT_CHARS} 字以内"}), 400
    if not model:
        return jsonify({"error": "请先选择或填写模型"}), 400
    cap = capability_for(model)
    if reference and not cap.get("image_to_image"):
        return jsonify({"error": "当前模型暂未声明参考图能力"}), 400
    payload, target_n = _filtered_payload(body, model, cap)
    try:
        response = _run_generation(model, payload, reference, target_n,
                                   fallback_size=(cap.get("supported_sizes") or [None])[0], edit=body["edit"])
    except GenError as e:
        return jsonify(with_tls_note({"error": str(e)})), e.status
    return jsonify(with_tls_note(response))


# ---------- 生成任务队列 ----------
# 一条提示词 + N 张出图的进度与取消都靠它；单 worker 串行，避免同一密钥并发触发限流
TASK_RETENTION = 1800  # 已结束的任务保留 30 分钟供查询
_tasks = {}
_tasks_lock = threading.Lock()
_task_queue = queue.Queue()


def _purge_tasks():
    now = time.time()
    with _tasks_lock:
        stale = [tid for tid, t in _tasks.items()
                 if t["status"] in ("done", "failed", "cancelled")
                 and t.get("finished_at") and now - t["finished_at"] > TASK_RETENTION]
        for tid in stale:
            _tasks.pop(tid, None)


def _run_batch_task(task: dict):
    def should_stop():
        with _tasks_lock:
            return task["status"] in ("cancelled", "cancelling")

    def record_images(images):
        with _tasks_lock:
            task["images"].extend(images)

    for i, prompt in enumerate(task["prompts"]):
        with _tasks_lock:
            if task["status"] in ("cancelled", "cancelling"):
                break
            task["status"] = "running"
            task["index"] = i
        payload = {**task["base_payload"], "prompt": prompt}
        try:
            result = _run_generation(task["model"], payload, task["reference"], task.get("target_n", 1),
                                     should_stop=should_stop, fallback_size=task.get("fallback_size"),
                                     provider_id=task["provider_id"], on_images=record_images, edit=task["edit"])
            with _tasks_lock:
                if result.get("notice"):
                    task["notice"] = result["notice"]
        except GenError as e:
            with _tasks_lock:
                task["errors"].append({"prompt": prompt, "error": str(e)})
        except Exception as e:  # 单条出错不中断整批，最后汇总
            with _tasks_lock:
                task["errors"].append({"prompt": prompt, "error": f"生成失败：{e}"})
    with _tasks_lock:
        # 取消只在任务真正收尾后才算完成：已经在飞的那张仍会入账
        if task["status"] == "cancelling":
            task["status"] = "cancelled"
        elif task["status"] != "cancelled":
            task["status"] = "failed" if task["errors"] and not task["images"] else "done"
        task["reference"] = None
        task["finished_at"] = time.time()


def _task_worker():
    while True:
        tid = _task_queue.get()
        with _tasks_lock:
            task = _tasks.get(tid)
        if not task:
            continue
        try:
            _run_batch_task(task)
        except Exception as e:
            with _tasks_lock:
                task["status"] = "failed"
                task["finished_at"] = time.time()
                task["errors"].append({"prompt": "", "error": f"任务异常：{e}"})


threading.Thread(target=_task_worker, daemon=True, name="gen-queue").start()


@app.post("/api/generate-task")
def generate_task():
    """整段提示词 = 一次生成，按「数量」出 N 张。

    队列只用来把多张出图拆成可观察、可取消的步骤：提示词原样使用，
    不按行、不按空行拆分——用户写几段都只算一条提示词。
    """
    body, reference, error = _parse_generation_body()
    if error:
        return jsonify({"error": error}), 400
    model = (body.get("model") or "").strip()
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "提示词不能为空"}), 400
    if len(prompt) > MAX_PROMPT_CHARS:
        return jsonify({"error": f"提示词过长（{len(prompt)} 字），请控制在 {MAX_PROMPT_CHARS} 字以内"}), 400
    if not model:
        return jsonify({"error": "请先选择或填写模型"}), 400
    cap = capability_for(model)
    if reference and not cap.get("image_to_image"):
        return jsonify({"error": "当前模型暂未声明参考图能力"}), 400
    prov = active_provider()
    if not prov or not prov.get("api_base") or not prov.get("api_key"):
        return jsonify({"error": "还没有可用的中转站，请在设置里添加并填写地址和密钥"}), 400
    base_payload, target_n = _filtered_payload(body, model, cap)
    base_payload.pop("prompt", None)  # 执行时填入整段提示词
    _purge_tasks()
    tid = uuid.uuid4().hex[:12]
    task = {"id": tid, "status": "queued", "model": model, "prompts": [prompt],
            "provider_id": prov["id"],
            "base_payload": base_payload, "reference": reference, "target_n": target_n, "edit": body["edit"],
            "fallback_size": (cap.get("supported_sizes") or [None])[0],
            "total": 1, "index": 0, "images": [], "errors": [],
            "notice": "", "created_at": time.time(), "finished_at": None}
    with _tasks_lock:
        _tasks[tid] = task
    _task_queue.put(tid)
    return jsonify({"task_id": tid, "total": 1, "target_n": target_n,
                    "target_images": target_n})


def _task_snapshot(task: dict) -> dict:
    # 只在持锁时调用
    idx = min(task["index"], len(task["prompts"]) - 1) if task["prompts"] else 0
    target_n = task.get("target_n", 1)
    return {"id": task["id"], "status": task["status"], "model": task["model"],
            "index": task["index"], "total": task["total"], "target_n": target_n,
            "target_images": target_n * task["total"],
            "prompt": task["prompts"][idx] if task["prompts"] else "",
            "image_count": len(task["images"]), "images": list(task["images"]),
            "errors": list(task["errors"]), "notice": task["notice"]}


@app.get("/api/task")
def task_status():
    tid = (request.args.get("id") or "").strip()
    with _tasks_lock:
        task = _tasks.get(tid)
        if not task:
            return jsonify({"error": "任务不存在"}), 404
        return jsonify(_task_snapshot(task))


@app.post("/api/task/cancel")
def task_cancel():
    """请求取消：下一个上游请求前生效，已发出的请求不打断，避免重复计费。

    状态先置为 cancelling，等 worker 真正收尾（可能还要等回一张图）才变 cancelled，
    这样前端轮询不会在图片入库前就提前收工。
    """
    tid = (request.get_json(force=True).get("id") or "").strip()
    with _tasks_lock:
        task = _tasks.get(tid)
        if not task:
            return jsonify({"error": "任务不存在"}), 404
        if task["status"] in ("queued", "running"):
            task["status"] = "cancelling"
        return jsonify({"ok": True, "status": task["status"]})


# ---------- 历史与筛选 ----------
_RANGE_SPANS = {"today": 86400, "week": 7 * 86400}
IMAGE_EXTS = {".webp", ".png", ".jpg", ".jpeg", ".gif"}

# 内存索引：目录里图片 / sidecar 没变就直接复用，避免每次请求全量读 JSON
_hist_lock = threading.Lock()
_hist_sig = None
_hist_meta = {}      # name -> sidecar 元数据
_hist_mtime = {}     # name -> 图片文件 mtime
_hist_sc_mtime = {}  # name -> sidecar mtime（收藏等只改 sidecar 的操作靠它发现变化）


def _output_image_path(name):
    if not isinstance(name, str) or not name or any(part in name for part in ("/", "\\", ":", "..", "\0")):
        return None
    path = OUTPUT_DIR / name
    if path.suffix.lower() not in IMAGE_EXTS:
        return None
    try:
        if path.is_file() and path.resolve().parent == OUTPUT_DIR.resolve():
            return path
    except (OSError, ValueError, RuntimeError):
        pass
    return None


def _read_meta(p: Path) -> dict:
    sidecar = p.with_name(p.name + ".json")
    if sidecar.exists():
        try:
            meta = json.loads(sidecar.read_text(encoding="utf-8"))
            if isinstance(meta, dict):
                return meta
        except (OSError, ValueError):
            pass
    return {}


def _write_meta(name: str, meta: dict):
    _atomic_write_json(OUTPUT_DIR / (name + ".json"), meta)


def history_index() -> dict:
    """返回 name -> mtime 映射，并保证 _hist_meta 与磁盘一致。"""
    global _hist_sig
    with _hist_lock:
        images, sidecars = {}, {}
        try:
            for entry in OUTPUT_DIR.iterdir():
                if not entry.is_file():
                    continue
                ext = entry.suffix.lower()
                try:
                    if ext in IMAGE_EXTS:
                        images[entry.name] = entry.stat().st_mtime
                    elif ext == ".json":
                        sidecars[entry.name] = entry.stat().st_mtime
                except OSError:
                    continue
        except OSError:
            return {}
        sig = (tuple(sorted(images.items())), tuple(sorted(sidecars.items())))
        if sig != _hist_sig:
            for name in [n for n in _hist_meta if n not in images]:
                _hist_meta.pop(name, None)
                _hist_mtime.pop(name, None)
                _hist_sc_mtime.pop(name, None)
            for name, mtime in images.items():
                sc_mtime = sidecars.get(name + ".json")
                if (name not in _hist_meta or _hist_mtime.get(name) != mtime
                        or _hist_sc_mtime.get(name) != sc_mtime):
                    _hist_meta[name] = _read_meta(OUTPUT_DIR / name)
                    _hist_mtime[name] = mtime
                    _hist_sc_mtime[name] = sc_mtime
            _hist_sig = sig
        return images


def _history_item(name: str, mtime: float, meta: dict) -> dict:
    return {
        "name": name,
        "url": url_for("outputs", name=name),
        "mtime": mtime,
        "model": meta.get("model", ""),
        "provider": meta.get("provider", ""),
        "provider_id": meta.get("provider_id", ""),
        "elapsed": meta.get("elapsed"),
        "prompt": meta.get("prompt", ""),
        "size": meta.get("size", ""),
        "size_requested": meta.get("size_requested", ""),
        "quality": meta.get("quality", ""),
        "background": meta.get("background", ""),
        "style": meta.get("style", ""),
        **{key: meta[key] for key in (*EXTENSION_PARAMS, "edit") if key in meta},
        "mode": meta.get("mode", "text-to-image"),
        "reference_used": bool(meta.get("reference_used", False)),
        "reference_name": meta.get("reference_name", ""),
        "reference_count": int(meta.get("reference_count", 0) or 0),
        "requested": int(meta.get("requested", 1) or 1),
        "failover": bool(meta.get("failover", False)),
        "failover_from": meta.get("failover_from", ""),
        "favorite": bool(meta.get("favorite", False)),
        "created_time": meta.get("created_time", time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(mtime))),
    }


@app.get("/api/history")
def history():
    page = max(1, request.args.get("page", 1, type=int))
    page_size = min(48, max(1, request.args.get("page_size", 12, type=int)))
    q = (request.args.get("q") or "").strip().lower()
    model_kw = (request.args.get("model") or "").strip().lower()
    provider_name = (request.args.get("provider") or "").strip()
    rng = request.args.get("range") or "all"
    sort = request.args.get("sort") or "newest"
    only_fav = request.args.get("favorite") in ("1", "true")
    only_final = request.args.get("final") in ("1", "true")
    now = time.time()

    images = history_index()
    entries = []
    model_facets, provider_facets = set(), set()
    for name in sorted(images, reverse=True):
        meta = _hist_meta.get(name) or {}
        mtime = images[name]
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
        if only_fav and not meta.get("favorite"):
            continue
        if only_final and not (meta.get("edit") or {}).get("review", {}).get("final"):
            continue
        if rng in _RANGE_SPANS and now - created > _RANGE_SPANS[rng]:
            continue
        entries.append((name, mtime, meta))

    if sort == "fastest":
        entries.sort(key=lambda e: (e[2].get("elapsed") is None, e[2].get("elapsed") or 0))
    elif sort == "model":
        entries.sort(key=lambda e: e[2].get("model", ""))
    else:
        entries.sort(key=lambda e: e[0], reverse=True)

    total = len(entries)
    pages = max(1, -(-total // page_size))
    page = min(page, pages)

    items = [_history_item(*entry) for entry in entries[(page - 1) * page_size : page * page_size]]
    return jsonify({
        "items": items, "page": page, "pages": pages, "total": total,
        "facets": {"models": sorted(model_facets), "providers": sorted(provider_facets)},
    })


@app.get("/api/history/versions")
def history_versions():
    name = request.args.get("name", "")
    images = history_index()
    with _hist_lock:
        if name not in images or _output_image_path(name) is None:
            return jsonify({"error": "这张图已删除或无法读取"}), 404
        meta = _hist_meta.get(name) or {}
        parent = (meta.get("edit") or {}).get("parent")
        return jsonify({
            "item": _history_item(name, images[name], meta),
            "parent": _history_item(parent, images[parent], _hist_meta.get(parent) or {})
            if parent in images and _output_image_path(parent) is not None else None,
            "children": [
                _history_item(child, images[child], _hist_meta[child])
                for child in sorted(images, reverse=True)
                if (_hist_meta.get(child, {}).get("edit") or {}).get("parent") == name
            ],
        })


@app.post("/api/history/review")
def history_review():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "验收内容格式有误"}), 400
    checks, final = body.get("checks"), body.get("final")
    if not isinstance(checks, list) or any(type(check) is not bool for check in checks) or type(final) is not bool:
        return jsonify({"error": "验收内容格式有误"}), 400
    with _hist_lock:
        path = _output_image_path(body.get("name"))
        if path is None:
            return jsonify({"error": "这张图已删除或无法读取"}), 404
        meta = _read_meta(path)
        edit = meta.get("edit")
        if not edit or len(checks) != len(edit["change"]) + len(edit["keep"]):
            return jsonify({"error": "验收项与改图记录不一致"}), 400
        if final and not all(checks):
            return jsonify({"error": "全部验收通过后才能标记成稿"}), 400
        edit["review"] = {"checks": checks, "final": final, "saved_at": time.strftime("%Y-%m-%d %H:%M:%S")}
        _write_meta(path.name, meta)
        _hist_meta[path.name] = meta
        _hist_sc_mtime[path.name] = path.with_name(path.name + ".json").stat().st_mtime
    return jsonify({"review": edit["review"]})


@app.get("/api/history/export")
def history_export():
    """导出全部元数据用于备份；不含图片本体，体积小，可随时重导。"""
    images = history_index()
    records = [
        {"name": name, "url": f"/outputs/{name}", "mtime": images[name], **(_hist_meta.get(name) or {})}
        for name in sorted(images, reverse=True)
    ]
    body = json.dumps({"app": "ai-image-studio", "version": APP_VERSION,
                       "exported_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                       "count": len(records), "items": records}, ensure_ascii=False, indent=2)
    fname = f"ai-image-studio-history-{time.strftime('%Y%m%d-%H%M%S')}.json"
    return Response(body, mimetype="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@app.post("/api/favorite")
def favorite():
    """切换或显式设置收藏；写 sidecar 并同步内存索引。"""
    body = request.get_json(force=True)
    name = (body.get("name") or "").strip()
    with _hist_lock:
        if not name or "/" in name or "\\" in name or ".." in name or not (OUTPUT_DIR / name).exists():
            return jsonify({"error": "无效文件名"}), 400
        meta = _read_meta(OUTPUT_DIR / name)
        if "favorite" in body:
            meta["favorite"] = bool(body["favorite"])
        else:
            meta["favorite"] = not meta.get("favorite", False)
        _write_meta(name, meta)
        _hist_meta[name] = meta
        _hist_sc_mtime[name] = (OUTPUT_DIR / (name + ".json")).stat().st_mtime
    return jsonify({"ok": True, "name": name, "favorite": meta["favorite"]})


@app.post("/api/delete")
def delete():
    body = request.get_json(force=True)
    names = body.get("names") if isinstance(body.get("names"), list) else None
    if not names and body.get("name"):
        names = [body["name"]]
    if not names:
        return jsonify({"error": "请提供要删除的文件名"}), 400
    if len(names) > 500:
        return jsonify({"error": "一次最多删除 500 张"}), 400
    cleaned = []
    for name in names:
        name = (name or "").strip()
        if not name or "/" in name or "\\" in name or ".." in name:
            return jsonify({"error": f"无效文件名：{name}"}), 400
        cleaned.append(name)
    deleted = 0
    global _hist_sig
    with _hist_lock:
        for name in cleaned:
            removed = False
            for suffix in ("", ".json"):
                f = OUTPUT_DIR / (name + suffix)
                if f.exists():
                    f.unlink()
                    removed = True
            if removed:
                deleted += 1
            _hist_meta.pop(name, None)
            _hist_mtime.pop(name, None)
            _hist_sc_mtime.pop(name, None)
        _hist_sig = None  # 强制下次扫描重建签名
    return jsonify({"ok": True, "deleted": deleted})


@app.get("/outputs/<path:name>")
def outputs(name):
    return send_from_directory(OUTPUT_DIR, name)


if __name__ == "__main__":
    import webbrowser

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "7860"))
    url = f"http://{host}:{port}"
    if os.environ.get("NO_BROWSER", "") not in ("1", "true", "yes"):
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    print(f"「{config['name']}」运行中: {url}  (Ctrl+C 退出)")
    app.run(host=host, port=port, debug=False)
