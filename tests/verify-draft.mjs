/**
 * 会话草稿隔离验证（2026-10-05）：输入框文字 + 附件（图）按会话（任务）独立，切换互不串
 * 用法：先 PI_GUI_CDP_PORT=9223 启动测试实例（独立 userData，不碰正式实例），再 node verify-draft.mjs 9223
 * 纯 DOM 驱动：只用侧栏磁盘历史会话做 A/B 双向切换（只读打开），**绝不派发 Enter/点发送**（防真发消息烧 token）
 * 附件用合成 paste 事件贴 1×1 PNG（ClipboardEvent+DataTransfer+File）
 */
const PORT = process.argv[2] || "9223";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DRAFT_A = "验证甲-1663";
const DRAFT_B = "验证乙-2917";

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

// 页面端检查：本文件是 mjs，无转义链问题
const CHECK = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const inputEl = document.getElementById("input");
  const setVal = (v) => { inputEl.value = v; inputEl.dispatchEvent(new Event("input", { bubbles: true })); };
  const currentName = () => document.querySelector(".session-item.current .session-name")?.textContent ?? null;
  const itemsNamed = (name) => [...document.querySelectorAll(".session-item")].filter(
    (i) => (i.querySelector(".session-name")?.textContent ?? "") === name
  );

  // 收集测试会话：按名字去重取两个不同会话（同名条目可能同会话双列——侧栏 WIP 现象，点哪个都指向同一磁盘会话）
  const items = [...document.querySelectorAll(".session-item")];
  const names = [];
  for (const it of items) {
    const nm = it.querySelector(".session-name")?.textContent ?? "";
    if (nm && !names.includes(nm)) names.push(nm);
  }
  if (names.length < 2) return JSON.stringify({ error: "distinct session names < 2", total: items.length });
  const [A, B] = names.slice(0, 2).map((nm) => ({ name: nm }));

  const waitCurrent = async (name, ms = 10000) => {
    for (let t = 0; t < ms; t += 200) {
      if (currentName() === name) return true;
      await sleep(200);
    }
    return false;
  };
  // 每次点击都重新定位元素（startSession 后侧栏重渲染，旧引用已失效）
  const clickSession = async (s) => {
    const el = itemsNamed(s.name)[0];
    if (!el) return false;
    el.click(); // 只触发 item 自身 click（归档/×是子元素且 stopPropagation，不会被点中）
    return waitCurrent(s.name);
  };

  const snap = async (tag, log) => {
    const st = await window.pi.getState();
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem("pi-gui:drafts") ?? "{}"); } catch {}
    log.push({ tag, sid: st?.sessionId, input: inputEl.value, stored: Object.keys(stored).length });
    return stored;
  };
  const log = [];
  window.__draftTrace = []; // 调试钩子（app.js 里 saveDraft/restoreDraft 会推记录）
  // 合成粘贴一张 1×1 PNG（paste 处理器读 clipboardData.items → FileReader → addAttachment）
  const pastePng = async () => {
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "t.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    inputEl.dispatchEvent(ev);
    for (let i = 0; i < 20; i++) { // FileReader 异步，轮询缩略图出现
      await sleep(150);
      if (document.querySelectorAll(".att-item").length) return true;
    }
    return false;
  };
  const attCount = () => document.querySelectorAll(".att-item").length;

  // ① 打开 A：输入草稿甲 + 贴一张图
  if (!(await clickSession(A))) return JSON.stringify({ error: "open A failed", A: A.name });
  await sleep(500);
  setVal("${DRAFT_A}");
  const pasteA = await pastePng();
  await snap("A-typed", log);
  // ② 切到 B：输入框不得残留甲，附件不得残留 A 的图
  if (!(await clickSession(B))) return JSON.stringify({ error: "open B failed", A: A.name, B: B.name });
  await sleep(500);
  const valB1 = inputEl.value;
  const attB1 = attCount();
  await snap("B-opened", log);
  setVal("${DRAFT_B}");
  const pasteB = await pastePng();
  await snap("B-typed", log);
  // ③ 切回 A：应还原甲 + 自己的图
  if (!(await clickSession(A))) return JSON.stringify({ error: "back A failed" });
  await sleep(500);
  const valA2 = inputEl.value;
  const attA2 = attCount();
  await snap("back-A", log);
  // ④ 再切回 B：应还原乙 + 自己的图
  if (!(await clickSession(B))) return JSON.stringify({ error: "back B failed" });
  await sleep(500);
  const valB2 = inputEl.value;
  const attB2 = attCount();
  await sleep(800); // 防抖落库（500ms）后读持久化真值
  const stored = await snap("back-B", log);

  const recs = Object.values(stored).map((v) => (typeof v === "string" ? { t: v, a: [] } : v));
  return JSON.stringify({
    A: A.name, B: B.name, log,
    trace: window.__draftTrace,
    pasteA, pasteB, attB1, attA2, attB2,
    sidB_first: log.find((l) => l.tag === "B-opened")?.sid,
    sidB_again: log.find((l) => l.tag === "back-B")?.sid,
    sameSidB: log.find((l) => l.tag === "B-opened")?.sid === log.find((l) => l.tag === "back-B")?.sid,
    noLeakAB: valB1 !== "${DRAFT_A}" && attB1 === 0,
    valB1, valA2, valB2,
    restoreA: valA2 === "${DRAFT_A}" && attA2 === 1,
    restoreB: valB2 === "${DRAFT_B}" && attB2 === 1,
    persisted: recs.some((v) => v.t === "${DRAFT_A}" && (v.a?.length ?? 0) >= 1)
      && recs.some((v) => v.t === "${DRAFT_B}" && (v.a?.length ?? 0) >= 1),
    draftEntries: Object.keys(stored).length,
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
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; } // 非 JSON 帧忽略
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

  // 等 UI 初始化 + 侧栏渲染出会话列表
  let ready = false;
  for (let i = 0; i < 45; i++) {
    const st = await call(`(() => {
      if (!window.pi?.getState) return "no-api";
      return document.querySelectorAll(".session-item").length >= 2 ? "ready" : "waiting";
    })()`, false);
    if (st === "ready") { ready = true; break; }
    await sleep(1000);
  }
  if (!ready) throw new Error("UI 未就绪（window.pi 或侧栏会话列表未渲染）");
  await sleep(1000);

  const raw = await call(CHECK, true);
  console.log("RESULT:", raw);
  let r;
  try { r = JSON.parse(raw); } catch { throw new Error("页面端返回非 JSON: " + raw); }
  if (r.error) throw new Error("页面端报错: " + r.error + " " + JSON.stringify(r));
  const pass = r.pasteA && r.pasteB && r.noLeakAB && r.restoreA && r.restoreB && r.persisted;
  console.log(pass
    ? "✅ 草稿隔离验证通过：文字+附件 A/B 切换互不串、切回各自还原、localStorage 已持久化（含附件）"
    : "❌ 验证未通过，见 RESULT");
  ws.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("验证失败:", e.message); process.exit(1); });
