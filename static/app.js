/* 拾光 · 前端逻辑：生成 / 瀑布流分页与筛选 / 中转站管理 / 灯箱信息面板 / GSAP 动效 */
const $ = (id) => document.getElementById(id);

let busy = false;
let size = "1024x1024";
let page = 1, pages = 1, total = 0;
let modelList = [];
let providers = [];          // [{id,name,api_base,api_key,models}]
let activePid = "";
let capabilityDefs = {};
let capabilityMatchers = [
  ["gpt-image", "gpt-image"], ["dall-e", "dall-e"], ["nano-banana", "nano-banana"],
  ["banana", "banana"], ["gemini image", "gemini"], ["seedream", "seedream"],
  ["flux", "flux"], ["grok image", "grok"], ["image", "image"],
];
// 上限由后端 /api/settings 下发，避免前后端各写一份写死
let limits = { max_images: 4, max_references: 4, max_reference_mb: 10, max_prompt_chars: 8000 };
let referenceFiles = [];     // 多参考图：[{File}]，最多 limits.max_references 张
let refObjectUrls = [];      // 参考图缩略图的 objectURL，重渲染前回收
let editingPid = "";         // 正在编辑的中转站，空 = 新增
let wallItems = [];          // 当前墙上的图片（新→旧），供灯箱左右切换
const PAGE_SIZE = 12;
// 生成参数与草稿都记在本地：刷页面不用重设，符合反复打磨一张图的工作习惯
const SETTINGS_KEY = "is_gen_settings";
const DRAFT_KEY = "is_prompt_draft";
const SPEED_KEY = "is_model_speed";
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const gsapOK = typeof gsap !== "undefined" && !reduceMotion;

function showToast(text, type = "info") {
  const container = $("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("toast-fadeout");
    setTimeout(() => toast.remove(), 260);
  }, 2400);
}

/* ---------- 本地轻量记忆 ---------- */
const PROMPT_KEY = "is_prompt_history"; // Prompt 与中转站无关，全局一份

function recentKey() { // 最近使用的模型按中转站隔离，避免跨站选到不存在的模型
  return `is_recent_models:${activePid || "none"}`;
}

function lsGet(key, fallback = []) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* 隐私模式忽略 */ }
}
function pushPromptHistory(text) {
  const t = text.trim();
  if (!t) return;
  const list = lsGet(PROMPT_KEY).filter((p) => p !== t);
  list.unshift(t);
  lsSet(PROMPT_KEY, list.slice(0, 20));
  renderPromptHistory();
}
function pushRecentModel(name) {
  if (!name) return;
  const list = lsGet(recentKey()).filter((m) => m !== name);
  list.unshift(name);
  lsSet(recentKey(), list.slice(0, 5));
}

/* 默认模型：优先上次用过的，其次模型列表第一个（避免写死某个中转站的专有名字） */
function pickDefaultModel() {
  if (!modelList.length) return "";
  const remembered = lsGet(recentKey()).find((m) => modelList.includes(m));
  return remembered || modelList[0];
}

/* 侧栏状态：中转站名 + 健康点与延迟 + 状态胶囊 */
function renderRailProvider() {
  const el = $("rail-provider");
  if (!el) return;
  const p = providers.find((x) => x.id === activePid) || providers[0];
  const dot = $("rs-dot");
  const pingEl = $("rs-ping");
  if (!p) {
    el.textContent = "尚未连接中转站";
    el.classList.add("warn");
    el.title = "";
    if (dot) dot.className = "rs-dot";
    if (pingEl) { pingEl.textContent = "未配置"; pingEl.style.color = "var(--faint)"; }
    return;
  }
  el.classList.remove("warn");
  const health = (p.health || {}).status || "unchecked";
  el.textContent = p.name;
  el.title = `${p.api_base || ""}${p.has_key ? "" : " · 未填密钥"}`;
  if (dot) {
    dot.className = `rs-dot ${health}`;
    dot.title = healthLabel(p.health);
  }
  if (pingEl) {
    const ms = (p.health || {}).latency_ms;
    if (ms != null) {
      pingEl.textContent = `${ms}ms`;
      pingEl.style.color = ms < 800 ? "var(--success)" : ms < 2000 ? "var(--accent)" : "var(--danger)";
    } else {
      pingEl.textContent = healthLabel(p.health);
      pingEl.style.color = "";
    }
  }
}

/* 提示词整段就是一张图：字数与行数只作为参考信息，不做任何拆分 */
function setPrompt(text) {
  $("prompt").value = text || "";
  renderPromptMeta();
  saveDraft();
  renderRequestPreview(capabilityFor(modelInput?.value || ""));
}

function renderPromptMeta() {
  const el = $("prompt-meta");
  if (!el) return;
  const v = $("prompt").value;
  const chars = v.trim().length;
  const max = limits.max_prompt_chars || 8000;
  el.textContent = `${chars} / ${max} 字`;
  el.style.color = chars > max ? "var(--danger)" : chars > max * 0.85 ? "var(--accent)" : "";
}

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, $("prompt").value); } catch { /* 忽略 */ }
}

function loadDraft() {
  try { return localStorage.getItem(DRAFT_KEY) || ""; } catch { return ""; }
}

/* 各模型出图速度：用历史耗时算平均，用来预估等待时间 */
function speedMap() { return lsGet(SPEED_KEY, {}); }

function noteSpeed(model, secs) {
  if (!model || !secs) return;
  const map = speedMap();
  map[model] = (map[model] || []).concat([Math.round(secs)]).slice(-8);
  lsSet(SPEED_KEY, map);
}

function avgSpeed(model) {
  const arr = speedMap()[model] || [];
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function humanDuration(secs) {
  const s = Math.max(1, Math.round(secs));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分钟`;
}

/* 预计耗时：单张均值 × 张数；没有历史数据时给一个保守提示 */
function estimateSeconds(model, count) {
  const avg = avgSpeed(model);
  if (!avg) return null;
  return avg * count;
}

function renderPromptHistory() {
  const list = lsGet(PROMPT_KEY);
  const field = $("prompt-history-field");
  const box = $("prompt-history");
  field.hidden = !list.length;
  box.innerHTML = "";
  for (const p of list.slice(0, 8)) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.tabIndex = 0;
    chip.setAttribute("role", "button");
    chip.title = p;
    chip.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPrompt(p); $("prompt").focus(); }
    });
    const txt = document.createElement("span");
    txt.className = "chip-text";
    txt.textContent = p;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "chip-del";
    del.textContent = "✕";
    del.title = "删除这条";
    del.setAttribute("aria-label", "删除这条 Prompt 历史");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      lsSet(PROMPT_KEY, lsGet(PROMPT_KEY).filter((t) => t !== p));
      renderPromptHistory();
    });
    chip.append(txt, del);
    chip.addEventListener("click", () => { setPrompt(p); $("prompt").focus(); });
    box.appendChild(chip);
  }
}

$("ph-clear").addEventListener("click", () => {
  if (!lsGet(PROMPT_KEY).length) return;
  if (!confirm("清空全部历史提示词？（不影响已生成的图片）")) return;
  lsSet(PROMPT_KEY, []);
  renderPromptHistory();
});

$("prompt-clear").addEventListener("click", () => {
  if (!$("prompt").value.trim()) return;
  setPrompt("");
  $("prompt").focus();
  showToast("已清空提示词", "info");
});

/* ---------- GSAP 动效 ---------- */
function enterCard(el, delay = 0) {
  if (!gsapOK) return;
  gsap.from(el, { y: 26, autoAlpha: 0, scale: 0.96, duration: 0.55, delay, ease: "power3.out", clearProps: "all" });
}

function enterRail() {
  if (!gsapOK) return;
  gsap.from(".rail > *", { x: -24, autoAlpha: 0, duration: 0.5, stagger: 0.06, ease: "power3.out", clearProps: "all" });
}

function themePulse() {
  if (!gsapOK) return;
  gsap.fromTo("body", { autoAlpha: 0.82 }, { autoAlpha: 1, duration: 0.35, ease: "power1.out", clearProps: "opacity,visibility" });
}

/* ---------- 设置 ---------- */
async function loadSettings() {
  try {
    const s = await (await fetch("/api/settings")).json();
    applyIdentity(s.name, s.theme);
    $("set-name").value = s.name;
    providers = s.providers || [];
    activePid = s.active_provider || "";
    if (s.limits) limits = { ...limits, ...s.limits };
    $("failover-toggle").checked = !!s.failover_enabled;
    renderQuantityGroup();
    renderRailProvider();
    $("set-version").textContent = `v${s.version || "—"}`;
    $("set-limits").textContent =
      `· 一条提示词最多 ${limits.max_images} 张 · 参考图 ${limits.max_references} 张/${limits.max_reference_mb}MB · 提示词上限 ${limits.max_prompt_chars} 字`;
    renderProviders();
    markTheme(s.theme);
    const noApi = !providers.length;
    $("need-api").hidden = !noApi;
    if (noApi && $("settings").hidden) {
      $("settings").hidden = false; // 首次使用直接带出设置
      $("set-msg").textContent = "先添加一个 API 中转站，保存后即可生图";
      openProviderForm("");
    }
  } catch { /* 用默认值 */ }
}

async function loadCapabilities() {
  try {
    const d = await (await fetch("/api/capabilities")).json();
    capabilityDefs = d.capabilities || {};
    if (Array.isArray(d.matchers) && d.matchers.length) capabilityMatchers = d.matchers;
    if (Array.isArray(d.size_library) && d.size_library.length) sizeLibrary = d.size_library;
  } catch { capabilityDefs = {}; }
  updateCapabilityUI();
}

function applyIdentity(name, t) {
  if (name) {
    $("app-name").textContent = name;
    document.title = `${name} · 生图`;
  }
  if (t) document.documentElement.dataset.theme = t;
}

function capabilityFor(model) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[-_]/g, " ");
  const name = norm(model);
  for (const [key, matcher] of capabilityMatchers) {
    if (capabilityDefs[key] && name.includes(norm(matcher))) return { ...capabilityDefs[key], key };
  }
  return {
    ...(capabilityDefs.generic || {
      family: "Generic OpenAI Compatible", text_to_image: true, image_to_image: true,
      supported_sizes: ["1024x1024", "1536x1024", "1024x1536"], n: true, n_mode: "upstream",
    }), key: "generic",
  };
}

const PARAM_LABELS = { low: "低", medium: "中", high: "高", standard: "标清", hd: "高清",
  auto: "自动", transparent: "透明", opaque: "不透明", vivid: "鲜明", natural: "自然" };

function rebuildOptions(sel, values) {
  if (!sel || !values) return; // 未声明值集 = 沿用现有选项
  const keep = sel.value;
  sel.innerHTML = '<option value="">默认</option>' +
    values.map((v) => `<option value="${v}">${PARAM_LABELS[v] || v}</option>`).join("");
  sel.value = values.includes(keep) ? keep : "";
}

/* ---------- 生成数量：按钮组 + 参数说明 ---------- */
function currentN() {
  const max = Math.max(1, Math.min(8, limits.max_images || 4));
  const v = parseInt($("n")?.value, 10);
  return Number.isFinite(v) ? Math.max(1, Math.min(max, v)) : 1;
}

function markQuantity(v) {
  document.querySelectorAll("#n-group .n-btn").forEach((b) => {
    const on = +b.dataset.n === v;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
}

function setQuantity(v) {
  if ($("n")) $("n").value = String(v);
  markQuantity(v);
  saveGenSettings();
  updateCapabilityUI();
}

function renderQuantityGroup() {
  const box = $("n-group");
  if (!box) return;
  const max = Math.max(1, Math.min(8, limits.max_images || 4));
  if (box.dataset.max !== String(max)) {
    box.dataset.max = String(max);
    box.innerHTML = "";
    for (let i = 1; i <= max; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "n-btn";
      b.dataset.n = String(i);
      b.setAttribute("role", "radio");
      b.setAttribute("aria-label", `生成 ${i} 张`);
      b.textContent = String(i);
      b.addEventListener("click", () => setQuantity(i));
      box.appendChild(b);
    }
  }
  markQuantity(currentN());
}

function labelOf(sel) {
  const o = sel?.selectedOptions?.[0];
  return o ? o.textContent.trim() : "";
}

/* ---------- 画幅：按比例画小方框 ---------- */
// 后端 /api/capabilities 下发的通用画幅库；中转站按 WxH 透传，官方尺寸会额外标记
let sizeLibrary = [
  { size: "1024x1024", ratio: "1:1", group: "方" },
  { size: "1280x1024", ratio: "5:4", group: "横" },
  { size: "1344x1008", ratio: "4:3", group: "横" },
  { size: "1536x1024", ratio: "3:2", group: "横" },
  { size: "1536x864", ratio: "16:9", group: "横" },
  { size: "1536x768", ratio: "2:1", group: "宽幅" },
  { size: "1680x720", ratio: "21:9", group: "宽幅" },
  { size: "1536x512", ratio: "3:1", group: "宽幅" },
  { size: "1024x1280", ratio: "4:5", group: "竖" },
  { size: "1008x1344", ratio: "3:4", group: "竖" },
  { size: "1024x1536", ratio: "2:3", group: "竖" },
  { size: "864x1536", ratio: "9:16", group: "竖" },
  { size: "768x1536", ratio: "1:2", group: "长幅" },
  { size: "720x1680", ratio: "9:21", group: "长幅" },
];
let ratioFilter = "全部";

function ratioLabel(w, h) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h) || 1;
  return `${w / g}:${h / g}`;
}

/* 该模型能选的画幅：官方固定尺寸的只给官方；其余给整套比例库并标出官方项 */
function ratioPool(cap) {
  const official = cap.supported_sizes || [];
  if (!official.length) return [];
  if (cap.size_mode === "fixed") {
    return official.map((s) => {
      const [w, h] = s.split("x").map(Number);
      return { size: s, ratio: ratioLabel(w, h), group: "官方", official: true };
    });
  }
  const known = new Map(official.map((s) => [s, true]));
  const pool = sizeLibrary.map((e) => ({ ...e, official: known.has(e.size) }));
  // 官方尺寸若不在库里（各家中转站可能不同），补进来
  for (const s of official) {
    if (!pool.some((e) => e.size === s)) {
      const [w, h] = s.split("x").map(Number);
      pool.unshift({ size: s, ratio: ratioLabel(w, h), group: "官方", official: true });
    }
  }
  return pool;
}

function renderRatioGroup(cap) {
  const box = $("ratio-group");
  const filterBox = $("ratio-groups");
  if (!box) return;
  const pool = ratioPool(cap);
  const groups = ["全部", ...new Set(pool.map((e) => e.group))];
  if (!groups.includes(ratioFilter)) ratioFilter = "全部";

  if (filterBox) {
    filterBox.hidden = groups.length <= 2;
    filterBox.innerHTML = groups
      .map((g) => `<button type="button" class="ratio-tab${g === ratioFilter ? " on" : ""}" data-group="${g}">${g}</button>`)
      .join("");
    filterBox.querySelectorAll(".ratio-tab").forEach((b) => {
      b.addEventListener("click", () => { ratioFilter = b.dataset.group; renderRatioGroup(cap); });
    });
  }

  const shown = ratioFilter === "全部" ? pool : pool.filter((e) => e.group === ratioFilter);
  const key = `${shown.map((e) => e.size + (e.official ? "*" : "")).join("|")}#${ratioFilter}`;
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = "";
    for (const entry of shown) {
      const [w, h] = entry.size.split("x").map(Number);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ratio" + (entry.official ? " official" : "");
      btn.dataset.size = entry.size;
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", "false");
      btn.title = `${entry.size} · ${entry.ratio}${entry.official ? "（该模型官方尺寸）" : "（由中转站按原样接收）"}`;
      const scale = Math.min(30 / w, 22 / h);
      const shape = document.createElement("span");
      shape.className = "ratio-shape";
      shape.style.width = `${Math.max(9, Math.round(w * scale))}px`;
      shape.style.height = `${Math.max(9, Math.round(h * scale))}px`;
      const label = document.createElement("span");
      label.className = "ratio-label";
      label.textContent = entry.ratio;
      const px = document.createElement("span");
      px.className = "ratio-px";
      px.textContent = entry.size.replace("x", "×");
      btn.append(shape, label, px);
      btn.addEventListener("click", () => selectSize(entry.size));
      box.appendChild(btn);
    }
  }
  // 当前尺寸若不在该模型的可选范围内，退回官方第一个
  const allowed = pool.map((e) => e.size);
  if (allowed.length && !allowed.includes(size) && !(sizeCustom && sizeCustom.value.trim())) {
    size = allowed.find((s) => (cap.supported_sizes || []).includes(s)) || allowed[0];
  }
  markRatio();
}

function markRatio() {
  document.querySelectorAll("#ratio-group .ratio").forEach((b) => {
    const on = b.dataset.size === size;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
}

function isOfficialSize(cap, value) {
  return (cap.supported_sizes || []).includes(value);
}

function selectSize(v) {
  size = v;
  if (sizeCustom) { sizeCustom.value = ""; sizeCustom.classList.remove("invalid"); }
  markRatio();
  const cap = capabilityFor(modelInput?.value || "");
  const [w, h] = v.split("x").map(Number);
  setSizeHint(`${v.replace("x", "×")} · ${ratioLabel(w, h)}${isOfficialSize(cap, v) ? " · 官方" : ""}`);
  saveGenSettings();
  renderRequestPreview(cap);
}

/* 「本次将发送」：一行参数 + 一行代价，控制在两行内 */
function renderRequestPreview(cap) {
  const box = $("req-preview");
  if (!box) return;
  const model = (modelInput?.value || "").trim();
  if (!model) { box.hidden = true; return; }
  const n = currentN();
  const parts = [];
  const notes = [];

  parts.push(model);
  if ((cap.supported_sizes || []).length) parts.push(`${size.replace("x", "×")} ${ratioLabel(...size.split("x").map(Number))}`);
  else notes.push("该模型族不接收画幅");

  parts.push(n > 1 ? `${n} 张` : "1 张");
  if (n > 1 && cap.n) {
    parts.push(cap.n_mode === "local" ? `分 ${n} 次请求` : "不足自动补齐");
  } else if (n > 1) {
    notes.push("该模型族不支持多张");
  }

  const skipped = [];
  for (const [key, name] of [["quality", "质量"], ["background", "背景"], ["style", "风格"]]) {
    if (!cap[key]) { skipped.push(name); continue; }
    const val = labelOf($(key));
    if (val && val !== "默认") parts.push(`${name} ${val}`);
  }
  if (skipped.length) notes.push(`该模型族不接收：${skipped.join(" / ")}`);

  parts.push(referenceFiles.length ? `图生图 ${referenceFiles.length} 张参考图` : "文生图");

  const secs = estimateSeconds(model, n);
  const est = secs
    ? `预计约 ${humanDuration(secs)}（按该模型近期平均 ${humanDuration(secs / n)}/张）`
    : n > 1 ? `首次生成没有耗时记录，可能较慢` : "";
  if (cap.notes && n > 1) notes.push(cap.notes);

  box.innerHTML =
    `<div class="req-line">${escapeHtml(parts.join(" · "))}</div>` +
    (est || notes.length
      ? `<div class="req-sub">${est ? `<span class="est">${escapeHtml(est)}</span>` : ""}` +
        `${est && notes.length ? " · " : ""}${escapeHtml(notes.join(" · "))}</div>`
      : "");
  box.hidden = false;
}

function renderAdvSummary(cap) {
  const el = $("adv-summary");
  if (!el) return;
  const active = [];
  for (const [key, name] of [["quality", "质量"], ["background", "背景"], ["style", "风格"]]) {
    if (!cap[key]) continue;
    const val = labelOf($(key));
    if (val && val !== "默认") active.push(`${name} ${val}`);
  }
  el.textContent = active.length ? active.join(" · ") : "默认";
}

function updateCapabilityUI() {
  const cap = capabilityFor(modelInput?.value || "");
  $("capability-label").textContent = cap.family || "Generic OpenAI Compatible";
  ["quality", "background", "style", "n"].forEach((key) => {
    const row = $(`${key}-param`);
    if (row) row.hidden = key === "n" ? !cap.n : !cap[key];
  });
  rebuildOptions($("quality"), cap.quality_values);
  rebuildOptions($("background"), cap.background_values);
  rebuildOptions($("style"), cap.style_values);

  const sizeField = $("size-field");
  if (sizeField) sizeField.hidden = !(cap.supported_sizes || []).length;
  renderRatioGroup(cap);
  if (sizeField && !sizeField.hidden) {
    const [w, h] = size.split("x").map(Number);
    if (!sizeCustom || !sizeCustom.value.trim()) {
      setSizeHint(`${size.replace("x", "×")} · ${ratioLabel(w, h)}${isOfficialSize(cap, size) ? " · 官方" : ""}`);
    }
  }

  const n = currentN();
  const nHint = $("n-hint");
  if (nHint) {
    nHint.textContent = !cap.n ? "该模型族只出 1 张"
      : n > 1 ? (cap.n_mode === "local" ? `将分 ${n} 次请求` : "上游不足会自动补齐")
      : "整段提示词出 1 张";
  }

  $("param-note").textContent = cap.notes || "";
  renderAdvSummary(cap);
  renderReferenceNote(cap);
  renderRequestPreview(cap);
}

function renderReferenceNote(cap) {
  const note = $("reference-note");
  if (!note) return;
  const cap2 = cap || capabilityFor(modelInput?.value || "");
  const supported = cap2.image_to_image || cap2.key === "generic";
  const btn = $("reference-add");
  if (btn) {
    btn.classList.toggle("disabled", !supported);
    btn.title = supported ? "添加参考图" : "当前模型族暂不支持参考图";
  }
  if (!supported) { note.textContent = "当前模型族暂不支持参考图"; return; }
  note.textContent = referenceFiles.length
    ? `图生图模式 · 已选 ${referenceFiles.length}/${limits.max_references} 张`
    : `拖入或粘贴图片，最多 ${limits.max_references} 张`;
}

function markTheme(t) {
  document.querySelectorAll(".theme-btn").forEach((b) => b.classList.toggle("on", b.dataset.theme === t));
}

/* ---------- 中转站管理 ---------- */
function maskKey(key) {
  if (!key) return "未填写";
  return key.length > 12 ? `${key.slice(0, 5)}••••${key.slice(-4)}` : "••••";
}

function renderProviders() {
  const box = $("provider-list");
  box.innerHTML = "";
  if (!providers.length) {
    box.innerHTML = '<p class="prov-empty">还没有中转站，点下方按钮添加。</p>';
    return;
  }
  for (const p of providers) {
    const card = document.createElement("div");
    card.className = "prov-card" + (p.id === activePid ? " on" : "");
    const isActive = p.id === activePid;
    card.innerHTML = `
      <div class="prov-head">
        <span class="prov-name">${escapeHtml(p.name)}</span>
        ${isActive ? '<span class="prov-tag">使用中</span>' : ""}
        <span style="flex:1"></span>
        <span class="prov-health ${(p.health || {}).status || "unchecked"}">${healthLabel(p.health)}</span>
        <button class="prov-btn use ${isActive ? "on" : ""}" ${isActive ? "disabled" : ""}>${isActive ? "使用中" : "使用"}</button>
        <button class="prov-btn edit">编辑</button>
        <button class="prov-btn danger del">删除</button>
      </div>
      <div class="prov-facts">
        <span><b>地址</b>${escapeHtml(p.api_base || "未填写")}</span>
        <span><b>Key</b>${p.has_key ? "已保存（仅本机可见）" : "未填写"}</span>
        <span><b>模型</b>${(p.models || []).length} 个</span>
      </div>`;
    card.querySelector(".use").addEventListener("click", () => activateProvider(p.id));
    card.querySelector(".edit").addEventListener("click", () => openProviderForm(p.id));
    card.querySelector(".del").addEventListener("click", () => deleteProvider(p.id, p.name));
    box.appendChild(card);
  }
}

function healthLabel(health) {
  const h = health || {};
  const names = { unchecked: "未检测", healthy: "正常", slow: "较慢", rate_limited: "限流", unavailable: "不可用" };
  return `${names[h.status] || "未检测"}${h.latency_ms != null ? ` ${h.latency_ms}ms` : ""}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function openProviderForm(pid) {
  editingPid = pid;
  const p = providers.find((x) => x.id === pid);
  $("provider-form").hidden = false;
  $("pf-name").value = p ? p.name : "";
  $("pf-base").value = p ? p.api_base : "";
  $("pf-key").value = "";
  $("pf-key").placeholder = p?.has_key ? "已保存，留空则保持不变" : "sk-…";
  $("pf-name").focus();
}

function closeProviderForm() {
  editingPid = "";
  $("provider-form").hidden = true;
}

function setMsg(text, cls = "") {
  const m = $("set-msg");
  m.className = "set-msg" + (cls ? ` ${cls}` : "");
  m.textContent = text || "";
}

$("provider-add").addEventListener("click", () => openProviderForm(""));
$("pf-cancel").addEventListener("click", closeProviderForm);

$("pf-save").addEventListener("click", async () => {
  setMsg("保存中…");
  const wasEdit = !!editingPid;
  try {
    const r = await fetch("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: editingPid || undefined,
        name: $("pf-name").value.trim(),
        api_base: $("pf-base").value.trim(),
        api_key: $("pf-key").value.trim(),
      }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    providers = d.providers || [];
    activePid = d.active_provider || "";
    renderProviders();
    closeProviderForm();
    setMsg(wasEdit ? "中转站已更新" : "中转站已添加并启用", "ok");
    $("need-api").hidden = !!providers.length;
    await loadModels(); // 模型拉取结果只反映在输入框占位符，不覆盖上面的成功提示
  } catch (e) { setMsg(e.message, "err"); }
});

$("pf-test").addEventListener("click", async () => {
  setMsg("连接中…");
  try {
    const r = await fetch("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_base: $("pf-base").value.trim(),
        api_key: $("pf-key").value.trim(),
      }),
    });
    const d = await r.json();
    if (d.ok) { setMsg(`连接成功，${d.models} 个模型`, "ok"); }
    else setMsg("失败：" + d.error, "err");
  } catch (e) { setMsg(e.message, "err"); }
});

async function activateProvider(pid) {
  setMsg("切换中转站…");
  try {
    const r = await fetch("/api/providers/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: pid }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    providers = d.providers || [];
    activePid = d.active_provider || "";
    renderProviders();
    modelList = d.models || [];
    modelsLoading = false;
    modelInput.placeholder = modelList.length ? "输入筛选或直接填写模型名" : "未发现生图模型，可手动填写";
    if (modelList.length) modelInput.value = pickDefaultModel();
    if (!modelListBox.hidden) renderModelList();
    updateCapabilityUI();
    renderRailProvider();
    setMsg(d.warning ? `已切换，但拉取模型失败：${d.warning}` : "已切换，模型列表已刷新", d.warning ? "err" : "ok");
  } catch (e) { setMsg(e.message, "err"); }
}

async function refreshHealth(force = false) {
  setMsg("检测中…");
  try {
    // 一次请求探测全部线路（后端并行执行），响应里附带最新 settings
    const r = await fetch("/api/providers/health", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }) });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    if (d.settings) {
      providers = d.settings.providers || providers;
      if (d.settings.active_provider !== undefined) activePid = d.settings.active_provider;
      renderRailProvider();
    }
    renderProviders();
    setMsg("健康状态已更新", "ok");
  } catch (e) { setMsg("健康检测失败：" + e.message, "err"); }
}

async function deleteProvider(pid, name) {
  if (!confirm(`删除中转站「${name}」？不会删除已生成的图片。`)) return;
  try {
    const r = await fetch("/api/providers/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: pid }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const wasActive = pid === activePid;
    providers = d.providers || [];
    activePid = d.active_provider || "";
    renderProviders();
    setMsg(`已删除「${name}」`, "ok");
    if (wasActive) loadModels();
  } catch (e) { setMsg(e.message, "err"); }
}

/* ---------- 名称与主题 ---------- */
$("name-save").addEventListener("click", async () => {
  setMsg("保存中…");
  try {
    const r = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: $("set-name").value.trim() }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    applyIdentity(d.name, null);
    setMsg("名称已保存", "ok");
  } catch (e) { setMsg(e.message, "err"); }
});

$("set-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("name-save").click(); });

document.querySelectorAll(".theme-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const t = btn.dataset.theme;
    markTheme(t);
    applyIdentity(null, t);
    themePulse();
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: t }),
      });
    } catch { /* 下次再存 */ }
  });
});

const settingsEl = $("settings");
$("open-settings").addEventListener("click", () => { settingsEl.hidden = false; setMsg(""); refreshHealth(false); });
$("set-close").addEventListener("click", () => { settingsEl.hidden = true; closeProviderForm(); loadSettings(); });
settingsEl.addEventListener("click", (e) => { if (e.target === settingsEl) { settingsEl.hidden = true; closeProviderForm(); loadSettings(); } });
$("failover-toggle").addEventListener("change", async (e) => {
  try {
    const r = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ failover_enabled: e.target.checked }) });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    setMsg(e.target.checked ? "备用线路已开启" : "备用线路已关闭", "ok");
  } catch (err) { e.target.checked = !e.target.checked; setMsg(err.message, "err"); }
});
$("health-refresh").addEventListener("click", () => refreshHealth(true));

/* ---------- 可搜索模型下拉（含最近使用） ---------- */
const modelInput = $("model");
const modelListBox = $("model-list");

let modelsLoading = false;

function renderModelList(filter = "") {
  if (modelsLoading) {
    modelListBox.innerHTML = '<div class="none">模型列表加载中…</div>';
    modelListBox.hidden = false;
    return;
  }
  const kw = filter.trim().toLowerCase();
  const hits = kw ? modelList.filter((m) => m.toLowerCase().includes(kw)) : modelList;
  const recents = lsGet(recentKey()).filter((m) => !kw || m.toLowerCase().includes(kw));
  const parts = [];
  if (recents.length) {
    parts.push('<div class="combo-group">最近使用</div>');
    for (const m of recents) parts.push(`<button class="opt${m === modelInput.value ? " hot" : ""}" type="button">↻ ${escapeHtml(m)}</button>`);
  }
  const rest = hits.filter((m) => !recents.includes(m));
  if (rest.length) {
    if (recents.length) parts.push('<div class="combo-group">全部模型</div>');
    for (const m of rest) parts.push(`<button class="opt${m === modelInput.value ? " hot" : ""}" type="button">${escapeHtml(m)}</button>`);
  }
  modelListBox.innerHTML = parts.length
    ? parts.join("")
    : `<div class="none">${modelList.length ? "没有匹配的模型，可直接使用输入的名称" : "未加载到模型，可直接输入名称"}</div>`;
  modelListBox.hidden = false;
}

modelInput.addEventListener("focus", () => renderModelList(modelInput.value && modelList.some((m) => m === modelInput.value) ? "" : modelInput.value));
modelInput.addEventListener("input", () => { renderModelList(modelInput.value); updateCapabilityUI(); renderRailProvider(); });

$("model-combo").querySelector(".combo-toggle").addEventListener("click", () => {
  if (modelListBox.hidden) renderModelList();
  else modelListBox.hidden = true;
});

modelListBox.addEventListener("click", (e) => {
  const opt = e.target.closest(".opt");
  if (!opt) return;
  modelInput.value = opt.textContent.replace(/^↻\s*/, "");
  modelListBox.hidden = true;
  updateCapabilityUI();
  renderRailProvider();
});

document.addEventListener("click", (e) => {
  if (!$("model-combo").contains(e.target)) modelListBox.hidden = true;
});

async function loadModels() {
  modelsLoading = true;
  modelInput.value = "";
  modelInput.placeholder = "加载中…";
  modelList = [];
  try {
    const d = await (await fetch("/api/models")).json();
    modelList = d.models || [];
    modelsLoading = false;
    if (d.warning) showToast(d.warning, "error");
    if (d.error && !modelList.length) {
      modelInput.placeholder = "未配置 API，可手动填写模型名";
    } else {
      modelInput.placeholder = modelList.length ? "输入筛选或直接填写模型名" : "未发现生图模型，可手动填写";
      if (modelList.length) modelInput.value = pickDefaultModel();
    }
  } catch {
    modelsLoading = false;
    modelInput.placeholder = "未配置 API，可手动填写模型名";
  }
  if (!modelListBox.hidden) renderModelList(); // 渲染完整列表，不按默认选中名过滤
  updateCapabilityUI();
  renderRailProvider();
}

/* ---------- 历史墙：分页 + 筛选 ---------- */
function renderPager() {
  const pager = $("pager");
  if (!total) { pager.hidden = true; return; }
  pager.hidden = false;
  $("pg-info").textContent = `共 ${total} 张 · 每页 ${PAGE_SIZE} 张 · 第 ${page} / ${pages} 页`;
  const multi = pages > 1;
  $("pg-controls").hidden = !multi;
  if (!multi) return;
  const nums = [];
  const add = (p, label, cls) => nums.push(`<button class="pg-btn ${cls || ""}" data-p="${p}">${label || p}</button>`);
  const dots = () => nums.push('<span class="pg-dots">…</span>');
  add(1, null, page === 1 ? "cur" : "");
  if (page > 3) dots();
  for (let p = Math.max(2, page - 1); p <= Math.min(pages - 1, page + 1); p++) add(p, null, p === page ? "cur" : "");
  if (page < pages - 2) dots();
  if (pages > 1) add(pages, null, page === pages ? "cur" : "");
  $("pg-nums").innerHTML = nums.join("");
  $("pg-prev").disabled = page <= 1;
  $("pg-next").disabled = page >= pages;
  $("pg-first").disabled = page <= 1;
  $("pg-last").disabled = page >= pages;
  $("pg-input").max = pages;
}

function fillSelect(sel, values, allLabel) {
  const cur = sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` +
    values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function filterQuery() {
  const p = new URLSearchParams();
  if ($("f-q").value.trim()) p.set("q", $("f-q").value.trim());
  if ($("f-model").value) p.set("model", $("f-model").value);
  if ($("f-provider").value) p.set("provider", $("f-provider").value);
  if ($("f-range").value !== "all") p.set("range", $("f-range").value);
  if ($("f-sort") && $("f-sort").value !== "newest") p.set("sort", $("f-sort").value);
  if (onlyFav) p.set("favorite", "1");
  return p.toString();
}

async function loadHistory(p = page) {
  try {
    const qs = filterQuery();
    const d = await (await fetch(`/api/history?page=${p}&page_size=${PAGE_SIZE}&${qs}`)).json();
    page = d.page; pages = d.pages; total = d.total;
    wallItems = d.items.map((it) => ({ ...it }));
    const wallCountEl = $("wall-count");
    if (wallCountEl) wallCountEl.textContent = `共 ${total} 幅作品`;
    fillSelect($("f-model"), d.facets.models, "全部模型");
    fillSelect($("f-provider"), d.facets.providers, "全部来源");
    const g = $("gallery");
    g.innerHTML = "";
    for (const item of d.items) g.appendChild(makeCard(item, false));
    const empty = $("empty");
    if (empty) empty.hidden = !!d.items.length;
    renderPager();
    // 用历史耗时给没记录过的模型补一个速度参考，用来预估等待时间
    const known = speedMap();
    for (const it of d.items) {
      if (it.model && it.elapsed > 0 && !(known[it.model] || []).length) {
        noteSpeed(it.model, it.elapsed);
        known[it.model] = [it.elapsed];
      }
    }
    renderRequestPreview(capabilityFor(modelInput.value));
    if (gsapOK && d.items.length) {
      gsap.from("#gallery .print", { y: 24, autoAlpha: 0, duration: 0.5, stagger: 0.05, ease: "power3.out", clearProps: "all" });
    }
    document.querySelector(".wall").scrollTo({ top: 0 });
  } catch { /* 加载失败不阻塞 */ }
}

$("pager").addEventListener("click", (e) => {
  const b = e.target.closest("[data-p]");
  if (b) { loadHistory(+b.dataset.p); return; }
  if (e.target === $("pg-prev")) loadHistory(page - 1);
  if (e.target === $("pg-next")) loadHistory(page + 1);
  if (e.target === $("pg-first")) loadHistory(1);
  if (e.target === $("pg-last")) loadHistory(pages);
});

$("pg-go").addEventListener("click", () => {
  const v = Math.min(pages, Math.max(1, +$("pg-input").value || 1));
  loadHistory(v);
});

$("pg-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("pg-go").click(); });

/* 筛选控件 */
let searchDebounce = null;
$("f-q").addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => loadHistory(1), 250);
});
for (const id of ["f-model", "f-provider", "f-range", "f-sort"]) {
  $(id).addEventListener("change", () => loadHistory(1));
}

/* 只看收藏 */
let onlyFav = false;
$("f-fav").addEventListener("click", () => {
  onlyFav = !onlyFav;
  $("f-fav").classList.toggle("on", onlyFav);
  $("f-fav").setAttribute("aria-pressed", String(onlyFav));
  $("f-fav").innerHTML = onlyFav ? '<span class="ft-star">★</span> 收藏中' : '<span class="ft-star">★</span> 收藏';
  loadHistory(1);
});

/* 批量管理 */
let batchMode = false;
const selected = new Set();

function updateBatchCount() { $("batch-count").textContent = `已选 ${selected.size} 张`; }

function setBatchMode(on) {
  batchMode = on;
  selected.clear();
  document.body.classList.toggle("batch-mode", on);
  $("f-batch").classList.toggle("on", on);
  $("f-batch").setAttribute("aria-pressed", String(on));
  $("batch-bar").hidden = !on;
  document.querySelectorAll("#gallery .print").forEach((c) => c.classList.remove("selected"));
  updateBatchCount();
  if (on) showToast("已开启批量管理，点击图片可多选", "info");
}

function toggleSelect(card, item) {
  if (selected.has(item.name)) { selected.delete(item.name); card.classList.remove("selected"); }
  else { selected.add(item.name); card.classList.add("selected"); }
  updateBatchCount();
}

$("f-batch").addEventListener("click", () => setBatchMode(!batchMode));
$("batch-exit").addEventListener("click", () => setBatchMode(false));
$("batch-all").addEventListener("click", () => {
  wallItems.forEach((it) => { if (it.name) selected.add(it.name); });
  document.querySelectorAll("#gallery .print").forEach((c) => c.classList.add("selected"));
  updateBatchCount();
  showToast(`已全选当前页共 ${selected.size} 张照片`, "info");
});
$("batch-del").addEventListener("click", async () => {
  const names = [...selected];
  if (!names.length) { setGenMsg("先点击图片勾选要删除的照片"); showToast("请先点击图片勾选要删除的照片", "error"); return; }
  if (!confirm(`删除所选 ${names.length} 张照片？文件会从 outputs 里移除。`)) return;
  try {
    const r = await fetch("/api/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    selected.clear();
    updateBatchCount();
    setGenMsg(`已删除 ${d.deleted} 张`);
    showToast(`成功删除 ${d.deleted} 张照片`, "success");
    loadHistory(page);
  } catch (e) { setGenMsg("删除失败：" + e.message); showToast("删除失败：" + e.message, "error"); }
});

/* ---------- 卡片复用全部参数 ---------- */
function reuseParamsFromItem(item) {
  if (!item) return;
  const done = [];
  if (item.prompt) { setPrompt(item.prompt); done.push("提示词"); }
  if (item.model) { modelInput.value = item.model; done.push("模型"); }
  if (item.size && SIZE_RE.test(item.size)) {
    size = item.size;
    if (sizeCustom) { sizeCustom.value = ""; sizeCustom.classList.remove("invalid"); }
    done.push("画幅");
  }
  for (const key of ["quality", "background", "style"]) {
    const v = item[key] || "";
    if ([...$(key).options].some((o) => o.value === v)) {
      $(key).value = v;
      if (v) done.push(PARAM_LABELS[v] || v);
    }
  }
  saveGenSettings();
  updateCapabilityUI();
  renderRailProvider();
  $("prompt").focus();
  setGenMsg(done.length ? `已复用：${done.join("、")}` : "这张图没有可复用的参数");
  if (done.length) showToast(`已复用参数：${done.join(" / ")}`, "success");
}

/* ---------- 艺术画幅卡片 ---------- */
function makeCard(item, fresh) {
  const card = document.createElement("div");
  card.className = "print" + (selected.has(item.name) ? " selected" : "");
  card.dataset.name = item.name || "";
  const secs = item.elapsed != null ? `<span class="secs">${item.elapsed}s</span>` : "";
  const model = item.model || "早期图片";
  const date = item.created_time ? item.created_time.slice(5, 10) : "";
  card.title = item.prompt || "";
  card.innerHTML = `
    <div class="print-img-wrap">
      <img src="${item.url}" alt="生成的图片" loading="lazy">
      <div class="print-actions-overlay">
        <button class="p-action-btn p-zoom" type="button" title="检视大图">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <button class="p-action-btn p-copy" type="button" title="复制提示词">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
        </button>
        <button class="p-action-btn p-reuse" type="button" title="复用参数">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
        </button>
        <a href="${item.url}" class="p-action-btn p-dl" download title="下载原图">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </a>
      </div>
    </div>
    <div class="meta">
      <button class="fav ${item.favorite ? "on" : ""}" type="button" title="收藏 / 取消收藏">★</button>
      <span class="model" title="${escapeHtml(model)}">${escapeHtml(model)}</span>
      ${secs}
      ${date ? `<span class="date">${date}</span>` : ""}
    </div>`;

  const onOpenOrSelect = () => {
    if (batchMode) toggleSelect(card, item);
    else openLightbox(item.url, item.name);
  };

  card.querySelector(".print-img-wrap").addEventListener("click", (e) => {
    if (e.target.closest(".p-action-btn")) return;
    onOpenOrSelect();
  });

  card.querySelector(".p-zoom").addEventListener("click", (e) => {
    e.stopPropagation();
    openLightbox(item.url, item.name);
  });

  card.querySelector(".p-copy").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!item.prompt) { showToast("无提示词可复制", "info"); return; }
    try {
      await navigator.clipboard.writeText(item.prompt);
      showToast("提示词已复制到剪贴板", "success");
    } catch {
      showToast("复制失败", "error");
    }
  });

  card.querySelector(".p-reuse").addEventListener("click", (e) => {
    e.stopPropagation();
    reuseParamsFromItem(item);
  });

  card.querySelector(".fav").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavorite(item);
  });
  if (fresh) enterCard(card);
  return card;
}

async function toggleFavorite(item) {
  if (!item?.name) return;
  try {
    const r = await fetch("/api/favorite", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: item.name }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    item.favorite = d.favorite;
    const wall = wallItems.find((w) => w.name === item.name);
    if (wall && wall !== item) wall.favorite = d.favorite;
    const btn = document.querySelector(`#gallery .print[data-name="${cssEscape(item.name)}"] .fav`);
    if (btn) btn.classList.toggle("on", d.favorite);
    if (!lightboxEl.hidden && lbName === item.name) renderLbFav(d.favorite);
    showToast(d.favorite ? "已加入收藏 ★" : "已移出收藏", "info");
  } catch (e) { setGenMsg("收藏失败：" + e.message); showToast("收藏失败：" + e.message, "error"); }
}

function cssEscape(s) {
  return window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
}

/* ---------- 生成参数：记住上次的选择 ---------- */
function saveGenSettings() {
  lsSet(SETTINGS_KEY, {
    size, n: currentN(),
    quality: $("quality").value, background: $("background").value, style: $("style").value,
    advOpen: $("advanced-params").open,
  });
}

function restoreGenSettings() {
  const s = lsGet(SETTINGS_KEY, null);
  if (!s || typeof s !== "object") return;
  if (typeof s.size === "string" && SIZE_RE.test(s.size)) size = s.size;
  if (Number.isFinite(+s.n)) $("n").value = String(+s.n);
  for (const key of ["quality", "background", "style"]) {
    if (typeof s[key] === "string" && [...$(key).options].some((o) => o.value === s[key])) $(key).value = s[key];
  }
  if (s.advOpen) $("advanced-params").open = true;
}

/* ---------- 画幅 ---------- */
const sizeCustom = $("size-custom");
const SIZE_RE = /^\d{2,5}x\d{2,5}$/;

function setSizeHint(text, bad = false) {
  const el = $("size-hint");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("bad", bad);
}

if (sizeCustom) sizeCustom.addEventListener("input", () => {
  const v = sizeCustom.value.trim().toLowerCase();
  if (!SIZE_RE.test(v)) {
    // 出现分隔符却没写完整 = 明显写错才标红，避免输入过程闪红
    const obviouslyBad = /[x×,，]/.test(v) && !SIZE_RE.test(v);
    sizeCustom.classList.toggle("invalid", obviouslyBad);
    setSizeHint(obviouslyBad ? "格式应为 宽x高，如 768x1344" : "", obviouslyBad);
    if (!v) {
      markRatio();
      const [w, h] = size.split("x").map(Number);
      setSizeHint(`${size.replace("x", "×")} · ${ratioLabel(w, h)}` +
        (isOfficialSize(capabilityFor(modelInput.value), size) ? " · 官方" : ""));
    }
    return;
  }
  // 自定义尺寸原样透传，由中转站决定如何映射
  sizeCustom.classList.remove("invalid");
  document.querySelectorAll("#ratio-group .ratio").forEach((b) => {
    b.classList.remove("on");
    b.setAttribute("aria-checked", "false");
  });
  size = v;
  setSizeHint(`已生效 ${size}（自定义）`);
  saveGenSettings();
  renderRequestPreview(capabilityFor(modelInput?.value || ""));
});

/* ---------- 生成 ---------- */
function setGenMsg(text) { $("msg").textContent = text || ""; }

/* 进度条：多张时按张数走，单张时走不确定动画 */
function showProgress(done, total) {
  const box = $("progress");
  if (!box) return;
  box.hidden = false;
  const pct = total > 1 ? Math.round((done / total) * 100) : 0;
  box.classList.toggle("indet", total <= 1);
  $("progress-fill").style.width = total > 1 ? `${pct}%` : "";
  $("progress-text").textContent = total > 1 ? `${done}/${total} 张` : "生成中…";
}

function hideProgress() {
  const box = $("progress");
  if (!box) return;
  box.hidden = true;
  box.classList.remove("indet");
  $("progress-fill").style.width = "0";
}

function addReference(file) {
  if (!file) return;
  const cap = capabilityFor(modelInput.value);
  if (!cap.image_to_image && cap.key !== "generic") { setGenMsg("当前模型族暂不支持参考图"); return; }
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setGenMsg("参考图仅支持 PNG、JPEG 或 WEBP"); return; }
  if (!file.size) { setGenMsg("参考图为空"); return; }
  if (file.size > limits.max_reference_mb * 1024 * 1024) { setGenMsg(`参考图过大，请控制在 ${limits.max_reference_mb}MB 以内`); return; }
  if (referenceFiles.length >= limits.max_references) { setGenMsg(`参考图最多 ${limits.max_references} 张`); return; }
  referenceFiles.push(file);
  renderReferenceThumbs();
  setGenMsg("");
}

function renderReferenceThumbs() {
  const box = $("reference-thumbs");
  // 缩略图 URL 用完即回收，避免长会话下 objectURL 累积泄漏
  refObjectUrls.forEach((u) => URL.revokeObjectURL(u));
  refObjectUrls = [];
  box.innerHTML = "";
  referenceFiles.forEach((file, i) => {
    const item = document.createElement("span");
    item.className = "reference-preview";
    const img = document.createElement("img");
    const url = URL.createObjectURL(file);
    refObjectUrls.push(url);
    img.src = url;
    img.alt = "参考图缩略图";
    const name = document.createElement("span");
    name.textContent = file.name || "粘贴的图片";
    name.title = file.name || "粘贴的图片";
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "✕";
    del.setAttribute("aria-label", `移除参考图 ${i + 1}`);
    del.addEventListener("click", () => { referenceFiles.splice(i, 1); renderReferenceThumbs(); });
    item.append(img, name, del);
    box.appendChild(item);
  });
  renderReferenceNote();
  renderRequestPreview(capabilityFor(modelInput.value));
}

function clearReference() {
  referenceFiles = [];
  $("reference-input").value = "";
  renderReferenceThumbs();  // 内部会回收全部 objectURL
  updateCapabilityUI();
}

$("reference-add").addEventListener("click", () => {
  if (!$("reference-add").classList.contains("disabled")) $("reference-input").click();
});
$("reference-input").addEventListener("change", (e) => {
  [...e.target.files].forEach(addReference);
  e.target.value = ""; // 清空，允许再次选择同一文件
});
$("reference-box").addEventListener("dragover", (e) => { e.preventDefault(); $("reference-box").classList.add("dragover"); });
$("reference-box").addEventListener("dragleave", () => $("reference-box").classList.remove("dragover"));
$("reference-box").addEventListener("drop", (e) => {
  e.preventDefault(); $("reference-box").classList.remove("dragover");
  [...e.dataTransfer.files].forEach(addReference);
});
$("prompt").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.items || [])]
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); files.forEach(addReference); }
});

/* ---------- 生成任务 ---------- */
/* 一条提示词出多张时走任务队列：能边出边看，也能中途取消 */
let currentTaskId = null;
let taskPollTimer = null;
const GO_HTML = '<span class="go-spark" aria-hidden="true">✦</span><span class="go-text">开始生成</span><kbd class="go-kbd">Ctrl ↵</kbd>';

function makeDevelopingCard(label) {
  const card = document.createElement("div");
  card.className = "print";
  const [w, h] = size.split("x");
  card.innerHTML = `
    <div class="developing" style="aspect-ratio:${w}/${h}">
      <div class="red-lamp"></div>
      <div class="dev-label">${label}</div>
      <div class="dev-time">0s</div>
    </div>`;
  return card;
}

function setGoIdle() {
  busy = false;
  $("go").disabled = false;
  $("go").innerHTML = GO_HTML;
}

function bumpWall(count) {
  if (!count) return;
  total += count;
  pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  renderPager();
  const empty = $("empty");
  if (empty) empty.hidden = true;
  const wallCountEl = $("wall-count");
  if (wallCountEl) wallCountEl.textContent = `共 ${total} 幅作品`;
}

async function cancelCurrentTask() {
  if (!currentTaskId) return;
  setGenMsg("正在取消，当前这张出完就停…");
  $("go").disabled = true;
  $("go").innerHTML = "正在取消…";
  try {
    await fetch("/api/task/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: currentTaskId }),
    });
  } catch { /* 下次轮询会拿到最终状态 */ }
}

function stopPolling() {
  if (taskPollTimer) clearInterval(taskPollTimer);
  taskPollTimer = null;
  currentTaskId = null;
}

function taskLabel(t, targetImages) {
  if (t.status === "cancelling") return "正在取消…";
  if (targetImages > 1) return `已出 ${t.image_count}/${targetImages} 张`;
  return "显影中";
}

async function runTask(options, card, prompt, timer, n) {
  const r = await fetch("/api/generate-task", options);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  currentTaskId = d.task_id;
  $("go").innerHTML = "取消本次生成";
  $("go").disabled = false;
  const labelEl = card.querySelector(".dev-label");
  const targetImages = d.target_images || d.target_n || n || 1;
  let rendered = 0;
  let closed = false;

  const finish = (t, fallbackMsg) => {
    if (closed) return;
    closed = true;
    card.remove();
    clearInterval(timer);
    stopPolling();
    hideProgress();
    setGoIdle();
    const okCount = t ? t.image_count : rendered;
    const errors = (t && t.errors) || [];
    if (fallbackMsg) setGenMsg(fallbackMsg);
    else if (!t) setGenMsg("任务已结束");
    else if (t.status === "cancelled") setGenMsg(`已取消：本次共出图 ${okCount} 张`);
    else if (t.status === "failed") setGenMsg(`生成失败：${errors[0]?.error || "未知错误"}`);
    else if (t.notice) setGenMsg(t.notice);
    else setGenMsg(`完成 ${okCount} 张`);
    bumpWall(rendered);
    if (rendered) pushPromptHistory(prompt);
    pushRecentModel((t && t.model) || "");
    if (t && t.images && t.images.length) {
      const secs = t.images.map((i) => i.elapsed).filter((v) => v > 0);
      if (secs.length) noteSpeed(t.model, secs.reduce((a, b) => a + b, 0) / secs.length);
    }
    renderRailProvider();
    renderRequestPreview(capabilityFor((t && t.model) || modelInput.value));
    if (referenceFiles.length) clearReference();
  };

  taskPollTimer = setInterval(async () => {
    if (closed) return;
    if (!currentTaskId) { finish(null, "任务已结束"); return; }
    let t;
    try {
      t = await (await fetch(`/api/task?id=${currentTaskId}`)).json();
    } catch { return; } // 临时网络抖动不中断任务
    if (t.error) { finish(null, `任务状态已失效（${t.error}），已生成的图片仍保留在墙上`); return; }
    labelEl.textContent = taskLabel(t, targetImages);
    showProgress(t.image_count || 0, targetImages);
    const freshImgs = (t.images || []).slice(rendered);
    for (let i = freshImgs.length - 1; i >= 0; i--) {
      const c = makeCard(freshImgs[i], true);
      c.querySelector("img").classList.add("develop");
      $("gallery").prepend(c);
    }
    if (freshImgs.length) {
      wallItems.unshift(...freshImgs);
      rendered = t.images.length;
    }
    if (["done", "failed", "cancelled"].includes(t.status)) finish(t);
  }, 800);
}

async function gen() {
  if (busy) return;
  // 整段提示词原样使用：写几段都只算一张图的提示词，多张由「数量」决定
  const prompt = $("prompt").value.trim();
  if (!prompt) { setGenMsg("请先写提示词"); $("prompt").focus(); return; }
  if (!modelInput.value.trim()) { setGenMsg("请先选择或填写模型"); modelInput.focus(); return; }
  if (prompt.length > (limits.max_prompt_chars || 8000)) {
    setGenMsg(`提示词过长（${prompt.length} 字），请控制在 ${limits.max_prompt_chars} 字以内`);
    return;
  }
  const customRaw = sizeCustom?.value.trim() || "";
  if (customRaw && !SIZE_RE.test(customRaw.toLowerCase())) {
    setGenMsg("自定义画幅格式应为 宽x高，如 768x1344；可清空输入框改用预设");
    sizeCustom.classList.add("invalid");
    return; // 不静默回退，避免用户以为发的是自定义尺寸
  }
  const n = currentN();

  busy = true;
  $("go").disabled = true;
  setGenMsg("");
  const emptyEl = $("empty");
  if (emptyEl) emptyEl.hidden = true;

  const useQueue = n > 1;   // 多张才需要轮询进度；单张直接同步等结果
  const card = makeDevelopingCard(n > 1 ? `已出 0/${n} 张` : "显影中");
  $("gallery").prepend(card);
  enterCard(card);
  const timeEl = card.querySelector(".dev-time");
  const t0 = Date.now();
  const timer = setInterval(() => { timeEl.textContent = `${Math.round((Date.now() - t0) / 1000)}s`; }, 500);
  showProgress(0, n);

  const cap = capabilityFor(modelInput.value.trim());
  const fields = { prompt, model: modelInput.value.trim(),
    quality: $("quality").value, background: $("background").value, style: $("style").value, n: String(n) };
  // grok 等不接收画幅的模型族：UI 已隐藏画幅选择，残留的全局 size 不能带出去
  if (cap.size_mode !== "none") fields.size = size;
  const options = { method: "POST" };
  if (referenceFiles.length) {
    const form = new FormData();
    Object.entries(fields).forEach(([key, value]) => form.append(key, value));
    referenceFiles.forEach((f) => form.append("image", f, f.name || "reference.png"));
    options.body = form;
  } else {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(fields);
  }

  try {
    if (useQueue) {
      await runTask(options, card, prompt, timer, n);
      return; // 轮询接管计时与收尾
    }
    const r = await fetch("/api/generate", options);
    const d = await r.json();
    if (d.error) {
      if (d.warning) showToast(d.warning, "error");
      throw new Error(d.error);
    }
    const images = d.images || [];
    if (!images.length) throw new Error("上游未返回图片");
    const withResponseMeta = (img) => ({ ...img, model: d.model, elapsed: d.elapsed, prompt: d.prompt,
      provider: d.provider, provider_id: d.provider_id, mode: d.mode,
      reference_used: !!img.reference_used, reference_count: img.reference_count || 0,
      requested: d.requested || 1,
      favorite: false, failover: !!d.failover, failover_from: d.failover_from || "" });
    const fresh = makeCard(withResponseMeta(images[0]), true);
    fresh.querySelector("img").classList.add("develop");
    card.replaceWith(fresh);
    for (let i = images.length - 1; i >= 1; i--) $("gallery").prepend(makeCard(withResponseMeta(images[i]), true));
    wallItems.unshift(...images.map(withResponseMeta));
    bumpWall(images.length);
    pushPromptHistory(prompt);
    pushRecentModel(d.model);
    noteSpeed(d.model, d.elapsed);
    renderRailProvider();
    renderRequestPreview(capabilityFor(d.model));
    setGenMsg(d.notice || `完成 ${images.length} 张 · 耗时 ${d.elapsed}s`);
    if (d.warning) showToast(d.warning, "error");
    if (referenceFiles.length) clearReference();
  } catch (e) {
    card.remove();
    setGenMsg("出错：" + e.message);
  } finally {
    if (!currentTaskId) {
      clearInterval(timer);
      hideProgress();
      setGoIdle();
    }
  }
}

/* ---------- 灯箱：缩放 + 平移 ---------- */
const lightboxEl = $("lightbox");
const lbImg = $("lb-img");
const stage = document.querySelector(".lightbox .stage");
let scale = 1, tx = 0, ty = 0;
let lbName = null;
const MIN_SCALE = 0.2, MAX_SCALE = 10;

function applyTransform(instant = false) {
  lbImg.style.transition = instant ? "none" : "";
  lbImg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  $("zoom-level").textContent = `${Math.round(scale * 100)}%`;
}

function resetZoom() { scale = 1; tx = 0; ty = 0; applyTransform(); }

function clampPan() {
  const r = lbImg.getBoundingClientRect();
  if (r.width <= stage.clientWidth) tx = 0;
  else tx = Math.max(stage.clientWidth - r.width, Math.min(0, tx));
  if (r.height <= stage.clientHeight) ty = 0;
  else ty = Math.max(stage.clientHeight - r.height, Math.min(0, ty));
}

function zoomAt(clientX, clientY, factor) {
  const rect = stage.getBoundingClientRect();
  const cx = clientX - rect.left - rect.width / 2 - tx;
  const cy = clientY - rect.top - rect.height / 2 - ty;
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
  factor = next / scale;
  scale = next;
  tx -= cx * factor - cx;
  ty -= cy * factor - cy;
  clampPan();
  applyTransform(true);
}

stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
}, { passive: false });

$("zoom-in").addEventListener("click", () => zoomAtCenter(1.3));
$("zoom-out").addEventListener("click", () => zoomAtCenter(1 / 1.3));
$("zoom-reset").addEventListener("click", resetZoom);

function zoomAtCenter(factor) {
  const r = stage.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
}

let panning = false, lastX = 0, lastY = 0;

stage.addEventListener("pointerdown", (e) => {
  if (scale <= 1) return;
  panning = true; lastX = e.clientX; lastY = e.clientY;
  stage.classList.add("panning");
  lbImg.classList.add("dragging");
  stage.setPointerCapture(e.pointerId);
});

stage.addEventListener("pointermove", (e) => {
  if (!panning) return;
  tx += e.clientX - lastX;
  ty += e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  clampPan();
  applyTransform(true);
});

stage.addEventListener("pointerup", () => {
  panning = false;
  stage.classList.remove("panning");
  lbImg.classList.remove("dragging");
});

lbImg.addEventListener("dblclick", () => (scale > 1.01 ? resetZoom() : zoomAtCenter(2.5)));

/* ---------- 灯箱开关 + 信息面板 + 左右切换 ---------- */
let lbIndex = -1;

function renderLbFav(on) { $("lb-fav").textContent = on ? "★ 已收藏" : "☆ 收藏"; }

function fillLbInfo(item) {
  $("lb-model").textContent = item.model || "—";
  $("lb-provider").textContent = item.provider || "—";
  $("lb-time").textContent = item.created_time || "—";
  $("lb-elapsed").textContent = item.elapsed != null ? `${item.elapsed} 秒` : "—";
  $("lb-size").textContent = item.size
    ? `${item.size.replace("x", "×")}${item.size_requested ? `（原请求 ${item.size_requested.replace("x", "×")}，中转站不接受已回退）` : ""}`
    : "—";
  const params = $("lb-params");
  if (params) {
    const list = [["质量", item.quality], ["背景", item.background], ["风格", item.style]]
      .filter(([, v]) => v)
      .map(([k, v]) => `${k} ${PARAM_LABELS[v] || v}`);
    params.textContent = list.length ? list.join(" · ") : "默认（未附加参数）";
  }
  $("lb-mode").textContent = item.mode === "image-to-image" ? "图生图" : "文生图";
  const refs = $("lb-refs");
  if (refs) {
    if (item.reference_used) {
      const count = item.reference_count || 1;
      const names = item.reference_name || "";
      refs.textContent = names ? `${count} 张 · ${names}` : `${count} 张`;
      refs.title = names;
    } else {
      refs.textContent = "无";
      refs.title = "";
    }
  }
  $("lb-route").textContent = item.failover ? `备用线路（来自 ${item.failover_from || "主线路"}）` : "主线路";
  $("lb-prompt").textContent = item.prompt || "（早期图片没有记录提示词）";
  renderLbFav(!!item.favorite);
}

/* ---------- 萃取主色调 ---------- */
function extractPalette(imgEl) {
  const palEl = $("lb-palette");
  if (!palEl) return;
  palEl.innerHTML = "";
  if (!imgEl || !imgEl.src) return;

  const tempImg = new Image();
  tempImg.crossOrigin = "anonymous";
  tempImg.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(tempImg, 0, 0, 32, 32);
      const data = ctx.getImageData(0, 0, 32, 32).data;
      const colorMap = {};
      for (let i = 0; i < data.length; i += 16) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const qr = Math.round(r / 32) * 32;
        const qg = Math.round(g / 32) * 32;
        const qb = Math.round(b / 32) * 32;
        const key = `${qr},${qg},${qb}`;
        colorMap[key] = (colorMap[key] || 0) + 1;
      }
      const sorted = Object.entries(colorMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (!sorted.length) return;
      palEl.innerHTML = "";
      sorted.forEach(([key]) => {
        const [r, g, b] = key.split(",").map(Number);
        const hex = "#" + [r, g, b].map(x => Math.min(255, Math.max(0, x)).toString(16).padStart(2, "0")).join("").toUpperCase();
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "palette-chip";
        chip.style.backgroundColor = hex;
        chip.title = `点击复制色值 ${hex}`;
        chip.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(hex); } catch {}
          showToast(`已复制色值：${hex}`, "success");
        });
        palEl.appendChild(chip);
      });
    } catch {
      // 跨域或损坏图片忽略
    }
  };
  tempImg.src = imgEl.src;
}

function showLbAt(i) {
  if (!wallItems.length) return;
  lbIndex = ((i % wallItems.length) + wallItems.length) % wallItems.length; // 循环
  const item = wallItems[lbIndex];
  lbName = item.name;
  lbImg.src = item.url;
  $("lb-dl").href = item.url;
  $("lb-name").textContent = item.name || item.url.split("/").pop();
  fillLbInfo(item);
  extractPalette(lbImg);
  resetZoom();
}

function openLightbox(url, name) {
  const i = wallItems.findIndex((it) => it.url === url || it.name === name);
  if (i >= 0) showLbAt(i);
  else {
    lbName = name;
    lbImg.src = url;
    $("lb-dl").href = url;
    $("lb-name").textContent = name || url.split("/").pop();
    lbIndex = -1;
    fillLbInfo({}); // 找不到条目时清空面板，避免残留上一张的信息
    extractPalette(lbImg);
  }
  lightboxEl.hidden = false;
  if (gsapOK) gsap.from(".lightbox .frame", { y: 18, autoAlpha: 0, duration: 0.3, ease: "power2.out", clearProps: "all" });
}

function closeLightbox() {
  lightboxEl.hidden = true;
  lbImg.src = "";
  const pal = $("lb-palette");
  if (pal) pal.innerHTML = "";
}

$("lb-prev").addEventListener("click", () => showLbAt(lbIndex - 1));
$("lb-next").addEventListener("click", () => showLbAt(lbIndex + 1));
$("lb-close").addEventListener("click", closeLightbox);
lightboxEl.addEventListener("click", (e) => { if (e.target === lightboxEl) closeLightbox(); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!lightboxEl.hidden) closeLightbox();
    else if (!settingsEl.hidden) { settingsEl.hidden = true; closeProviderForm(); loadSettings(); }
    else if (batchMode) setBatchMode(false);
    return;
  }
  if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
    if (!lightboxEl.hidden || !settingsEl.hidden) return; // 灯箱/设置打开时不抢按键
    e.preventDefault();
    $("f-q")?.focus();
    return;
  }
  if (lightboxEl.hidden) return;
  if (e.key === "ArrowLeft") showLbAt(lbIndex - 1);
  if (e.key === "ArrowRight") showLbAt(lbIndex + 1);
});

$("lb-copy").addEventListener("click", async () => {
  const item = wallItems[lbIndex];
  const text = item?.prompt || "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const btn = $("lb-copy");
  const old = btn.textContent;
  btn.textContent = "已复制 ✓";
  showToast("提示词已复制到剪贴板", "success");
  setTimeout(() => { btn.textContent = old; }, 1200);
});

$("lb-fav").addEventListener("click", () => {
  const item = wallItems[lbIndex];
  if (item?.name) toggleFavorite(item);
});

$("lb-reuse").addEventListener("click", () => {
  const item = wallItems[lbIndex];
  if (!item) return;
  reuseParamsFromItem(item);
  closeLightbox();
});

$("lb-del").addEventListener("click", async () => {
  if (!lbName) { closeLightbox(); return; }
  if (!confirm("删除这张照片？文件会从 outputs 里移除。")) return;
  try {
    const r = await fetch("/api/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: lbName }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    wallItems.splice(lbIndex, 1);
    if (wallItems.length) showLbAt(lbIndex); // 停在相邻一张
    else closeLightbox();
    loadHistory(page);
    showToast("照片已成功删除", "info");
  } catch (e) { setGenMsg("删除失败：" + e.message); showToast("删除失败：" + e.message, "error"); }
});

/* ---------- 灵感骰子 & 风格修饰 ---------- */
const INSPIRATION_PROMPTS = [
  "电影级中画幅摄影，古典雨夜咖啡馆橱窗的暖黄倒影，哈苏相机拍摄，35mm镜头，极细致光斑，水汽与微凉夜色交融，8K超清",
  "中国传统大写意水墨，云雾缭绕中的古松与飞鸟，宋瓷青绿设色，留白空灵，宣纸纤维肌理，大师杰作",
  "未来主义赛博朋克深海，机械巨鲸穿梭于微光珊瑚森林之间，流动的青金霓虹光纹，虚幻引擎5光线追踪渲染，超高精细度",
  "新海诚唯美动画风格，盛夏午后电车掠过海边铁道口，碧海澄空，白云如棉，金色阳光耀斑，清澈治愈",
  "极简主义建筑特写，白色弧形清水混凝土与天光阴影，优雅几何线条，包豪斯现代美学，柔和漫反射光线",
  "暗黑哥特巴洛克奇幻，星空下的古老水晶大教堂，漂浮的金色古籍与微光机械羽翼，超精细雕塑细节，伦勃朗光影",
  "微距生态摄影，晨曦荷叶上晶莹剔透的水滴，倒映着整个旭日东升的森林，纤毫毕现的叶脉纹理，自然奇迹",
  "复古70年代暖色调胶片相片，旧木屋唱片机旁晒太阳的橘猫，漫溢的浮尘光柱，柯达金胶卷色调，温馨怀旧",
  "浩瀚深空星际要塞，环绕垂暮恒星缓缓旋转的巨型戴森环，紫红星云褶皱，硬核科幻质感，宏大壮丽",
  "文艺复兴油画笔触，手持油灯的守夜人漫步在雾气弥漫的石板古巷，卡拉瓦乔明暗对照法，厚涂肌理质感"
];

$("prompt-dice")?.addEventListener("click", () => {
  const p = INSPIRATION_PROMPTS[Math.floor(Math.random() * INSPIRATION_PROMPTS.length)];
  setPrompt(p);
  $("prompt").focus();
  showToast("已注入全新灵感构思 ✦", "success");
});

$("prompt-magic")?.addEventListener("click", () => {
  const bar = $("magic-tags-bar");
  if (!bar) return;
  bar.hidden = !bar.hidden;
  $("prompt-magic").classList.toggle("on", !bar.hidden);
});

document.querySelectorAll(".mt-tag").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tag = btn.dataset.tag;
    const cur = $("prompt").value.trim();
    if (!cur) setPrompt(tag);
    else setPrompt(cur.endsWith("，") || cur.endsWith(",") ? `${cur} ${tag}` : `${cur}，${tag}`);
    $("prompt").focus();
    showToast(`已追加「${btn.textContent}」标签`, "info");
  });
});

/* 空态启发词卡片 */
document.querySelectorAll(".es-pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    const p = pill.dataset.prompt;
    if (p) {
      setPrompt(p);
      $("prompt").focus();
      showToast("已载入灵感构思 ✦", "success");
    }
  });
});

/* 搜索框清除按钮 */
const searchInput = $("f-q");
const searchClearBtn = $("search-clear-btn");
if (searchInput && searchClearBtn) {
  searchInput.addEventListener("input", () => {
    searchClearBtn.hidden = !searchInput.value.trim();
  });
  searchClearBtn.addEventListener("click", () => {
    searchInput.value = "";
    searchClearBtn.hidden = true;
    searchInput.focus();
    loadHistory(1);
  });
}

/* 视图模式切换器 (Masonry / Grid / Cinema) */
const VIEW_MODE_KEY = "is_view_mode";
function setViewMode(mode) {
  const wall = document.querySelector(".wall");
  if (!wall) return;
  wall.classList.remove("mode-grid", "mode-cinema");
  if (mode === "grid") wall.classList.add("mode-grid");
  else if (mode === "cinema") wall.classList.add("mode-cinema");
  document.querySelectorAll(".view-btn").forEach((b) => {
    b.classList.toggle("on", b.dataset.mode === mode);
  });
  lsSet(VIEW_MODE_KEY, mode);
}

document.querySelectorAll(".view-btn").forEach((btn) => {
  btn.addEventListener("click", () => setViewMode(btn.dataset.mode));
});

/* 设置模版快捷填入与密码显示 */
document.querySelectorAll(".pp-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const preset = btn.dataset.preset;
    openProviderForm("");
    if (preset === "siliconflow") {
      $("pf-name").value = "硅基流动 SiliconFlow";
      $("pf-base").value = "https://api.siliconflow.cn/v1";
    } else if (preset === "openai") {
      $("pf-name").value = "官方 OpenAI";
      $("pf-base").value = "https://api.openai.com/v1";
    } else if (preset === "openrouter") {
      $("pf-name").value = "OpenRouter";
      $("pf-base").value = "https://openrouter.ai/api/v1";
    }
    $("pf-key").focus();
    showToast(`已填入 ${btn.textContent.replace("+ ", "")} 模版，请补充 API Key`, "info");
  });
});

$("pf-key-eye")?.addEventListener("click", () => {
  const input = $("pf-key");
  if (!input) return;
  const isPass = input.type === "password";
  input.type = isPass ? "text" : "password";
  $("pf-key-eye").textContent = isPass ? "🔒" : "👁";
});

/* ---------- 快捷键 ---------- */
$("prompt").addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); gen(); }
});

/* 提示词：整段使用，只更新字数与草稿，不做任何拆分 */
let draftTimer = null;
$("prompt").addEventListener("input", () => {
  renderPromptMeta();
  renderRequestPreview(capabilityFor(modelInput.value));
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 400);
});

$("go").addEventListener("click", () => {
  if (currentTaskId) cancelCurrentTask();
  else gen();
});

/* 高级参数改动要记住，并同步「将发送」与摘要 */
for (const id of ["quality", "background", "style"]) {
  $(id).addEventListener("change", () => {
    saveGenSettings();
    renderAdvSummary(capabilityFor(modelInput.value));
    renderRequestPreview(capabilityFor(modelInput.value));
  });
}
$("advanced-params").addEventListener("toggle", saveGenSettings);
$("rs-switch").addEventListener("click", () => {
  $("settings").hidden = false;
  setMsg("");
  refreshHealth(false);
});

/* ---------- 启动 ---------- */
restoreGenSettings();    // 先恢复上次的画幅 / 数量 / 高级参数，再渲染按钮高亮
renderQuantityGroup();
setPrompt(loadDraft());  // 上次没写完的提示词也还在
enterRail();
loadCapabilities();
loadSettings();
loadModels();
renderPromptHistory();
setViewMode(lsGet(VIEW_MODE_KEY, "masonry"));
loadHistory(1);
