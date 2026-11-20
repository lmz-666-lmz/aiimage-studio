/* Download the current cross-page gallery selection as one portable collection. */
(() => {
  const button = document.getElementById("batch-download");
  if (!button) return;

  const label = button.textContent;
  let downloading = false;

  function updateButton() {
    button.disabled = downloading || !selected.size;
    button.textContent = downloading ? "正在打包…" : label;
    button.setAttribute("aria-busy", String(downloading));
  }

  document.addEventListener("studio:selectionchange", updateButton);
  updateButton();

  button.addEventListener("click", async () => {
    if (downloading || !batchMode || !selected.size) return;
    const names = [...selected];
    downloading = true;
    updateButton();
    try {
      const response = await fetch("/api/history/bundle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (response.status === 409) {
          for (const name of result.unavailable || []) selected.delete(name);
          updateBatchCount();
          await loadHistory(page, false);
        }
        throw new Error(result.error || `下载失败（HTTP ${response.status}）`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      const disposition = response.headers.get("Content-Disposition") || "";
      const filename = disposition.match(/filename="?([\w.-]+\.zip)"?/i);
      link.href = url;
      link.download = filename?.[1] || "shiguang-collection.zip";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      showToast(`已开始下载 ${names.length} 张原图与参数清单`, "success");
    } catch (error) {
      showToast(error.message || "无法下载作品包，请重试", "error");
    } finally {
      downloading = false;
      updateButton();
    }
  });
})();
