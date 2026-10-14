// 页面端 DOM 检查：2026-10-03 第二轮（composer 合并状态栏 + footer git/智谱 + / 菜单动作）
(() => {
  const r = {};
  // 1) composer：按钮已删、状态已合并
  r.modeSwitchGone = !document.getElementById("mode-switch");
  r.compareBtnGone = !document.getElementById("btn-compare");
  r.statusbarGone = !document.getElementById("statusbar");
  r.statusDotInComposer = !!document.querySelector("#composer #status-dot");
  r.statusText = document.getElementById("status-state")?.textContent ?? null;
  r.usageChip = !!document.getElementById("status-usage");
  r.modelSelect = !!document.getElementById("model-select");
  // 2) footer：git + 智谱用量
  r.footerGit = document.getElementById("footer-git-text")?.textContent ?? null;
  r.footerZai = document.getElementById("footer-zai-text")?.textContent ?? null;
  r.archivedToggle = document.getElementById("btn-toggle-archived")?.textContent ?? null;
  // 3) / 菜单：GUI 动作三条都能搜到
  const input = document.getElementById("input");
  const menu = document.getElementById("slash-menu");
  input.value = "/排";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  r.queueCmd = [...menu.querySelectorAll(".slash-label")].map((x) => x.textContent);
  input.value = "/插";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  r.steerCmd = [...menu.querySelectorAll(".slash-label")].map((x) => x.textContent);
  input.value = "/co";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  r.compareCmd = [...menu.querySelectorAll(".slash-label")].map((x) => x.textContent);
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  // 4) 侧栏树仍在
  r.wsGroups = document.querySelectorAll(".ws-group").length;
  r.sessions = document.querySelectorAll(".session-item").length;
  return JSON.stringify(r, null, 1);
})()
