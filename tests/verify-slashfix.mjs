/**
 * slash 菜单参数消失 bug 修复验证（2026-10-04）
 * bug：选中命令后继续输入参数，菜单复活 → Enter 被 pickSlash 拦截 → 参数被重置抹掉
 * 修复：输入含空白后 slashToken 返回 null，菜单不再触发
 *
 * 断言均为纯 DOM 状态（不派发 Enter，避免真实发送给模型）：
 *   菜单 hidden ⇒ keydown 的 menuOpen=false ⇒ 不进 pickSlash 分支 ⇒ Enter 走 send()
 */
const PORT = process.argv[2] || "9223";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /Pi/i.test(t.title ?? ""));
      if (page) return page;
    } catch { /* 未就绪 */ }
    await sleep(1000);
  }
  throw new Error("CDP target 未找到");
}

// 页面端脚本独立文件读入，规避多层转义坑（AGENTS 踩坑④⑤）
const INJECT = (await import("node:fs")).readFileSync(new URL("./verify-slashfix-page.js", import.meta.url), "utf8");

let ws = null;
let msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  const target = await findTarget();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };

  const { result } = await send("Runtime.evaluate", {
    expression: INJECT,
    returnByValue: true,
    awaitPromise: true,
  });
  const r = result?.value;
  if (!r || typeof r !== "object") throw new Error("注入脚本返回 undefined（抛异常未捕获？）: " + JSON.stringify(result).slice(0, 300));

  let fail = 0;
  const check = (name, ok, detail = "") => {
    console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  — " + detail : ""));
    if (!ok) fail++;
  };

  check("A. 输入含参数（含空白）→ 菜单不弹出", r.withArgs.menuHidden, "menuHidden=" + r.withArgs.menuHidden);
  check("B. 输入参数后 input.value 完整保留", r.withArgs.value === r.withArgs.expected, "value=" + JSON.stringify(r.withArgs.value));
  check("C. 纯命令 token（无空格）→ 菜单仍弹出", !r.bareToken.menuHidden, "menuHidden=" + r.bareToken.menuHidden);
  check("D. 输入 /ski → 菜单过滤仍工作", !r.filtered.menuHidden && r.filtered.itemCount > 0, "itemCount=" + r.filtered.itemCount);
  check("E. 输入普通文本 → 菜单不弹出", r.plainText.menuHidden, "menuHidden=" + r.plainText.menuHidden);
  check("F. 收尾状态：输入框已还原为空", r.cleanupValue === "", "value=" + JSON.stringify(r.cleanupValue));

  ws.close();
  console.log(fail === 0 ? "\n全部通过 ✓" : `\n${fail} 项失败 ✗`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("验证失败:", e.message); process.exit(1); });
