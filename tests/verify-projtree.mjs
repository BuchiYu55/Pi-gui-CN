/**
 * 右栏项目结构树验证（2026-10-06 owner 需求：文件区改多工作区结构树，点项目切换工作区）
 * ① pane 标题「项目」且组数=工作区数 ② 活跃组朱砂高亮 + 初始自动展开一层
 * ③ 箭头展开任一项目目录子树 ④ 点项目名：有会话=切换（cwd 变、无通知条、左栏同步）；无会话=不自动新建+右键「在此开新会话」（2026-10-06 owner 拍板）；子目录右键开新会话=自动登记工作区（用 <repo-root>\renderer 确定性验证）
 * ⑤ 切换只刷新高亮：已展开状态保留 ⑥ 移除工作区后树同步刷新
 * 重建触发一律走真实 UI 点击（组头/自由区+）；全程不发 prompt，零 token。
 * 用法：PI_GUI_CDP_PORT=9225 [PI_GUI_USER_DATA=...] 启动测试实例后 node verify-projtree.mjs 9225
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.argv[2] || "9225";
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const groups = () => [...document.querySelectorAll("#file-tree .proj-group")];
  const head = (g) => g.querySelector(".proj-head");
  const kids = (g) => g.querySelector(".tree-children");
  const wsOf = (g) => cfgById[g.dataset.wsId];
  let cfg = await window.pi.wsList();
  let cfgById = Object.fromEntries(cfg.workspaces.map((w) => [String(w.id), w]));
  const waitCwd = async (cwd, ms) => {
    for (let i = 0; i < ms / 250; i++) {
      const st = await window.pi.getState();
      if (st && st.cwd === cwd) return true;
      await sleep(250);
    }
    return false;
  };
  // 右键「在此开新会话」（2026-10-06 新语义：无会话工作区点击不再自动新建，会话入口在右键）
  const ctxNew = async (gEl) => {
    head(gEl).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    await sleep(300);
    [...document.querySelectorAll(".ctx-menu .ctx-item")].find((b) => b.textContent.includes("在此开新会话"))?.click();
  };
  // 触发整树重建的真实 UI 路径：优先点一个非当前 cwd 的组头（有会话=直接切）；
  // 点不动（无会话，2026-10-06 后不再自动新建）则右键开新会话落地；没有组则点自由区+
  const forceRebuild = async () => {
    const cur = (await window.pi.getState()).cwd;
    const gX = groups().find((g) => wsOf(g) && wsOf(g).cwd !== cur);
    if (gX) {
      head(gX).click();
      if (await waitCwd(wsOf(gX).cwd, 5000)) return true;
      await ctxNew(gX);
      return waitCwd(wsOf(gX).cwd, 12000);
    }
    document.querySelector("#free-sessions .ws-add")?.click();
    await sleep(1500);
    return true;
  };

  // ① 初始对账（可能 0 组=全新 userData，也可能继承存量）
  R.paneTitle = document.querySelector(".pane-files .pane-head")?.textContent.trim();
  const cfg0 = cfg;
  R.wsCount0 = cfg0.workspaces.length;
  R.groupsVsWs = groups().length === cfg0.workspaces.length;
  R.list = cfg0.workspaces.map((w) => w.name + "|" + w.cwd);

  // 保证 ≥2 个工作区（design/docs 真实存在；会话存 ~/.pi 侧，不污染仓库）
  R.addedIds = [];
  for (const dir of ["__REPO_ROOT__\\design", "__REPO_ROOT__\\docs", "__REPO_ROOT__"]) {
    if (!cfg.workspaces.some((w) => w.cwd.toLowerCase() === dir.toLowerCase())) {
      const c2 = await window.pi.wsAdd(dir);
      const nw = c2.workspaces.find((w) => w.cwd.toLowerCase() === dir.toLowerCase());
      if (nw) R.addedIds.push(nw.id);
      cfg = c2;
    }
  }
  cfgById = Object.fromEntries(cfg.workspaces.map((w) => [String(w.id), w]));
  if (groups().length !== cfg.workspaces.length) {
    if (!await forceRebuild()) { R.fail = "rebuild-trigger"; return JSON.stringify(R); }
    await sleep(800);
  }
  R.rebuildCount = groups().length === cfg.workspaces.length && groups().length >= 2;

  // ② 切到 A：断言高亮/颜色/自动展开。A 确定性选仓库根（子目录多，tree-node 断言需要）——
  // 不能再 groups()[0]：TEST_CWD 钩子（bdf97b2）把初始会话 cwd 改到钩子目录，init 会自动把它登记为首个
  // 工作区（无子目录），组序 shift 后 [0] 不再是 pi-gui 根（2026-10-08 无头轮实测踩中）
  const gA = groups().find((g) => (wsOf(g)?.cwd ?? "").toLowerCase() === "__REPO_ROOT_LOWER__") ?? groups()[0];
  const gB = groups().find((g) => g !== gA);
  const A = wsOf(gA), B = wsOf(gB);
  if ((await window.pi.getState()).cwd !== A.cwd) {
    head(gA).click(); // 有会话=直接切；无会话=不自动新建（新语义），改右键开新会话
    if (!(await waitCwd(A.cwd, 5000))) { await ctxNew(gA); await waitCwd(A.cwd, 12000); }
  }
  await sleep(800); // 等 startSession 全链路（renderFileRoot 高亮刷新）
  R.activeCount = groups().filter((g) => g.classList.contains("active")).length;
  R.activeIsA = gA.classList.contains("active");
  // 2026-10-06 设计轮：专属色落在 .proj-name/.proj-ic 上（head 本身不再着色）
  // 断言改为「与 A 登记色一致」（2026-10-08）：TEST_CWD 钩子目录组先登记抢走 cinnabar，
  // 写死朱砂会随组序漂移误红；六色对照 style.css --wc-* 变量
  const WC_RGB = { cinnabar: "rgb(180, 72, 60)", indigo: "rgb(62, 92, 118)", pine: "rgb(74, 120, 86)", ochre: "rgb(168, 124, 31)", plum: "rgb(125, 90, 120)", umber: "rgb(138, 106, 79)" };
  R.activeColor = getComputedStyle(head(gA).querySelector(".proj-name")).color;
  R.activeColorOk = R.activeColor === (WC_RGB[A?.color] ?? WC_RGB.cinnabar);
  await sleep(600);
  R.autoExpand = !kids(gA).classList.contains("hidden") && kids(gA).querySelectorAll(".tree-node").length > 0;

  // ③ 箭头收起→再展开（B 组多为 design/docs 无子目录，改在 A=pi-gui 根上测箭头语义；2026-10-08）
  if (!kids(gA).classList.contains("hidden")) { gA.querySelector(".t-chevron").click(); await sleep(800); }
  gA.querySelector(".t-chevron").click();
  await sleep(800);
  R.chevExpand = !kids(gA).classList.contains("hidden") && kids(gA).querySelectorAll(".tree-node").length > 0;

  // ④ 点 B 项目名：有会话=直接切换；无会话=不自动新建（2026-10-06 owner 拍板）→右键「在此开新会话」开
  const bs = (await window.pi.wsSessions(B.cwd).catch(() => ({}))).sessions ?? [];
  R.bHadSessions = bs.length > 0;
  head(gB).click();
  await sleep(1200);
  if (!R.bHadSessions) {
    R.noAutoNew = (await window.pi.getState()).cwd !== B.cwd; // 点击不再自动新建
    R.noSessNotice = document.getElementById("notice").classList.contains("hidden"); // 黄条永远不要（2026-10-06 owner 拍板）
    head(gB).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    await sleep(300);
    const mi = [...document.querySelectorAll(".ctx-menu .ctx-item")];
    R.rootMenuNew = mi.some((b) => b.textContent.includes("在此开新会话"));
    R.rootMenuRm = mi.some((b) => b.textContent.includes("移除工作区"));
    mi.find((b) => b.textContent.includes("在此开新会话"))?.click();
  }
  R.switchOk = await waitCwd(B.cwd, 10000);
  await sleep(800);
  R.noticeHidden = document.getElementById("notice").classList.contains("hidden");
  R.activeIsB = gB.classList.contains("active") && !gA.classList.contains("active");
  R.leftSync = [...document.querySelectorAll("#ws-groups .ws-group")].some((g) => g.dataset.wsId === String(B.id) && g.classList.contains("active"));

  // ④b 子目录右键「在此目录开新会话」：未登记目录自动登记为工作区（用 <repo-root>\renderer 确定性子目录；登记触发整树重建）
  {
    const ROOT2 = "__REPO_ROOT__";
    const gRoot = groups().find((g) => g.dataset.cwd === ROOT2);
    R.subRootThere = !!gRoot;
    if (gRoot) {
      const rk = gRoot.querySelector(":scope > .tree-children");
      if (rk.classList.contains("hidden")) gRoot.querySelector(":scope > .proj-head .t-chevron").click();
      let subRow = null;
      for (let i = 0; i < 30 && !subRow; i++) {
        await sleep(300);
        subRow = [...rk.querySelectorAll(":scope > .tree-node > .tree-row")]
          .find((r) => r.dataset.dir === "1" && /renderer/i.test(r.dataset.full));
      }
      R.subMenuNew = false;
      if (subRow) {
        const sub = subRow.dataset.full;
        subRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 320 }));
        await sleep(400);
        const mi2 = [...document.querySelectorAll(".ctx-menu .ctx-item")];
        R.subMenuNew = mi2.some((b) => b.textContent.includes("在此目录开新会话"));
        mi2.find((b) => b.textContent.includes("在此目录开新会话"))?.click();
        R.subNewOk = await waitCwd(sub, 12000); // 已切到子目录会话
        await sleep(1200); // 登记新工作区触发整树重建
        const wl = await window.pi.wsList();
        R.subRegistered = groups().some((g) => g.dataset.cwd === sub)
          && (wl.workspaces ?? []).some((w) => w.cwd === sub); // 左栏分组无 dataset.cwd，对账以 wsList 为准
        R.subAddedId = (groups().find((g) => g.dataset.cwd === sub) || {}).dataset?.wsId;
      } else {
        R.subNewOk = "n/a-no-subdir";
        R.subRegistered = "n/a-no-subdir";
      }
    }
  }

  // ⑤ 切换只刷新高亮：A 的展开状态保留（子目录登记重建后 treeExpanded 恢复展开态）
  const gA2 = groups().find((g) => g.dataset.wsId === gA.dataset.wsId);
  R.keepExpanded = !!gA2 && !gA2.querySelector(":scope > .tree-children").classList.contains("hidden");

  // ⑥ 清理还原：切自由会话 → 移除补充项 → 再触发重建 → 组数回到初始
  const home = cfg.homeDir;
  document.querySelector("#free-sessions .ws-add")?.click();
  R.toHome = home ? await waitCwd(home, 8000) : true;
  for (const id of R.addedIds) await window.pi.wsRemove(id);
  if (R.subAddedId) await window.pi.wsRemove(R.subAddedId); // 子目录登记的工作区一并清理
  // 清理后的重建只走自由区 +（真实 UI 路径）：不能用 forceRebuild——其右键兑底会把刚删的工作区重新登记回来
  document.querySelector("#free-sessions .ws-add")?.click();
  await sleep(1500);
  await sleep(800);
  R.rmRefresh = groups().length === cfg0.workspaces.length
    && R.addedIds.every((id) => !groups().some((g) => g.dataset.wsId === String(id)));

  return JSON.stringify(R);
})()
`;

async function main() {
  const target = await findTarget();
  console.log("target:", target.title);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  let n = 0;
  const call = (expression, awaitPromise) => new Promise((resolve, reject) => {
    const id = ++n;
    const onMsg = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; } // 非 JSON 帧忽略
      if (msg.id === id) {
        ws.removeEventListener("message", onMsg);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result?.result?.value);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise } }));
  });
  for (let i = 0; i < 30; i++) { if (await call("window.pi ? 'ready' : 'no'", false) === "ready") break; await sleep(1000); }
  await sleep(2500);
  const expression = CHECK
    .replaceAll("__REPO_ROOT_LOWER__", REPO_ROOT.toLowerCase().replaceAll("\\", "\\\\"))
    .replaceAll("__REPO_ROOT__", REPO_ROOT.replaceAll("\\", "\\\\"));
  const raw = await call(expression, true);
  if (raw === undefined) { console.log("❌ evaluate 返回 undefined（页面脚本异常）"); process.exit(1); }
  console.log("RESULT:", raw);
  let r;
  try { r = JSON.parse(raw); } catch { console.log("❌ RESULT 非 JSON:", raw); process.exit(1); }
  const pass = !r.fail
    && r.paneTitle === "项目"
    && r.groupsVsWs
    && r.rebuildCount
    && r.activeCount === 1 && r.activeIsA
    && r.activeColorOk
    && r.autoExpand
    && r.chevExpand
    && r.switchOk && r.noticeHidden && r.activeIsB && r.leftSync
    && (!r.bHadSessions ? r.noAutoNew && r.noSessNotice && r.rootMenuNew && r.rootMenuRm : true)
    && (r.subRootThere === false || r.subNewOk === "n/a-no-subdir" ? true : r.subNewOk === true && r.subMenuNew && r.subRegistered)
    && r.keepExpanded
    && r.toHome
    && r.rmRefresh;
  console.log(pass ? "✅ 全绿：标题/组数/高亮/自动展开/箭头展开/切换/无通知条/展开保留/移除刷新" : "❌ 见 RESULT");
  ws.close();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("验证失败:", e.message); process.exit(1); });
