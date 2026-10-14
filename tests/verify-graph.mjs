/**
 * wiki 图谱交互重设计验证（2026-10-08 计划书阶段一）：
 * ① fit：加载后全部节点在可视区；② 滚轮缩放（光标中心）+ 缩放指示 + 下限钳 0.3；
 * ③ 空白拖拽平移（tx/ty 精确随位移）；④ 节点拖拽（world 坐标随动，不误开查看器）；
 * ⑤ 节点单击（≤4px）开查看器 tab；⑥ fit 按钮复位全可见。
 * 用法：PI_GUI_CDP_PORT=9223 起无头实例后 node tests/verify-graph.mjs 9223
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

  // 会话就绪 + 登记工作区（真实数据出图）
  for (let i = 0; i < 30; i++) {
    const st = await call(`window.pi && window.pi.getState().then((s) => !!s && !!s.cwd).catch(() => false)`, true).catch(() => false);
    if (st === true) break;
    await sleep(1000);
  }
  await call(`window.pi.wsAdd("E:\\\\pi-gui").then(() => "ok").catch(() => "skip")`, true);
  // 模式守卫：同实例连跑时图谱可能已开（状态污染坑）——先归零再开，保证走「点击开图」路径
  const wasOn = await call(`document.getElementById('btn-tree-graph').classList.contains('graph-on')`);
  if (wasOn === true) {
    await call(`document.getElementById('btn-tree-graph').click(); true`);
    await sleep(400);
  }
  // 诊断陷阱：记录 __wikiGraph 每次写入的 scale + 此刻 wrap 尺寸（判定重置是否伴随真实 resize）
  await call(`(() => {
    window.__hookLog = [];
    let _h = window.__wikiGraph ?? null;
    Object.defineProperty(window, '__wikiGraph', { configurable: true, get: () => _h, set: (v) => { _h = v; const wr = document.getElementById('wiki-graph-wrap').getBoundingClientRect(); window.__hookLog.push([Date.now()%1000000, v && v.view ? v.view.scale.toFixed(3) : String(v), Math.round(wr.width) + 'x' + Math.round(wr.height)]); } });
    return 1;
  })()`);
  await call(`document.getElementById('btn-tree-graph').click(); true`);
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await sleep(800);
    const v = await call(`window.__wikiGraph ? JSON.stringify({ count: window.__wikiGraph.count, view: window.__wikiGraph.view, canvas: window.__wikiGraph.canvas }) : null`).catch(() => null);
    if (v) { ready = JSON.parse(v).count > 0; if (ready) break; }
  }
  check("①图谱出图", ready);
  if (!ready) throw new Error("图谱未出图，后续断言无意义");

  const gjson = () => call(`JSON.stringify(window.__wikiGraph)`).then((s) => JSON.parse(s));

  // ① fit：全部节点在可视区内
  let g = await gjson();
  const inView = g.nodes.every((n) => n.sx >= -1 && n.sx <= g.canvas.w + 1 && n.sy >= -1 && n.sy <= g.canvas.h + 1);
  check("①加载后自动 fit 全部可见", inView, `scale=${g.view.scale.toFixed(2)}`);

  // ② 滚轮缩放（光标中心）+ 指示更新 + 下限钳 0.3
  const rect = await call(`(() => { const r = document.getElementById('wiki-graph').getBoundingClientRect(); return JSON.stringify({ l: r.left, t: r.top }); })()`).then((s) => JSON.parse(s));
  const cx = rect.l + g.canvas.w / 2, cy = rect.t + g.canvas.h / 2;
  const wheel = (dy, x, y) => call(`(() => {
    document.getElementById('wiki-graph').dispatchEvent(new WheelEvent('wheel', { deltaY: ${dy}, clientX: ${x}, clientY: ${y}, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await wheel(-240, cx, cy);
  await sleep(200);
  const g2 = await gjson();
  const hookLog2 = await call(`JSON.stringify(window.__hookLog ?? [])`).catch(() => "[]");
  check("②滚轮放大", g2.view.scale > g.view.scale * 1.3, `${g.view.scale.toFixed(2)} → ${g2.view.scale.toFixed(2)}；hook写入=${hookLog2}`);
  const zoomText = await call(`document.getElementById('graph-zoom').textContent`);
  check("②缩放指示更新", zoomText === Math.round(g2.view.scale * 100) + "%", zoomText);
  for (let i = 0; i < 12; i++) { await wheel(240, cx, cy); await sleep(60); }
  const g3 = await gjson();
  check("②缩放下限钳 0.3", g3.view.scale >= 0.3 - 1e-6, String(g3.view.scale.toFixed(3)));

  // ③ 空白拖拽平移：取离所有节点最远的画布角落按下
  const blank = await call(`(() => {
    const g = window.__wikiGraph;
    const cands = [[8, g.canvas.h - 8], [g.canvas.w - 8, 8], [8, 8]];
    let best = cands[0], bd = -1;
    for (const c of cands) {
      let d = Infinity;
      for (const n of g.nodes) d = Math.min(d, (n.sx - c[0]) ** 2 + (n.sy - c[1]) ** 2);
      if (d > bd) { bd = d; best = c; }
    }
    return JSON.stringify({ x: best[0], y: best[1] });
  })()`).then((s) => JSON.parse(s));
  const bx = rect.l + blank.x, by = rect.t + blank.y;
  const drag = async (dx, dy) => call(`(() => {
    const c = document.getElementById('wiki-graph');
    c.dispatchEvent(new MouseEvent('mousedown', { clientX: ${bx}, clientY: ${by}, button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: ${bx + dx}, clientY: ${by + dy}, button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: ${bx + dx}, clientY: ${by + dy}, button: 0, bubbles: true }));
    return true;
  })()`);
  const before3 = (await gjson()).view;
  await drag(40, 30);
  await sleep(200);
  const after3 = (await gjson()).view;
  check("③空白拖拽平移精确", Math.abs(after3.tx - before3.tx - 40) < 2 && Math.abs(after3.ty - before3.ty - 30) < 2,
    `tx ${before3.tx.toFixed(1)}→${after3.tx.toFixed(1)}`);

  // ④ 节点拖拽：world 坐标随动 ~delta/scale，且不开查看器
  g = await gjson();
  const mid = g.nodes.reduce((a, b) => (Math.abs(b.sx - g.canvas.w / 2) + Math.abs(b.sy - g.canvas.h / 2) < Math.abs(a.sx - g.canvas.w / 2) + Math.abs(a.sy - g.canvas.h / 2) ? b : a));
  const nx = rect.l + mid.sx, ny = rect.t + mid.sy;
  await call(`(() => {
    const c = document.getElementById('wiki-graph');
    c.dispatchEvent(new MouseEvent('mousedown', { clientX: ${nx}, clientY: ${ny}, button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: ${nx + 40}, clientY: ${ny + 30}, button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: ${nx + 40}, clientY: ${ny + 30}, button: 0, bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  const g4 = await gjson();
  const nd4 = g4.nodes.find((n) => n.path === mid.path);
  const expdx = 40 / g4.view.scale, expdy = 30 / g4.view.scale;
  const movedOk = nd4 && Math.abs(nd4.wx - mid.wx - expdx) < 4 / g4.view.scale + 1 && Math.abs(nd4.wy - mid.wy - expdy) < 4 / g4.view.scale + 1;
  check("④节点拖拽 world 随动", !!movedOk, `Δwx=${nd4 ? (nd4.wx - mid.wx).toFixed(1) : "?"} 期望≈${expdx.toFixed(1)}`);
  await sleep(500);
  const tabs4 = Number(await call(`document.querySelectorAll('.vw-tab').length`)) || 0;
  check("④拖拽不误开查看器", tabs4 === 0, `tabs=${tabs4}`);

  // ⑤ 节点单击（≤4px）开查看器
  g = await gjson();
  const clickTarget = g.nodes[0];
  const kx = rect.l + clickTarget.sx, ky = rect.t + clickTarget.sy;
  await call(`(() => {
    const c = document.getElementById('wiki-graph');
    c.dispatchEvent(new MouseEvent('mousedown', { clientX: ${kx}, clientY: ${ky}, button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: ${kx + 2}, clientY: ${ky + 1}, button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: ${kx + 2}, clientY: ${ky + 1}, button: 0, bubbles: true }));
    return true;
  })()`);
  let tabName = "";
  for (let i = 0; i < 8; i++) {
    await sleep(600);
    tabName = String(await call(`(() => { const ts = [...document.querySelectorAll('.vw-tab')]; return ts.length ? ts[ts.length - 1].textContent : ""; })()`));
    if (tabName) break;
  }
  check("⑤节点单击开查看器", tabName.length > 0, tabName.slice(0, 30));

  // ⑥ fit 按钮复位全可见
  await call(`document.getElementById('btn-graph-fit').click(); true`);
  await sleep(200);
  const g6 = await gjson();
  const inView6 = g6.nodes.every((n) => n.sx >= -1 && n.sx <= g6.canvas.w + 1 && n.sy >= -1 && n.sy <= g6.canvas.h + 1);
  check("⑥fit 复位全部可见", inView6, `scale=${g6.view.scale.toFixed(2)}`);
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
