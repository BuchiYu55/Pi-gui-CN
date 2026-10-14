/* 新会话侧栏即时出现验证（2026-10-10 owner 报障修复）：
 * 症状：点「新会话」后发消息，新会话要点其他会话才出现在左侧栏。
 * 修复：handleEvent 的 agent_start/agent_settled（当前会话分支）补 renderSidebarTree()。
 * 流程：注册测试 cwd 为工作区 → 记该组会话名单 → 点组头「+」新建 → 等欢迎页 → 发极短真实消息 →
 *       不点任何其他会话，轮询该组名单断言新条目出现。
 * 注意：自由区不能用作断言位——PI_GUI_TEST_CWD 只改写建会话落点，自由区列表仍读真实主目录（实测踩坑）。 */
const PORT = process.argv[2] || "9223";
const TEST_CWD = process.env.PI_GUI_TEST_CWD || (process.env.TEMP ? process.env.TEMP + "\\pi-gui-test-cwd" : "/tmp/pi-gui-test-cwd");
const WS_NAME = "pi-gui-test-cwd";
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const TEST_CWD = ${JSON.stringify(TEST_CWD)};
  const WS_NAME = ${JSON.stringify(WS_NAME)};

  // 0) 注册测试工作区（幂等：已登记则跳过），等侧栏组出现
  let cfg = await window.pi.wsList();
  if (!(cfg.workspaces ?? []).some((w) => w.cwd === TEST_CWD)) {
    await window.pi.wsAdd(TEST_CWD);
    await wait(800);
  }
  const groupOf = () => [...document.querySelectorAll("#ws-groups .ws-group")].find((g) => {
    const n = g.querySelector(".ws-name"); return n && n.textContent.trim() === WS_NAME;
  });
  let group = null;
  for (let i = 0; i < 20 && !group; i++) { await wait(300); group = groupOf(); }
  if (!group) return JSON.stringify({ fail: "测试工作区组未出现在侧栏" });

  const namesOf = (g) => [...g.querySelectorAll(".ws-sessions .session-name")].map((n) => n.textContent.trim());
  const currentNameIn = (g) => g?.querySelector(".ws-sessions .session-item.current .session-name")?.textContent.trim() ?? null;
  const before = namesOf(group);
  const currentBefore = currentNameIn(group); // 重跑免疫：旧 current 属于先前轮次，与本轮 token 不同名
  const TOKEN = "ns" + Date.now().toString(36);

  // 1) 点组头「+」新建会话（工作区 cwd，不落 home）
  const add = group.querySelector(".ws-add");
  if (!add) return JSON.stringify({ fail: "组头无 + 按钮" });
  add.click();

  // 2) 等视图重建完成（welcome 出现）再碰输入区（startSession 清 input 时序坑）
  let welcome = false;
  for (let i = 0; i < 30; i++) { await wait(200); const w = document.getElementById("welcome"); if (w && !w.classList.contains("hidden")) { welcome = true; break; } }
  if (!welcome) return JSON.stringify({ fail: "welcome 未出现" });

  // 3) 发极短真实消息（带唯一 token：会话名=首条消息前 60 字，token 必入名，断言可对拍且重跑免疫）
  const input = document.getElementById("input");
  input.value = "只回复两个字母：ok（" + TOKEN + "）";
  document.getElementById("btn-send").click();

  // 4) 不点任何其他会话，轮询该组等带 token 的 current 条目出现（agent_start 即刷；列表封顶 30 条，计数断言在存量满额时失效，改判 token 入列）
  const t0 = Date.now();
  let appearedNow = false;
  for (let i = 0; i < 60; i++) {
    await wait(500);
    const g = groupOf();
    const n = currentNameIn(g);
    if (n && n.includes(TOKEN)) { appearedNow = true; break; }
  }
  const gAfter = groupOf();
  const st = await window.pi.getState();
  return JSON.stringify({
    token: TOKEN,
    beforeCount: before.length,
    afterCount: gAfter ? namesOf(gAfter).length : null,
    currentBefore,
    appeared: appearedNow,
    ms: Date.now() - t0,
    sessionPath: st?.sessionPath ?? null,
    cwd: st?.cwd ?? null,
    running: st?.running ?? null,
  });
})()
`;

const CLEANUP = String.raw`
(async () => {
  const TEST_CWD = ${JSON.stringify(TEST_CWD)};
  try { await window.pi.wsRemove(TEST_CWD); } catch { /* 已不在 */ }
  return true;
})()
`;

let ended = false;
let ws = null;
try {
  const page = await findTarget();
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  ws = sock;
  await new Promise((r, j) => { sock.addEventListener("open", r); sock.addEventListener("error", j); });
  let seq = 0;
  const pending = new Map();
  sock.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const { res } = pending.get(m.id); pending.delete(m.id); res(m); }
  });
  function send(method, params) {
    const id = ++seq;
    return new Promise((res) => { pending.set(id, { res }); sock.send(JSON.stringify({ id, method, params })); });
  }
  async function call(expression) {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error("页面表达式异常: " + JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
    return r.result?.result?.value;
  }

  const r = JSON.parse(await call(CHECK));
  console.log(JSON.stringify(r, null, 1));
  if (r.fail) throw new Error(r.fail);
  if (r.cwd && r.cwd !== TEST_CWD) console.log("（提示：会话 cwd=" + r.cwd + "）");
  if (!r.appeared) throw new Error("发送后侧栏未出现新会话（轮询 30s，token=" + r.token + "）");
  if (r.running === true) {
    // 等回合收尾再走，防后台残留
    for (let i = 0; i < 60; i++) { await sleep(500); if ((await call("window.pi.getState().running")) === false) break; }
  }
  await call(CLEANUP); // 摘除测试工作区登记（userData 内，不碰 owner 实例）
  console.log("== verify-newsession-sidebar：通过（发送后侧栏即时出现，未点其他会话） ==");
  ended = true;
} catch (err) {
  console.error("❌", err?.message ?? err);
  process.exitCode = 2;
} finally {
  try { ws?.close(); } catch {}
  process.exit(ended ? 0 : 2);
}
