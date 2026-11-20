/* 拾光 · 前端逻辑：生成 / 瀑布流分页与筛选 / 中转站管理 / 灯箱信息面板 / GSAP 动效 / A/B 对比 / 专业预设矩阵 / Web Audio 暗房音效 */
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
let editSource = null;
let editingPid = "";         // 正在编辑的中转站，空 = 新增
let wallItems = [];          // 当前墙上的图片（新→旧），供灯箱左右切换与 A/B 对比
const PAGE_SIZE = 12;
// 生成参数与草稿都记在本地：刷页面不用重设，符合反复打磨一张图的工作习惯
const SETTINGS_KEY = "is_gen_settings";
const DRAFT_KEY = "is_prompt_draft";
const SPEED_KEY = "is_model_speed";
const SOUND_KEY = "is_sound_enabled";
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const gsapOK = typeof gsap !== "undefined" && !reduceMotion;

function showToast(text, type = "info") {
  const container = $("toast-container");
  if (!container) return;
  const icons = { success: "✦", error: "✕", info: "ℹ" };
  const icon = icons[type] || "✦";
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("toast-fadeout");
    setTimeout(() => toast.remove(), 260);
  }, 2600);
}

/* ==========================================================================
   Web Audio API 暗房音效引擎 (Darkroom Soundscapes)
   纯算法合成：柔和快门声、完成定影空灵风铃、暗房红灯安全弱鸣
   ========================================================================== */
let soundEnabled = lsGet(SOUND_KEY, false); // 默认静音
let audioCtx = null;
let safelightHumNode = null;
let safelightGainNode = null;

function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// 柔和暗房机械相机快门声 (Soft Mechanical Camera Shutter Click)
function playShutterSound() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    // 1. 反光板弹起冲击 (Mirror Lift Noise Burst)
    const bufferSize = Math.floor(ctx.sampleRate * 0.038);
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.28));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1350, now);
    filter.Q.setValueAtTime(3.2, now);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.24, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.036);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noise.start(now);

    // 2. 机械快门叶片扫动 (Shutter Blade Sweep)
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(700, now);
    osc.frequency.exponentialRampToValueAtTime(110, now + 0.03);
    oscGain.gain.setValueAtTime(0.18, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.032);
    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.034);

    // 3. 后帘闭合二次瞬态 (Curtain Close Click) ~42ms 后
    const closeNoise = ctx.createBufferSource();
    closeNoise.buffer = noiseBuffer;
    const closeFilter = ctx.createBiquadFilter();
    closeFilter.type = "bandpass";
    closeFilter.frequency.setValueAtTime(1150, now + 0.042);
    closeFilter.Q.setValueAtTime(2.6, now + 0.042);
    const closeGain = ctx.createGain();
    closeGain.gain.setValueAtTime(0.001, now);
    closeGain.gain.setValueAtTime(0.16, now + 0.042);
    closeGain.gain.exponentialRampToValueAtTime(0.001, now + 0.075);
    closeNoise.connect(closeFilter);
    closeFilter.connect(closeGain);
    closeGain.connect(ctx.destination);
    closeNoise.start(now + 0.042);
  } catch {
    // 忽略音频策略限制
  }
}

// 显影定影完成晶莹风铃声 (Pleasant Pentatonic Darkroom Chime)
function playChimeSound() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    // 五度空灵和弦: E5 (659Hz), B5 (988Hz), E6 (1318Hz), G#6 (1661Hz)
    const freqs = [659.25, 987.77, 1318.51, 1661.22];
    freqs.forEach((freq, idx) => {
      const startTime = now + idx * 0.055;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0.001, startTime);
      gain.gain.linearRampToValueAtTime(0.12 / (idx + 1), startTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 1.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + 1.2);
    });
  } catch {
    // 忽略音频策略限制
  }
}

// 复古暗房安全灯低频微鸣 (Retro Darkroom Safelight Hum)
function startSafelightHum() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx || safelightHumNode) return;
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(55, now); // 55Hz 基频交流微鸣

    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(110, now); // 110Hz 谐波

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(130, now);

    safelightGainNode = ctx.createGain();
    safelightGainNode.gain.setValueAtTime(0.0001, now);
    safelightGainNode.gain.linearRampToValueAtTime(0.012, now + 1.2); // 极温和低沉背景声

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(safelightGainNode);
    safelightGainNode.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now);
    safelightHumNode = { osc1, osc2 };
  } catch {}
}

function stopSafelightHum() {
  if (!safelightGainNode || !audioCtx) return;
  try {
    const now = audioCtx.currentTime;
    safelightGainNode.gain.linearRampToValueAtTime(0.0001, now + 0.4);
    setTimeout(() => {
      if (safelightHumNode) {
        try { safelightHumNode.osc1.stop(); safelightHumNode.osc2.stop(); } catch {}
        safelightHumNode = null;
      }
      safelightGainNode = null;
    }, 450);
  } catch {}
}

function updateSoundToggleUI() {
  const btn = $("sound-toggle");
  if (!btn) return;
  btn.setAttribute("aria-pressed", String(soundEnabled));
  btn.classList.toggle("on", soundEnabled);
  btn.classList.toggle("muted", !soundEnabled);
  btn.title = soundEnabled ? "暗房沉浸音效已开启 (点击静音)" : "暗房沉浸音效已静音 (点击开启)";
}

function setSoundEnabled(enabled) {
  soundEnabled = !!enabled;
  lsSet(SOUND_KEY, soundEnabled);
  updateSoundToggleUI();
  if (soundEnabled) {
    getAudioContext();
    startSafelightHum();
    playShutterSound();
    showToast("暗房沉浸音效已开启 🔊", "info");
  } else {
    stopSafelightHum();
    showToast("暗房音效已静音 🔇", "info");
  }
}

function initSoundEngine() {
  const btn = $("sound-toggle");
  if (btn) {
    updateSoundToggleUI();
    btn.addEventListener("click", () => setSoundEnabled(!soundEnabled));
  }
  if (soundEnabled) {
    // 首次交互时唤醒背景微鸣
    const resumeOnTouch = () => {
      startSafelightHum();
      window.removeEventListener("pointerdown", resumeOnTouch);
      window.removeEventListener("keydown", resumeOnTouch);
    };
    window.addEventListener("pointerdown", resumeOnTouch, { once: true });
    window.addEventListener("keydown", resumeOnTouch, { once: true });
  }
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
  syncPresetChipsActive();
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
  const veil = document.getElementById("theme-veil");
  if (veil) gsap.fromTo(veil, { opacity: 0.3 }, { opacity: 0, duration: 0.55, ease: "power2.out", clearProps: "opacity" });
  gsap.fromTo("body", { autoAlpha: 0.86 }, { autoAlpha: 1, duration: 0.35, ease: "power1.out", clearProps: "opacity,visibility" });
}

/* ---------- 设置 ---------- */
async function loadSettings({ promptSetup = false } = {}) {
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
    const version = s.version ? `v${s.version}` : "";
    $("set-version").textContent = version;
    $("brand-version").textContent = version;
    $("brand-version").hidden = !version;
    $("set-limits").textContent =
      `· 一条提示词最多 ${limits.max_images} 张 · 参考图 ${limits.max_references} 张/${limits.max_reference_mb}MB · 提示词上限 ${limits.max_prompt_chars} 字`;
    renderProviders();
    markTheme(s.theme);
    const noApi = !providers.length;
    $("need-api").hidden = !noApi;
    if (promptSetup && noApi && settingsEl.hidden) {
      openSettings();
      setMsg("先添加一个 API 中转站，保存后即可生图");
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
  const allowed = pool.map((e) => e.size);
  if (allowed.length && !allowed.includes(size)) {
    size = allowed.find((s) => (cap.supported_sizes || []).includes(s)) || allowed[0];
  }
  markRatio();
}

function markRatio() {
  const presetActive = !sizeCustom.value.trim();
  document.querySelectorAll("#ratio-group .ratio").forEach((b) => {
    const on = presetActive && b.dataset.size === size;
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
  const n = editSource ? 1 : currentN();
  const parts = [];
  const notes = [];

  parts.push(model);
  const previewSize = currentSize();
  if ((cap.supported_sizes || []).length) parts.push(`${previewSize.replace("x", "×")} ${ratioLabel(...previewSize.split("x").map(Number))}`);
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
  const extensions = extensionParams();
  if (extensions.negative_prompt) parts.push("反向提示词");
  if (extensions.seed != null) parts.push(`Seed ${extensions.seed}`);
  if (extensions.cfg_scale != null) parts.push(`CFG ${extensions.cfg_scale}`);
  if (Object.keys(extensions).length) notes.push("扩展参数由线路决定是否生效");

  if (editSource) parts.push("以图库原图改图");
  else parts.push(referenceFiles.length ? `图生图 ${referenceFiles.length} 张参考图` : "文生图");

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
    if (row) row.hidden = key === "n" ? Boolean(editSource) || !cap.n : !cap[key];
  });
  rebuildOptions($("quality"), cap.quality_values);
  rebuildOptions($("background"), cap.background_values);
  rebuildOptions($("style"), cap.style_values);

  const sizeField = $("size-field");
  if (sizeField) sizeField.hidden = !(cap.supported_sizes || []).length;
  renderRatioGroup(cap);
  if (sizeField && !sizeField.hidden) {
    const [w, h] = size.split("x").map(Number);
    if (!sizeCustom.value.trim()) {
      setSizeHint(`${size.replace("x", "×")} · ${ratioLabel(w, h)}${isOfficialSize(cap, size) ? " · 官方" : ""}`);
    } else if (SIZE_RE.test(sizeCustom.value.trim().toLowerCase())) {
      setSizeHint(`已生效 ${currentSize()}（自定义）`);
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
  $("edit-model-note").hidden = !editSource || Boolean(cap.image_to_image);
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
  document.querySelectorAll(".theme-btn").forEach((b) => {
    const active = b.dataset.theme === t;
    b.classList.toggle("on", active);
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(active));
  });
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
    await loadModels();
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

let themeWrites = Promise.resolve();
window.setStudioTheme = function setStudioTheme(theme) {
  markTheme(theme);
  applyIdentity(null, theme);
  themePulse();
  themeWrites = themeWrites.then(async () => {
    const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme }),
    });
    if (!response.ok) throw new Error("工作室未能保存主题");
  }).catch(() => {
    if (document.documentElement.dataset.theme === theme) showToast("主题已预览，本次保存失败", "error");
  });
  return themeWrites;
};
document.querySelectorAll(".theme-btn").forEach((btn) => {
  btn.addEventListener("click", () => window.setStudioTheme(btn.dataset.theme));
});

const settingsEl = $("settings");

const overlayOpeners = new WeakMap();
function showOverlay(el, focusTarget) {
  if (el.hidden || el.classList.contains("closing")) overlayOpeners.set(el, document.activeElement);
  el.classList.remove("closing");
  el.hidden = false;
  focusTarget.focus({ preventScroll: true });
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Tab" || document.querySelector("dialog[open]")) return;
  const overlay = ["shortcuts-modal", "compare-modal", "lightbox", "settings"]
    .map($).find(el => !el.hidden && !el.classList.contains("closing"));
  if (!overlay) return;
  const targets = [...overlay.querySelectorAll("button:not(:disabled), a[href], input:not(:disabled), textarea, select, summary, [tabindex='0']")]
    .filter(el => el.tabIndex >= 0 && el.getClientRects().length);
  if (!targets.length) return;
  const focus = document.activeElement;
  if (!overlay.contains(focus) || focus === (event.shiftKey ? targets[0] : targets.at(-1))) {
    event.preventDefault();
    (event.shiftKey ? targets.at(-1) : targets[0]).focus();
  }
}, true);

/* 带退场动画地关闭弹窗（灯箱、设置与对比共用 .lightbox 的 closing 关键帧） */
function closeOverlayAnimated(el, after) {
  if (!el || el.hidden || el.classList.contains("closing")) return;
  const finish = () => {
    const restore = el.contains(document.activeElement) || document.activeElement === document.body;
    el.hidden = true;
    el.classList.remove("closing");
    if (after) after();
    if (restore && !document.querySelector(".lightbox:not([hidden]), dialog[open]")) {
      const opener = overlayOpeners.get(el);
      const fallback = document.body.classList.contains("composer-open") ? $("rail-collapse-btn") : $("composer-open");
      (opener?.isConnected && opener.getClientRects().length && !opener.closest("[inert]") ? opener : fallback).focus({ preventScroll: true });
    }
    overlayOpeners.delete(el);
  };
  if (reduceMotion) {
    finish();
    return;
  }
  el.classList.add("closing");
  setTimeout(() => {
    if (!el.classList.contains("closing")) return;
    finish();
  }, 180);
}

function closeSettings() {
  closeProviderForm();
  closeOverlayAnimated(settingsEl, () => themeWrites.then(() => loadSettings()));
}

function openSettings() {
  showOverlay(settingsEl, $("set-close"));
}

$("open-settings").addEventListener("click", () => { openSettings(); setMsg(""); refreshHealth(false); });
$("set-close").addEventListener("click", closeSettings);
settingsEl.addEventListener("click", (e) => { if (e.target === settingsEl) closeSettings(); });
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
      if (modelList.length && !modelInput.value.trim()) modelInput.value = pickDefaultModel();
    }
  } catch {
    modelsLoading = false;
    modelInput.placeholder = "未配置 API，可手动填写模型名";
  }
  if (!modelListBox.hidden) renderModelList(modelList.includes(modelInput.value) ? "" : modelInput.value);
  updateCapabilityUI();
  renderRailProvider();
}

/* ---------- 画廊卡片滚动进场 ---------- */
const revealDelays = new WeakMap();
let revealBatchAt = 0;
const revealObserver = !reduceMotion && "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => {
      const staggered = performance.now() - revealBatchAt < 450;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const card = entry.target;
        const delay = staggered ? (revealDelays.get(card) || 0) : 0;
        card.style.transitionDelay = delay ? `${delay}ms` : "";
        card.classList.add("reveal-in");
        card.classList.remove("reveal");
        card.addEventListener("transitionend", () => { card.style.transitionDelay = ""; }, { once: true });
        revealObserver.unobserve(card);
      }
    }, { root: document.querySelector(".wall"), rootMargin: "60px 0px", threshold: 0.04 })
  : null;

function watchReveal(card, delay = 0) {
  if (!revealObserver) return;
  revealDelays.set(card, delay);
  card.classList.add("reveal");
  revealObserver.observe(card);
}

function revealSafetyNet() {
  setTimeout(() => {
    document.querySelectorAll("#gallery .print.reveal").forEach((c) => {
      c.classList.remove("reveal");
      c.classList.add("reveal-in");
    });
  }, 1500);
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
  if (onlyFinal) p.set("final", "1");
  return p.toString();
}

let historyRequest = 0;
async function loadHistory(p = page, scrollToTop = true) {
  const requestId = ++historyRequest;
  const qs = filterQuery();
  try {
    const r = await fetch(`/api/history?page=${p}&page_size=${PAGE_SIZE}&${qs}`);
    if (!r.ok) throw new Error("history");
    const d = await r.json();
    if (requestId !== historyRequest || qs !== filterQuery()) return;
    $("history-error").hidden = true;
    page = d.page; pages = d.pages; total = d.total;
    wallItems = d.items;
    if (batchMode) updateBatchCount();
    const wallCountEl = $("wall-count");
    if (wallCountEl) wallCountEl.textContent = `${total} 幅`;
    fillSelect($("f-model"), d.facets.models, "全部模型");
    fillSelect($("f-provider"), d.facets.providers, "全部来源");
    const g = $("gallery");
    const pending = g.querySelector(".print-developing");
    g.replaceChildren(...(pending ? [pending] : []), ...wallItems.map((item) => makeCard(item, false)));
    updateGalleryEmpty();
    renderPager();
    const known = speedMap();
    for (const it of d.items) {
      if (it.model && it.elapsed > 0 && !(known[it.model] || []).length) {
        noteSpeed(it.model, it.elapsed);
        known[it.model] = [it.elapsed];
      }
    }
    renderRequestPreview(capabilityFor(modelInput.value));
    revealBatchAt = performance.now();
    let vi = 0;
    for (const card of g.querySelectorAll(".print[data-name]")) watchReveal(card, Math.min(vi++, 9) * 45);
    revealSafetyNet();
    if (scrollToTop) $("library-heading").scrollIntoView({ block: "start" });
  } catch {
    if (requestId !== historyRequest || qs !== filterQuery()) return;
    $("history-error").hidden = false;
    for (const id of ["empty", "empty-filter", "empty-final", "pager"]) $(id).hidden = true;
  }
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
let onlyFinal = false;
$("f-fav").addEventListener("click", () => {
  onlyFav = !onlyFav;
  $("f-fav").classList.toggle("on", onlyFav);
  $("f-fav").setAttribute("aria-pressed", String(onlyFav));
  $("f-fav").innerHTML = onlyFav ? '<span class="ft-star">★</span> 收藏中' : '<span class="ft-star">★</span> 收藏';
  loadHistory(1);
});
$("f-final").addEventListener("click", () => {
  onlyFinal = !onlyFinal;
  $("f-final").setAttribute("aria-pressed", String(onlyFinal));
  loadHistory(1);
});

/* 批量管理 */
let batchMode = false;
const selected = new Set();

function offPageSelectionCount() {
  return selected.size - wallItems.filter(({ name }) => selected.has(name)).length;
}

function updateBatchCount() {
  const offPage = offPageSelectionCount();
  $("batch-count").textContent = `已选 ${selected.size} 张${offPage ? `（含其他页面 ${offPage} 张）` : ""}`;
  document.dispatchEvent(new Event("studio:selectionchange"));
}

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
  document.querySelectorAll("#gallery .print[data-name]").forEach((card) => {
    card.classList.toggle("selected", selected.has(card.dataset.name));
  });
  updateBatchCount();
  showToast(`已选本页 ${wallItems.length} 张，共 ${selected.size} 张`, "info");
});
$("batch-del").addEventListener("click", async () => {
  const names = [...selected];
  if (!names.length) { setGenMsg("先点击图片勾选要删除的照片"); showToast("请先点击图片勾选要删除的照片", "error"); return; }
  const offPage = offPageSelectionCount();
  const selection = offPage ? `${names.length} 张照片（含其他页面 ${offPage} 张）` : `${names.length} 张照片`;
  if (!confirm(`删除所选 ${selection}？文件会从 outputs 里移除。`)) return;
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
  window.openStudioComposer?.(false);
  if (editSource && !busy) setEditSource(null);
  const done = [];
  if (item.prompt) { setPrompt(item.prompt); done.push("提示词"); }
  if (item.model) { modelInput.value = item.model; done.push("模型"); }
  updateCapabilityUI();
  if (item.size && SIZE_RE.test(item.size)) {
    const isPreset = ratioPool(capabilityFor(modelInput.value)).some((entry) => entry.size === item.size);
    if (isPreset) size = item.size;
    sizeCustom.value = isPreset ? "" : item.size;
    sizeCustom.classList.remove("invalid");
    done.push("画幅");
  }
  for (const key of ["quality", "background", "style"]) {
    const v = item[key] || "";
    if ([...$(key).options].some((o) => o.value === v)) {
      $(key).value = v;
      if (v) done.push(PARAM_LABELS[v] || v);
    }
  }
  $("negative-prompt").value = item.negative_prompt || "";
  $("seed-input").value = item.seed ?? "";
  $("cfg-slider").value = item.cfg_scale ?? $("cfg-slider").defaultValue;
  $("send-cfg-scale").checked = item.cfg_scale != null;
  $("cfg-val").textContent = Number($("cfg-slider").value).toFixed(1);
  $("send-extension-params").checked = Boolean(item.negative_prompt || item.seed != null || item.cfg_scale != null);
  if (item.negative_prompt) done.push("反向词");
  if (item.seed != null) done.push("种子");
  if (item.cfg_scale != null) done.push("CFG");
  if (item.requested) {
    $("n").value = item.requested;
    markQuantity(currentN());
  }
  updateCapabilityUI();
  saveGenSettings();
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
  const secs = Number.isFinite(item.elapsed) ? `<span class="secs">${item.elapsed}s</span>` : "";
  const model = item.model || (item.fetch_error ? "远端原图" : "早期图片");
  const date = item.created_time ? escapeHtml(item.created_time.slice(5, 10)) : "";
  const caption = String(item.edit?.change || item.prompt || item.name || "未命名作品").replace(/\s+/g, " ").trim();
  card.title = item.prompt || item.fetch_error || "";
  card.innerHTML = `
    <div class="print-img-wrap">
      <img src="${escapeHtml(item.thumbnail_url || item.url)}" alt="${escapeHtml(caption.slice(0, 100))}" loading="lazy" decoding="async">
      <button class="print-open" type="button" aria-label="${escapeHtml("查看或选择作品：" + caption.slice(0, 50))}"></button>
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
        <button class="p-action-btn p-compare" type="button" title="加入 A/B 画面对比">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>
        </button>
        <a href="${escapeHtml(item.url)}" class="p-action-btn p-dl" download title="下载原图">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </a>
      </div>
    </div>
    <p class="print-caption">${escapeHtml(caption)}</p>
    <div class="meta">
      <button class="fav ${item.favorite ? "on" : ""}" type="button" title="收藏 / 取消收藏">★</button>
      <span class="model" title="${escapeHtml(model)}">${escapeHtml(model)}</span>
      ${item.edit?.review?.final ? '<span class="edit-final-badge">成稿</span>' : ""}
      ${secs}
      ${date ? `<span class="date">${date}</span>` : ""}
    </div>`;

  const onOpenOrSelect = () => {
    if (batchMode) toggleSelect(card, item);
    else openLightbox(item.url, item.name);
  };
  const preview = card.querySelector("img");
  if (item.thumbnail_url) preview.addEventListener("error", () => { preview.src = item.url; }, { once: true });

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

  card.querySelector(".p-compare")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openCompareModal(item);
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
    if (btn) {
      btn.classList.toggle("on", d.favorite);
      if (d.favorite) {
        btn.classList.remove("fav-pop");
        void btn.offsetWidth;
        btn.classList.add("fav-pop");
      }
    }
    if (!lightboxEl.hidden && lbItem?.name === item.name) {
      lbItem.favorite = d.favorite;
      renderLbFav(d.favorite);
    }
    if (onlyFav && !d.favorite) loadHistory(page, false);
    showToast(d.favorite ? "已加入收藏 ★" : "已移出收藏", "info");
  } catch (e) { setGenMsg("收藏失败：" + e.message); showToast("收藏失败：" + e.message, "error"); }
}

function cssEscape(s) {
  return window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
}

/* ---------- 生成参数：记住上次的选择 ---------- */
function saveGenSettings() {
  lsSet(SETTINGS_KEY, {
    size, customSize: sizeCustom.value.trim().toLowerCase(), n: currentN(),
    quality: $("quality").value, background: $("background").value, style: $("style").value,
    advOpen: $("advanced-params").open,
    negative_prompt: $("negative-prompt")?.value || "",
    seed: $("seed-input")?.value || "",
    cfg_scale: $("cfg-slider")?.value || "7.0",
    send_cfg_scale: $("send-cfg-scale").checked,
  });
}

function restoreGenSettings() {
  const s = lsGet(SETTINGS_KEY, null);
  if (!s || typeof s !== "object") return;
  if (typeof s.size === "string" && SIZE_RE.test(s.size)) size = s.size;
  if (typeof s.customSize === "string" && SIZE_RE.test(s.customSize)) sizeCustom.value = s.customSize;
  if (Number.isFinite(+s.n)) $("n").value = String(+s.n);
  for (const key of ["quality", "background", "style"]) {
    if (typeof s[key] === "string" && [...$(key).options].some((o) => o.value === s[key])) $(key).value = s[key];
  }
  if (s.advOpen) $("advanced-params").open = true;
  if (s.negative_prompt && $("negative-prompt")) $("negative-prompt").value = s.negative_prompt;
  if (s.seed && $("seed-input")) $("seed-input").value = s.seed;
  if (s.cfg_scale && $("cfg-slider")) {
    const slider = $("cfg-slider");
    slider.value = s.cfg_scale;
    $("cfg-val").textContent = Number(slider.value).toFixed(1);
    $("send-cfg-scale").checked = s.send_cfg_scale ?? Number(slider.value) !== Number(slider.defaultValue);
  }
}

function extensionParams() {
  if (!$("send-extension-params").checked) return {};
  const fields = {};
  if ($("send-cfg-scale").checked) fields.cfg_scale = Number($("cfg-slider").value);
  const negative = $("negative-prompt").value.trim();
  const seed = $("seed-input");
  if (negative) fields.negative_prompt = negative;
  if (seed.validity.valid && seed.value !== "" && Number(seed.value) >= 0) fields.seed = Number(seed.value);
  return fields;
}

/* ---------- 画幅 ---------- */
const sizeCustom = $("size-custom");
const SIZE_RE = /^\d{2,5}x\d{2,5}$/;

function currentSize() {
  const custom = sizeCustom.value.trim().toLowerCase();
  return SIZE_RE.test(custom) ? custom : size;
}

function setSizeHint(text, bad = false) {
  const el = $("size-hint");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("bad", bad);
}

if (sizeCustom) sizeCustom.addEventListener("input", () => {
  const v = sizeCustom.value.trim().toLowerCase();
  markRatio();
  if (!SIZE_RE.test(v)) {
    const obviouslyBad = /[x×,，]/.test(v);
    sizeCustom.classList.toggle("invalid", obviouslyBad);
    setSizeHint(obviouslyBad ? "格式应为 宽x高，如 768x1344" : "", obviouslyBad);
    if (!v) {
      const [w, h] = size.split("x").map(Number);
      setSizeHint(`${size.replace("x", "×")} · ${ratioLabel(w, h)}` +
        (isOfficialSize(capabilityFor(modelInput.value), size) ? " · 官方" : ""));
    }
  } else {
    sizeCustom.classList.remove("invalid");
    setSizeHint(`已生效 ${v}（自定义）`);
  }
  saveGenSettings();
  renderRequestPreview(capabilityFor(modelInput?.value || ""));
});

/* ---------- 生成 ---------- */
function setGenMsg(text) { $("msg").textContent = text || ""; }

function showProgress(done, total) {
  const box = $("progress");
  if (!box) return;
  box.hidden = false;
  const pct = total > 1 ? Math.round((done / total) * 100) : 0;
  box.classList.toggle("indet", total <= 1);
  $("progress-fill").style.width = total > 1 ? `${pct}%` : "";
  $("progress-text").textContent = total > 1 ? `${done}/${total} 张 · ${pct}%` : "显影中…";
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
  renderReferenceThumbs();
  updateCapabilityUI();
}

function setEditSource(item) {
  if (item && item.name !== editSource?.name) {
    $("edit-change").value = "";
    $("edit-keep").value = "";
  }
  editSource = item;
  $("edit-draft").hidden = !item;
  $("prompt-workshop").hidden = Boolean(item);
  if (item) {
    $("edit-source-image").src = item.url;
    $("edit-source-name").textContent = item.name;
  } else {
    $("edit-source-image").removeAttribute("src");
  }
  if (!busy) $("go").querySelector(".go-text").textContent = item ? "生成改图" : "开始生成";
  setGenMsg("");
  updateCapabilityUI();
}

$("edit-cancel").addEventListener("click", () => setEditSource(null));

$("reference-add").addEventListener("click", () => {
  if (!$("reference-add").classList.contains("disabled")) $("reference-input").click();
});
$("reference-input").addEventListener("change", (e) => {
  [...e.target.files].forEach(addReference);
  e.target.value = "";
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

/* ---------- 生成任务 & 暗房显影动态状态机 ---------- */
let currentTaskId = null;
const TASK_CONTROL_TIMEOUT_MS = 5000;
const MAX_TASK_POLL_FAILURES = 5;
const GO_HTML = '<span class="go-spark" aria-hidden="true">✦</span><span class="go-text">开始生成</span><kbd class="go-kbd">Ctrl ↵</kbd>';

const PENDING_TASK_KEY = "shiguang.pending-task.v1";
let pendingTask = null;

function rememberTask(task) {
  pendingTask = task;
  try {
    if (task) sessionStorage.setItem(PENDING_TASK_KEY, JSON.stringify(task));
    else sessionStorage.removeItem(PENDING_TASK_KEY);
  } catch { /* The current page still holds its task when browser storage is unavailable. */ }
}

function showTaskState(state, text) {
  const strip = $("task-strip");
  strip.hidden = false;
  strip.dataset.state = state;
  if ($("task-summary").textContent !== text) $("task-summary").textContent = text;
  $("task-stop").hidden = state !== "running" || !currentTaskId;
  $("task-stop").disabled = $("go").disabled;
  $("task-reconnect").hidden = state !== "offline";
  $("task-dismiss").hidden = state === "running" || state === "offline";
}
$("task-dismiss").addEventListener("click", () => { $("task-strip").hidden = true; });
$("task-stop").addEventListener("click", cancelCurrentTask);
$("task-reconnect").addEventListener("click", resumePendingTask);

function makeDevelopingCard(label) {
  const card = document.createElement("div");
  card.className = "print print-developing";
  const devCap = capabilityFor(modelInput?.value || "");
  const [w, h] = (devCap.size_mode === "none" ? "1024x1024" : currentSize()).split("x");
  card.innerHTML = `
    <div class="developing" style="--developing-ratio:${w}/${h}">
      <div class="red-lamp" aria-hidden="true"></div>
      <div class="dev-label">${label}</div>
      <div class="dev-time">0s</div>
    </div>`;
  return card;
}

function setGoIdle() {
  busy = false;
  $("go").disabled = false;
  $("go").innerHTML = GO_HTML;
  if (pendingTask) $("go").querySelector(".go-text").textContent = "重新连接任务";
  else if (editSource) $("go").querySelector(".go-text").textContent = "生成改图";
  $("edit-cancel").disabled = false;
}

function updateGalleryEmpty() {
  const hasImages = Boolean(wallItems.length || $("gallery").querySelector(".print-developing"));
  const filtered = Boolean($("f-q").value.trim() || $("f-model").value || $("f-provider").value || $("f-range").value !== "all" || onlyFav);
  $("empty").hidden = hasImages || onlyFinal || filtered;
  $("empty-final").hidden = hasImages || !onlyFinal || filtered;
  $("empty-filter").hidden = hasImages || !filtered;
}

function appendGeneratedImages(images) {
  if (page !== 1 || filterQuery()) return;
  const gallery = $("gallery");
  const pending = gallery.querySelector(".print-developing");
  const fresh = images.filter((item) => item.name && !wallItems.some((existing) => existing.name === item.name));
  for (const item of fresh) {
    const card = makeCard(item, true);
    card.querySelector("img").classList.add("develop");
    if (pending) pending.after(card);
    else gallery.prepend(card);
    wallItems.unshift(item);
  }
}

async function withTaskControlTimeout(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TASK_CONTROL_TIMEOUT_MS);
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function cancelCurrentTask() {
  const id = currentTaskId;
  if (!id) return;
  setGenMsg("正在取消，当前这张出完就停…");
  $("go").disabled = true;
  $("go").innerHTML = "正在取消…";
  $("task-stop").disabled = true;
  try {
    const r = await withTaskControlTimeout((signal) => fetch("/api/task/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
      signal,
    }));
    if (!r.ok) throw new Error("取消请求失败");
  } catch {
    if (currentTaskId !== id) return;
    $("go").disabled = false;
    $("go").textContent = "取消本次生成";
    setGenMsg("未能确认取消请求，可以再次尝试取消");
    showTaskState("running", "取消请求尚未确认，可以再次取消");
  }
}

function taskLabel(t, targetImages) {
  if (t.status === "cancelling") return "取消中，正在等待已发出的请求结束";
  if (t.status === "queued") return "等待队列调度";
  return `正在生成 · 已收到 ${t.image_count || 0} / ${targetImages} 张`;
}

async function runTask(options, card, n, onImages) {
  const r = await fetch("/api/generate-task", options);
  const d = await r.json();
  if (!r.ok || !d.task_id) throw new Error(d.error || "无法创建生成任务");
  const task = { id: d.task_id, target: d.target_images || d.target_n || n || 1, started: Date.now() };
  rememberTask(task);
  return watchTask(task, card, onImages);
}

async function watchTask(task, card, onImages) {
  currentTaskId = task.id;
  $("go").textContent = "取消本次生成";
  $("go").disabled = false;
  const labelEl = card.querySelector(".dev-label");
  const targetImages = task.target;
  let rendered = 0;
  let pollFailures = 0;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    let t;
    try {
      t = await withTaskControlTimeout(async (signal) => {
        const status = await fetch(`/api/task?id=${encodeURIComponent(task.id)}`, { signal });
        if (status.status === 404) return { status: "missing" };
        return status.ok ? status.json() : null;
      });
    } catch { /* 短暂断线后重新查询同一个任务 */ }
    if (!t?.status) {
      if (++pollFailures >= MAX_TASK_POLL_FAILURES) {
        throw new Error("暂时无法查询进度。重新连接可继续跟踪原任务");
      }
      continue;
    }
    pollFailures = 0;
    if (t.status === "missing") {
      rememberTask(null);
      throw new Error("任务记录已失效，已生成的作品可在作品库查看");
    }
    const newText = taskLabel(t, targetImages);
    card.querySelector(".dev-time").textContent = Math.round((Date.now() - task.started) / 1000) + "s";
    if (t.status === "cancelling") $("go").disabled = true;
    showTaskState("running", newText);
    if (labelEl && labelEl.textContent !== newText) {
      labelEl.textContent = newText;
    }
    showProgress(t.image_count || 0, targetImages);
    const freshImgs = (t.images || []).slice(rendered);
    if (freshImgs.length) {
      onImages(freshImgs);
      rendered = t.images.length;
    }
    if (["done", "failed", "cancelled"].includes(t.status)) {
      rememberTask(null);
      return t;
    }
  }
}

function reportTaskResult(result) {
  const count = (result.images || []).length;
  const message = result.status === "cancelled" ? `已取消，保留 ${count} 张作品`
    : result.status === "failed" ? `生成失败：${result.errors?.[0]?.error || "服务未返回图片"}`
    : result.notice || `完成 ${count} 张${result.elapsed ? " · 耗时 " + result.elapsed + "s" : ""}`;
  setGenMsg(message);
  showTaskState(result.status === "failed" ? "error" : "done", message);
}

function reportTaskError(error) {
  setGenMsg("出错：" + error.message);
  showTaskState(pendingTask ? "offline" : "error", error.message);
}

async function resumePendingTask() {
  if (busy || !pendingTask) return;
  busy = true;
  $("edit-cancel").disabled = true;
  const card = makeDevelopingCard("正在连接原任务");
  $("gallery").prepend(card);
  updateGalleryEmpty();
  showTaskState("running", "正在连接原任务…");
  try {
    const result = await watchTask(pendingTask, card, appendGeneratedImages);
    reportTaskResult(result);
  } catch (error) {
    reportTaskError(error);
  } finally {
    card.remove();
    currentTaskId = null;
    hideProgress();
    setGoIdle();
    updateGalleryEmpty();
    loadHistory(page, false);
  }
}

async function gen() {
  if (busy) return;
  if (pendingTask) { await resumePendingTask(); return; }
  const submittedEdit = editSource;
  const prompt = submittedEdit ? "" : $("prompt").value.trim();
  const change = submittedEdit ? $("edit-change").value.trim() : "";
  const model = modelInput.value.trim();
  if (submittedEdit && !change) { setGenMsg("请填写要改什么"); $("edit-change").focus(); return; }
  if (!submittedEdit && !prompt) { setGenMsg("请先写提示词"); $("prompt").focus(); return; }
  if (!model) { setGenMsg("请先选择或填写模型"); modelInput.focus(); return; }
  if (prompt.length > (limits.max_prompt_chars || 8000)) {
    setGenMsg(`提示词过长（${prompt.length} 字），请控制在 ${limits.max_prompt_chars} 字以内`);
    return;
  }
  const customRaw = sizeCustom?.value.trim() || "";
  const cap = capabilityFor(model);
  if (submittedEdit && !cap.image_to_image) {
    setGenMsg("请先选择支持图生图的模型");
    modelInput.focus();
    return;
  }
  if (cap.size_mode !== "none" && customRaw && !SIZE_RE.test(customRaw.toLowerCase())) {
    setGenMsg("自定义画幅格式应为 宽x高，如 768x1344；可清空输入框改用预设");
    sizeCustom.classList.add("invalid");
    return;
  }
  if ($("send-extension-params").checked && !$("seed-input").validity.valid) {
    $("advanced-params").open = true;
    $("seed-input").reportValidity();
    return;
  }
  const n = submittedEdit ? 1 : currentN();
  const submittedReferences = submittedEdit ? [] : [...referenceFiles];
  if (submittedReferences.length && !cap.image_to_image) {
    setGenMsg("当前模型不支持参考图，请移除参考图或切换模型");
    return;
  }

  // 触发相机快门声
  playShutterSound();

  busy = true;
  $("go").disabled = true;
  $("edit-cancel").disabled = true;
  setGenMsg("");
  const useQueue = n > 1 || Boolean(submittedEdit);
  window.studioGenerationStarted?.();
  const card = makeDevelopingCard("等待生图服务返回");
  $("gallery").prepend(card);
  updateGalleryEmpty();
  enterCard(card);
  const timeEl = card.querySelector(".dev-time");
  showTaskState("running", `${model} · 已提交 ${n} 张，正在等待结果`);
  const t0 = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    timeEl.textContent = `${elapsed}s`;
  }, 500);
  showProgress(0, n);

  const fields = { model, quality: $("quality").value, background: $("background").value,
    style: $("style").value, n: String(n), ...extensionParams() };
  if (submittedEdit) {
    fields.edit_parent = submittedEdit.name;
    fields.edit_change = change;
    fields.edit_keep = $("edit-keep").value.trim();
  } else {
    fields.prompt = prompt;
  }
  if (cap.size_mode !== "none") fields.size = currentSize();

  const options = { method: "POST" };
  if (submittedReferences.length) {
    const form = new FormData();
    Object.entries(fields).forEach(([key, value]) => form.append(key, value));
    submittedReferences.forEach((f) => form.append("image", f, f.name || "reference.png"));
    options.body = form;
  } else {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(fields);
  }

  try {
    let result;
    if (useQueue) {
      result = await runTask(options, card, n, appendGeneratedImages);
    } else {
      const r = await fetch("/api/generate", options);
      result = await r.json();
      if (result.warning) showToast(result.warning, "error");
      if (!r.ok || result.error) throw new Error(result.error || "生成请求失败");
      appendGeneratedImages(result.images || []);
    }
    const images = (result.images || []).filter((item) => item.name);
    if (images.length) {
      if (prompt) pushPromptHistory(prompt);
      pushRecentModel(model);
      const secs = images.map((item) => item.elapsed).filter((value) => value > 0);
      if (secs.length) noteSpeed(model, secs.reduce((sum, value) => sum + value, 0) / secs.length);
      playChimeSound();
      if (submittedReferences.length && referenceFiles.length === submittedReferences.length &&
          referenceFiles.every((file, i) => file === submittedReferences[i])) clearReference();
    }
    if (submittedEdit && images.length && result.status !== "cancelled") {
      setEditSource(null);
      openCompareModal(submittedEdit, images[0], true);
    }
    reportTaskResult(result);
  } catch (e) {
    reportTaskError(e);
  } finally {
    card.remove();
    currentTaskId = null;
    clearInterval(timer);
    hideProgress();
    setGoIdle();
    updateGalleryEmpty();
    renderRailProvider();
    renderRequestPreview(capabilityFor(modelInput.value));
    loadHistory(page, false);
  }
}

/* ---------- 灯箱：缩放 + 平移 + 惯性滑动 + Minimap 雷达 ---------- */
const lightboxEl = $("lightbox");
const lbImg = $("lb-img");
const stage = document.querySelector(".lightbox .stage");
let scale = 1, tx = 0, ty = 0;
let lbItem = null;
const MIN_SCALE = 0.2, MAX_SCALE = 10;

function applyTransform(instant = false) {
  lbImg.style.transition = instant ? "none" : "";
  lbImg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  stage.classList.toggle("zoomed", scale > 1);
  $("zoom-level").textContent = `${Math.round(scale * 100)}%`;
  updateMinimap();
}

function resetZoom() {
  stopPan();
  stopInertia();
  scale = 1;
  tx = 0;
  ty = 0;
  applyTransform();
}

function clampPan() {
  // 图片居中缩放，任一方向的可移动距离是溢出量的一半。
  const maxX = Math.max(0, (lbImg.offsetWidth * scale - stage.clientWidth) / 2);
  const maxY = Math.max(0, (lbImg.offsetHeight * scale - stage.clientHeight) / 2);
  tx = Math.max(-maxX, Math.min(maxX, tx));
  ty = Math.max(-maxY, Math.min(maxY, ty));
}

function zoomAt(clientX, clientY, factor) {
  stopInertia();
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

/* 平移带惯性物理滑动 (Smooth Pan with Inertia) */
let panPointer = null, lastX = 0, lastY = 0;
let vx = 0, vy = 0;
let lastMoveTime = 0;
let inertiaRaf = null;

function stopInertia() {
  if (inertiaRaf) { cancelAnimationFrame(inertiaRaf); inertiaRaf = null; }
}

function stopPan() {
  if (panPointer === null) return;
  const pointer = panPointer;
  panPointer = null;
  stage.classList.remove("panning");
  lbImg.classList.remove("dragging");
  const target = lbImg.hasPointerCapture(pointer) ? lbImg : stage;
  if (target.hasPointerCapture(pointer)) target.releasePointerCapture(pointer);
}

stage.addEventListener("pointerdown", (e) => {
  if (scale <= 1 || e.button !== 0 || panPointer !== null || e.target.closest(".lb-nav, .lb-minimap")) return;
  stopInertia();
  panPointer = e.pointerId;
  lastX = e.clientX; lastY = e.clientY;
  lastMoveTime = performance.now();
  vx = 0; vy = 0;
  stage.classList.add("panning");
  lbImg.classList.add("dragging");
  e.target.setPointerCapture(e.pointerId);
});

stage.addEventListener("pointermove", (e) => {
  if (panPointer !== e.pointerId) return;
  const now = performance.now();
  const dt = Math.max(1, now - lastMoveTime);
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  tx += dx;
  ty += dy;
  vx = dx / dt;
  vy = dy / dt;
  lastX = e.clientX;
  lastY = e.clientY;
  lastMoveTime = now;
  clampPan();
  applyTransform(true);
});

stage.addEventListener("lostpointercapture", (e) => {
  if (panPointer === e.pointerId) stopPan();
});

stage.addEventListener("pointerup", (e) => {
  if (panPointer !== e.pointerId) return;
  stopPan();

  const speed = Math.hypot(vx, vy);
  if (!reduceMotion && speed > 0.08 && performance.now() - lastMoveTime < 100) {
    let curVx = vx * 16;
    let curVy = vy * 16;
    const friction = 0.92;
    function stepInertia() {
      inertiaRaf = null;
      if (Math.hypot(curVx, curVy) < 0.2) return;
      tx += curVx;
      ty += curVy;
      curVx *= friction;
      curVy *= friction;
      clampPan();
      applyTransform(true);
      inertiaRaf = requestAnimationFrame(stepInertia);
    }
    inertiaRaf = requestAnimationFrame(stepInertia);
  }
});

lbImg.addEventListener("dblclick", (e) => {
  if (scale > 1.05) {
    resetZoom();
  } else {
    zoomAt(e.clientX, e.clientY, 2.5);
  }
});

/* ---------- Minimap Radar 雷达导航图 ---------- */
function updateMinimap() {
  const minimap = $("lb-minimap");
  const canvas = $("lb-minimap-canvas");
  const vp = $("lb-minimap-viewport");
  if (!minimap || !canvas || !vp || !lbImg || !stage) return;

  if (scale <= 1.05) {
    minimap.style.opacity = "0";
    minimap.style.pointerEvents = "none";
    return;
  }

  minimap.style.opacity = "1";
  minimap.style.pointerEvents = "auto";

  const ctx = canvas.getContext("2d");
  if (lbImg.naturalWidth && lbImg.naturalHeight) {
    const nw = lbImg.naturalWidth;
    const nh = lbImg.naturalHeight;
    const maxW = 120, maxH = 80;
    const r = Math.min(maxW / nw, maxH / nh);
    const cw = Math.max(1, Math.round(nw * r));
    const ch = Math.max(1, Math.round(nh * r));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    ctx.clearRect(0, 0, cw, ch);
    try {
      ctx.drawImage(lbImg, 0, 0, cw, ch);
    } catch {}

    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const iw = lbImg.offsetWidth * scale;
    const ih = lbImg.offsetHeight * scale;
    if (iw <= 0 || ih <= 0) return;

    const x0 = (sw - iw) / 2 + tx;
    const y0 = (sh - ih) / 2 + ty;
    const nx0 = Math.max(0, -x0 / iw);
    const ny0 = Math.max(0, -y0 / ih);
    const nx1 = Math.min(1, (sw - x0) / iw);
    const ny1 = Math.min(1, (sh - y0) / ih);

    const vpL = nx0 * cw;
    const vpT = ny0 * ch;
    const vpW = Math.max(6, (nx1 - nx0) * cw);
    const vpH = Math.max(6, (ny1 - ny0) * ch);

    vp.style.left = `${vpL}px`;
    vp.style.top = `${vpT}px`;
    vp.style.width = `${vpW}px`;
    vp.style.height = `${vpH}px`;
  }
}

function initMinimapRadar() {
  const minimap = $("lb-minimap");
  const canvas = $("lb-minimap-canvas");
  if (!minimap || !canvas) return;

  const onMinimapClick = (e) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    stopInertia();
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    const iw = lbImg.offsetWidth * scale;
    const ih = lbImg.offsetHeight * scale;

    tx = -(nx - 0.5) * iw;
    ty = -(ny - 0.5) * ih;
    clampPan();
    applyTransform(true);
  };

  minimap.addEventListener("click", onMinimapClick);
}

/* ---------- 灯箱开关 + 信息面板 + 左右切换 ---------- */
function renderLbFav(on) { $("lb-fav").textContent = on ? "★ 已收藏" : "☆ 收藏"; }

function fillLbInfo(item) {
  $("lb-model").textContent = item.model || "—";
  if ($("lb-seed")) $("lb-seed").textContent = item.seed ?? "—";
  $("lb-provider").textContent = item.provider || "—";
  $("lb-time").textContent = item.created_time || "—";
  $("lb-elapsed").textContent = item.elapsed != null ? `${item.elapsed} 秒` : "—";
  $("lb-size").textContent = item.size
    ? `${item.size.replace("x", "×")}${item.size_requested ? `（原请求 ${item.size_requested.replace("x", "×")}，中转站不接受已回退）` : ""}`
    : "—";
  const params = $("lb-params");
  if (params) {
    const list = [["质量", item.quality], ["背景", item.background], ["风格", item.style],
      ["请求 CFG", item.cfg_scale], ["请求反向提示词", item.negative_prompt]]
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
        chip.dataset.hex = hex;
        chip.style.backgroundColor = hex;
        chip.title = `点击复制色值 ${hex}`;
        chip.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(hex); } catch {}
          showToast(`已复制色值：${hex}`, "success");
        });
        palEl.appendChild(chip);
      });
    } catch {}
  };
  tempImg.src = imgEl.src;
}

let lbParent = null;

function renderLightboxVersions(item, children = []) {
  const review = item.edit?.review;
  const info = $("lb-edit-status");
  const links = $("lb-version-links");
  $("lb-versions").hidden = !item.edit && !children.length;
  $("lb-review").hidden = !item.edit;
  info.hidden = !review;
  if (review) {
    const passed = review.checks.filter(Boolean).length;
    const status = review.final ? "已标记成稿" : passed === review.checks.length ? "已验收" : "验收未通过";
    info.textContent = review.saved_at ? `${passed} / ${review.checks.length} 项通过 · ${status}` : "待验收";
  }
  links.replaceChildren();
  for (const [label, version] of [["查看原图", lbParent], ...children.map((child) => ["查看衍生版", child])]) {
    if (!version) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "zoom-btn wide edit-version-link";
    button.textContent = `${label} · ${version.name}${version.edit?.review?.final ? " · 成稿" : ""}`;
    button.addEventListener("click", () => showLightboxItem(version));
    links.append(button);
  }
}

async function loadLightboxVersions(item) {
  try {
    const res = await fetch(`/api/history/versions?name=${encodeURIComponent(item.name)}`);
    if (!res.ok) throw new Error("无法加载改图版本");
    const data = await res.json();
    if (lbItem !== item || lightboxEl.hidden) return;
    item.edit = data.item.edit;
    lbParent = data.parent;
    renderLightboxVersions(item, data.children);
    $("lb-review").disabled = false;
  } catch {
    if (lbItem !== item || lightboxEl.hidden || !item.edit) return;
    $("lb-edit-status").hidden = false;
    $("lb-edit-status").textContent = "版本记录加载失败，重新打开照片可再试。";
  }
}

function showLightboxItem(item) {
  lbItem = { ...item };
  lbParent = null;
  lbImg.src = item.url;
  $("lb-dl").href = item.url;
  $("lb-name").textContent = item.name || item.url.split("/").pop();
  fillLbInfo(item);
  const useAsSource = /\.(png|jpe?g|webp)$/i.test(item.name || "");
  $("lb-edit").disabled = !useAsSource;
  $("lb-edit").title = useAsSource ? "" : "改图原图仅支持 PNG、JPEG 或 WEBP";
  $("lb-review").disabled = true;
  renderLightboxVersions(lbItem);
  if (item.name) loadLightboxVersions(lbItem);
  extractPalette(lbImg);
  resetZoom();
}

function moveLightbox(offset) {
  if (!wallItems.length) return;
  const current = wallItems.findIndex((item) => item.name === lbItem?.name);
  const start = current < 0 && offset < 0 ? 0 : current;
  const index = (start + offset + wallItems.length) % wallItems.length;
  showLightboxItem(wallItems[index]);
}

function openLightboxItem(item) {
  showOverlay(lightboxEl, $("lb-close"));
  showLightboxItem(item);
  if (gsapOK) gsap.from(lightboxEl.querySelector(".frame"), { y: 18, autoAlpha: 0, duration: 0.3, ease: "power2.out", clearProps: "all" });
}

function openLightbox(url, name) {
  openLightboxItem(wallItems.find((item) => item.url === url || (name && item.name === name)) || { url, name });
}

function closeLightbox() {
  stopPan();
  stopInertia();
  closeOverlayAnimated(lightboxEl, () => {
    lbItem = null;
    lbImg.src = "";
    const pal = $("lb-palette");
    if (pal) pal.innerHTML = "";
  });
}

$("lb-prev").addEventListener("click", () => moveLightbox(-1));
$("lb-next").addEventListener("click", () => moveLightbox(1));
$("lb-close").addEventListener("click", closeLightbox);
lightboxEl.addEventListener("click", (e) => { if (e.target === lightboxEl) closeLightbox(); });

function openShortcutsModal() {
  const modal = $("shortcuts-modal");
  if (!modal) return;
  showOverlay(modal, $("shortcuts-close"));
  if (gsapOK) {
    gsap.from(".shortcuts-frame", { y: 20, autoAlpha: 0, duration: 0.32, ease: "power2.out", clearProps: "all" });
  }
}

function closeShortcutsModal() {
  const modal = $("shortcuts-modal");
  if (!modal || modal.hidden) return;
  closeOverlayAnimated(modal);
}

document.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]") || e.defaultPrevented) return;
  if (e.key === "Escape") {
    if (!$("shortcuts-modal")?.hidden) closeShortcutsModal();
    else if (!$("compare-modal")?.hidden) closeCompareModal();
    else if (!lightboxEl.hidden) closeLightbox();
    else if (!settingsEl.hidden) closeSettings();
    else if (batchMode) setBatchMode(false);
    return;
  }
  if ((e.key === "?" || (e.shiftKey && e.key === "/")) && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
    if (!lightboxEl.hidden || !settingsEl.hidden || !$("compare-modal")?.hidden) return;
    e.preventDefault();
    openShortcutsModal();
    return;
  }
  if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
    if (!lightboxEl.hidden || !settingsEl.hidden || !$("compare-modal")?.hidden || !$("shortcuts-modal")?.hidden) return;
    e.preventDefault();
    window.closeStudioComposer?.();
    $("f-q")?.focus();
    return;
  }
  if (lightboxEl.hidden) return;
  if (e.key === "ArrowLeft") moveLightbox(-1);
  if (e.key === "ArrowRight") moveLightbox(1);
  if (e.key.toLowerCase() === "f") { e.preventDefault(); resetZoom(); }
});

$("lb-copy").addEventListener("click", async () => {
  const text = lbItem?.prompt || "";
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

$("lb-copy-prompt-btn")?.addEventListener("click", () => $("lb-copy").click());

$("lb-copy-model")?.addEventListener("click", async () => {
  const txt = $("lb-model")?.textContent;
  if (txt && txt !== "—") {
    try { await navigator.clipboard.writeText(txt); } catch {}
    showToast(`已复制模型名称: ${txt}`, "success");
  }
});

$("lb-copy-seed")?.addEventListener("click", async () => {
  const txt = $("lb-seed")?.textContent;
  if (txt && txt !== "—") {
    try { await navigator.clipboard.writeText(txt); } catch {}
    showToast(`已复制随机种子: ${txt}`, "success");
  }
});

$("lb-fav").addEventListener("click", () => {
  if (lbItem?.name) toggleFavorite(lbItem);
});

$("lb-reuse").addEventListener("click", () => {
  if (!lbItem) return;
  reuseParamsFromItem(lbItem);
  closeLightbox();
});

$("lb-edit").addEventListener("click", () => {
  if (!lbItem) return;
  if (busy) {
    showToast("当前生成任务结束后可开启改图", "info");
    return;
  }
  setEditSource(lbItem);
  closeLightbox();
  window.openStudioComposer?.(false);
  if (document.body.classList.contains("rail-collapsed")) setRailCollapsed(false);
  $("edit-change").focus();
});

$("lb-review").addEventListener("click", () => {
  if (!lbItem?.edit) return;
  openCompareModal(lbParent, lbItem, true);
  closeLightbox();
});

$("lb-del").addEventListener("click", async () => {
  const name = lbItem?.name;
  if (!name) { closeLightbox(); return; }
  if (!confirm("删除这张照片？文件会从 outputs 里移除。")) return;
  try {
    const r = await fetch("/api/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const index = wallItems.findIndex((item) => item.name === name);
    if (index !== -1) wallItems.splice(index, 1);
    if (!lightboxEl.hidden && lbItem?.name === name) {
      if (wallItems.length) showLightboxItem(wallItems[Math.max(0, index) % wallItems.length]);
      else closeLightbox();
    }
    loadHistory(page);
    showToast("照片已成功删除", "info");
  } catch (e) { setGenMsg("删除失败：" + e.message); showToast("删除失败：" + e.message, "error"); }
});

/* ==========================================================================
   交互式 A/B 图像对比分析台 (Interactive A/B Comparison Modal)
   ========================================================================== */
let cmpItemA = null;
let cmpItemB = null;
let cmpSplitPct = 50;
let cmpMode = "split"; // "split", "side", "diff"
let cmpDragging = false;
let cmpReview = false;
let reviewSaving = false;

function reviewCheckboxes() {
  return [...$("compare-review").querySelectorAll("input[type=checkbox]")];
}

function updateReviewActions() {
  if (!cmpReview) return;
  const boxes = reviewCheckboxes();
  const passed = boxes.filter((box) => box.checked).length;
  const isFinal = cmpItemB.edit.review.final;
  $("review-progress").textContent = `${passed} / ${boxes.length} 项通过${isFinal ? " · 已标记成稿" : ""}`;
  $("review-save").disabled = reviewSaving;
  $("review-final").disabled = reviewSaving || (!isFinal && passed !== boxes.length);
  $("review-final").textContent = isFinal ? "取消成稿标记" : "标记为成稿";
  boxes.forEach((box) => { box.disabled = reviewSaving; });
}

function renderCompareReview() {
  $("compare-review").hidden = !cmpReview;
  if (!cmpReview) return;
  $("review-message").textContent = "";
  $("review-missing-source").hidden = Boolean(cmpItemA);
  const { change, keep, review } = cmpItemB.edit;
  $("review-keep-group").hidden = !keep.length;
  for (const [id, items, offset] of [["review-change", change, 0], ["review-keep", keep, change.length]]) {
    $(id).replaceChildren(...items.map((text, index) => {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = review.checks[offset + index];
      const description = document.createElement("span");
      description.textContent = text;
      label.append(box, description);
      return label;
    }));
  }
  updateReviewActions();
}

async function saveCompareReview(markFinal) {
  if (!cmpReview || reviewSaving) return;
  const item = cmpItemB;
  const checks = reviewCheckboxes().map((box) => box.checked);
  const final = markFinal ? !item.edit.review.final : item.edit.review.final && checks.every(Boolean);
  reviewSaving = true;
  updateReviewActions();
  $("review-message").textContent = "正在保存…";
  try {
    const response = await fetch("/api/history/review", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: item.name, checks, final }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "保存失败");
    item.edit.review = data.review;
    if (cmpItemB === item && cmpReview) {
      $("review-message").textContent = data.review.final ? "已保存为成稿" : "验收已保存";
    }
    if (lbItem?.name === item.name) loadLightboxVersions(lbItem);
    loadHistory(page, false);
  } catch (error) {
    if (cmpItemB === item && cmpReview) $("review-message").textContent = `未能保存 · ${error.message}`;
  } finally {
    reviewSaving = false;
    updateReviewActions();
  }
}

function openCompareModal(itemA = null, itemB = null, review = false) {
  const modal = $("compare-modal");
  if (!modal) return;

  if (!review) {
    if (!itemA && wallItems.length) itemA = wallItems[0];
    if (!itemB) {
      itemB = wallItems.find((item) => item.name !== itemA?.name) || itemA;
    }
  }

  if (!itemA && !itemB) {
    showToast("画廊中暂无作品可供比对，请先生成或加载照片", "info");
    return;
  }

  cmpReview = review && Boolean(itemB?.edit);
  cmpItemA = cmpReview ? itemA : itemA || itemB;
  cmpItemB = itemB || itemA;

  const imgA = $("compare-img-a");
  const imgB = $("compare-img-b");
  imgA.hidden = !cmpItemA;
  if (cmpItemA) imgA.src = cmpItemA.url;
  else imgA.removeAttribute("src");
  imgB.src = cmpItemB.url;
  $("compare-tag-a").textContent = cmpReview ? (cmpItemA ? "原图" : "原图缺失") : "方案 A";
  $("compare-tag-b").textContent = cmpReview ? "改图" : "方案 B";

  updateCmpCard("a", cmpItemA);
  updateCmpCard("b", cmpItemB);

  renderCompareReview();
  setCompareMode(cmpReview && !cmpItemA ? "side" : "split");
  setCompareSplit(50);

  showOverlay(modal, $("compare-close"));
  modal.querySelector(".compare-frame").scrollTop = 0;

  if (gsapOK) {
    gsap.from(".compare-frame", { y: 24, autoAlpha: 0, duration: 0.35, ease: "power2.out", clearProps: "all" });
  }
}

function updateCmpCard(prefix, item) {
  item = item || {};
  const setTxt = (id, txt) => { const el = $(`cmp-${id}-${prefix}`); if (el) el.textContent = txt; };
  setTxt("model", item.model || "—");
  setTxt("time", item.created_time || (item.elapsed ? `${item.elapsed}s` : "—"));
  setTxt("prompt", item.prompt || "（无提示词记录）");
  setTxt("seed", `请求 Seed ${item.seed ?? "—"}`);
  setTxt("cfg", `请求 CFG ${item.cfg_scale ?? "—"}`);
  setTxt("size", `尺寸: ${item.size ? item.size.replace("x", "×") : "—"}`);
  setTxt("prov", `线路: ${item.provider || "主线路"}`);
}

function closeCompareModal() {
  const modal = $("compare-modal");
  if (!modal || modal.hidden) return;
  closeOverlayAnimated(modal, () => {
    const reviewed = cmpReview ? cmpItemB : null;
    cmpReview = false;
    cmpItemA = null;
    cmpItemB = null;
    if (reviewed) openLightboxItem(reviewed);
  });
}

function setCompareSplit(pct) {
  cmpSplitPct = Math.max(0, Math.min(100, pct));
  const handle = $("compare-handle");
  const layerA = $("compare-layer-a");
  if (handle) {
    handle.style.left = `${cmpSplitPct}%`;
    handle.setAttribute("aria-valuenow", String(Math.round(cmpSplitPct)));
  }
  if (layerA) {
    layerA.style.clipPath = `polygon(0 0, ${cmpSplitPct}% 0, ${cmpSplitPct}% 100%, 0 100%)`;
  }
}

function setCompareMode(mode) {
  cmpMode = mode;
  const wrap = $("compare-split-wrap");
  const handle = $("compare-handle");
  const layerA = $("compare-layer-a");

  document.querySelectorAll(".compare-pill-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.cmp === mode);
  });

  if (!wrap) return;
  wrap.classList.remove("mode-side", "mode-diff");

  if (mode === "side") {
    wrap.classList.add("mode-side");
    if (handle) handle.hidden = true;
    if (layerA) layerA.style.clipPath = "none";
  } else if (mode === "diff") {
    wrap.classList.add("mode-diff");
    if (handle) handle.hidden = true;
    if (layerA) layerA.style.clipPath = "none";
  } else {
    if (handle) handle.hidden = false;
    setCompareSplit(cmpSplitPct);
  }
}

function initCompareTool() {
  const closeBtn = $("compare-close");
  const modal = $("compare-modal");
  const handle = $("compare-handle");
  const splitWrap = $("compare-split-wrap");

  $("compare-review").addEventListener("change", updateReviewActions);
  $("review-save").addEventListener("click", () => saveCompareReview(false));
  $("review-final").addEventListener("click", () => saveCompareReview(true));
  if (closeBtn) closeBtn.addEventListener("click", closeCompareModal);
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeCompareModal();
    });
  }

  document.querySelectorAll(".compare-pill-btn").forEach((btn) => {
    btn.addEventListener("click", () => setCompareMode(btn.dataset.cmp));
  });

  $("f-compare")?.addEventListener("click", () => openCompareModal());

  $("lb-compare-btn")?.addEventListener("click", () => {
    const curItem = lbItem;
    closeLightbox();
    setTimeout(() => openCompareModal(curItem), 120);
  });

  if (handle && splitWrap) {
    const onPointerMove = (e) => {
      if (!cmpDragging) return;
      const rect = splitWrap.getBoundingClientRect();
      if (!rect.width) return;
      const x = e.clientX - rect.left;
      const pct = (x / rect.width) * 100;
      setCompareSplit(pct);
    };

    const onPointerUp = (e) => {
      if (!cmpDragging) return;
      cmpDragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch {}
      splitWrap.classList.remove("dragging");
    };

    handle.addEventListener("pointerdown", (e) => {
      cmpDragging = true;
      try { handle.setPointerCapture(e.pointerId); } catch {}
      splitWrap.classList.add("dragging");
      e.preventDefault();
    });

    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);

    splitWrap.addEventListener("click", (e) => {
      if (cmpMode !== "split" || e.target.closest("#compare-handle")) return;
      const rect = splitWrap.getBoundingClientRect();
      if (!rect.width) return;
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      if (gsapOK) {
        gsap.to({ p: cmpSplitPct }, {
          p: pct,
          duration: 0.25,
          ease: "power2.out",
          onUpdate: function () { setCompareSplit(this.targets()[0].p); },
        });
      } else {
        setCompareSplit(pct);
      }
    });

    handle.addEventListener("keydown", (e) => {
      if (cmpMode !== "split") return;
      if (e.key === "ArrowLeft") { e.preventDefault(); setCompareSplit(cmpSplitPct - (e.shiftKey ? 10 : 2)); }
      else if (e.key === "ArrowRight") { e.preventDefault(); setCompareSplit(cmpSplitPct + (e.shiftKey ? 10 : 2)); }
      else if (e.key === "Home") { e.preventDefault(); setCompareSplit(0); }
      else if (e.key === "End") { e.preventDefault(); setCompareSplit(100); }
    });
  }
}

/* ==========================================================================
   Pro Style & Camera Preset Matrix 矩阵控制器
   ========================================================================== */
function initPresetMatrix() {
  const matrix = $("style-preset-matrix");
  const toggleBtn = $("prompt-matrix-btn");
  const closeBtn = $("spm-close-btn");

  if (toggleBtn && matrix) {
    toggleBtn.addEventListener("click", () => {
      const isOpen = !matrix.hidden;
      matrix.hidden = isOpen;
      toggleBtn.classList.toggle("on", !isOpen);
      if (!isOpen && gsapOK) {
        gsap.from(matrix, { opacity: 0, y: -8, duration: 0.28, ease: "power2.out", clearProps: "all" });
      }
    });
  }

  if (closeBtn && matrix) {
    closeBtn.addEventListener("click", () => {
      matrix.hidden = true;
      toggleBtn?.classList.remove("on");
    });
  }

  // 选项卡切换
  const tabs = document.querySelectorAll(".spm-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");

      const targetTab = tab.dataset.tab;
      document.querySelectorAll(".spm-panel").forEach((panel) => {
        const isMatch = panel.id === `spm-panel-${targetTab}`;
        panel.hidden = !isMatch;
        panel.classList.toggle("active", isMatch);
        if (isMatch && gsapOK) {
          gsap.from(panel.querySelectorAll(".preset-chip"), {
            opacity: 0,
            y: 6,
            duration: 0.22,
            stagger: 0.02,
            ease: "power1.out",
            clearProps: "all",
          });
        }
      });
    });
  });

  // Preset Chips 点击添加/切换
  document.querySelectorAll(".preset-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const preset = chip.dataset.preset;
      if (!preset) return;
      togglePresetInPrompt(preset, chip);
    });
  });

  $("prompt").addEventListener("input", syncPresetChipsActive);
}

function togglePresetInPrompt(term, chipEl) {
  const promptEl = $("prompt");
  let val = promptEl.value.trim();
  const exists = val.includes(term);

  if (exists) {
    let regex = new RegExp(`([，,\\s]*)${escapeRegExp(term)}([，,\\s]*)`, "g");
    val = val.replace(regex, (match, p1, p2) => {
      return (p1 && p2) ? "，" : "";
    }).replace(/^[，,\\s]+|[，,\\s]+$/g, "");
    setPrompt(val);
    chipEl?.classList.remove("active", "selected");
    showToast(`已移除预设：${chipEl ? chipEl.textContent.trim() : term}`, "info");
  } else {
    if (!val) {
      val = term;
    } else {
      const needComma = !/[，,、；;。\s]$/.test(val);
      val = val + (needComma ? "，" : " ") + term;
    }
    setPrompt(val);
    chipEl?.classList.add("active", "selected");
    if (gsapOK && chipEl) {
      gsap.fromTo(chipEl, { scale: 0.94 }, { scale: 1, duration: 0.2, ease: "back.out(2)" });
    }
    showToast(`已追加预设：${chipEl ? chipEl.textContent.trim() : term}`, "success");
  }
  syncPresetChipsActive();
}

function syncPresetChipsActive() {
  const promptVal = $("prompt")?.value || "";
  document.querySelectorAll(".preset-chip").forEach((chip) => {
    const p = chip.dataset.preset;
    const on = p && promptVal.includes(p);
    chip.classList.toggle("active", on);
    chip.classList.toggle("selected", on);
  });
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ==========================================================================
   反向提示词 & 种子随机 & CFG 控制器
   ========================================================================== */
function initNegativePromptAndProParams() {
  const negToggleBtn = $("neg-toggle-btn");
  const negBody = $("neg-body");
  const negClearBtn = $("neg-clear-btn");
  const negTextarea = $("negative-prompt");
  const updateParams = () => {
    saveGenSettings();
    renderRequestPreview(capabilityFor(modelInput.value));
  };
  $("send-extension-params").addEventListener("change", updateParams);
  $("send-cfg-scale").addEventListener("change", updateParams);

  if (negToggleBtn && negBody) {
    negToggleBtn.addEventListener("click", () => {
      const isHidden = negBody.hidden;
      negBody.hidden = !isHidden;
      negToggleBtn.setAttribute("aria-expanded", String(isHidden));
      negToggleBtn.classList.toggle("open", isHidden);
      if (isHidden && gsapOK) {
        gsap.from(negBody, { opacity: 0, height: 0, duration: 0.25, ease: "power2.out", clearProps: "all" });
      }
    });
  }

  if (negClearBtn && negTextarea) {
    negClearBtn.addEventListener("click", () => {
      if (!negTextarea.value.trim()) return;
      negTextarea.value = "";
      updateParams();
      showToast("已清空反向提示词", "info");
    });
  }

  document.querySelectorAll(".neg-tag").forEach((btn) => {
    btn.addEventListener("click", () => {
      const neg = btn.dataset.neg || btn.dataset.negative;
      if (!neg || !negTextarea) return;
      let cur = negTextarea.value.trim();
      if (!cur) {
        negTextarea.value = neg;
      } else if (!cur.includes(neg)) {
        const needComma = !/[，,、；;。\s]$/.test(cur);
        negTextarea.value = cur + (needComma ? "，" : " ") + neg;
      }
      updateParams();
      showToast(`已追加排除项: ${btn.textContent.trim()}`, "info");
    });
  });

  if (negTextarea) {
    negTextarea.addEventListener("input", updateParams);
  }

  const seedInput = $("seed-input");
  seedInput.addEventListener("input", updateParams);
  const seedRandomBtn = $("seed-random-btn");
  if (seedRandomBtn && seedInput) {
    seedRandomBtn.addEventListener("click", () => {
      const newSeed = Math.floor(Math.random() * 2147483647);
      seedInput.value = String(newSeed);
      if (gsapOK) {
        gsap.fromTo(seedRandomBtn.querySelector("svg"), { rotation: 0 }, { rotation: 360, duration: 0.45, ease: "power2.out" });
      }
      playShutterSound();
      updateParams();
      showToast(`已生成随机种子: ${newSeed}`, "info");
    });
  }

  const cfgSlider = $("cfg-slider");
  const cfgVal = $("cfg-val");
  if (cfgSlider && cfgVal) {
    cfgSlider.addEventListener("input", () => {
      const v = parseFloat(cfgSlider.value).toFixed(1);
      cfgVal.textContent = v;
      $("send-cfg-scale").checked = true;
      updateParams();
    });
  }
}

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
  const dice = $("prompt-dice");
  dice.classList.add("rolling");
  setTimeout(() => dice.classList.remove("rolling"), 600);
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
  if (gsapOK) gsap.from("#gallery .print", { y: 14, autoAlpha: 0, duration: 0.4, stagger: 0.03, ease: "power2.out", clearProps: "all" });
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
for (const id of ["prompt", "edit-change", "edit-keep"]) {
  $(id).addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); gen(); }
  });
}

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

for (const id of ["quality", "background", "style"]) {
  $(id).addEventListener("change", () => {
    saveGenSettings();
    renderAdvSummary(capabilityFor(modelInput.value));
    renderRequestPreview(capabilityFor(modelInput.value));
  });
}
$("advanced-params").addEventListener("toggle", saveGenSettings);
$("rs-switch").addEventListener("click", () => {
  openSettings();
  setMsg("");
  refreshHealth(false);
});

/* ---------- 创作侧栏折叠/展开 ---------- */
const RAIL_COLLAPSED_KEY = "is_rail_collapsed";
function setRailCollapsed(collapsed) {
  document.body.classList.toggle("rail-collapsed", !!collapsed);
  lsSet(RAIL_COLLAPSED_KEY, !!collapsed);
  if (gsapOK && !collapsed) {
    gsap.from(".rail", { x: -30, opacity: 0.7, duration: 0.3, ease: "power2.out", clearProps: "all" });
  }
}
$("rail-collapse-btn")?.addEventListener("click", () => {
  if (!matchMedia("(max-width: 980px)").matches) setRailCollapsed(true);
});
$("rail-expand-btn")?.addEventListener("click", () => setRailCollapsed(false));
if (lsGet(RAIL_COLLAPSED_KEY, false)) {
  setRailCollapsed(true);
}

function initShortcutsModal() {
  $("open-shortcuts")?.addEventListener("click", openShortcutsModal);
  $("shortcuts-btn")?.addEventListener("click", openShortcutsModal);
  $("shortcuts-close")?.addEventListener("click", closeShortcutsModal);
  $("shortcuts-modal")?.addEventListener("click", (e) => {
    if (e.target === $("shortcuts-modal")) closeShortcutsModal();
  });
}

/* ---------- 启动 ---------- */
restoreGenSettings();
renderQuantityGroup();
setPrompt(loadDraft());
enterRail();
loadCapabilities();
loadSettings();
loadModels();
renderPromptHistory();
setViewMode(lsGet(VIEW_MODE_KEY, "masonry"));
initSoundEngine();
initPresetMatrix();
initNegativePromptAndProParams();
initCompareTool();
initMinimapRadar();
initShortcutsModal();
loadHistory(1, false);
try {
  const storedTask = JSON.parse(sessionStorage.getItem(PENDING_TASK_KEY));
  if (storedTask && /^[a-zA-Z0-9_-]{1,64}$/.test(storedTask.id) && Number.isFinite(storedTask.started) && Number.isFinite(storedTask.target)) {
    pendingTask = storedTask;
    resumePendingTask();
  }
} catch { /* Invalid or unavailable tab storage has no effect on new work. */ }
