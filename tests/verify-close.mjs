/**
 * UI 级关闭验证（2026-10-03）：关闭内存会话 entry（与归档语义分离）
 * 场景：①关闭后台运行中会话（closed/当前不受影响）②文件保留可重开 ③关闭当前会话自动切换 ④ws:sessions 新字段
 * 用法：先 PI_GUI_CDP_PORT=9223 启动测试实例，再 node verify-close.mjs 9223
 */
const PORT = process.argv[2] || "9223";
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
  const init = await window.pi.getState();
  const s2 = await window.pi.createSession(init.cwd, null);
  R.distinct = s2.sessionId !== init.sessionId;
  window.pi.prompt("只回复两个字母：ok");
  let runningSeen = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if ((await window.pi.getState()).running) { runningSeen = true; break; }
  }
  R.runningSeen = runningSeen;
  const path2 = (await window.pi.getState()).sessionPath;
  R.path2 = path2 ? "saved" : null;
  // 切走（s2 后台运行）
  const s3 = await window.pi.createSession(init.cwd, null);
  // ①关闭后台运行中的 s2
  const c1 = await window.pi.closeSession(path2);
  R.close1 = { closed: c1.closed, wasCurrent: c1.wasCurrent };
  await new Promise((r) => setTimeout(r, 800));
  const st = await window.pi.getState();
  R.currentIsS3 = st?.sessionId === s3.sessionId;
  // ②文件保留：重新打开
  const reopened = await window.pi.createSession(init.cwd, path2);
  R.reopenMsgs = (reopened.messages ?? []).length;
  // ③关闭当前（重开的 s2'），应切到剩余 s3
  const c2 = await window.pi.closeSession(path2);
  R.close2 = { closed: c2.closed, wasCurrent: c2.wasCurrent, nextStateId: c2.state?.sessionId ?? null, expectS3: s3.sessionId };
  // ④ws:sessions 字段
  const ws = await window.pi.wsSessions(init.cwd);
  R.wsFields = ws.sessions?.length ? { hasInMemory: "inMemory" in ws.sessions[0], hasRunning: "running" in ws.sessions[0] } : null;
  // 关不存在的
  const c3 = await window.pi.closeSession("Z:\\nonexistent.jsonl");
  R.closeMiss = { closed: c3.closed };
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
      if (msg.id === id) {
        ws.removeEventListener("message", onMsg);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result?.result?.value);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise } }));
  });
  for (let i = 0; i < 30; i++) {
    if (await call("window.pi ? 'ready' : 'no'", false) === "ready") break;
    await sleep(1000);
  }
  await sleep(2000);
  const raw = await call(CHECK, true);
  console.log("RESULT:", raw);
  const r = JSON.parse(raw);
  const pass = r.distinct && r.runningSeen && r.path2 === "saved"
    && r.close1.closed && r.close1.wasCurrent === false && r.currentIsS3
    && r.reopenMsgs >= 2
    && r.close2.closed && r.close2.wasCurrent && r.close2.nextStateId === r.close2.expectS3
    && r.wsFields?.hasInMemory && r.wsFields?.hasRunning
    && r.closeMiss.closed === false;
  console.log(pass ? "✅ UI 级关闭验证通过：后台关/重开/切当前/字段全绿" : "❌ 验证未通过，见 RESULT");
  ws.close();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("验证失败:", e.message); process.exit(1); });
