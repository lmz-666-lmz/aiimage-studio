(() => {
  const group = document.querySelector("#studio-themes.themes, #studio-themes .themes, .themes");
  if (!group) return;
  const themes = [
    { id: "celadon", name: "青瓷", detail: "浅青釉色 · 松绿", bg: "#eaf1ed", accent: "#126149" },
    { id: "berry", name: "莓夜", detail: "深紫底色 · 莓红", bg: "#211326", accent: "#ff97c5" },
    { id: "marine", name: "海盐", detail: "深海蓝绿 · 薄荷", bg: "#071e26", accent: "#74e6c3" },
  ];
  for (const theme of themes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "size theme-btn";
    button.dataset.theme = theme.id;
    button.title = theme.name + " · " + theme.detail;
    button.innerHTML = '<span class="theme-swatch" aria-hidden="true"><i class="sw-bg"></i><i class="sw-ac"></i></span><span class="theme-name"></span><span class="theme-desc"></span>';
    button.querySelector(".sw-bg").style.background = theme.bg;
    button.querySelector(".sw-ac").style.background = theme.accent;
    button.querySelector(".theme-name").textContent = theme.name;
    button.querySelector(".theme-desc").textContent = theme.detail;
    button.addEventListener("click", () => window.setStudioTheme(theme.id));
    group.append(button);
  }

  const buttons = [...group.querySelectorAll("button[data-theme]")];
  function syncSelection() {
    const theme = document.documentElement.dataset.theme;
    for (const button of buttons) {
      const checked = button.dataset.theme === theme;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
  }
  syncSelection();
  new MutationObserver(syncSelection).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  group.addEventListener("keydown", (event) => {
    const index = buttons.indexOf(event.target);
    if (index === -1) return;
    const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!delta && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + delta + buttons.length) % buttons.length;
    buttons[next].focus();
    buttons[next].click();
  });
})();
