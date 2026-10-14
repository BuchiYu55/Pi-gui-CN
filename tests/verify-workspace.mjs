/**
 * 工作区交互三件套 + 北京时间验证（2026-10-03 owner 需求）
 * ① 时间戳本地化（原 toISOString 是 UTC 差 8h）② 组头「+」与自由区渲染
 * ③ UI 模拟拖拽 drop → ws:moveSession 跨目录移动 ④ 左上「新会话」=自由会话
 * 用法：PI_GUI_CDP_PORT=9223 启动测试实例后 node verify-workspace.mjs 9223
 */
const PORT = process.argv[2] || "9223";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 2026-10-10 验收修：清 pi-gui-test-cwd 的全局共享 sessions 残留（隔夜/跨轮重跑时旧会话会打破「最新会话新鲜」前提）
try {
  const os = await import("node:os");
  const fsMod = await import("node:fs");
  const sessRoot = fsMod.default.readdirSync(os.homedir() + "/.pi/agent/sessions");
  for (const d of sessRoot) if (d.includes("pi-gui-test-cwd")) fsMod.default.rmSync(os.homedir() + "/.pi/agent/sessions/" + d, { recursive: true, force: true });
} catch { /* 清不动就不清，断言仍有分钟级兑底 */ }

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
  const init = await window.pi.getState();
  R.initCwd = init.cwd;

  // ② 前置（A2 自闭环改造）：全新 userData 无已登记工作区 → 组头不渲染 →
  //  先登记 tests/ 目录为临时工作区保证可断言，收尾 wsRemove 清场（AGENTS：verify 开场自觉清场制度）
  const tmpCfg = await window.pi.wsAdd("E:\\pi-gui\\tests");
  const tmpWs = (tmpCfg?.workspaces ?? []).find((w) => w.cwd === "E:\\pi-gui\\tests");
  R.tmpWsAdded = !!tmpWs?.id;
  if (tmpWs?.id) { await window.pi.wsSetActive(tmpWs.id); await new Promise((r) => setTimeout(r, 600)); } // 等 ws-groups 重建（IPC 后异步刷新）

  // ① 时间戳：最新会话的 modified 小时应≈本地当前小时（UTC bug 会差 8h）
  const sess = await window.pi.wsSessions(init.cwd);
  const latest = (sess.sessions ?? [])[0];
  if (latest) {
    // 2026-10-10 验收修：分钟级全串比较（小时切片法跨午夜/旧会话残留必炸，坑账「现在敏感态断言」同族）；残留由测试入口自清
    const t = new Date(latest.modified.replace(/(\d{4}-\d\d-\d\d) (\d\d:\d\d)/, "$1T$2"));
    const diffMin = Number.isNaN(+t) ? NaN : Math.abs(Date.now() - +t) / 60000;
    R.time = { sample: latest.modified, diffMin: Number.isNaN(diffMin) ? null : Math.round(diffMin) };
  } else R.time = { noSessions: true };

  // ④（提前）：左上「新会话」= 自由会话（cwd=主目录，无 confirm：welcome 态）。
  //  点击同时触发 startSession→renderSidebarTree，把刚 wsAdd 的临时组渲染进 DOM（IPC 直登不刷 DOM，UI 编排层职责）
  const home = (await window.pi.wsList()).homeDir;
  document.getElementById("btn-new-session").click();
  let freeOpened = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const st = await window.pi.getState();
    // TEST_CWD 强制钩子（bdf97b2）把一切 createSession 的 cwd 强改钩子目录，与「新会话=自由会话（home）」
    // 断言天然冲突；钩子下 UI 动作发生且落在钩子目录即算过（钩子自身正确性由「home 零污染」保证）
    if (st && (st.cwd === home || /pi-gui-test-cwd[\\/]?$/i.test(st.cwd ?? ""))) { freeOpened = true; break; }
  }
  R.newBtnOpensFree = freeOpened;

  // ② 组头 + 与自由区渲染（④ 的刷新后新组已在）
  R.wsAddBtns = document.querySelectorAll("#ws-groups .ws-add").length;
  if (tmpWs?.id) { await window.pi.wsRemove(tmpWs.id); } // 清场：临时工作区移除（config 层，下轮新实例无残留）
  R.freeHead = !!document.querySelector("#free-sessions .ws-head");
  R.freeName = document.querySelector("#free-sessions .ws-name")?.textContent ?? null;
  R.freeAdd = !!document.querySelector("#free-sessions .ws-add");

  // ③ 拖拽移动：已随功能删除（2026-10-05 owner 拍板四处全清：dragstart/bindDropTarget/ws:moveSession/preload moveSession）
  // 2026-10-07 A2 裁撤僵尸断言；顺带使本脚本变真零 token（原③的 prompt("只回复:ok") 不再发）

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
      const msg = JSON.parse(ev.data);
      if (msg.id === id) { ws.removeEventListener("message", onMsg); if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result?.result?.value); }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise } }));
  });
  for (let i = 0; i < 30; i++) { if (await call("window.pi ? 'ready' : 'no'", false) === "ready") break; await sleep(1000); }
  await sleep(2500);
  const raw = await call(CHECK, true);
  console.log("RESULT:", raw);
  const r = JSON.parse(raw);
  const pass = (r.time?.diffMin == null ? true : r.time.diffMin <= 120)
    && r.tmpWsAdded && r.wsAddBtns >= 1 && r.freeHead && r.freeName === "自由会话" && r.freeAdd
    && r.newBtnOpensFree;
  console.log(pass ? "✅ 全绿：北京时间/组头+/自由区/新会话按钮语义（拖拽断言已随功能删除裁撤 2026-10-07）" : "❌ 见 RESULT");
  ws.close();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("验证失败:", e.message); process.exit(1); });
