/* Personal workspace geometry is local to this browser. */
(() => {
  const rail = document.getElementById("studio-rail");
  const wall = document.getElementById("studio-wall");
  const scene = document.getElementById("scene-cover");
  const library = document.getElementById("library-panel");
  const trigger = document.getElementById("open-layout");
  if (!rail || !wall || !scene || !library || !trigger) return;

  const key = "shiguang.workspace-layout.v1";
  const root = document.documentElement;
  const desktop = matchMedia("(min-width: 981px)");
  const blocks = new Map([...rail.querySelectorAll(":scope > [data-layout-block]")]
    .map(node => [node.dataset.layoutBlock, node]));
  const labels = { connection: "模型与线路", prompt: "提示词", edit: "改图要求", parameters: "画面参数" };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)));
  const number = (value, min, max) => Number.isFinite(value) ? clamp(value, min, max) : null;
  const defaults = () => ({ side: "left", width: null, main: "scene", share: 44,
    order: [...blocks.keys()], heights: {}, cover: null });
  const anchor = document.createComment("layout-blocks");
  blocks.values().next().value?.before(anchor);
  function normalized(saved) {
    const state = defaults();
    if (saved && typeof saved === "object") {
      state.side = saved.side === "right" ? "right" : "left";
      state.width = number(saved.width, 280, 480);
      state.cover = number(saved.cover, 220, 760);
      state.main = ["library", "split"].includes(saved.main) ? saved.main : "scene";
      state.share = number(saved.share, 32, 58) ?? 44;
      if (Array.isArray(saved.order)) state.order = [...new Set([...saved.order, ...state.order])].filter(id => blocks.has(id));
      for (const id of state.order) state.heights[id] = number(saved.heights?.[id], 112, 900);
    }
    return state;
  }
  let state = defaults();
  try { state = normalized(JSON.parse(localStorage.getItem(key))); }
  catch { /* A disabled or cleared browser store starts from the defaults. */ }

  const divider = document.createElement("div");
  divider.id = "layout-divider";
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "vertical");
  divider.setAttribute("aria-label", "创作面板宽度，使用方向键调整");
  divider.setAttribute("aria-controls", rail.id);
  divider.setAttribute("aria-valuemin", "280");
  divider.setAttribute("aria-valuemax", "480");
  divider.title = "拖动调整宽度，双击恢复自动宽度";
  divider.tabIndex = 0;
  rail.after(divider);
  const panel = document.createElement("dialog");
  panel.id = "layout-dialog";
  panel.setAttribute("aria-labelledby", "layout-title");
  panel.innerHTML = `
    <form method="dialog" class="layout-sheet">
      <header><h2 id="layout-title">工作区布局</h2><button class="layout-close" aria-label="关闭布局设置">×</button></header>
      <div class="layout-fields">
        <div id="layout-presets"></div>
        <fieldset><legend>创作面板</legend>
          <label class="layout-pair">桌面位置<select id="layout-side"><option value="left">左侧</option><option value="right">右侧</option></select></label>
          <label class="layout-pair">桌面宽度<span class="layout-slider"><input id="layout-width" type="range" min="280" max="480" step="1"><output id="layout-width-value"></output></span></label>
          <div class="layout-list" id="layout-block-list"></div>
        </fieldset>
        <fieldset><legend>作品工作区</legend>
          <label class="layout-pair">排列方式<select id="layout-main"><option value="scene">灵感封面在上</option><option value="library">作品库在上</option><option value="split">宽屏左右并排</option></select></label>
          <label class="layout-pair" id="layout-share-row">封面占宽<span class="layout-slider"><input id="layout-share" type="range" min="32" max="58"><output id="layout-share-value"></output></span></label>
          <label class="layout-pair">封面高度<span class="layout-number"><input id="layout-cover" type="number" min="220" max="760" step="1" placeholder="自动"><span>px</span></span></label>
        </fieldset>
      </div>
      <footer><button id="layout-reset" type="button">恢复默认布局</button><button class="layout-done">完成</button></footer>
    </form>`;
  document.body.appendChild(panel);
  const control = id => panel.querySelector("#layout-" + id);
  const width = control("width");
  function save() { try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* private browser */ } }
  function syncWidth() {
    if (state.width === null) root.style.removeProperty("--rail-width");
    else root.style.setProperty("--rail-width", state.width + "px");
    const px = state.width ?? (desktop.matches && rail.offsetWidth ? rail.offsetWidth : 336);
    divider.setAttribute("aria-valuenow", String(px));
    width.value = px;
    control("width-value").value = px + " px";
  }
  function apply() {
    document.body.dataset.railSide = state.side;
    wall.dataset.mainLayout = state.main;
    wall.style.setProperty("--scene-share", state.share + "%");
    let previous = anchor;
    for (const id of state.order) {
      const node = blocks.get(id);
      if (previous.nextElementSibling !== node) previous.after(node);
      previous = node;
      node.classList.toggle("layout-fixed-block", !!state.heights[id]);
      node.style.setProperty("--block-height", (state.heights[id] || 200) + "px");
    }
    scene.style.height = state.cover ? state.cover + "px" : "";
    if (state.main === "library") {
      if (library.nextElementSibling !== scene) library.after(scene);
    } else if (scene.nextElementSibling !== library) scene.after(library);
    syncWidth();
  }
  function setWidth(value) { state.width = value === null ? null : clamp(value, 280, 480); syncWidth(); }
  const updateSize = () => {
    wall.classList.toggle("layout-wide", desktop.matches && wall.clientWidth >= 840);
    syncWidth();
  };
  new ResizeObserver(updateSize).observe(wall);
  let dragging = null;
  divider.addEventListener("pointerdown", event => {
    if (event.button !== 0 || dragging) return;
    dragging = { id: event.pointerId, x: event.clientX, width: rail.offsetWidth };
    divider.setPointerCapture(event.pointerId);
    document.body.classList.add("layout-dragging");
    event.preventDefault();
  });
  divider.addEventListener("pointermove", event => {
    if (dragging?.id === event.pointerId) {
      const delta = event.clientX - dragging.x;
      setWidth(dragging.width + (state.side === "right" ? -delta : delta));
    }
  });
  function endDrag() {
    if (!dragging) return;
    dragging = null;
    document.body.classList.remove("layout-dragging");
    save();
  }
  divider.addEventListener("lostpointercapture", endDrag);
  divider.addEventListener("pointerup", endDrag);
  divider.addEventListener("pointercancel", endDrag);
  divider.addEventListener("dblclick", () => { setWidth(null); save(); });
  divider.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const direction = (event.key === "ArrowRight") === (state.side === "left") ? 1 : -1;
    const next = rail.offsetWidth + direction * (event.shiftKey ? 40 : 8);
    setWidth(event.key === "Home" ? 280 : event.key === "End" ? 480 : next);
    save();
  });

  function renderEditor() {
    control("side").value = state.side;
    control("main").value = state.main;
    control("share").value = state.share;
    control("share-value").value = state.share + "%";
    control("share-row").hidden = state.main !== "split";
    control("cover").value = state.cover ?? "";
    syncWidth();
    const list = control("block-list");
    list.replaceChildren();
    const visible = state.order.filter(id => !blocks.get(id).hidden);
    for (const [index, id] of visible.entries()) {
      const row = document.createElement("div");
      row.className = "layout-block-row";
      const label = labels[id] || id;
      row.innerHTML = '<span class="layout-block-name"></span><div class="layout-move"><button type="button">↑</button><button type="button">↓</button></div><label class="layout-number"><input type="number" min="112" max="900" placeholder="自动"><span>px</span></label>';
      row.firstElementChild.textContent = label;
      const height = row.querySelector("input");
      height.value = state.heights[id] ?? "";
      height.setAttribute("aria-label", label + "高度，留空自动");
      height.addEventListener("change", () => {
        state.heights[id] = number(height.valueAsNumber, 112, 900);
        height.value = state.heights[id] ?? "";
        apply(); save();
      });
      row.querySelectorAll("button").forEach((button, buttonIndex) => {
        const offset = buttonIndex ? 1 : -1;
        button.setAttribute("aria-label", (buttonIndex ? "下移" : "上移") + label);
        const target = visible[index + offset];
        button.disabled = !target;
        button.addEventListener("click", () => {
          const a = state.order.indexOf(id), b = state.order.indexOf(target);
          [state.order[a], state.order[b]] = [state.order[b], state.order[a]];
          apply(); save(); renderEditor();
          const moved = list.children[index + offset];
          (moved.querySelector("button:not(:disabled)") || moved.querySelector("input")).focus();
        });
      });
      list.appendChild(row);
    }
  }
  control("side").addEventListener("change", event => { state.side = event.target.value; apply(); save(); });
  width.addEventListener("input", () => { setWidth(Number(width.value)); save(); });
  control("main").addEventListener("change", event => { state.main = event.target.value; apply(); save(); renderEditor(); });
  control("share").addEventListener("input", event => {
    state.share = Number(event.target.value);
    wall.style.setProperty("--scene-share", state.share + "%");
    control("share-value").value = state.share + "%";
    save();
  });
  control("cover").addEventListener("change", event => {
    state.cover = number(event.target.valueAsNumber, 220, 760);
    event.target.value = state.cover ?? "";
    apply(); save();
  });
  control("reset").addEventListener("click", () => { state = defaults(); apply(); save(); renderEditor(); });
  window.getStudioLayout = () => normalized(state);
  window.applyStudioLayout = patch => {
    state = normalized({ ...state, ...patch, heights: { ...state.heights, ...patch?.heights } });
    apply(); save();
    if (panel.open) renderEditor();
  };
  trigger.addEventListener("click", () => { renderEditor(); panel.showModal(); });
  panel.addEventListener("click", event => { if (event.target === panel) panel.close(); });
  panel.addEventListener("close", () => {
    if (!document.body.classList.contains("geometry-editing")) trigger.focus({ preventScroll: true });
  });
  apply();
})();
