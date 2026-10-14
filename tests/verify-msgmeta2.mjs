/**
 * 消息元信息修正版验证（2026-10-06）：assistant 行=角标+token 用量（无复制钮）；owner 气泡下=复制钮
 * 用法：实例起后 node verify-msgmeta2.mjs 9227
 */
const PORT = process.argv[2] || "9227";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseSafe = (s) => { try { return JSON.parse(s); } catch { return null; } };

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && /Pi/.test(t.title ?? ""));
  if (!page) throw new Error("CDP target 未找到");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  let n = 0;
  const call = (expression) => new Promise((resolve, reject) => {
    const id = ++n;
    const onMsg = (ev) => { try { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener("message", onMsg); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result?.result?.value); } } catch { /* 忽略 */ } };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  const assert = (cond, label) => { if (!cond) throw new Error("断言失败: " + label); };

  await sleep(3000);
  await call(`(() => { const i = document.getElementById('input'); i.value = '主人留言测试一二三'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  for (let t = 0; t < 40; t++) {
    const has = await call(`!!document.querySelector('.msg-tokens')`);
    if (has === true) break;
    await sleep(1000);
  }

  const meta = parseSafe(await call(`JSON.stringify({
    badge: document.querySelector('.msg-model-badge')?.textContent ?? null,
    tokens: document.querySelector('.msg-tokens')?.textContent ?? null,
    tokensTitleLines: (document.querySelector('.msg-tokens')?.title ?? '').split('\\n').length,
    assistantCopyBtn: document.querySelectorAll('.msg-assistant .msg-copy-btn').length,
    userCopyInUserMsg: !!document.querySelector('.msg-user .user-copy-row .msg-copy-btn'),
  })`));
  assert(meta?.badge === "glm-5.3-flash" || meta?.badge === "glm-5.3", "① 角标，got " + meta?.badge);
  assert(/^↑\d+ ↓\d+$/.test(meta?.tokens ?? ""), "① token 用量，got " + JSON.stringify(meta?.tokens));
  assert(meta.tokensTitleLines >= 4, "① tokens title 含缓存明细");
  assert(meta.assistantCopyBtn === 0, "① assistant 行无复制钮");
  assert(meta.userCopyInUserMsg === true, "① owner 气泡下有复制钮");
  console.log("== ① assistant 行：", meta.badge, meta.tokens, "（title 明细", meta.tokensTitleLines, "行）；复制钮只在 owner 侧 ✓");

  await call(`document.querySelector('.user-copy-row .msg-copy-btn')?.click(); true`);
  await sleep(700);
  const okState = await call(`document.querySelector('.user-copy-row .msg-copy-btn')?.classList.contains('ok')`);
  assert(okState === true, "② 复制 ok 态");
  console.log("== ② owner 复制钮点击 ok ✓（剪贴板由外部 Get-Clipboard 核对）");

  await call(`location.reload(); true`);
  await sleep(5000);
  const after = parseSafe(await call(`JSON.stringify({
    badge: document.querySelector('.msg-model-badge')?.textContent ?? null,
    tokens: document.querySelector('.msg-tokens')?.textContent ?? null,
    userCopy: !!document.querySelector('.msg-user .user-copy-row .msg-copy-btn'),
  })`));
  assert(after?.badge && after?.tokens && after.userCopy, "③ reload 回放，got " + JSON.stringify(after));
  console.log("== ③ reload 回放角标/用量/复制钮俱在 ✓");

  console.log("\n全部通过 ✅  verify-msgmeta2 3/3");
  ws.close();
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
