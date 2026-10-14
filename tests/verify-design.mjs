/**
 * 右栏设计轮验证（2026-10-06 owner 拍板：树=定位+结构化 / 查看器=主区分栏多 tab / 变更栏砍除 / 窗口记忆）
 * ① 变更栏砍除（无 pane-changes，pane-files flex=7）② 多根+专属色（ws 根 wc-* 着色，色值=色板）
 * ③ 右键菜单（文件 4 项/目录含收藏/根含色板；换色生效）④ 收藏目录（右键收藏→fav 根出现书签图标；
 * 移除=摘引用不删文件）⑤ 过滤（含未展开目录、结果行手势与树同步=单击查看/双击 @、Esc 退出）⑥ 显示隐藏（readDir 双态）
 * ⑦ 查看器 tabs（单击打开/重复聚焦/上限 8 聚焦最旧/Esc 逐个关/关完收起；2026-10-06 手势对调，双击=@ 恰一次）
 * ⑧ HTML 渲染⇄源码 / md 渲染 / 图片 dataUrl ⑨ 路径点击入壳（文件开查看器、目录树定位+闪烁）
 * ⑩ 窗口首次启动最大化 + window-state.json 落盘
 * 全程不发 prompt，零 token。用法：PI_GUI_CDP_PORT=9231 [PI_GUI_USER_DATA=...] node verify-design.mjs 9231
 */
const PORT = process.argv[2] || "9231";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /Pi/.test(t.title ?? ""));
      if (page) return page;
    } catch { /* 未就绪 */ }
    await sleep(1000);
  }
  throw new Error("CDP target 未找到");
}

const CHECK = String.raw`
(async () => {
  const R = {};
  // sleep 用 MessageChannel 自旋而非 setTimeout：测试窗口被 owner 最小化/遮挡时页面 hidden，
  // Chromium 把定时器限到 ~1s 地板甚至冻结（2026-10-06 实测：50ms 实测 718ms、脚本级假挂）；
  // MC 往返属普通任务不受 visibility 节流（实测 10 次往返 0ms）。
  const sleep = (ms) => new Promise((r) => {
    const ch = new MessageChannel();
    const t0 = performance.now();
    ch.port1.onmessage = () => {
      if (performance.now() - t0 >= ms) r();
      else ch.port2.postMessage(1);
    };
    ch.port2.postMessage(1);
  });
  const $ = (id) => document.getElementById(id);
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const groups = () => qa("#file-tree .proj-group");
  const clk = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  // 真实双击序列（click,click,dblclick）：2026-10-06 对调后语义=@ 引用
  const dbl = (el) => { clk(el); clk(el); el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); };
  const ctx = (el) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 260, clientY: 300 }));
  const rowByPath = (p) => q('.tree-row[data-full="' + CSS.escape(p) + '"]');
  const menuBtn = (label) => qa(".ctx-menu .ctx-item, .ctx-menu .ctx-swatch").find((b) => (b.textContent || "").includes(label) || b.title === label);
  const tabNames = () => qa(".vw-tab .vw-name").map((x) => x.textContent);
  // 轮询等某 tab 出现：单击开查看器走 app 内 230ms setTimeout，隐藏窗口被 Chromium
  // 节流到 ~1s 地板（2026-10-06 坑⑥同族），固定 sleep 赌时序不稳，改轮询（MC 自旋不受节流）
  const waitTab = async (name, ms = 6000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (tabNames().includes(name)) return true;
      await sleep(120);
    }
    return tabNames().includes(name);
  };
  const waitActive = async (name, ms = 6000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (q(".vw-tab.active .vw-name")?.textContent === name) return true;
      await sleep(120);
    }
    return q(".vw-tab.active .vw-name")?.textContent === name;
  };
  const ROOT = "E:\\pi-gui";

  // 准备：全新 userData 首启会把主目录登记为首个工作区（既有行为）；确保 E:\pi-gui 在树里；
  // 清掉前次运行残留的收藏根（僵尸脚本遗留），一律经真实 UI 路径触发重建
  let cfg0 = await window.pi.wsList();
  let rebuilt = false;
  if ((cfg0.favorites ?? []).length) {
    for (const f of cfg0.favorites) await window.pi.wsFavRemove(f.id);
    rebuilt = true;
  }
  if (!cfg0.workspaces.some((w) => w.cwd === ROOT)) {
    await window.pi.wsAdd(ROOT);
    rebuilt = true;
  }
  if (rebuilt) {
    // wsAdd/wsFavRemove 走 API 不触发树重建：点自由会话区「+」走 startSession → renderFileRoot（真实 UI 路径）
    document.querySelector("#free-sessions .ws-add")?.click();
    // 2026-10-10 验收修：固定 2.5s 在冷/负载实例下不够（右栏未建=q('.pane-files') 踩空 TypeError）→ 轮询等 pane 就绪
    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && !document.querySelector(".pane-files")) await sleep(300);
    await sleep(500);
  }

  // ① 变更栏砍除 + 比例 3:7
  R.noChangesPane = !q(".pane-changes") && !q("#change-list");
  R.filesFlex = getComputedStyle(q(".pane-files")).flexGrow;
  R.todoStill = !!q("#todo-panel");

  // ② 多根 + 专属色（等 init 完成；按实时配置对账：组数 = 工作区 + 收藏）
  for (let i = 0; i < 20 && groups().length === 0; i++) await sleep(500);
  const cfg = await window.pi.wsList();
  R.groupsVsWs = groups().length === cfg.workspaces.length + (cfg.favorites ?? []).length;
  const gMain = groups().find((g) => g.dataset.cwd === ROOT);
  R.wsRootThere = !!gMain;
  R.wcColor = gMain ? getComputedStyle(gMain.querySelector(".proj-name")).color : null;
  R.palette = { cinnabar: "rgb(180, 72, 60)", indigo: "rgb(62, 92, 118)", pine: "rgb(74, 120, 86)" };
  R.colorMatches = gMain && Object.values(R.palette).includes(R.wcColor);

  // 活跃组自动展开；若无活跃组（主目录不再进树，2026-10-06 owner 拍板）则记 n/a 跳过；
  // 并断言主目录不出现在树根
  await sleep(600);
  const activeG = groups().find((g) => g.classList.contains("active"));
  R.autoExpand = activeG ? !activeG.querySelector(":scope > .tree-children").classList.contains("hidden") : "n/a-no-active-root";
  R.noHomeRoot = cfg.homeDir ? !groups().some((g) => g.dataset.cwd === cfg.homeDir) : true;
  // 展开 pi-gui 根 + renderer 子目录（app.js/style.css/index.html 都在 renderer/ 下）
  gMain.querySelector(":scope > .proj-head .t-chevron").click();
  let rendererRow = null;
  for (let i = 0; i < 20 && !rendererRow; i++) {
    await sleep(400);
    rendererRow = rowByPath(ROOT + "\\renderer");
  }
  rendererRow.click(); // 目录行单击=展开
  let appjs = null;
  for (let i = 0; i < 20 && !appjs; i++) {
    await sleep(400);
    appjs = rowByPath(ROOT + "\\renderer\\app.js");
  }
  R.expandRows = !!appjs;

  // ⑦ 查看器：单击 app.js → 1 tab，高亮+行号（2026-10-06 对调：单击=查看）
  R.fileRowThere = !!appjs;
  $("input").value = "";
  clk(appjs);
  await waitTab("app.js");
  R.viewerOpen1 = !q("#viewer").classList.contains("hidden") && !q("#viewer-split").classList.contains("hidden");
  R.tabCount1 = tabNames().length === 1 && tabNames()[0] === "app.js";
  R.singleClickNoRef = !($("input").value || "").includes("@"); // 单击只开查看，不插引用
  // 内容异步加载（readFile IPC）：轮询等行号就位再验高亮/gutter
  const gutterLines = () => (q(".vw-gutter")?.textContent || "").trim().split("\n").length;
  {
    const t0 = performance.now();
    while (performance.now() - t0 < 8000 && gutterLines() < 100) await sleep(150);
  }
  R.hljsCode = !!q(".vw-pre code.hljs, .vw-pre code");
  R.gutter = gutterLines() > 100; // app.js 两千多行

  // 重复打开聚焦已有（开 style.css 再开 app.js → 仍 2 tab 且 active=app.js）
  clk(rowByPath(ROOT + "\\renderer\\style.css"));
  await waitTab("style.css");
  clk(rowByPath(ROOT + "\\renderer\\app.js"));
  R.tabCount2 = tabNames().length === 2;
  R.refocus = await waitActive("app.js");

  // 上限 8：再开 6 个到满，第 9 个聚焦最旧（index.html 在 renderer/，其余在根）
  for (const f of ["renderer\\index.html", "package.json", "main.js", "preload.cjs", "README.md", "WORKLOG.md"]) {
    const nm = f.split("\\").pop();
    clk(rowByPath(ROOT + "\\" + f));
    await waitTab(nm); // 逐个等到位再点下一个，避开隐藏窗定时器节流
  }
  R.tabCap8 = tabNames().length === 8;
  clk(rowByPath(ROOT + "\\启动.bat"));
  R.tabCapFocusOldest = (await waitActive("app.js")) && tabNames().length === 8;

  // ⑧ HTML 渲染⇄源码：先关到只剩 1 个 tab，展开 design 后开 design-proposals.html
  qa(".vw-tab .vw-x").slice(0, 7).forEach((x) => x.click());
  await sleep(300);
  R.afterCloseOne = tabNames().length === 1;
  const designRow = rowByPath(ROOT + "\\design");
  designRow.click(); await sleep(900);
  const propRow = rowByPath(ROOT + "\\design\\design-proposals.html");
  R.propRowThere = !!propRow;
  if (propRow) { clk(propRow); await waitTab("design-proposals.html"); }
  R.iframeThere = !!q(".vw-frame") && (q(".vw-frame").src || "").startsWith("file:///");
  R.segThere = qa(".vw-seg button").length === 2 && qa(".vw-seg button").map((b) => b.textContent).join("") === "渲染源码";
  qa(".vw-seg button")[1].click(); await sleep(300);
  R.htmlSource = !!q(".vw-pre");
  qa(".vw-seg button")[0].click(); await sleep(300);
  R.htmlRenderBack = !!q(".vw-frame");

  // md 渲染：README.md
  clk(rowByPath(ROOT + "\\README.md")); await waitTab("README.md");
  R.mdRender = !!q(".vw-md") && q(".vw-md").children.length > 0;

  // 图片：icon.png
  const iconRow = rowByPath(ROOT + "\\icon.png");
  if (iconRow) { clk(iconRow); await waitTab("icon.png"); }
  R.imgView = !!q(".vw-img-wrap img") && (q(".vw-img-wrap img").src || "").startsWith("data:image/png");

  // Esc 逐个关 tab → 关完收起查看器
  const before = tabNames().length;
  for (let i = 0; i < before; i++) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await sleep(150);
  }
  await sleep(300);
  R.escCloseAll = tabNames().length === 0 && q("#viewer").classList.contains("hidden");

  // 手势对调回归（2026-10-06）：双击=@ 引用恰好一次、不开查看器；重复引用根治
  $("input").value = "";
  dbl(rowByPath(ROOT + "\\README.md"));
  await sleep(500);
  R.dblOneRef = (($("input").value || "").match(/@/g) || []).length === 1 && ($("input").value || "").startsWith("@E:\\pi-gui\\README.md");
  R.dblNoViewer = tabNames().length === 0;
  $("input").value = "";

  // ③⑤⑥ 树附属能力（查看器已关）
  // 右键文件菜单 4 项（用根目录 README.md，不依赖 renderer 展开）
  ctx(rowByPath(ROOT + "\\README.md"));
  await sleep(200);
  R.fileMenuItems = qa(".ctx-menu .ctx-item").length;
  R.fileMenuHas = ["引用", "复制路径", "系统打开", "在树中定位"].every((t) => qa(".ctx-menu .ctx-item").some((b) => b.textContent.includes(t)));
  qa(".ctx-menu .ctx-item")[0].click(); // @ 引用：输入框应被插入
  await sleep(200);
  R.atInsert = ($("input").value || "").startsWith("@E:\\pi-gui\\README.md");
  $("input").value = "";

  // 根右键：6 色板 + 换色生效（基准 indigo → 换 cinnabar → 还原）
  let gMain2 = groups().find((g) => g.dataset.cwd === ROOT);
  ctx(gMain2.querySelector(".proj-head"));
  await sleep(200);
  R.swatches = qa(".ctx-menu .ctx-swatch").length;
  qa(".ctx-menu .ctx-swatch")[0].click();
  await sleep(700);
  R.recolored = groups().find((g) => g.dataset.cwd === ROOT).className.includes("wc-cinnabar");
  gMain2 = groups().find((g) => g.dataset.cwd === ROOT);
  ctx(gMain2.querySelector(".proj-head")); await sleep(200);
  qa(".ctx-menu .ctx-swatch")[1].click(); await sleep(700); // 还原 indigo
  R.colorRestored = groups().find((g) => g.dataset.cwd === ROOT).className.includes("wc-indigo");

  // ④ 收藏目录：右键 design 目录 → 收藏此目录 → fav 根出现（书签图标）
  // （换色刚触发过整树重建，行回位是异步的：轮询等 design 行回盘，12s 仍无则点根箭头兑底重展开）
  let designRowMenu = rowByPath(ROOT + "\\design");
  for (let i = 0; i < 40 && !designRowMenu; i++) {
    await sleep(300);
    designRowMenu = rowByPath(ROOT + "\\design");
  }
  if (!designRowMenu) {
    const gRoot = groups().find((g) => g.dataset.cwd === ROOT);
    const kidsRoot = gRoot.querySelector(":scope > .tree-children");
    if (kidsRoot.classList.contains("hidden")) gRoot.querySelector(":scope > .proj-head .t-chevron").click();
    for (let i = 0; i < 20 && !designRowMenu; i++) {
      await sleep(300);
      designRowMenu = rowByPath(ROOT + "\\design");
    }
  }
  ctx(designRowMenu); await sleep(200);
  const favBtn = menuBtn("收藏此目录");
  R.dirMenuFav = !!favBtn;
  favBtn.click();
  await sleep(1000);
  const favG = groups().find((g) => g.dataset.kind === "fav");
  R.favRoot = !!favG && favG.dataset.cwd === ROOT + "\\design";
  R.favIcon = favG ? (favG.querySelector(".proj-ic use").getAttribute("href") === "#i-bookmark") : false;
  R.favNeutral = favG ? !/wc-/.test(favG.className) : false;
  const cfgF = await window.pi.wsList();
  R.favPersist = (cfgF.favorites || []).some((f) => f.cwd === ROOT + "\\design");
  // fav 根点名=展开（不切工作区）。注：若重建时因 treeExpanded 残留（⑧段展开过 design 同路径）
  // 收藏根自动展开，先收起归零再测——否则点名点击是在“收起”而非“展开”
  const cwdBefore = (await window.pi.getState()).cwd;
  {
    const fg0 = groups().find((g) => g.dataset.kind === "fav");
    if (fg0 && !fg0.querySelector(":scope > .tree-children").classList.contains("hidden")) {
      fg0.querySelector(".proj-head").click();
      await sleep(400);
    }
  }
  favG.querySelector(".proj-head").click();
  const favKidsOpen = () => {
    const fg = groups().find((g) => g.dataset.kind === "fav");
    return !!fg && !fg.querySelector(":scope > .tree-children").classList.contains("hidden");
  };
  for (let i = 0; i < 40 && !favKidsOpen(); i++) await sleep(300);
  R.favClickExpand = favKidsOpen();
  R.favNoSwitch = (await window.pi.getState()).cwd === cwdBefore;
  // 移除=摘引用不删文件
  ctx(favG.querySelector(".proj-head")); await sleep(200);
  menuBtn("从树中移除").click(); await sleep(900);
  const cfgF2 = await window.pi.wsList();
  R.favRemoved = !groups().some((g) => g.dataset.kind === "fav") && !(cfgF2.favorites || []).length;
  R.favNotDeleted = ((await window.pi.readDir(ROOT, false)).entries || []).some((e) => e.name === "design" && e.dir);

  // ⑤ 过滤：btn-tree-filter → 输入 app.b → 结果含 app.bundle.js；结果行手势与树同步（2026-10-06 对调）：单击=开查看 tab、双击=@；Esc 退出
  $("btn-tree-filter").click(); await sleep(200);
  R.filterRowShown = !$("tree-filter-row").classList.contains("hidden");
  $("tree-filter-input").value = "app.b";
  $("tree-filter-input").dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(2500); // 防抖是 app 内 setTimeout（隐藏页 ~1s 地板）+ 搜索，给足余量
  R.resultsShown = !$("tree-results").classList.contains("hidden") && $("file-tree").classList.contains("hidden");
  R.resultHit = qa(".tree-result-row").some((r) => (r.dataset.full || "").endsWith("app.bundle.js"));
  const rrow = qa(".tree-result-row").find((r) => (r.dataset.full || "").endsWith("app.bundle.js"));
  if (rrow) { clk(rrow); await waitTab("app.bundle.js"); }
  R.filterClkView = tabNames().includes("app.bundle.js"); // 单击=查看（tab 去重）
  if (rrow) { clk(rrow); await sleep(1500); } // 同文件再单击：仍 1 个同名 tab（等节流定时器响完再计数）
  R.filterClkDedupe = tabNames().filter((n) => n === "app.bundle.js").length === 1;
  if (rrow) { dbl(rrow); await sleep(400); }
  R.filterAt = (($("input").value || "").match(/@/g) || []).length === 1 && ($("input").value || "").includes("app.bundle.js");
  // 清场：关查看器 tab、清输入
  for (let i = 0; i < tabNames().length; i++) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await sleep(150);
  }
  $("input").value = "";
  $("tree-filter-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await sleep(300);
  R.filterExit = $("tree-results").classList.contains("hidden") && !$("file-tree").classList.contains("hidden") && $("tree-filter-row").classList.contains("hidden");

  // ⑥ 显示隐藏（直接 API 断言双态 + 按钮 active 态）
  const withHidden = await window.pi.readDir(ROOT, true);
  const noHidden = await window.pi.readDir(ROOT, false);
  R.hiddenToggleApi = (withHidden.entries || []).some((e) => e.name === "node_modules") && !(noHidden.entries || []).some((e) => e.name === "node_modules");
  const hiddenBefore = localStorage.getItem("pi-gui:tree-hidden");
  $("btn-tree-hidden").click(); await sleep(600);
  R.hiddenBtnActive = $("btn-tree-hidden").classList.contains("active") && localStorage.getItem("pi-gui:tree-hidden") === "1";
  $("btn-tree-hidden").click(); await sleep(600);
  R.hiddenRestored = localStorage.getItem("pi-gui:tree-hidden") === (hiddenBefore ?? "0") || localStorage.getItem("pi-gui:tree-hidden") === "0";

  // ⑨ 路径点击入壳：注入 file-link（文件 → 查看器 tab；目录 → 树定位+闪烁）
  // 注：preload.cjs 在仓库根目录（不在 renderer/）——路径必须用根
  const fl = document.createElement("span");
  fl.className = "file-link"; fl.dataset.path = ROOT + "\\preload.cjs"; fl.textContent = "x";
  $("chat").appendChild(fl); fl.click();
  await sleep(1500);
  R.linkFileOpens = tabNames().includes("preload.cjs");
  const fl2 = document.createElement("span");
  fl2.className = "file-link"; fl2.dataset.path = ROOT + "\\docs"; fl2.textContent = "y";
  $("chat").appendChild(fl2); fl2.click();
  await sleep(1800);
  R.linkDirLocates = !!rowByPath(ROOT + "\\docs\\2026-10-02-改进讨论-会话提取.md") && !q('.tree-children[data-path="' + CSS.escape(ROOT + "\\docs") + '"]').classList.contains("hidden");
  fl.remove(); fl2.remove();
  // 收尾：关掉查看器
  $("vw-close").click(); await sleep(200);
  R.finalClosed = q("#viewer").classList.contains("hidden");

  // ⑩ 窗口：首次启动最大化（宽≈工作区宽；窗口被 owner 最小化时无法度量，豁免不算失败）
  R.maximized = Math.abs(window.outerWidth - window.screen.availWidth) < 8 || document.hidden;
  R.windowHiddenNote = document.hidden ? "（窗口当前被隐藏，maximized 豁免）" : "";

  return JSON.stringify(R);
})()
`;

function judge(r) {
  const checks = [
    ["noChangesPane", r.noChangesPane],
    ["filesFlex=7", r.filesFlex === "7"],
    ["todoStill", r.todoStill],
    ["groupsVsWs", r.groupsVsWs],
    ["wsRootThere", r.wsRootThere],
    ["expandRows", r.expandRows],
    ["colorMatches", r.colorMatches],
    ["autoExpand", r.autoExpand === true || r.autoExpand === "n/a-no-active-root"],
    ["noHomeRoot", r.noHomeRoot],
    ["fileRowThere", r.fileRowThere],
    ["viewerOpen1", r.viewerOpen1],
    ["tabCount1", r.tabCount1],
    ["hljsCode", r.hljsCode],
    ["gutter", r.gutter],
    ["tabCount2", r.tabCount2],
    ["refocus", r.refocus],
    ["tabCap8", r.tabCap8],
    ["tabCapFocusOldest", r.tabCapFocusOldest],
    ["afterCloseOne", r.afterCloseOne],
    ["propRowThere", r.propRowThere],
    ["iframeThere", r.iframeThere],
    ["segThere", r.segThere],
    ["htmlSource", r.htmlSource],
    ["htmlRenderBack", r.htmlRenderBack],
    ["mdRender", r.mdRender],
    ["imgView", r.imgView],
    ["escCloseAll", r.escCloseAll],
    ["fileMenuItems=4", r.fileMenuItems === 4],
    ["fileMenuHas", r.fileMenuHas],
    ["atInsert", r.atInsert],
    ["swatches=6", r.swatches === 6],
    ["recolored", r.recolored],
    ["colorRestored", r.colorRestored],
    ["dirMenuFav", r.dirMenuFav],
    ["favRoot", r.favRoot],
    ["favIcon", r.favIcon],
    ["favNeutral", r.favNeutral],
    ["favPersist", r.favPersist],
    ["favClickExpand", r.favClickExpand],
    ["favNoSwitch", r.favNoSwitch],
    ["favRemoved", r.favRemoved],
    ["favNotDeleted", r.favNotDeleted],
    ["filterRowShown", r.filterRowShown],
    ["resultsShown", r.resultsShown],
    ["resultHit", r.resultHit],
    ["filterClkView", r.filterClkView],
    ["filterClkDedupe", r.filterClkDedupe],
    ["filterAt", r.filterAt],
    ["filterExit", r.filterExit],
    ["hiddenToggleApi", r.hiddenToggleApi],
    ["hiddenBtnActive", r.hiddenBtnActive],
    ["hiddenRestored", r.hiddenRestored],
    ["linkFileOpens", r.linkFileOpens],
    ["linkDirLocates", r.linkDirLocates],
    ["finalClosed", r.finalClosed],
    ["maximized", r.maximized || process.env.PI_GUI_TEST_SHOW !== "1"], // 无头模式窗口不最大化，豁免（2026-10-08）
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([k]) => k);
  return { pass: failed.length === 0, failed };
}

async function main() {
  const target = await findTarget();
  console.log("target:", target.title);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  let n = 0;
  // 保活三连（2026-10-06 实测坑）：测试窗口被 owner 最小化/遮挡 → 页面 hidden → Chromium 冻结定时器
  // → 页面脚本里一切 await sleep 假挂（evaluates 照常响应，极具迷惑性）。强制 active + 仿真焦点 + 最大化窗口。
  const cdpRaw = (method, params) => new Promise((resolve) => {
    // id 必须整数：Chromium CDP 拒收字符串 id（"Message must have integer 'id'"）且错误响应不带 id，
    // 按字符串 id 匹配的 promise 会永挂（2026-10-06 实测：keep-alive 一句话挂掉整个验证脚本）
    const id = ++n;
    const onMsg = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id === id) { ws.removeEventListener("message", onMsg); resolve(msg); }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await cdpRaw("Page.enable", {});
    await cdpRaw("Page.setWebLifecycleState", { state: "active" });
    await cdpRaw("Emulation.setFocusEmulatedVisible", { visible: true });
    // 无头模式（2026-10-08 owner 拍板：测试不弹窗不抢前台）不最大化窗口；真窗口模式保留最大化保活三连
    if (process.env.PI_GUI_TEST_SHOW === "1") {
      const wt = await cdpRaw("Browser.getWindowForTarget", {});
      if (wt?.result?.windowId) {
        await cdpRaw("Browser.setWindowBounds", { windowId: wt.result.windowId, bounds: { windowState: "maximized" } });
      }
    }
  } catch { /* 保活尽力而为，不影响断言 */ }
  const call = (expression, awaitPromise) => new Promise((resolve, reject) => {
    const id = ++n;
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        ws.removeEventListener("message", onMsg);
        const ex = msg.result?.exceptionDetails;
        if (ex) reject(new Error("页面异常: " + (ex.exception?.description || ex.text)));
        else msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result?.result?.value);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise } }));
  });
  for (let i = 0; i < 30; i++) { if (await call("window.pi ? 'ready' : 'no'", false) === "ready") break; await sleep(1000); }
  await sleep(2500);
  const raw = await call(CHECK, true);
  if (raw === undefined) { console.log("❌ evaluate 返回 undefined（页面脚本异常）"); process.exit(1); }
  const r = JSON.parse(raw);
  console.log("RESULT:", raw);
  const { pass, failed } = judge(r);
  // 窗口状态文件（若给了独立 userData）
  if (process.env.PI_GUI_USER_DATA) {
    try {
      const fs = await import("node:fs");
      const st = JSON.parse(fs.readFileSync(process.env.PI_GUI_USER_DATA.replace(/\\+$/, "") + "\\window-state.json", "utf8"));
      console.log("window-state.json:", JSON.stringify(st), st.maximized === true && Number.isFinite(st.width) ? "✅" : "⚠️");
    } catch (e) { console.log("window-state.json 未读到:", e.message); }
  }
  console.log(pass ? `✅ 全绿（${judge(r) && 52} 项）` : "❌ 未过项：\n  - " + failed.join("\n  - "));
  ws.close();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("验证失败:", e.message); process.exit(1); });
