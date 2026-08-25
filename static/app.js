/* 暗房 · 前端逻辑：生成 / 瀑布流分页 / 设置 / 可搜索模型 / GSAP 动效 */
const $ = (id) => document.getElementById(id);

let busy = false;
let size = "1024x1024";
let page = 1, pages = 1, total = 0;
let modelList = [];
let wallItems = []; // 当前墙上的图片（新→旧），供灯箱左右切换
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const gsapOK = typeof gsap !== "undefined" && !reduceMotion;

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
    $("set-base").value = s.api_base || "";
    $("set-key").value = s.api_key || "";
    markTheme(s.theme);
    const noApi = !s.api_base || !s.api_key;
    $("need-api").hidden = !noApi;
    if (noApi && $("settings").hidden) {
      $("settings").hidden = false; // 首次使用直接带出设置
      $("set-msg").textContent = "先填写中转站地址和密钥，保存后即可生图";
    }
  } catch { /* 用默认值 */ }
}

function applyIdentity(name, t) {
  if (name) {
    $("app-name").textContent = name;
    document.title = `${name} · 生图`;
  }
  if (t) document.documentElement.dataset.theme = t;
}

function markTheme(t) {
  document.querySelectorAll(".theme-btn").forEach((b) => b.classList.toggle("on", b.dataset.theme === t));
}

/* 主题：点击即换 + 静默保存 */
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
$("open-settings").addEventListener("click", () => { settingsEl.hidden = false; $("set-msg").textContent = ""; });
$("set-close").addEventListener("click", () => { settingsEl.hidden = true; loadSettings(); });
settingsEl.addEventListener("click", (e) => { if (e.target === settingsEl) { settingsEl.hidden = true; loadSettings(); } });

/* 名称单独保存 */
$("name-save").addEventListener("click", async () => {
  const msg = $("set-msg");
  msg.className = "set-msg";
  msg.textContent = "保存中…";
  try {
    const r = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: $("set-name").value.trim() }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    applyIdentity(d.name, null);
    msg.className = "set-msg ok";
    msg.textContent = "名称已保存";
  } catch (e) {
    msg.className = "set-msg err";
    msg.textContent = e.message;
  }
});

$("set-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("name-save").click(); });

/* 保存 API 信息 */
$("set-save").addEventListener("click", async () => {
  const msg = $("set-msg");
  msg.className = "set-msg";
  msg.textContent = "保存中…";
  try {
    const r = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_base: $("set-base").value.trim(),
        api_key: $("set-key").value.trim(),
      }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    msg.className = "set-msg ok";
    msg.textContent = "API 信息已保存";
    $("need-api").hidden = true;
    loadModels();
  } catch (e) {
    msg.className = "set-msg err";
    msg.textContent = e.message;
  }
});

/* 测试连接（用输入框里的值，不必先保存） */
$("set-test").addEventListener("click", async () => {
  const msg = $("set-msg");
  msg.className = "set-msg";
  msg.textContent = "连接中…";
  try {
    const r = await fetch("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_base: $("set-base").value.trim(),
        api_key: $("set-key").value.trim(),
      }),
    });
    const d = await r.json();
    if (d.ok) { msg.className = "set-msg ok"; msg.textContent = `连接成功，${d.models} 个模型`; }
    else { msg.className = "set-msg err"; msg.textContent = "失败：" + d.error; }
  } catch (e) { msg.className = "set-msg err"; msg.textContent = e.message; }
});

/* ---------- 可搜索模型下拉 ---------- */
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
  modelListBox.innerHTML = hits.length
    ? hits.map((m) => `<button class="opt${m === modelInput.value ? " hot" : ""}" type="button">${m}</button>`).join("")
    : `<div class="none">${modelList.length ? "没有匹配的模型，可直接使用输入的名称" : "未加载到模型，可直接输入名称"}</div>`;
  modelListBox.hidden = false;
}

modelInput.addEventListener("focus", () => renderModelList(modelInput.value && modelList.some((m) => m === modelInput.value) ? "" : modelInput.value));
modelInput.addEventListener("input", () => renderModelList(modelInput.value));

$("model-combo").querySelector(".combo-toggle").addEventListener("click", () => {
  if (modelListBox.hidden) renderModelList();
  else modelListBox.hidden = true;
});

modelListBox.addEventListener("click", (e) => {
  const opt = e.target.closest(".opt");
  if (!opt) return;
  modelInput.value = opt.textContent;
  modelListBox.hidden = true;
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
    if (d.error) throw new Error(d.error);
    modelList = d.models || [];
    modelsLoading = false;
    modelInput.placeholder = modelList.length ? "输入筛选或直接填写模型名" : "未发现生图模型，可手动填写";
    if (modelList.length) modelInput.value = modelList.includes("fal-gpt-image-2") ? "fal-gpt-image-2" : modelList[0];
  } catch (e) {
    modelsLoading = false;
    modelInput.placeholder = "未配置 API，可手动填写模型名";
  }
  if (!modelListBox.hidden) renderModelList(modelInput.value);
}

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

async function loadHistory(p = page) {
  try {
    const d = await (await fetch(`/api/history?page=${p}&page_size=12`)).json();
    page = d.page; pages = d.pages; total = d.total;
    wallItems = d.items.map((it) => ({ url: it.url, name: it.name }));
    const g = $("gallery");
    g.innerHTML = "";
    for (const item of d.items) g.appendChild(makeCard(item, false));
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

/* ---------- 卡片 ---------- */
function makeCard(item, fresh) {
  const card = document.createElement("div");
  card.className = "print";
  const secs = item.elapsed != null ? `<span class="secs">${item.elapsed}s</span>` : "";
  const model = item.model || "早期图片";
  card.title = item.prompt || "";
  card.innerHTML = `
    <img src="${item.url}" alt="生成的图片" loading="lazy">
    <div class="meta">
      <span class="model">${model}</span>
      ${secs}
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
function setMsg(text) { $("msg").textContent = text || ""; }

async function gen() {
  if (busy) return;
  const prompt = $("prompt").value.trim();
  if (!prompt) { setMsg("请先写一句提示词"); return; }
  if (!modelInput.value.trim()) { setMsg("请先选择或填写模型"); return; }

  busy = true;
  $("go").disabled = true;
  setMsg("");
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
    const r = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, model: modelInput.value.trim(), size }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const img = d.images[0];
    const fresh = makeCard({ url: img.url, name: img.name, model: d.model, elapsed: d.elapsed, prompt: d.prompt }, true);
    fresh.querySelector("img").classList.add("develop");
    card.replaceWith(fresh);
    wallItems.unshift({ url: img.url, name: img.name });
  } catch (e) {
    card.remove();
    setMsg("出错：" + e.message);
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
  lbImg.classList.toggle("dragging", instant);
  lbImg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  $("zoom-level").textContent = Math.round(scale * 100) + "%";
}

function resetZoom() { scale = 1; tx = 0; ty = 0; applyTransform(); }

function zoomAt(clientX, clientY, factor) {
  const rect = lbImg.getBoundingClientRect();
  const px = clientX - (rect.left + rect.width / 2);
  const py = clientY - (rect.top + rect.height / 2);
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
  const ratio = next / scale;
  tx = px - ratio * (px - tx);
  ty = py - ratio * (py - ty);
  scale = next;
  clampPan();
  applyTransform();
}

function clampPan() {
  if (scale <= 1) { tx = 0; ty = 0; return; }
  const dispW = lbImg.getBoundingClientRect().width;
  const dispH = lbImg.getBoundingClientRect().height;
  const limX = Math.max(0, (dispW * scale - stage.clientWidth) / 2);
  const limY = Math.max(0, (dispH * scale - stage.clientHeight) / 2);
  tx = Math.min(limX, Math.max(-limX, tx));
  ty = Math.min(limY, Math.max(-limY, ty));
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

/* ---------- 灯箱开关 + 左右切换 ---------- */
let lbIndex = -1;

function showLbAt(i) {
  if (!wallItems.length) return;
  lbIndex = ((i % wallItems.length) + wallItems.length) % wallItems.length; // 循环
  const item = wallItems[lbIndex];
  lbName = item.name;
  lbImg.src = item.url;
  $("lb-dl").href = item.url;
  $("lb-name").textContent = item.name || item.url.split("/").pop();
  resetZoom();
}

function openLightbox(url, name) {
  const i = wallItems.findIndex((it) => it.url === url || it.name === name);
  showLbAt(i >= 0 ? i : 0);
  if (i < 0) { lbName = name; lbImg.src = url; $("lb-dl").href = url; $("lb-name").textContent = name || url.split("/").pop(); }
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
    else if (!settingsEl.hidden) { settingsEl.hidden = true; loadSettings(); }
    return;
  }
  if (lightboxEl.hidden) return;
  if (e.key === "ArrowLeft") showLbAt(lbIndex - 1);
  if (e.key === "ArrowRight") showLbAt(lbIndex + 1);
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
  } catch (e) { setMsg("删除失败：" + e.message); }
});

/* ---------- 快捷键 ---------- */
$("prompt").addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); gen(); }
});
$("go").addEventListener("click", gen);

/* ---------- 启动 ---------- */
enterRail();
loadSettings();
loadModels();
loadHistory(1);
