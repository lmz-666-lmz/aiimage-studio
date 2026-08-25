# -*- coding: utf-8 -*-
"""拾光 · 本地生图工作台

运行:  python app.py  → 自动打开 http://127.0.0.1:7860
依赖:  flask  (pip install flask)
配置:  config.json（名称 / 主题 / 中转站地址 / 密钥），页面里可改
"""
import base64
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = BASE_DIR / "outputs"
OUTPUT_DIR.mkdir(exist_ok=True)
CONFIG_PATH = BASE_DIR / "config.json"

DEFAULT_CONFIG = {
    "name": "拾光",
    "theme": "darkroom",
    "api_base": "",
    "api_key": "",
}
THEMES = ("darkroom", "ink", "paper")

config = dict(DEFAULT_CONFIG)
if CONFIG_PATH.exists():
    try:
        config.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    except Exception:
        pass  # 配置文件损坏时回退默认


def save_config():
    CONFIG_PATH.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")


app = Flask(__name__, static_folder="static", static_url_path="/static")


def upstream(path: str, payload: dict | None = None, timeout: int = 300, base: str | None = None, key: str | None = None):
    base = (base or config["api_base"]).rstrip("/")
    headers = {
        "Authorization": f"Bearer {key or config['api_key']}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",  # 上游会 403 python-urllib 默认 UA
    }
    req = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers,
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


@app.get("/")
def index():
    return send_from_directory("static", "index.html")


# ---------- 设置 ----------
@app.get("/api/settings")
def get_settings():
    return jsonify(config)


@app.post("/api/settings")
def set_settings():
    """部分更新：只改请求里出现的字段。主题点击即存，API 信息用保存按钮。"""
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
    if "api_base" in body:
        api_base = (body.get("api_base") or "").strip().rstrip("/")
        if not api_base.startswith(("http://", "https://")):
            return jsonify({"error": "API 地址需以 http:// 或 https:// 开头"}), 400
        config["api_base"] = api_base
    if "api_key" in body:
        api_key = (body.get("api_key") or "").strip()
        if not api_key:
            return jsonify({"error": "密钥不能为空"}), 400
        config["api_key"] = api_key
    save_config()
    return jsonify(config)


@app.post("/api/test")
def test_conn():
    body = request.get_json(silent=True) or {}
    base = (body.get("api_base") or config["api_base"]).strip().rstrip("/")
    key = (body.get("api_key") or config["api_key"]).strip()
    if not base.startswith(("http://", "https://")):
        return jsonify({"ok": False, "error": "请先填写 API 地址"})
    if not key:
        return jsonify({"ok": False, "error": "请先填写密钥"})
    try:
        data = upstream("/v1/models", base=base, key=key, timeout=20)
        return jsonify({"ok": True, "models": len(data.get("data", []))})
    except urllib.error.HTTPError as e:
        return jsonify({"ok": False, "error": f"HTTP {e.code}: {e.read().decode(errors='replace')[:200]}"}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 200
_models_cache = {"key": None, "models": [], "ts": 0.0}


@app.get("/api/models")
def models():
    if not config["api_base"] or not config["api_key"]:
        return jsonify({"error": "请先在设置里填写 API 地址和密钥"}), 400
    now = time.time()
    cache_key = (config["api_base"], config["api_key"])
    if _models_cache["key"] == cache_key and now - _models_cache["ts"] < 600:
        return jsonify({"models": _models_cache["models"]})
    try:
        ids = [m["id"] for m in upstream("/v1/models").get("data", [])]
        kw = ("image", "banana", "seedream", "kling", "dall", "flux")
        result = sorted(i for i in ids if any(k in i.lower() for k in kw))
        _models_cache.update({"key": cache_key, "models": result, "ts": now})
        return jsonify({"models": result})
    except Exception as e:
        # 上游抖动时回退旧缓存，避免页面列表突然清空
        if _models_cache["key"] == cache_key and _models_cache["models"]:
            return jsonify({"models": _models_cache["models"]})
        return jsonify({"error": str(e)}), 502



@app.post("/api/generate")
def generate():
    if not config["api_base"] or not config["api_key"]:
        return jsonify({"error": "请先在设置里填写 API 地址和密钥"}), 400
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
        data = upstream("/v1/images/generations", payload)
    except urllib.error.HTTPError as e:
        return jsonify({"error": f"上游返回 {e.code}: {e.read().decode(errors='replace')[:300]}"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    items = data.get("data") or []
    if not items:
        return jsonify({"error": f"上游未返回图片: {json.dumps(data, ensure_ascii=False)[:300]}"}), 502

    elapsed = round(time.time() - t0, 1)
    results = []
    for i, item in enumerate(items):
        if item.get("b64_json"):
            name = f"{time.strftime('%Y%m%d_%H%M%S')}_{i}.webp"
            (OUTPUT_DIR / name).write_bytes(base64.b64decode(item["b64_json"]))
            meta = {
                "model": payload["model"],
                "elapsed": elapsed,
                "prompt": prompt,
                "size": payload["size"],
                "created": int(time.time()),
            }
            (OUTPUT_DIR / f"{name}.json").write_text(
                json.dumps(meta, ensure_ascii=False), encoding="utf-8"
            )
            results.append({"url": f"/outputs/{name}", "name": name, **meta})
        elif item.get("url"):
            results.append({"url": item["url"], "name": None})

    return jsonify({"images": results, "elapsed": elapsed, "model": payload["model"], "prompt": prompt})


@app.get("/api/history")
def history():
    page = max(1, request.args.get("page", 1, type=int))
    page_size = min(48, max(1, request.args.get("page_size", 12, type=int)))

    files = sorted(OUTPUT_DIR.glob("*.webp"), key=lambda p: p.name, reverse=True)
    total = len(files)
    pages = max(1, -(-total // page_size))
    page = min(page, pages)

    items = []
    for p in files[(page - 1) * page_size : page * page_size]:
        meta = {}
        sidecar = p.with_name(p.name + ".json")
        if sidecar.exists():
            try:
                meta = json.loads(sidecar.read_text(encoding="utf-8"))
            except Exception:
                pass
        items.append({
            "name": p.name,
            "url": f"/outputs/{p.name}",
            "mtime": p.stat().st_mtime,
            "model": meta.get("model", ""),
            "elapsed": meta.get("elapsed"),
            "prompt": meta.get("prompt", ""),
        })
    return jsonify({"items": items, "page": page, "pages": pages, "total": total})

@app.post("/api/delete")
def delete():
    name = (request.get_json(force=True).get("name") or "").strip()
    path = (OUTPUT_DIR / name).resolve()
    if not name or path.parent != OUTPUT_DIR or not path.exists():
        return jsonify({"error": "文件不存在"}), 404
    path.unlink()
    path.with_name(path.name + ".json").unlink(missing_ok=True)
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
