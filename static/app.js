/* 拾光 · 前端逻辑：生成 / 瀑布流分页与筛选 / 中转站管理 / 灯箱信息面板 / GSAP 动效 */
const $ = (id) => document.getElementById(id);

let busy = false;
let size = "1024x1024";
let page = 1, pages = 1, total = 0;
let modelList = [];
let providers = [];          // [{id,name,api_base,api_key,models}]
let activePid = "";
let capabilityDefs = {};
let referenceFile = null;
let editingPid = "";         // 正在编辑的中转站，空 = 新增
let wallItems = [];          // 当前墙上的图片（新→旧），供灯箱左右切换
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const gsapOK = typeof gsap !== "undefined" && !reduceMotion;

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
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("prompt").value = p; $("prompt").focus(); }
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
    chip.addEventListener("click", () => { $("prompt").value = p; $("prompt").focus(); });
    box.appendChild(chip);
  }
}

$("ph-clear").addEventListener("click", () => {
  if (!lsGet(PROMPT_KEY).length) return;
  if (!confirm("清空全部 Prompt 历史？（不影响已生成的图片）")) return;
  lsSet(PROMPT_KEY, []);
  renderPromptHistory();
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
    $("failover-toggle").checked = !!s.failover_enabled;
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
  const norm = (s) => s.toLowerCase().replace(/[-_]/g, " ");
  const name = norm(model || "");
  const matchers = [
    ["gpt-image", "gpt-image"], ["dall-e", "dall-e"], ["nano-banana", "nano-banana"],
    ["banana", "banana"], ["gemini image", "gemini"], ["seedream", "seedream"],
    ["flux", "flux"], ["grok image", "grok image"], ["image", "image"],
  ];
  for (const [key, matcher] of matchers) if (name.includes(norm(matcher)) && capabilityDefs[key]) return { ...capabilityDefs[key], key };
  return { ...(capabilityDefs.generic || { family: "Generic OpenAI Compatible", text_to_image: true, image_to_image: true, supported_sizes: ["1024x1024", "1536x1024", "1024x1536"], n: true }), key: "generic" };
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

function updateCapabilityUI() {
  const cap = capabilityFor(modelInput?.value || "");
  const params = $("advanced-params");
  if (params) params.hidden = false;
  $("capability-label").textContent = cap.family || "Generic OpenAI Compatible";
  ["quality", "background", "style", "n"].forEach((key) => {
    const row = $(`${key}-param`);
    if (row) row.hidden = key === "n" ? !cap.n : !cap[key];
  });
  rebuildOptions($("quality"), cap.quality_values);
  rebuildOptions($("background"), cap.background_values);
  rebuildOptions($("style"), cap.style_values);
  const sizes = cap.supported_sizes || ["1024x1024"];
  const sizeField = $("size-field");
  if (sizeField) sizeField.hidden = !(cap.supported_sizes || []).length;
  document.querySelectorAll(".size:not(.theme-btn)").forEach((btn) => {
    const enabled = sizes.includes(btn.dataset.size);
    btn.hidden = !enabled;
    if (!enabled && btn.classList.contains("on")) {
      btn.classList.remove("on");
      btn.setAttribute("aria-checked", "false");
    }
  });
  if (!document.querySelector(".size:not(.theme-btn).on")) {
    const first = document.querySelector(`.size:not(.theme-btn)[data-size="${sizes[0]}"]`);
    if (first) { first.classList.add("on"); first.setAttribute("aria-checked", "true"); size = first.dataset.size; }
  }
  const refButton = $("reference-add");
  if (refButton) {
    const supported = cap.image_to_image || cap.key === "generic";
    refButton.classList.toggle("disabled", !supported);
    refButton.title = supported ? "添加参考图" : "当前模型暂未声明参考图能力";
    $("reference-note").textContent = supported ? "拖入或粘贴图片" : "当前模型暂未声明参考图能力";
  }
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
    if (modelList.length) modelInput.value = modelList.includes("fal-gpt-image-2") ? "fal-gpt-image-2" : modelList[0];
    if (!modelListBox.hidden) renderModelList();
    updateCapabilityUI();
    setMsg(d.warning ? `已切换，但拉取模型失败：${d.warning}` : "已切换，模型列表已刷新", d.warning ? "err" : "ok");
  } catch (e) { setMsg(e.message, "err"); }
}

async function refreshHealth(force = false) {
  setMsg("检测中…");
  try {
    const results = [];
    for (const p of providers) {
      const r = await fetch("/api/providers/health", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider_id: p.id, force }) });
      const d = await r.json();
      if (d.providers?.[0]) results.push(d.providers[0]);
    }
    for (const result of results) {
      const p = providers.find((x) => x.id === result.provider_id);
      if (p) p.health = result;
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
modelInput.addEventListener("input", () => { renderModelList(modelInput.value); updateCapabilityUI(); });

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
    if (d.error && !modelList.length) {
      modelInput.placeholder = "未配置 API，可手动填写模型名";
    } else {
      modelInput.placeholder = modelList.length ? "输入筛选或直接填写模型名" : "未发现生图模型，可手动填写";
      if (modelList.length) modelInput.value = modelList.includes("fal-gpt-image-2") ? "fal-gpt-image-2" : modelList[0];
    }
  } catch {
    modelsLoading = false;
    modelInput.placeholder = "未配置 API，可手动填写模型名";
  }
  if (!modelListBox.hidden) renderModelList(); // 渲染完整列表，不按默认选中名过滤
  updateCapabilityUI();
}

/* ---------- 历史墙：分页 + 筛选 ---------- */
function renderPager() {
  const pager = $("pager");
  if (!total) { pager.hidden = true; return; }
  pager.hidden = false;
  $("pg-info").textContent = `共 ${total} 张 · 每页 12 张 · 第 ${page} / ${pages} 页`;
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
  return p.toString();
}

async function loadHistory(p = page) {
  try {
    const qs = filterQuery();
    const d = await (await fetch(`/api/history?page=${p}&page_size=12&${qs}`)).json();
    page = d.page; pages = d.pages; total = d.total;
    wallItems = d.items.map((it) => ({ ...it }));
    fillSelect($("f-model"), d.facets.models, "全部模型");
    fillSelect($("f-provider"), d.facets.providers, "全部来源");
    const g = $("gallery");
    g.innerHTML = "";
    for (const item of d.items) g.appendChild(makeCard(item, false));
    const empty = $("empty");
    if (empty) empty.hidden = !!d.items.length;
    renderPager();
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

/* ---------- 卡片 ---------- */
function makeCard(item, fresh) {
  const card = document.createElement("div");
  card.className = "print";
  const secs = item.elapsed != null ? `<span class="secs">${item.elapsed}s</span>` : "";
  const model = item.model || "早期图片";
  const date = item.created_time ? item.created_time.slice(5, 10) : "";
  card.title = item.prompt || "";
  card.innerHTML = `
    <img src="${item.url}" alt="生成的图片" loading="lazy">
    <div class="meta">
      <span class="model">${escapeHtml(model)}</span>
      ${secs}
      ${date ? `<span class="date">${date}</span>` : ""}
      <a href="${item.url}" download>保存</a>
    </div>`;
  card.querySelector("img").addEventListener("click", () => openLightbox(item.url, item.name));
  if (fresh) enterCard(card);
  return card;
}

/* ---------- 画幅 ---------- */
document.querySelectorAll(".size:not(.theme-btn)").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".size:not(.theme-btn)").forEach((b) => {
      b.classList.toggle("on", b === btn);
      b.setAttribute("aria-checked", b === btn ? "true" : "false");
    });
    size = btn.dataset.size;
  });
});

/* ---------- 生成 ---------- */
function setGenMsg(text) { $("msg").textContent = text || ""; }

function setReference(file) {
  if (!file) return;
  const cap = capabilityFor(modelInput.value);
  if (!cap.image_to_image && cap.key !== "generic") { setGenMsg("当前模型暂未声明参考图能力"); return; }
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setGenMsg("参考图仅支持 PNG、JPEG 或 WEBP"); return; }
  if (!file.size) { setGenMsg("参考图为空"); return; }
  if (file.size > 10 * 1024 * 1024) { setGenMsg("参考图过大，请控制在 10MB 以内"); return; }
  referenceFile = file;
  $("reference-thumb").src = URL.createObjectURL(file);
  $("reference-name").textContent = file.name || "粘贴的图片";
  $("reference-preview").hidden = false;
  $("reference-add").hidden = true;
  $("reference-note").textContent = "图生图模式";
}

function clearReference() {
  referenceFile = null;
  $("reference-input").value = "";
  $("reference-preview").hidden = true;
  $("reference-add").hidden = false;
  updateCapabilityUI();
}

$("reference-add").addEventListener("click", () => {
  if (!$("reference-add").classList.contains("disabled")) $("reference-input").click();
});
$("reference-input").addEventListener("change", (e) => setReference(e.target.files[0]));
$("reference-clear").addEventListener("click", clearReference);
$("reference-box").addEventListener("dragover", (e) => { e.preventDefault(); $("reference-box").classList.add("dragover"); });
$("reference-box").addEventListener("dragleave", () => $("reference-box").classList.remove("dragover"));
$("reference-box").addEventListener("drop", (e) => { e.preventDefault(); $("reference-box").classList.remove("dragover"); setReference(e.dataTransfer.files[0]); });
$("prompt").addEventListener("paste", (e) => {
  const file = [...(e.clipboardData?.items || [])].find((item) => item.type.startsWith("image/"))?.getAsFile();
  if (file) { e.preventDefault(); setReference(file); }
});

async function gen() {
  if (busy) return;
  const prompt = $("prompt").value.trim();
  if (!prompt) { setGenMsg("请先写一句提示词"); return; }
  if (!modelInput.value.trim()) { setGenMsg("请先选择或填写模型"); return; }

  busy = true;
  $("go").disabled = true;
  setGenMsg("");
  $("empty")?.remove();

  const card = document.createElement("div");
  card.className = "print";
  const [w, h] = size.split("x");
  card.innerHTML = `
    <div class="developing" style="aspect-ratio:${w}/${h}">
      <div class="red-lamp"></div>
      <div class="dev-label">显影中</div>
      <div class="dev-time">0s</div>
    </div>`;
  $("gallery").prepend(card);
  enterCard(card);
  const timeEl = card.querySelector(".dev-time");
  const t0 = Date.now();
  const timer = setInterval(() => { timeEl.textContent = `${Math.round((Date.now() - t0) / 1000)}s`; }, 500);

  try {
    const fields = { prompt, model: modelInput.value.trim(), size, quality: $("quality").value, background: $("background").value, style: $("style").value, n: $("n").value };
    const options = { method: "POST" };
    if (referenceFile) {
      const form = new FormData();
      Object.entries(fields).forEach(([key, value]) => form.append(key, value));
      form.append("image", referenceFile, referenceFile.name || "reference.png");
      options.body = form;
    } else {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(fields);
    }
    const r = await fetch("/api/generate", options);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const images = d.images || [];
    if (!images.length) throw new Error("上游未返回图片");
    const first = images[0];
    const withResponseMeta = (img) => ({ ...img, model: d.model, elapsed: d.elapsed, prompt: d.prompt,
      provider: d.provider, provider_id: d.provider_id, mode: d.mode, reference_used: !!img.reference_used,
      failover: !!d.failover, failover_from: d.failover_from || "" });
    const fresh = makeCard(withResponseMeta(first), true);
    fresh.querySelector("img").classList.add("develop");
    card.replaceWith(fresh);
    for (let i = images.length - 1; i >= 1; i--) $("gallery").prepend(makeCard(withResponseMeta(images[i]), true));
    wallItems.unshift(...images.map(withResponseMeta));
    pushPromptHistory(prompt);
    pushRecentModel(d.model);
    if (referenceFile) clearReference();
  } catch (e) {
    card.remove();
    setGenMsg("出错：" + e.message);
  } finally {
    clearInterval(timer);
    busy = false;
    $("go").disabled = false;
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

function fillLbInfo(item) {
  $("lb-model").textContent = item.model || "—";
  $("lb-provider").textContent = item.provider || "—";
  $("lb-time").textContent = item.created_time || "—";
  $("lb-elapsed").textContent = item.elapsed != null ? `${item.elapsed} 秒` : "—";
  $("lb-size").textContent = item.size || "—";
  $("lb-mode").textContent = item.mode === "image-to-image" ? "图生图" : "文生图";
  $("lb-route").textContent = item.failover ? `备用线路（来自 ${item.failover_from || "主线路"}）` : "主线路";
  $("lb-prompt").textContent = item.prompt || "（早期图片没有记录提示词）";
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
  }
  lightboxEl.hidden = false;
  if (gsapOK) gsap.from(".lightbox .frame", { y: 18, autoAlpha: 0, duration: 0.3, ease: "power2.out", clearProps: "all" });
}

function closeLightbox() { lightboxEl.hidden = true; lbImg.src = ""; }

$("lb-prev").addEventListener("click", () => showLbAt(lbIndex - 1));
$("lb-next").addEventListener("click", () => showLbAt(lbIndex + 1));
$("lb-close").addEventListener("click", closeLightbox);
lightboxEl.addEventListener("click", (e) => { if (e.target === lightboxEl) closeLightbox(); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!lightboxEl.hidden) closeLightbox();
    else if (!settingsEl.hidden) { settingsEl.hidden = true; closeProviderForm(); loadSettings(); }
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
  setTimeout(() => { btn.textContent = old; }, 1200);
});

$("lb-reuse").addEventListener("click", () => {
  const item = wallItems[lbIndex];
  if (!item?.prompt) return;
  $("prompt").value = item.prompt;
  closeLightbox();
  $("prompt").focus();
  setGenMsg("已回填该照片的提示词");
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
  } catch (e) { setGenMsg("删除失败：" + e.message); }
});

/* ---------- 快捷键 ---------- */
$("prompt").addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); gen(); }
});
$("go").addEventListener("click", gen);

/* ---------- 启动 ---------- */
enterRail();
loadCapabilities();
loadSettings();
loadModels();
renderPromptHistory();
loadHistory(1);
