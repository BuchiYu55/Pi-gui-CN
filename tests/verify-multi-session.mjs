/**
 * 多会话并行验证（2026-10-03）：任务运行中新建会话，旧任务不中断、互不影响
 * 用法：先 PI_GUI_CDP_PORT=9223 启动测试实例，再 node verify-multi-session.mjs 9223
 * 探针：页面端 onEvent 收集带 sessionId 的事件流；真实小模型回合（GLM，一条极短 prompt）
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

// 页面端异步检查（独立文件读不进来的部分直接内联，注意本文件是 mjs 无转义链问题）
const CHECK = String.raw`
(async () => {
  const events = [];
  window.__multiProbe = (e) => events.push({ t: e.type, sid: e.sessionId });
  const off = window.pi.onEvent(window.__multiProbe);

  const init = await window.pi.getState();
  if (!init) return JSON.stringify({ error: "no initial session" });

  // 1) 新建会话：sessionId 必须不同（不再 abort 旧会话）
  const s2 = await window.pi.createSession(init.cwd, null);
  const distinct = s2.sessionId !== init.sessionId;

  // 2) 在新会话发极短真实回合
  window.pi.prompt("只回复两个字母：ok");
  let runningSeen = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if ((await window.pi.getState()).running) { runningSeen = true; break; }
  }
  const stBefore = await window.pi.getState(); // 仍是 s2：记录落盘路径
  const path2 = stBefore.sessionPath;

  // 3) 运行中切走（新建第三个会话），观察 s2 事件流是否继续
  const s3 = await window.pi.createSession(init.cwd, null);
  const switchedAt = events.length;
  let settled = false;
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (events.some((e) => e.sid === s2.sessionId && (e.t === "agent_settled" || e.t === "host_error"))) { settled = true; break; }
  }
  const eventsOfS2AfterSwitch = events.slice(switchedAt).filter((e) => e.sid === s2.sessionId).map((e) => e.t);

  // 4) 切回 s2：消息应完整（含 assistant 回复）
  const back = await window.pi.createSession(init.cwd, path2 ?? null);
  const msgs = back.messages ?? [];
  const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
  const lastText = lastAssistant ? JSON.stringify(lastAssistant.content) : "";

  off();
  return JSON.stringify({
    distinct, runningSeen, settled,
    path2: path2 ? "saved" : null,
    backSameAsS2: back.sessionId === s2.sessionId,
    msgCount: msgs.length,
    assistantReplied: /ok/i.test(lastText),
    eventsOfS2AfterSwitch: eventsOfS2AfterSwitch.slice(0, 8),
    eventsOfS2AfterSwitchCount: eventsOfS2AfterSwitch.length,
  });
})()
`;

async function main() {
  const target = await findTarget();
  console.log("target:", target.title, target.url);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });

  let n = 0;
  const call = (expression, awaitPromise) =>
    new Promise((resolve, reject) => {
      const id = ++n;
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === id) {
          ws.removeEventListener("message", onMsg);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result?.result?.value);
        }
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise },
      }));
    });

  // 等 UI 初始化（init 建好会话）
  let initOk = false;
  for (let i = 0; i < 30; i++) {
    const st = await call("window.pi ? (window.pi.getState ? 'ready' : 'no-api') : 'no-pi'", false);
    if (st === "ready") { initOk = true; break; }
    await sleep(1000);
  }
  if (!initOk) throw new Error("window.pi 未就绪");
  await sleep(2000); // 给 init 的 createSession 留时间

  const raw = await call(CHECK, true);
  console.log("RESULT:", raw);
  const r = JSON.parse(raw);
  const pass = r.distinct && r.runningSeen && r.settled && r.backSameAsS2 && r.assistantReplied && r.eventsOfS2AfterSwitchCount > 0;
  console.log(pass ? "✅ 多会话并行验证通过：任务运行中切走，旧任务继续跑完且消息完整" : "❌ 验证未通过，见 RESULT");
  ws.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("验证失败:", e.message); process.exit(1); });
