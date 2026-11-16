// Loop 连接设置 · Created by Leo Hu
// 内部工具，仅限公司内部使用，请勿外传。只有本人用 Loop 时才需要填；不填就是关闭，对其他功能没有任何影响。
(() => {
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");

  function showStatus(s) {
    if (!s) {
      statusEl.className = "";
      statusEl.textContent = "";
      return;
    }
    statusEl.className = s.state === "on" ? "on" : s.state === "error" ? "error" : "";
    const t = s.at ? new Date(s.at).toLocaleTimeString("zh-CN", { hour12: false }) : "";
    statusEl.textContent = (s.text || "") + (t ? "（" + t + "）" : "");
  }

  chrome.storage.local.get(["loop", "loopStatus"], (r) => {
    const l = r.loop || {};
    if (l.url) $("url").value = l.url;
    if (l.worker) $("name").value = l.worker;
    if (l.key) $("key").value = l.key;
    $("enabled").checked = !!l.enabled;
    showStatus(r.loopStatus);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.loopStatus) showStatus(changes.loopStatus.newValue);
  });

  $("save").addEventListener("click", async () => {
    const url = $("url").value.trim().replace(/\/+$/, "");
    const loop = { enabled: $("enabled").checked, url, worker: $("name").value.trim(), key: $("key").value.trim() };
    if (loop.enabled) {
      let u;
      try {
        u = new URL(url);
      } catch (e) {
        return showStatus({ state: "error", text: "地址写得不对" });
      }
      // 只允许连本机：这个功能是给本机的 Loop 用的，不应该把密钥发到别处
      if (!["127.0.0.1", "localhost"].includes(u.hostname)) return showStatus({ state: "error", text: "只能连本机地址（127.0.0.1 或 localhost）" });
      if (!loop.key) return showStatus({ state: "error", text: "还没填接单密钥" });
      const granted = await chrome.permissions.request({ origins: [u.protocol + "//" + u.hostname + "/*"] }).catch(() => false);
      if (!granted) return showStatus({ state: "error", text: "没有授权访问本机地址，无法连接" });
    }
    await chrome.storage.local.set({ loop });
    showStatus({ state: "", text: loop.enabled ? "已保存，正在连接…" : "已保存（未启用）" });
  });
})();
