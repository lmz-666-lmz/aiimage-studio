/* Named recipes contain composer settings only. Image files stay with the current draft. */
(() => {
  "use strict";
  const storageKey = "shiguang.recipes.v1";
  const undoKey = "shiguang.recipe-draft.v1";
  const openButton = $("open-recipes");
  const saveButton = $("save-recipe");
  if (!openButton || !saveButton) return;

  const dialog = document.createElement("dialog");
  dialog.id = "recipe-dialog";
  dialog.className = "recipe-dialog";
  dialog.setAttribute("aria-labelledby", "recipe-heading");
  dialog.innerHTML = `
    <header class="recipe-header">
      <div><h2 id="recipe-heading">我的配方</h2><p id="recipe-intro"></p></div>
      <button type="button" class="recipe-close" aria-label="关闭配方库">×</button>
    </header>
    <section id="recipe-browser">
      <div id="recipe-search-row" hidden>
        <label for="recipe-search">查找配方</label>
        <input id="recipe-search" type="search" placeholder="名称、提示词或模型" autocomplete="off">
      </div>
      <div id="recipe-list" class="recipe-list"></div>
      <div class="recipe-footer">
        <button id="recipe-new" class="recipe-button" type="button">保存当前配方</button>
        <button id="recipe-undo" class="recipe-link" type="button" hidden>恢复应用前的草稿</button>
      </div>
    </section>
    <form id="recipe-form" hidden>
      <label for="recipe-name">配方名称</label>
      <input id="recipe-name" name="name" maxlength="60" required autocomplete="off" placeholder="例如：棚拍 · 白瓷器皿">
      <div class="recipe-preview"><p id="recipe-preview-prompt"></p><span id="recipe-preview-facts"></span></div>
      <p id="recipe-ref-note" class="recipe-hint" hidden></p>
      <div class="recipe-footer">
        <button type="submit" class="recipe-button">保存配方</button>
        <button id="recipe-back" type="button" class="recipe-link">返回配方库</button>
      </div>
    </form>
    <p id="recipe-message" class="recipe-message" role="status"></p>`;
  document.body.append(dialog);
  const list = $("recipe-list");
  const form = $("recipe-form");
  const message = $("recipe-message");
  let opener = null;
  let snapshot = null;
  let previousDraft = null;
  let deletion = null;
  let library = [];

  function readLibrary() {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.some((entry) =>
      !entry || typeof entry.id !== "string" || typeof entry.name !== "string" ||
      !entry.draft || typeof entry.draft.prompt !== "string")) {
      throw new Error("无法读取本机配方数据，已保留原记录。");
    }
    return entries;
  }

  async function changeLibrary(change) {
    const write = () => {
      const entries = readLibrary();
      const next = change(entries);
      localStorage.setItem(storageKey, JSON.stringify(next));
    };
    // Localhost supports Web Locks, so two open workspaces can save without losing entries.
    if (navigator.locks) await navigator.locks.request(storageKey, write);
    else write();
  }

  function reportError(error) {
    if (error instanceof SyntaxError) message.textContent = "无法读取本机配方数据，已保留原记录。";
    else if (error instanceof DOMException) message.textContent = "浏览器无法存储配方，请检查本地存储权限与可用空间。";
    else message.textContent = error.message;
  }

  function captureDraft() {
    return {
      prompt: $("prompt").value, model: modelInput.value.trim(),
      size, customSize: sizeCustom.value.trim().toLowerCase(), n: currentN(),
      quality: $("quality").value, background: $("background").value, style: $("style").value,
      negative: $("negative-prompt").value, seed: $("seed-input").value,
      cfg: $("cfg-slider").value, sendCfg: $("send-cfg-scale").checked,
      sendExtensions: $("send-extension-params").checked,
    };
  }

  function restoreDraft(draft, keepCurrentModel) {
    if (draft.model || !keepCurrentModel) modelInput.value = draft.model || "";
    const cap = capabilityFor(modelInput.value);
    if (SIZE_RE.test(draft.size)) size = draft.size;
    sizeCustom.value = draft.customSize || "";
    sizeCustom.classList.toggle("invalid", Boolean(sizeCustom.value && !SIZE_RE.test(sizeCustom.value)));
    $("n").value = String(keepCurrentModel && !cap.n ? 1 : (draft.n || 1));
    $("n").value = String(currentN());
    updateCapabilityUI();
    for (const key of ["quality", "background", "style"]) {
      const select = $(key);
      const value = draft[key] || "";
      select.value = [...select.options].some((o) => o.value === value) ? value : "";
    }
    $("negative-prompt").value = draft.negative || "";
    $("seed-input").value = draft.seed ?? "";
    $("cfg-slider").value = draft.cfg ?? $("cfg-slider").defaultValue;
    $("cfg-val").textContent = Number($("cfg-slider").value).toFixed(1);
    $("send-cfg-scale").checked = Boolean(draft.sendCfg);
    $("send-extension-params").checked = Boolean(draft.sendExtensions);
    markQuantity(currentN());
    setPrompt(draft.prompt);
    renderAdvSummary(cap);
    renderRequestPreview(cap);
    saveGenSettings();
  }

  function facts(draft) {
    const values = [draft.model || "沿用当前模型"];
    const cap = capabilityFor(draft.model || modelInput.value);
    if (cap.size_mode !== "none") values.push((draft.customSize || draft.size || "").replace("x", "×"));
    values.push(`${cap.n ? draft.n : 1} 张`);
    return values.filter(Boolean).join(" · ");
  }

  function open(openerButton) {
    if (dialog.open) return;
    opener = openerButton;
    dialog.showModal();
  }

  function renderMatches() {
    list.replaceChildren();
    deletion = null;
    const query = $("recipe-search").value.trim().toLowerCase();
    const matches = !query ? library : library.filter(({ name, draft }) =>
      [name, draft.prompt, draft.model].some((value) => value?.toLowerCase().includes(query)));
    for (const entry of matches) list.append(createCard(entry));
    if (matches.length) return;
    const empty = document.createElement("div");
    empty.className = "recipe-empty";
    if (!library.length) {
      empty.innerHTML = '<strong>还没有保存配方</strong><p>写好提示词、调好参数，就可以给它们起个名字。</p>';
    } else {
      empty.textContent = "没有找到匹配的配方。";
    }
    list.append(empty);
  }

  function renderLibrary(resetSearch = true) {
    snapshot = null;
    deletion = null;
    message.textContent = "";
    $("recipe-heading").textContent = "我的配方";
    $("recipe-intro").textContent = "保存在此浏览器，可反复载入创作面板。";
    form.hidden = true;
    $("recipe-browser").hidden = false;
    if (resetSearch) $("recipe-search").value = "";
    try {
      library = readLibrary();
      $("recipe-search-row").hidden = library.length < 2;
      if (library.length < 2) $("recipe-search").value = "";
      renderMatches();
    } catch (error) {
      library = [];
      list.replaceChildren();
      $("recipe-search-row").hidden = true;
      reportError(error);
    }
    if (!previousDraft) {
      try { previousDraft = JSON.parse(sessionStorage.getItem(undoKey)); } catch { /* Optional tab-local backup. */ }
    }
    $("recipe-undo").hidden = !previousDraft;
  }

  function startSave() {
    renderLibrary();
    if (editSource) { message.textContent = "正在改图。退出改图后可保存文生图配方。"; return; }
    const draft = captureDraft();
    if (!draft.prompt.trim()) { message.textContent = "先在创作面板写下提示词，再保存配方。"; return; }
    if (draft.customSize && !SIZE_RE.test(draft.customSize)) { message.textContent = "请先修正自定义画幅，例如 768x1344。"; return; }
    if (draft.sendExtensions && !$("seed-input").validity.valid) { message.textContent = "请先修正随机种子。"; return; }
    snapshot = { draft, references: referenceFiles.length };
    $("recipe-heading").textContent = "保存创作配方";
    $("recipe-intro").textContent = "保存当前提示词、模型和画面参数。";
    $("recipe-browser").hidden = true;
    form.hidden = false;
    $("recipe-name").value = Array.from(draft.prompt.trim().split(/[。！？\n]/)[0]).slice(0, 20).join("");
    $("recipe-preview-prompt").textContent = draft.prompt;
    $("recipe-preview-facts").textContent = facts(draft);
    $("recipe-ref-note").hidden = !snapshot.references;
    $("recipe-ref-note").textContent = `此配方使用了 ${snapshot.references} 张参考图。再次使用时可自行添加参考图。`;
    $("recipe-name").focus();
    $("recipe-name").select();
  }

  function canRestore(draft, keepCurrentModel) {
    if (busy) { message.textContent = "生成结束后即可更换配方。"; return false; }
    if (editSource) { message.textContent = "正在改图。退出改图后可载入配方，当前修改说明已保留。"; return false; }
    const model = draft.model || (keepCurrentModel ? modelInput.value : "");
    if (referenceFiles.length && !capabilityFor(model).image_to_image) {
      message.textContent = "当前草稿含参考图，此模型只支持文生图。移除参考图后可载入。";
      return false;
    }
    return true;
  }

  function focusComposer() {
    dialog.close();
    window.openStudioComposer?.();
    $("prompt").focus();
  }

  function apply(entry) {
    if (!canRestore(entry.draft, true)) return;
    previousDraft = captureDraft();
    try { sessionStorage.setItem(undoKey, JSON.stringify(previousDraft)); } catch { /* Keep in memory if storage is unavailable. */ }
    restoreDraft(entry.draft, true);
    focusComposer();
    showToast(`已载入「${entry.name}」${entry.references && !referenceFiles.length ? "，可重新添加参考图" : ""}。可在配方库恢复原草稿。`, "success");
  }

  function createCard(entry) {
    const card = document.createElement("article");
    card.className = "recipe-card";
    card.innerHTML = `<div class="recipe-card-body"><h3></h3><p></p><small></small></div>
      <div class="recipe-card-actions"><button type="button" class="recipe-button">载入配方</button>
      <button type="button" class="recipe-link">删除</button></div>`;
    card.querySelector("h3").textContent = entry.name;
    card.querySelector("p").textContent = entry.draft.prompt;
    card.querySelector("small").textContent = facts(entry.draft) + (entry.references ? ` · 参考图 ×${entry.references}` : "");
    card.querySelector(".recipe-button").addEventListener("click", () => apply(entry));
    const remove = card.querySelector(".recipe-link");
    remove.setAttribute("aria-label", `删除配方「${entry.name}」`);
    remove.addEventListener("click", async () => {
      if (deletion !== remove) {
        if (deletion) deletion.textContent = "删除";
        deletion = remove;
        remove.textContent = "确认删除";
        message.textContent = `再点一次确认删除「${entry.name}」。`;
        return;
      }
      try {
        await changeLibrary((entries) => entries.filter((item) => item.id !== entry.id));
        renderLibrary(false);
        message.textContent = "已删除配方。";
        (list.querySelector("button") || $("recipe-new")).focus();
      } catch (error) { reportError(error); }
    });
    return card;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("recipe-name").value.trim();
    if (!name || !snapshot) { message.textContent = "请填写配方名称。"; return; }
    const entry = { ...snapshot, name, id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2) };
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      await changeLibrary((entries) => {
        if (entries.some((item) => item.name === name)) throw new Error("已有同名配方，换个名字即可保存。");
        return [entry, ...entries];
      });
      renderLibrary();
      message.textContent = `已保存「${name}」。`;
      list.querySelector("button")?.focus();
    } catch (error) { reportError(error); }
    finally { submit.disabled = false; }
  });

  $("recipe-undo").addEventListener("click", () => {
    if (!previousDraft || !canRestore(previousDraft, false)) return;
    restoreDraft(previousDraft, false);
    previousDraft = null;
    try { sessionStorage.removeItem(undoKey); } catch { /* In-memory state is already cleared. */ }
    focusComposer();
    showToast("已恢复应用配方前的草稿", "success");
  });
  openButton.addEventListener("click", () => { open(openButton); renderLibrary(); });
  saveButton.addEventListener("click", () => { open(saveButton); startSave(); });
  $("recipe-new").addEventListener("click", startSave);
  $("recipe-search").addEventListener("input", () => { message.textContent = ""; renderMatches(); });
  $("recipe-back").addEventListener("click", () => { renderLibrary(); $("recipe-new").focus(); });
  dialog.querySelector(".recipe-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      dialog.close();
    }
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  dialog.addEventListener("close", () => {
    if (document.activeElement === document.body) opener?.focus();
    snapshot = null;
  });
  window.addEventListener("storage", (event) => {
    if ((event.key === storageKey || event.key === null) && dialog.open && form.hidden) renderLibrary(false);
  });
})();
