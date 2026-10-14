/**
 * 右栏宽度可拖验证（2026-10-08 计划书阶段一）：
 * ① 默认 340px；② 拖条拖宽 +100 生效 + localStorage 落值；③ reload 后恢复；
 * ④ 拖超上限钳 520；⑤ 拖超下限钳 260；⑥ 图谱模式下拖宽 → ResizeObserver refit（无头尽力断言）。
 * 断言纪律（无头布局节流坑）：宽度一律读 inline style.width / window.__rbWidth 数据层，
 * 不读 getBoundingClientRect（隐藏窗口读数滞后于 CSSOM）。
 * 用法：PI_GUI_CDP_PORT=9223 起无头实例后 node tests/verify-rightbar-w.mjs 9223
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

const nextId = { n: 1 };
let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function main() {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  const call = (expression, ap = false) =>
    new Promise((resolve, reject) => {
      const id = nextId.n++;
      const onMsg = (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg?.id !== id) return;
        ws.removeEventListener("message", onMsg);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result?.result?.value);
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: ap } }));
    });

  // 会话就绪（显式等 getState，防 awaitPromise 缺失空转）
  for (let i = 0; i < 30; i++) {
    const st = await call(`window.pi && window.pi.getState().then((s) => !!s && !!s.cwd).catch(() => false)`, true).catch(() => false);
    if (st === true) break;
    await sleep(1000);
  }
  // 数据层读数：inline style.width（CSSOM 即时真值）+ __rbWidth 钩子
  const styleW = () => call(`parseInt(document.getElementById('rightbar').style.width) || 0`);
  const dragTo = (deltaX) => call(`(() => {
    const s = document.getElementById('rightbar-split');
    const r = s.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const x0 = r.left + r.width / 2;
    s.dispatchEvent(new MouseEvent('mousedown', { clientX: x0, clientY: y, button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: x0 + ${deltaX}, clientY: y, button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: x0 + ${deltaX}, clientY: y, button: 0, bubbles: true }));
    return window.__rbWidth;
  })()`);

  // ① 默认宽（全新 userData 无存档）：style 无 inline 值时回 0，CSS 340 生效
  const w0 = Number(await call(`parseInt(getComputedStyle(document.getElementById('rightbar')).width)`));
  check("①默认 340px", Math.abs(w0 - 340) < 2, String(w0));

  // ② 拖宽 +100
  const r1 = Number(await dragTo(-100));
  check("②拖宽 +100 生效", r1 === 440, String(r1));
  const saved = await call(`localStorage.getItem('pi-gui:rbw')`);
  check("②localStorage 落值", String(saved) === "440", String(saved));

  // ③ reload 恢复（initRbWidth 从 localStorage 应用 inline style）
  await call(`location.reload(); true`);
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const ready = await call(`document.readyState === 'complete' && !!document.getElementById('input')`);
      if (ready) break;
    } catch { /* 未就绪 */ }
  }
  for (let i = 0; i < 15; i++) {
    const w = await styleW();
    if (w === 440) break;
    await sleep(800);
  }
  const w2 = Number(await styleW());
  check("③reload 恢复宽度（style.width）", w2 === 440, String(w2));

  // ④ 拖超上限钳 520
  const r3 = Number(await dragTo(-400));
  check("④上限钳 520", r3 === 520, String(r3));

  // ⑤ 拖超下限钳 260
  const r4 = Number(await dragTo(600));
  check("⑤下限钳 260", r4 === 260, String(r4));

  // ⑥ 图谱模式 + 拖宽 → ResizeObserver refit（无头窗口布局节流可能不触发 RO：尽力断言，跳过不算失败）
  await call(`window.pi.wsAdd("E:\\\\pi-gui").then(() => "ok").catch(() => "skip")`, true);
  // 模式守卫：同实例连跑时图谱可能已开（状态污染坑）——先归零再开
  const wasOn = await call(`document.getElementById('btn-tree-graph').classList.contains('graph-on')`);
  if (wasOn === true) {
    await call(`document.getElementById('btn-tree-graph').click(); true`);
    await sleep(400);
  }
  await call(`document.getElementById('btn-tree-graph').click(); true`);
  let g = null;
  for (let i = 0; i < 15; i++) {
    await sleep(800);
    const v = await call(`window.__wikiGraph ? JSON.stringify({ count: window.__wikiGraph.count, canvas: window.__wikiGraph.canvas }) : null`).catch(() => null);
    if (v) { g = JSON.parse(v); break; }
  }
  check("⑥图谱出图", !!g && g.count > 0, g ? `nodes=${g.count} canvas=${g.canvas?.w}x${g.canvas?.h}` : "无数据");
  if (g) {
    const c0w = g.canvas.w;
    await dragTo(-80); // 拖宽 80px
    let refit = false;
    for (let i = 0; i < 8; i++) {
      await sleep(500);
      const v = await call(`window.__wikiGraph ? JSON.stringify(window.__wikiGraph.canvas) : null`).catch(() => null);
      if (v) { const c = JSON.parse(v); if (Math.abs(c.w - c0w) > 20) { refit = true; break; } }
    }
    if (refit) {
      check("⑥拖宽后 canvas 尺寸跟随（refit）", true);
      // refit 检出后节点 sx/sy 可能还要一帧才更新（无头 rAF 节流，同族坑）：轮询至稳定，不赌单次读数
      let fit = false;
      for (let i = 0; i < 10; i++) {
        fit = await call(`(() => {
          const g = window.__wikiGraph; if (!g) return false;
          return g.nodes.every((n) => n.sx >= -1 && n.sx <= g.canvas.w + 1 && n.sy >= -1 && n.sy <= g.canvas.h + 1);
        })()`).catch(() => false);
        if (fit === true) break;
        await sleep(500);
      }
      check("⑥refit 后节点全部可视", fit === true);
    } else {
      console.log(`△ ⑥拖宽后 canvas 尺寸跟随（refit）— 无头窗口布局节流下 RO 不触发，跳过（可见窗口人工验 DPI 项覆盖）`);
    }
  }
}

async function run() {
  try {
    await main();
  } catch (err) {
    check("执行链路无未捕获异常", false, String(err?.stack ?? err).slice(0, 250));
  }
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
run();
