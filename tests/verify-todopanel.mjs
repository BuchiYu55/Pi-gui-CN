/**
 * 任务清单 pane 验证（2026-10-05）：rpiv-todo 快照 → 右栏自绘 pane（同日自悬浮面板迁入，替换决策树占位）
 * 用法：PI_GUI_CDP_PORT=9223 启动测试实例后，node verify-todopanel.mjs 9223
 * 流程：① 空会话 pane-empty 引导（pane 常驻右栏不隐藏）；② /rename 命名会话（免烧 token，便于侧栏找回）；
 *      ③ 真实 GLM 回合建 3 个 todo → 0/3、三行 ○；
 *      ④ 第二回合：#1 完成、#2 进行中 → 1/3、✓ 行 + ● 行；
 *      ⑤ 折叠/展开（aria-expanded + .collapsed + pane-body 隐藏）；
 *      ⑥ 新会话 → pane-empty 回归；⑦ 侧栏按名字点回 → 历史回放恢复 1/3；
 *      ⑧ reload → attach 路径同样恢复（快照从 toolResult.details 回放）。
 */
const PORT = process.argv[2] || "9223";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAME = "todo面板验证-" + (Date.now() % 100000); // 唯一后缀：重跑不与旧同名会话混淆（⑦ 按名点回）
const parseSafe = (s) => { try { return JSON.parse(s); } catch { return null; } };

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

async function main() {
  const target = await findTarget();
  console.log("target:", target.title);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });

  const call = (expression) =>
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
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });

  // evaluate 抛异常时返回 undefined 而非 reject（AGENTS.md 坑）——断言一律显式判值
  const assert = (cond, label) => { if (!cond) throw new Error("断言失败: " + label); };

  const waitFor = async (expression, test, timeoutMs, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      let v = null;
      try { v = await call(expression); } catch { /* 瞬时失败忽略 */ }
      let ok = false;
      try { ok = v != null && test(v); } catch { ok = false; }
      if (ok) return v;
      await sleep(1200);
    }
    throw new Error("超时等待: " + label);
  };

  const send = (text) => call(`
    (() => {
      const i = document.getElementById('input');
      i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()
  `);

  const EXPR_PANEL = `(() => {
    const p = document.getElementById('todo-panel');
    if (!p || document.querySelector('#todo-body .pane-empty')) return null;
    return JSON.stringify({
      count: document.getElementById('todo-count')?.textContent ?? '',
      rows: document.querySelectorAll('#todo-body .todo-row').length,
      done: document.querySelectorAll('#todo-body .todo-row.done').length,
      active: document.querySelectorAll('#todo-body .todo-row.active').length,
    });
  })()`;
  const panelIs = (count, rows, done, active) => (v) => {
    const o = parseSafe(v);
    return !!o && o.count === count && o.rows === rows && o.done === done && o.active === active;
  };
  const EXPR_IDLE = `(() => { const el = document.getElementById('status-state'); return (!el?.classList.contains('busy') && (el?.textContent ?? '').includes('空闲')) ? 'idle' : null; })()`;

  await sleep(2500); // 等 init
  // 重跑净化：折叠态复位 + reload 拿最新盘上代码 + 换新空会话
  //（reload 后 init 会 attach 主进程仍在的旧会话，可能带快照/折叠态，必须换新会话才能验空态）
  await call(`localStorage.setItem('pi-gui:todo-collapsed','0'); location.reload(); true`);
  await sleep(4500); // 等 init + attach
  await call(`document.getElementById('btn-new-session').click(); true`);
  await sleep(800);

  // ① 空会话：pane 常驻右栏 + pane-empty 引导 + 计数徽标隐藏
  const empty1 = parseSafe(await call(`JSON.stringify({
    inRightbar: !!document.querySelector('#rightbar #todo-panel'),
    guidance: !!document.querySelector('#todo-body .pane-empty'),
    countHidden: document.getElementById('todo-count')?.classList.contains('hidden'),
  })`));
  assert(empty1 && empty1.inRightbar && empty1.guidance && empty1.countHidden === true,
    "① 初始空会话 pane-empty: " + JSON.stringify(empty1));
  console.log("== ① 空会话 pane-empty 引导（右栏内常驻）✓");

  // ③ 真实 GLM 回合：创建 3 个 todo
  await send("请用 todo 工具创建三个任务：买牛奶、写周报、提交代码。创建完成后立即停止，不要执行任何其他操作，不要调用其他工具。");
  await waitFor(EXPR_PANEL, panelIs("0/3", 3, 0, 0), 120000, "面板出现 Todos 0/3（三次 create 完成）");
  console.log("== ③ 建任务后面板 0/3、三行 ○ ✓");

  // ② /rename 命名（渲染端拦截，不走模型；必须在首轮消息落盘后——未保存会话不在侧栏）
  await send("/rename " + NAME);
  await waitFor(`(() => {
    const items = [...document.querySelectorAll('.session-item .session-name')];
    return items.some((n) => (n.textContent ?? '').includes(${JSON.stringify(NAME)})) ? 'named' : null;
  })()`, (v) => v === "named", 15000, "侧栏出现改名");
  console.log("== ②（原③后）会话已命名 ✓");

  // ④ 第二回合：#1 完成、#2 进行中（等最终态：快照到达后 todoTurnActive 复位，三行全显）
  await send("请把任务1标记为 completed，任务2标记为 in_progress。只调 todo 工具，完成后立即停止。");
  await waitFor(EXPR_PANEL, panelIs("1/3", 3, 1, 1), 120000, "面板 1/3（✓ 一行 + ● 一行）");
  console.log("== ④ 状态更新 1/3、✓/● 各一行 ✓");
  await waitFor(EXPR_IDLE, (v) => v === "idle", 60000, "回合结束空闲");

  // ⑤ 折叠/展开
  await call(`document.getElementById('todo-head').click(); true`);
  await sleep(200);
  const collapsed = parseSafe(await call(`JSON.stringify({
    collapsed: document.getElementById('todo-panel').classList.contains('collapsed'),
    aria: document.getElementById('todo-head').getAttribute('aria-expanded'),
    bodyHidden: getComputedStyle(document.querySelector('#todo-panel > .pane-body')).display === 'none',
  })`));
  assert(collapsed && collapsed.collapsed && collapsed.aria === "false" && collapsed.bodyHidden,
    "⑤ 折叠态: " + JSON.stringify(collapsed));
  await call(`document.getElementById('todo-head').click(); true`);
  await sleep(200);
  const expanded = await call(`document.getElementById('todo-head').getAttribute('aria-expanded')`);
  assert(expanded === "true", "⑤ 展开恢复 aria-expanded=true, got " + JSON.stringify(expanded));
  console.log("== ⑤ 折叠/展开 ✓");

  // ⑥ 新会话：pane-empty 回归（新会话无快照，pane 常驻不隐藏）
  await call(`document.getElementById('btn-new-session').click(); true`);
  await waitFor(`(() => {
    const guidance = document.querySelector('#todo-body .pane-empty');
    const countHidden = document.getElementById('todo-count')?.classList.contains('hidden');
    return (guidance && countHidden) ? 'empty' : null;
  })()`, (v) => v === "empty", 10000, "新会话后 pane-empty");
  console.log("== ⑥ 新会话 pane-empty 回归 ✓");

  // ⑦ 侧栏按名字点回：历史回放（toolResult.details）恢复面板
  const clicked = await call(`(() => {
    const items = [...document.querySelectorAll('.session-item')];
    const hit = items.find((it) => (it.querySelector('.session-name')?.textContent ?? '').includes(${JSON.stringify(NAME)}));
    if (!hit) return 'not-found';
    hit.click();
    return 'clicked';
  })()`);
  assert(clicked === "clicked", "⑦ 侧栏找到会话: " + JSON.stringify(clicked));
  await waitFor(`(() => {
    if (document.querySelector('#todo-body .pane-empty')) return null;
    return JSON.stringify({ count: document.getElementById('todo-count')?.textContent ?? '' });
  })()`, (v) => parseSafe(v)?.count === "1/3", 15000, "点回会话后面板恢复 1/3");
  console.log("== ⑦ 历史回放恢复 1/3 ✓");

  // ⑧ reload → attach 路径（主进程会话仍在，init→renderHistory 回放）
  await call(`location.reload(); true`);
  await sleep(4500); // 等 init + attach + renderHistory
  const afterReload = parseSafe(await call(`JSON.stringify({
    inRightbar: !!document.querySelector('#rightbar #todo-panel'),
    guidance: !!document.querySelector('#todo-body .pane-empty'),
    count: document.getElementById('todo-count')?.textContent ?? '',
  })`));
  assert(afterReload && afterReload.inRightbar && afterReload.guidance === false && afterReload.count === "1/3",
    "⑧ reload 后 attach 回放: " + JSON.stringify(afterReload));
  console.log("== ⑧ reload/attach 回放 1/3 ✓");

  console.log("\n全部通过 ✅  verify-todopanel 8/8");
  ws.close();
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
