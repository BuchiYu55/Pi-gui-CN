/**
 * /rename + 新会话免确认 验证（2026-10-04）
 * 用法：先 PI_GUI_CDP_PORT=9223 启动测试实例，再 node verify-rename.mjs 9223
 * 流程：① 覆写 confirm 后点「新会话」断言不再弹确认且会话已切换；
 *      ② 发一条消息让会话落盘；③ /rename 无参（LLM 自动起名）；④ /rename 带参直接改名；⑤ 菜单含 /rename。
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
  console.log("target:", target.title, target.url);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener("close", () => console.log("[diag] ws closed"));
  ws.addEventListener("error", (e) => console.log("[diag] ws error", e.message ?? ""));
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });

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

  // Node 侧轮询：页面取值 → 本地判断，直到命中或超时
  const waitFor = async (expression, test, timeoutMs, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      let v = null;
      try { v = await call(expression); } catch { /* 瞬时失败忽略 */ }
      if (v != null && test(v)) return v;
      await sleep(1000);
    }
    throw new Error("超时等待: " + label);
  };

  const EXPR_NOTICE = `document.getElementById('notice').classList.contains('hidden') ? null : document.getElementById('notice').textContent`;
  const EXPR_STATUS_IDLE = `(() => {
    const el = document.getElementById('status-state');
    return (!el?.classList.contains('busy') && (el?.textContent ?? '').includes('空闲')) ? el.textContent : null;
  })()`;

  await sleep(2500); // 等 init

  // ① 菜单里能搜到 /rename
  const menuR = JSON.parse(await call(`
    (() => {
      const input = document.getElementById('input');
      input.value = '/re';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const labels = [...document.querySelectorAll('#slash-menu .slash-label')].map(x => x.textContent);
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return JSON.stringify({ labels, hasRename: labels.includes('/rename') });
    })()
  `));
  console.log("== ① / 菜单 ==", menuR);
  if (!menuR.hasRename) throw new Error("菜单里没有 /rename");

  // ② 覆写 confirm → 点新会话 → 不应有 confirm，且切到新的空会话（welcome 挂载；state 在 bundle IIFE 内取不到，用 DOM 判断）
  const before = JSON.parse(await call(`
    (() => {
      window.__confirmCalled = false;
      window.confirm = () => { window.__confirmCalled = true; return false; };
      return JSON.stringify({ welcome: !!document.querySelector('.welcome-logo'), chatChildren: document.getElementById('chat').children.length });
    })()
  `));
  await call(`document.getElementById('btn-new-session').click(); true`);
  await sleep(2500);
  const after = JSON.parse(await call(`JSON.stringify({ welcome: !!document.querySelector('.welcome-logo'), confirmCalled: window.__confirmCalled })`));
  console.log("== ② 新会话免确认 ==", { before, after });
  if (after.confirmCalled) throw new Error("新会话仍弹了 confirm");
  if (!after.welcome) throw new Error("点击新会话后未切到空会话（无 welcome）");

  // ③ 发一条消息让会话落盘（也给自动起名提供素材）
  await call(`
    (() => {
      const input = document.getElementById('input');
      input.value = '请用一句话介绍你自己';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()
  `);
  await waitFor(EXPR_STATUS_IDLE, (v) => !!v, 120000, "首条消息回复完成");
  console.log("== ③ 首条消息完成，会话已落盘 ==");

  // ④ /rename 无参 → LLM 自动起名
  await call(`
    (() => {
      const input = document.getElementById('input');
      input.value = '/rename';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()
  `);
  const autoName = await waitFor(EXPR_NOTICE, (t) => typeof t === "string" && t.startsWith("已按任务历史改名："), 90000, "自动起名完成");
  console.log("== ④ /rename 自动起名 ==", autoName);

  // ⑤ /rename 带参 → 直接改名，侧栏 current 会话名同步
  await call(`
    (() => {
      const input = document.getElementById('input');
      input.value = '/rename CDP改名验证Session';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()
  `);
  const manualNotice = await waitFor(EXPR_NOTICE, (t) => typeof t === "string" && t.includes("CDP改名验证Session"), 15000, "手动改名提示");
  await sleep(1500); // renderSidebarTree 刷新
  const currentName = await call(`document.querySelector('.session-item.current .session-name')?.textContent ?? null`);
  console.log("== ⑤ /rename 带参 ==", { notice: manualNotice, sidebarCurrent: currentName });
  if (!/CDP改名验证Session/.test(currentName ?? "")) throw new Error("侧栏 current 会话名未更新: " + currentName);

  console.log("\nALL RENAME CHECKS PASSED ✅");
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error("VERIFY FAILED:", e); process.exit(1); });
