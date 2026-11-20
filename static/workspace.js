/* 工作台与作品库共享同一份画廊、筛选状态和创作草稿。 */
(() => {
  const mobile = matchMedia("(max-width: 980px)");
  const rail = $("studio-rail");
  const wall = $("studio-wall");
  const backdrop = $("composer-backdrop");
  let drawerOpen = false;
  let drawerTrigger = null;
  let scene = 0;
  const scenes = [
    {
      image: "desert", title: "旷野之环", english: "Desert Resonance",
      description: "地景摄影 · 铜色余晖 · 远景构图",
      alt: "夕阳下，巨大铜环矗立在沙漠与远山之间",
      prompt: "宽银幕地景摄影。暮色中的赤褐色沙谷，一枚巨大的细铜环立在画面右侧。远山层层沉入紫灰色薄雾，两位行人小得几乎看不见。低角度的落日勾亮金属边缘，保留沙丘纹理、胶片颗粒和左侧深色留白。"
    },
    {
      image: "coast", title: "潮汐来信", english: "Letters from the Tide",
      description: "海岸摄影 · 蓝调时刻 · 长曝光",
      alt: "蓝调时刻，沿岸灯塔从岩石海岬照向远海",
      prompt: "蓝调时刻的海岸，靛蓝海浪在长曝光下化成雾一般的细纹。右侧岩石海岬上有一座白色灯塔，狭窄的暖光穿过潮湿空气。低云压住海平线，保留青灰色调、层叠的暗礁和细微胶片颗粒。"
    },
    {
      image: "botanical", title: "花的切面", english: "Anatomy of a Poppy",
      description: "植物静物 · 侧窗光 · 微距特写",
      alt: "墨绿色背景上，一朵橘红色虞美人在侧光中展开",
      prompt: "美术馆画册里的植物静物摄影。墨绿背景前，一朵橘红色虞美人在画面右侧舒展，伴随纤细弯曲的花茎和未开放的花苞。侧面窗光穿过薄如丝绸的花瓣，照亮叶脉与露珠，左侧留出深色空间。"
    }
  ];

  function renderScene(direction) {
    scene = (scene + direction + scenes.length) % scenes.length;
    const current = scenes[scene];
    $("scene-image").src = "/static/assets/scenes/" + current.image + ".webp";
    $("scene-image").alt = current.alt;
    $("scene-title").textContent = current.title;
    $("scene-english").textContent = current.english;
    $("scene-description").textContent = current.description;
    $("scene-index").textContent = String(scene + 1).padStart(2, "0") + " / 03";
  }
  $("scene-prev").addEventListener("click", () => renderScene(-1));
  $("scene-next").addEventListener("click", () => renderScene(1));

  function syncDrawer() {
    const modal = mobile.matches && drawerOpen;
    const collapsed = document.body.classList.contains("rail-collapsed");
    document.body.classList.toggle("composer-open", modal);
    rail.inert = mobile.matches ? !modal : collapsed;
    wall.inert = modal;
    document.querySelector(".studio-header").inert = modal;
    backdrop.hidden = !modal;
    if (modal) {
      rail.setAttribute("role", "dialog");
      rail.setAttribute("aria-modal", "true");
    } else {
      rail.removeAttribute("role");
      rail.removeAttribute("aria-modal");
    }
    $("composer-open").setAttribute("aria-expanded", String(mobile.matches ? modal : !collapsed));
  }
  function openComposer(focus = true) {
    if (mobile.matches) {
      if (!drawerOpen) drawerTrigger = document.activeElement;
      drawerOpen = true;
    } else if (document.body.classList.contains("rail-collapsed")) {
      setRailCollapsed(false);
    }
    syncDrawer();
    if (focus) $(editSource ? "edit-change" : "prompt").focus();
  }
  function closeComposer() {
    if (!drawerOpen) return;
    drawerOpen = false;
    syncDrawer();
    (drawerTrigger?.isConnected && !drawerTrigger.closest(".lightbox") ? drawerTrigger : $("composer-open")).focus({ preventScroll: true });
    drawerTrigger = null;
  }
  window.openStudioComposer = openComposer;
  window.closeStudioComposer = closeComposer;
  window.studioGenerationStarted = () => {
    closeComposer();
    $("library-heading").scrollIntoView({ block: "start" });
  };
  $("composer-open").addEventListener("click", () => openComposer());
  $("rail-collapse-btn").addEventListener("click", () => {
    if (mobile.matches) closeComposer();
    else { syncDrawer(); $("composer-open").focus({ preventScroll: true }); }
  });
  $("rail-expand-btn").addEventListener("click", () => openComposer());
  backdrop.addEventListener("click", closeComposer);
  mobile.addEventListener("change", () => { drawerOpen = false; syncDrawer(); });
  syncDrawer();

  // Direct manipulation uses the same saved values as the layout settings dialog.
  document.addEventListener("DOMContentLoaded", () => {
    const editor = $("layout-dialog");
    if (!editor || !window.applyStudioLayout) return;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "layout-direct-button";
    toggle.textContent = "在工作台上调整";
    editor.querySelector("footer").prepend(toggle);
    const toolbar = document.createElement("div");
    toolbar.className = "geometry-toolbar";
    toolbar.hidden = true;
    toolbar.innerHTML = '<span>拖动分区标题换序，拖动底边调整高度</span><button type="button">完成调整</button>';
    document.body.append(toolbar);
    let active = false;
    let dragged = null;
    function editing(on) {
      active = on;
      document.body.classList.toggle("geometry-editing", on);
      toolbar.hidden = !on;
      if (on) {
        if (document.body.classList.contains("rail-collapsed")) openComposer(false);
        editor.close();
        toolbar.querySelector("button").focus();
      } else {
        dragged = null;
        $("open-layout").focus();
      }
    }
    toggle.addEventListener("click", () => editing(true));
    toolbar.querySelector("button").addEventListener("click", () => editing(false));
    document.addEventListener("keydown", event => {
      if (active && event.key === "Escape") { event.preventDefault(); editing(false); }
    }, true);
    mobile.addEventListener("change", () => { if (active && mobile.matches) editing(false); });

    const names = { connection: "模型与线路", prompt: "画面描述", edit: "改图要求", parameters: "画面参数" };
    const blocks = [...rail.querySelectorAll("[data-layout-block]")];
    for (const node of [...blocks, $("scene-cover")]) {
      const key = node.dataset.layoutBlock;
      if (key) {
        const handle = document.createElement("div");
        handle.className = "geometry-move";
        handle.draggable = true;
        handle.textContent = "⠿  " + names[key];
        handle.title = "拖到另一个分区上可交换位置";
        node.prepend(handle);
        handle.addEventListener("dragstart", event => {
          dragged = key;
          event.dataTransfer.setData("text/plain", key);
          event.dataTransfer.effectAllowed = "move";
        });
        handle.addEventListener("dragend", () => { dragged = null; });
        node.addEventListener("dragover", event => {
          if (active && dragged && dragged !== key) event.preventDefault();
        });
        node.addEventListener("drop", event => {
          if (!active || !dragged || dragged === key) return;
          event.preventDefault();
          const { order } = window.getStudioLayout();
          const from = order.indexOf(dragged), to = order.indexOf(key);
          [order[from], order[to]] = [order[to], order[from]];
          window.applyStudioLayout({ order });
          dragged = null;
        });
      }
      const edge = document.createElement("div");
      edge.className = "geometry-edge";
      edge.title = "拖动调整高度";
      edge.setAttribute("aria-hidden", "true");
      node.append(edge);
      let start = null;
      function stopSizing() {
        if (!start) return;
        start = null;
        document.body.classList.remove("geometry-sizing");
      }
      edge.addEventListener("pointerdown", event => {
        if (!active || event.button !== 0) return;
        event.preventDefault();
        start = { id: event.pointerId, y: event.clientY, h: node.offsetHeight };
        edge.setPointerCapture(event.pointerId);
        document.body.classList.add("geometry-sizing");
      });
      edge.addEventListener("pointermove", event => {
        if (start?.id !== event.pointerId) return;
        const height = Math.round(start.h + event.clientY - start.y);
        if (key) window.applyStudioLayout({ heights: { ...window.getStudioLayout().heights, [key]: height } });
        else window.applyStudioLayout({ cover: height });
      });
      edge.addEventListener("lostpointercapture", stopSizing);
      edge.addEventListener("pointerup", stopSizing);
      edge.addEventListener("pointercancel", stopSizing);
    }
  });

  function switchView(library) {
    $("scene-cover").hidden = library;
    for (const [id, active] of [["nav-library", library], ["nav-studio", !library]]) {
      $(id).classList.toggle("active", active);
      if (active) $(id).setAttribute("aria-current", "page");
      else $(id).removeAttribute("aria-current");
    }
    wall.scrollTo({ top: 0 });
  }
  $("nav-studio").addEventListener("click", () => switchView(false));
  $("nav-library").addEventListener("click", () => switchView(true));
  $("setup-provider").addEventListener("click", () => {
    openSettings();
    openProviderForm("");
    $("pf-name").focus();
  });

  const choice = document.createElement("dialog");
  choice.className = "scene-dialog";
  choice.setAttribute("aria-labelledby", "scene-choice-title");
  choice.innerHTML = '<form method="dialog"><h2 id="scene-choice-title">使用这组灵感</h2><p>当前已有画面描述，可以保留原文并追加，也可以替换。</p><div><button value="cancel" autofocus>取消</button><button value="append">追加到末尾</button><button value="replace">替换原文</button></div></form>';
  document.body.append(choice);
  function applyScene(append) {
    const existing = $("prompt").value.trimEnd();
    setPrompt(append && existing ? existing + "\n\n" + scenes[scene].prompt : scenes[scene].prompt);
    openComposer();
    showToast("已载入「" + scenes[scene].title + "」", "success");
  }
  $("scene-use").addEventListener("click", () => {
    if (editSource || busy) { showToast(editSource ? "请先退出改图，再使用灵感提示词" : "当前生成结束后可载入灵感"); return; }
    if ($("prompt").value.trim() && $("prompt").value !== scenes[scene].prompt) {
      choice.returnValue = "";
      choice.showModal();
    } else applyScene(false);
  });
  choice.addEventListener("close", () => {
    if (choice.returnValue === "append" || choice.returnValue === "replace") applyScene(choice.returnValue === "append");
  });
  document.querySelectorAll(".es-pill[data-scene]").forEach(button => {
    button.addEventListener("click", () => {
      renderScene(Number(button.dataset.scene) - scene);
      $("scene-use").click();
    });
  });

  function resetFilters() {
    clearTimeout(searchDebounce);
    $("f-q").value = "";
    $("search-clear-btn").hidden = true;
    $("f-model").value = "";
    $("f-provider").value = "";
    $("f-range").value = "all";
    $("f-sort").value = "newest";
    onlyFav = onlyFinal = false;
    $("f-fav").innerHTML = '<span class="ft-star">★</span> 收藏';
    $("f-fav").classList.remove("on");
    for (const id of ["f-fav", "f-final"]) $(id).setAttribute("aria-pressed", "false");
    $("filter-options").open = false;
    $("filter-indicator").hidden = true;
    loadHistory(1);
  }
  $("filter-reset").addEventListener("click", resetFilters);
  $("empty-reset").addEventListener("click", resetFilters);
  $("history-retry").addEventListener("click", () => loadHistory(page, false));
  $("filter-options").addEventListener("change", () => {
    $("filter-indicator").hidden = !($("f-model").value || $("f-provider").value || $("f-range").value !== "all" || $("f-sort").value !== "newest");
  });
  document.addEventListener("pointerdown", (event) => {
    if (!$("filter-options").contains(event.target)) $("filter-options").open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (document.querySelector("dialog[open], .lightbox:not([hidden])")) return;
    if (event.key === "Escape" && $("filter-options").open) {
      $("filter-options").open = false;
      $("filter-options").querySelector("summary").focus();
      event.preventDefault();
    } else if (drawerOpen && event.key === "Escape") {
      closeComposer();
      event.preventDefault();
    } else if (drawerOpen && event.key === "Tab") {
      const stops = [...rail.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea, summary, select")].filter(el => el.tabIndex >= 0 && el.getClientRects().length);
      if (event.shiftKey && document.activeElement === stops[0]) { event.preventDefault(); stops.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === stops.at(-1)) { event.preventDefault(); stops[0]?.focus(); }
    }
  }, true);
})();
