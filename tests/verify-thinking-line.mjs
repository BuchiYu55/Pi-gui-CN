/* 思考流单行横向改版验证（2026-10-10 owner 拍板 zcode 式；同日 owner 二改：首字从左缘进入）：
 * 折叠态=▸+单行 ticker——未溢出时首字从左缘向右增长（txt margin-right:auto），
 * 溢出后尾部锚定右缘、头部左溢渐隐（.cut）；点开=完整框。
 * 零 token：__mkThinking/__syncThinkCut 钩子注入 DOM，断言结构/对齐/溢出/cut/CSSOM 规则。 */
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
  const out = { checks: [] };
  const ok = (name, cond) => out.checks.push([name, !!cond]);
  const mk = window.__mkThinking;
  ok("__mkThinking 钩子在位", typeof mk === "function");
  if (typeof mk !== "function") return JSON.stringify(out);

  const chat = document.getElementById("chat");
  const host = document.createElement("div");
  host.style.width = "600px"; // 定宽容器，溢出断言才稳定
  chat.appendChild(host);
  try {
    const { d, txt, body } = mk();
    host.appendChild(d);

    // 1) 结构：details.thinking + summary(ticker) + body
    ok("details.thinking 结构", d.tagName === "DETAILS" && d.classList.contains("thinking"));
    ok("summary 含 ticker 与 label", !!d.querySelector("summary .think-stream .think-txt") && !!d.querySelector("summary .think-label"));
    ok("默认折叠（非 open）", !d.open);

    // 2a) 短文本：首字从左缘进入（margin-right:auto 生效）、无 cut 类（不渐隐）
    txt.textContent = "思考中";
    window.__syncThinkCut(txt);
    await new Promise((r) => setTimeout(r, 100));
    let s0 = d.querySelector(".think-stream").getBoundingClientRect();
    let t0 = txt.getBoundingClientRect();
    ok("短文本首字左起（左缘对齐≤2px）", Math.abs(s0.left - t0.left) < 2);
    ok("短文本无 cut（不渐隐首字）", !d.querySelector(".think-stream").classList.contains("cut"));

    // 2b) 长文本下 ticker 一行高、容器横向溢出，且挂 cut（溢出判定生效）
    txt.textContent = "用户觉得慢的关键在于思考过程占用了太多纵向视觉空间，改成单行横向流式后，同样的 token 量只占一行，视觉压力骤减，并且左缘渐隐暗示仍在推进。".repeat(6);
    await new Promise((r) => setTimeout(r, 100)); // 等一帧布局
    const stream = d.querySelector(".think-stream");
    const txtH = txt.getBoundingClientRect().height;
    // 注：justify-end 的溢出向左，容器 scrollWidth 只量右向溢出恒等 clientWidth（首版踩坑）；改测文本宽>容器宽=未收缩真溢出
    const overflowX = txt.getBoundingClientRect().width > stream.clientWidth + 2;
    window.__syncThinkCut(txt); // 溢出判定（与流式 flush 同函数）
    ok("ticker 单行（高度<30px）", txtH > 0 && txtH < 30);
    ok("横向溢出生效（文本宽>容器宽）", overflowX);
    ok("思考文本不换行（nowrap）", getComputedStyle(txt).whiteSpace === "nowrap");
    ok("溢出挂 cut（左缘渐隐启用）", stream.classList.contains("cut"));

    // 3) 尾部可见性：溢出档 ticker 右缘 ≈ stream 右缘（flex-end 锚定，auto margin 归零接管）
    const sRect = stream.getBoundingClientRect();
    const tRect = txt.getBoundingClientRect();
    ok("溢出档尾部锚定（右缘对齐≤2px）", Math.abs(sRect.right - tRect.right) < 2);

    // 4) CSSOM：折叠态去框 / 点开显框 / 点开隐 ticker 三条规则在位
    const rules = [];
    for (const sh of document.styleSheets) {
      let rs; try { rs = sh.cssRules; } catch { continue; }
      for (const r of rs) if (r.selectorText) rules.push(r.cssText); // cssText 含选择器+属性，属性类断言才可测
    }
    ok("折叠态去框规则", rules.some((s) => s.includes("details.thinking:not([open])")));
    ok("点开显框规则", rules.some((s) => s.includes("details.thinking[open]") && !s.includes("summary")));
    ok("点开隐 ticker 规则", rules.some((s) => s.includes("[open] summary .think-stream")));
    ok("溢出才渐隐规则（cut 限定）", rules.some((s) => s.includes("think-stream.cut")));
    ok("首字左起规则（txt auto margin）", rules.some((s) => s.includes(".think-txt") && s.includes("margin-right")));

    // 5) 点开：body 有全文（与 ticker 同源）
    body.textContent = txt.textContent;
    d.open = true;
    await new Promise((r) => setTimeout(r, 100));
    ok("点开后 body 全文在位", body.textContent.length > 100);
  } finally {
    host.remove(); // 清场
  }
  return JSON.stringify(out);
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

  const out = JSON.parse(await call(CHECK));
  console.log(JSON.stringify(out, null, 1));
  const fails = out.checks.filter(([, v]) => !v);
  if (fails.length) throw new Error("断言失败: " + fails.map(([n]) => n).join(" / "));
  console.log(`\n== verify-thinking-line：${out.checks.length}/${out.checks.length} 通过 ==`);
  ended = true;
} catch (err) {
  console.error("❌", err?.message ?? err);
  process.exitCode = 2;
} finally {
  try { ws?.close(); } catch {}
  process.exit(ended ? 0 : 2);
}
