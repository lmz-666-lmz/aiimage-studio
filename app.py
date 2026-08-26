# -*- coding: utf-8 -*-
"""拾光 · 本地生图工作台

运行:  python app.py  → 自动打开 http://127.0.0.1:7860
依赖:  flask  (pip install -r requirements.txt)
配置:  config.json（名称 / 主题 / 中转站列表），页面里可改
"""
import base64
import json
import ssl
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = BASE_DIR / "outputs"
OUTPUT_DIR.mkdir(exist_ok=True)
CONFIG_PATH = BASE_DIR / "config.json"

DEFAULT_CONFIG = {
    "name": "拾光",
    "theme": "darkroom",
    "providers": [],
    "active_provider": "",
}
THEMES = ("darkroom", "ink", "paper")


def _new_id() -> str:
    return f"provider_{uuid.uuid4().hex[:8]}"


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
        for field, default in (("name", "未命名中转"), ("api_base", ""), ("api_key", ""), ("models", [])):
            if field not in p:
                p[field] = default
                changed = True
    ids = {p["id"] for p in cfg["providers"]}
    if cfg.get("active_provider") not in ids:
        cfg["active_provider"] = cfg["providers"][0]["id"] if cfg["providers"] else ""
        changed = True
    for legacy in ("api_base", "api_key"):
        if legacy in cfg:
            del cfg[legacy]
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
        detail = e.read().decode(errors="replace").strip()[:120]
        head = {
            401: "API Key 无效或已过期，请检查密钥是否填对",
            403: "没有访问权限（HTTP 403），请确认密钥可用或切换其他中转站",
            404: "接口不存在（HTTP 404），请检查中转站地址是否正确",
            429: "请求太频繁或额度不足（HTTP 429），请稍后再试",
        }.get(e.code, f"当前中转站不可用（HTTP {e.code}），请稍后重试或切换其他服务")
        return f"{head}｜{detail}" if detail else head
    if isinstance(e, urllib.error.URLError):
        reason = getattr(e, "reason", e)
        if isinstance(reason, TimeoutError):
            return "连接中转站超时，请检查网络后重试"
        return f"无法连接到中转站，请检查 API 地址与网络（{reason}）"
    if isinstance(e, TimeoutError):
        return "请求超时，模型可能正忙，请稍后再试或换个模型"
    return f"生成失败：{e}"


@app.get("/")
def index():
    return send_from_directory("static", "index.html")



# ---------- 设置 ----------
def settings_payload():
    return {
        "name": config["name"],
        "theme": config["theme"],
        "providers": config["providers"],
        "active_provider": config["active_provider"],
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
        return jsonify({"error": err}), 400
    pid = (body.get("id") or "").strip()
    if pid:
        target = next((p for p in config["providers"] if p["id"] == pid), None)
        if not target:
            return jsonify({"error": "中转站不存在"}), 404
        if target["api_base"] != fields["api_base"] or target["api_key"] != fields["api_key"]:
            target["models"] = []
            drop_models_cache(target["api_base"], target["api_key"])
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


# ---------- 生成 ----------
@app.post("/api/generate")
def generate():
    prov = active_provider()
    if not prov or not prov["api_base"] or not prov["api_key"]:
        return jsonify({"error": "还没有可用的中转站，请在设置里添加并填写地址和密钥"}), 400
    body = request.get_json(force=True)
    prompt = (body.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "提示词不能为空"}), 400
    payload = {
        "model": body.get("model") or "fal-gpt-image-2",
        "prompt": prompt,
        "n": 1,
        "size": body.get("size") or "1024x1024",
    }
    try:
        t0 = time.time()
        data = upstream("/v1/images/generations", payload, base=prov["api_base"], key=prov["api_key"])
    except Exception as e:
        return jsonify({"error": friendly_error(e)}), 502

    items = data.get("data") or []
    if not items:
        return jsonify({"error": f"上游未返回图片: {json.dumps(data, ensure_ascii=False)[:300]}"}), 502

    elapsed = round(time.time() - t0, 1)

    def _ext_from(content_type: str, url: str) -> str:
        ct = (content_type or "").lower()
        if "png" in ct: return ".png"
        if "jpeg" in ct or "jpg" in ct: return ".jpg"
        if "webp" in ct: return ".webp"
        if "gif" in ct: return ".gif"
        low = url.lower().split("?")[0]
        for e in (".png", ".jpg", ".jpeg", ".webp"):
            if low.endswith(e): return e
        return ".png"

    def _persist(name: str, blob: bytes, meta: dict):
        (OUTPUT_DIR / name).write_bytes(blob)
        (OUTPUT_DIR / f"{name}.json").write_text(
            json.dumps(meta, ensure_ascii=False), encoding="utf-8"
        )

    results = []
    for i, item in enumerate(items):
        meta = {
            "model": payload["model"],
            "provider": prov["name"],
            "elapsed": elapsed,
            "prompt": prompt,
            "size": payload["size"],
            "created": int(time.time()),
            "created_time": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        if item.get("b64_json"):
            name = f"{time.strftime('%Y%m%d_%H%M%S')}_{i}.webp"
            _persist(name, base64.b64decode(item["b64_json"]), meta)
            results.append({"url": f"/outputs/{name}", "name": name, **meta})
        elif item.get("url"):
            # URL 型结果：下载落盘，否则刷新后历史墙找不到文件、信息面板也无从展示
            req = urllib.request.Request(item["url"], headers={"User-Agent": "Mozilla/5.0"})
            try:
                blob, ct = _fetch(req, 120)
                name = f"{time.strftime('%Y%m%d_%H%M%S')}_{i}{_ext_from(ct, item['url'])}"
                _persist(name, blob, meta)
                results.append({"url": f"/outputs/{name}", "name": name, **meta})
            except Exception as e:
                # 下载失败时兜底透传远端链接（本次能看，但不进历史）
                results.append({"url": item["url"], "name": None, "fetch_error": friendly_error(e)})

    return jsonify(with_tls_note({"images": results, "elapsed": elapsed, "model": payload["model"],
                    "prompt": prompt, "provider": prov["name"]}))


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
            "elapsed": meta.get("elapsed"),
            "prompt": meta.get("prompt", ""),
            "size": meta.get("size", ""),
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
