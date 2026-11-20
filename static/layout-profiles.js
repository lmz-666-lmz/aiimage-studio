(() => {
  const host = document.querySelector("#layout-presets");
  if (!host) return;
  const key = "shiguang.layout-profiles.v1";
  const presets = [
    { id: "classic", name: "经典创作", side: "left", width: null, main: "scene", cover: null },
    { id: "retouch", name: "右侧修图", side: "right", width: 390, main: "library", cover: 260 },
    { id: "contact", name: "双栏选片", side: "left", width: 300, main: "split", share: 38, cover: null },
  ];
  host.innerHTML = `<fieldset class="layout-profiles"><legend>布局预设</legend>
    <div class="layout-presets-grid"></div>
    <div class="layout-profile-row"><input id="profile-name" maxlength="40" aria-label="新布局名称" placeholder="给当前布局起个名字"><button type="button" id="profile-save">保存当前布局</button></div>
    <div class="layout-profile-row" id="profile-library" hidden><select id="profile-list" aria-label="已保存的布局"></select>
    <button type="button" id="profile-apply">应用</button><button type="button" id="profile-delete">删除</button></div>
    <p class="profile-feedback" role="status"></p></fieldset>`;
  const grid = host.querySelector(".layout-presets-grid");
  const msg = host.querySelector(".profile-feedback");
  const nameInput = host.querySelector("#profile-name");
  const list = host.querySelector("#profile-list");
  const del = host.querySelector("#profile-delete");
  let pendingDelete = "";

  function read() {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(value) || value.some(entry => !entry || typeof entry.name !== "string" || !entry.layout || typeof entry.layout !== "object")) {
      throw new Error("无法读取本机布局，已保留原记录。");
    }
    return value;
  }
  function write(change) {
    const update = () => localStorage.setItem(key, JSON.stringify(change(read())));
    return navigator.locks ? navigator.locks.request(key, update) : Promise.resolve().then(update);
  }
  function report(error) {
    msg.textContent = error instanceof DOMException ? "浏览器存储不可用，布局未保存。" : error instanceof SyntaxError ? "无法读取本机布局，已保留原记录。" : error.message;
  }
  function cancelDelete() { pendingDelete = ""; del.textContent = "删除"; }
  function refresh(selected = list.value) {
    cancelDelete();
    try {
      const entries = read();
      list.replaceChildren(...entries.map(entry => new Option(entry.name, entry.name)));
      if (entries.some(entry => entry.name === selected)) list.value = selected;
      host.querySelector("#profile-library").hidden = !entries.length;
    } catch (error) { report(error); }
  }
  function syncButtons() {
    const state = window.getStudioLayout();
    for (const [i, { id, name, ...patch }] of presets.entries()) {
      grid.children[i].setAttribute("aria-pressed", String(Object.entries(patch).every(([k, v]) => state[k] === v)));
    }
  }
  for (const { id, name, ...patch } of presets) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "layout-preset";
    card.dataset.preset = id;
    card.innerHTML = '<span class="layout-pictogram" aria-hidden="true"><i></i><b></b><em></em></span>';
    card.append(document.createTextNode(name));
    card.addEventListener("click", () => {
      window.applyStudioLayout(patch);
      syncButtons();
      msg.textContent = "已应用「" + name + "」。";
    });
    grid.append(card);
  }
  // Keep the stored object limited to geometry even if the editor gains new state.
  function geometry(source) {
    const { side, width, main, share, order, heights, cover } = source;
    const allowed = ["connection", "prompt", "edit", "parameters"];
    return { side, width, main, share, cover, order: Array.isArray(order) ? order.filter(id => allowed.includes(id)) : allowed,
      heights: Object.fromEntries(allowed.map(id => [id, heights?.[id] ?? null])) };
  }
  async function save() {
    const name = nameInput.value.trim().normalize();
    if (!name) { msg.textContent = "请先填写布局名称。"; nameInput.focus(); return; }
    try {
      const layout = geometry(window.getStudioLayout());
      await write(entries => {
        if (entries.some(entry => entry.name === name)) throw new Error("已有同名布局，请换个名字。");
        return [{ name, layout }, ...entries];
      });
      nameInput.value = "";
      refresh(name);
      msg.textContent = "已保存「" + name + "」。";
    } catch (error) { report(error); }
  }
  host.querySelector("#profile-save").addEventListener("click", save);
  nameInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); save(); }
  });
  host.querySelector("#profile-apply").addEventListener("click", () => {
    try {
      const entry = read().find(item => item.name === list.value);
      if (!entry) { refresh(); msg.textContent = "此布局已移除。"; return; }
      window.applyStudioLayout(geometry(entry.layout));
      cancelDelete(); syncButtons();
      msg.textContent = "已应用「" + entry.name + "」。";
    } catch (error) { report(error); }
  });
  del.addEventListener("click", async () => {
    const name = list.value;
    if (!name) return;
    if (pendingDelete !== name) { pendingDelete = name; del.textContent = "确认删除"; msg.textContent = "再次点击即可删除「" + name + "」。"; return; }
    try {
      await write(entries => entries.filter(entry => entry.name !== name));
      refresh();
      msg.textContent = "已删除「" + name + "」。";
    } catch (error) { report(error); }
  });
  list.addEventListener("change", cancelDelete);
  const panel = document.getElementById("layout-dialog");
  for (const type of ["input", "change", "click"]) panel.addEventListener(type, () => queueMicrotask(syncButtons));
  document.getElementById("open-layout").addEventListener("click", () => { refresh(); syncButtons(); });
  window.addEventListener("storage", event => { if (event.key === key || event.key === null) refresh(); });
  refresh();
  syncButtons();
})();
