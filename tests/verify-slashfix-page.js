/* 页面端检查：各输入场景下 slash-menu 的可见性（只读 DOM，零副作用，不派发 Enter） */
(async () => {
  const input = document.getElementById("input");
  const menu = document.getElementById("slash-menu");
  const menuHidden = () => menu.classList.contains("hidden");
  const setVal = (v) => {
    input.value = v;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const itemCount = () => menu.querySelectorAll(".slash-item").length;

  // 等菜单状态稳定（input 事件同步处理，一般无需等；防御性 rAF→改 setTimeout，规避后台窗口 rAF 不触发的坑）
  const settle = () => new Promise((r) => setTimeout(r, 60));

  // A/B: 选中命令后继续输入参数（复现 bug 场景：/skill:grill-me + 空格 + 参数）
  const expected = "/skill:grill-me 如何整理wps，这个也会双向同步";
  setVal(expected);
  await settle();
  const withArgs = { menuHidden: menuHidden(), value: input.value, expected };

  // C: 纯命令 token（无空白）→ 菜单应弹出（选中交互保留）
  setVal("/skill:grill-me");
  await settle();
  const bareToken = { menuHidden: menuHidden() };

  // D: 输入前缀 → 过滤菜单仍有项
  setVal("/ski");
  await settle();
  const filtered = { menuHidden: menuHidden(), itemCount: itemCount() };

  // E: 普通文本不触发
  setVal("普通文本消息");
  await settle();
  const plainText = { menuHidden: menuHidden() };

  // 还原
  setVal("");
  await settle();

  return { withArgs, bareToken, filtered, plainText, cleanupValue: input.value };
})()
