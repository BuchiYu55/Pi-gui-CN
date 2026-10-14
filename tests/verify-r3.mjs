/**
 * R3 质感验证（2026-10-04）：入场动效 + 轮末 chip + ContextRing + 后台会话未读绿点
 * 用法：PI_GUI_CDP_PORT=9223 启动测试实例后，node verify-r3.mjs 9223
 * 流程：① 弹层/菜单入场动效（合成元素 computed animation-name）；
 *      ② 真实小任务 → 轮末 chip（耗时文本）+ ContextRing（dashoffset 已设）+ 新消息入场动画；
 *      ③ 多会话：A 后台跑任务切到 B → A 运行中朱砂点 → A 完成绿点（未读）→ 点开 A 绿点消；
 *      ④ 减弱动效开关：重开弹层 animation-duration=0s。
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

async function main() {
  const target = await findTarget();
  console.log("target:", target.title);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener("close", () => console.log("[diag] ws closed"));
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });

  // 本机（Windows Server）系统动画关闭 → prefers-reduced-motion 常开，动效被正确压制。
  // 验证动效代码本身：模拟「无偏好」让动画可计算（不影响真实用户行为）。
  ws.send(JSON.stringify({ id: nextId.n++, method: "Emulation.setEmulatedMedia", params: { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] } }));
  await sleep(300);

  const call = (expression) =>
    new Promise((resolve, reject) => {
      const id = nextId.n++;
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === id) {
          ws.removeEventListener("message", onMsg);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result?.result?.value);
        }
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });

  const waitFor = async (expression, test, timeoutMs, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      let v = null;
      try { v = await call(expression); } catch { /* 瞬时失败忽略 */ }
      if (v != null && test(v)) return v;
      await sleep(1200);
    }
    throw new Error("超时等待: " + label);
  };

  const EXPR_IDLE = `(() => { const el = document.getElementById('status-state'); return (!el?.classList.contains('busy') && (el?.textContent ?? '').includes('空闲')) ? 'idle' : null; })()`;
  const send = (text) => call(`
    (() => {
      const i = document.getElementById('input');
      i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()
  `);

  await sleep(2200); // 等 init

  // ① 入场动效：设置弹层 + slash 菜单（合成元素 computed 校验）
  await call(`document.getElementById('btn-settings').click(); true`);
  await sleep(400);
  const anim1 = JSON.parse(await call(`JSON.stringify({
    overlay: getComputedStyle(document.getElementById('settings-overlay')).animationName,
    modal: getComputedStyle(document.querySelector('.st-modal')).animationName,
    dur: getComputedStyle(document.querySelector('.st-modal')).animationDuration,
  })`));
  console.log("== ① 弹层入场 ==", anim1);
  if (anim1.modal !== "modal-in" || anim1.overlay !== "overlay-in") throw new Error("弹层动画缺失: " + JSON.stringify(anim1));
  await call(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(300);
  await call(`
    (() => {
      const i = document.getElementById('input');
      i.value = '/';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(300);
  const menuAnim = await call(`getComputedStyle(document.getElementById('slash-menu')).animationName`);
  console.log("== ① slash 菜单 ==", menuAnim);
  if (menuAnim !== "rise-in") throw new Error("slash 菜单动画缺失: " + menuAnim);
  await call(`
    (() => {
      const i = document.getElementById('input');
      i.value = '';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);

  // ② 真实小任务 → 轮末 chip + ContextRing + 新消息入场
  await waitFor(EXPR_IDLE, (v) => v === "idle", 30000, "初始空闲");
  await send("请只回复一个字：好。不要使用任何工具。");
  await waitFor(EXPR_IDLE, (v) => v === "idle", 120000, "小任务完成");
  await sleep(600);
  const chip = await call(`document.querySelector('.turn-chip')?.textContent ?? null`);
  const ring = JSON.parse(await call(`JSON.stringify({
    hidden: document.getElementById('ctx-ring').classList.contains('hidden'),
    offset: document.querySelector('#ctx-ring .cr-prog')?.style.strokeDashoffset ?? null,
    title: document.getElementById('ctx-ring').title,
  })`));
  const EXPR_LASTBUBBLE = `(() => { const bs = document.querySelectorAll('#chat .msg-user .bubble'); const b = bs[bs.length - 1]; return b ? JSON.stringify({ anim: getComputedStyle(b).animationName, enter: b.classList.contains('enter') }) : null; })()`;
  const bInfo = JSON.parse(await call(EXPR_LASTBUBBLE));
  console.log("== ② 轮末 chip ==", JSON.stringify(chip), "| ring:", ring.title, "| 最后用户气泡:", bInfo);
  if (!chip || !/^\d+s$/.test(chip.trim()) && !/^\d+m\d+s$/.test(chip.trim())) throw new Error("轮末 chip 异常: " + chip);
  if (ring.hidden || !ring.offset) throw new Error("ContextRing 未生效: " + JSON.stringify(ring));
  if (!bInfo || bInfo.enter !== true || bInfo.anim !== "card-in") throw new Error("消息入场动画缺失: " + JSON.stringify(bInfo));

  // ③ 多会话完成强提示：A 跑慢任务 → 立刻切新会话 B → A 运行点 → A 完成整行态（置顶+✓已完成+组头徽标+标题前缀）→ 点开消
  await send("请从 1 慢慢数到 12，每个数字单独一行，然后结束。不要使用任何工具。");
  await sleep(1500); // 等 agent_start
  await call(`document.getElementById('btn-new-session').click(); true`);
  await sleep(2500); // 切到 B；A 后台跑
  const runDot = await call(`document.querySelectorAll('.run-dot').length`);
  console.log("== ③ A 运行中 ==", "run-dot 数:", runDot);
  await waitFor(`document.querySelectorAll('.session-item.unread').length`, (n) => typeof n === "number" && n >= 1, 120000, "A 完成出现整行完成态");
  const doneInfo = JSON.parse(await call(`JSON.stringify({
    unreadRows: document.querySelectorAll('.session-item.unread').length,
    doneTags: document.querySelectorAll('.session-item.unread .done-tag').length,
    badges: document.querySelectorAll('.ws-badge').length,
    title: document.title,
  })`));
  console.log("== ③ A 完成 ==", doneInfo);
  if (doneInfo.doneTags < 1) throw new Error("完成态缺 ✓ 已完成 标签");
  if (doneInfo.badges < 1) throw new Error("组头未读计数徽标缺失");
  if (!/^✓\d+ · /.test(doneInfo.title)) throw new Error("标题前缀缺失: " + doneInfo.title);
  // 点开该会话 → 完成态消 + 历史渲染且历史气泡零 .enter（无动画回放）
  await call(`document.querySelector('.session-item.unread')?.click(); true`);
  await sleep(2500);
  const afterOpen = JSON.parse(await call(`JSON.stringify({
    unread: document.querySelectorAll('.session-item.unread').length,
    badges: document.querySelectorAll('.ws-badge').length,
    title: document.title,
    chatMsgs: document.querySelectorAll('#chat .msg-user').length,
    enterCount: document.querySelectorAll('#chat .msg-user .bubble.enter, #chat .msg-assistant .bubble.enter').length,
  })`));
  console.log("== ③ 点开 A ==", afterOpen);
  if (afterOpen.unread !== 0) throw new Error("点开后完成态未消");
  if (afterOpen.badges !== 0) throw new Error("点开后组头徽标未消");
  if (afterOpen.title !== "Pi 桌面版") throw new Error("标题前缀未清: " + afterOpen.title);
  if (afterOpen.enterCount !== 0) throw new Error("历史渲染出现 .enter（会回放入场动画）");
  if (afterOpen.chatMsgs < 1) throw new Error("A 历史未渲染");

  // ④ 减弱动效：先切到外观 tab（面板懒渲染，不切则 #st-appearance 为空）→ 点「减弱」→ 重开弹层 duration=0s → 恢复「正常」
  await call(`document.getElementById('btn-settings').click(); true`);
  await sleep(400);
  await call(`document.querySelector('.st-nav-item[data-tab="appearance"]').click(); true`);
  await sleep(200);
  const clicked = await call(`
    (() => {
      const box = document.getElementById('st-appearance');
      const rows = [...box.querySelectorAll('.st-app-row')];
      const motion = rows.find(r => r.querySelector('.st-app-label').textContent.includes('动效'));
      const btn = motion ? [...motion.querySelectorAll('.chip')].find(c => c.textContent.trim() === '减弱') : null;
      if (!btn) return 'NOT_FOUND';
      btn.click();
      return 'OK';
    })()
  `);
  if (clicked !== "OK") throw new Error("减弱 chip 未找到");
  await sleep(300);
  await call(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(300);
  await call(`document.getElementById('btn-settings').click(); true`);
  await sleep(400);
  const durReduced = await call(`getComputedStyle(document.querySelector('.st-modal')).animationDuration`);
  console.log("== ④ 减弱动效 ==", "modal duration:", durReduced);
  if (durReduced !== "0s") throw new Error("减弱动效未生效: " + durReduced);
  // 恢复「正常」并关弹层（不弄脏外观偏好）
  await call(`
    (() => {
      const box = document.getElementById('st-appearance');
      const rows = [...box.querySelectorAll('.st-app-row')];
      const motion = rows.find(r => r.querySelector('.st-app-label').textContent.includes('动效'));
      const btn = motion ? [...motion.querySelectorAll('.chip')].find(c => c.textContent.trim() === '正常') : null;
      if (btn) btn.click();
      return true;
    })()
  `);
  await sleep(200);
  await call(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(200);

  console.log("\nALL R3 CHECKS PASSED ✅");
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error("VERIFY FAILED:", e); process.exit(1); });
