/** 输入框 tokens chip 移除验证：status-usage 删除、ctx-ring 唯一且空会话隐藏 */
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
  await sleep(2500);
  const r = parseSafe(await call(`JSON.stringify({
    usageChipGone: !document.getElementById("status-usage"),
    ringCount: document.querySelectorAll("#ctx-ring").length,
    ringHidden: document.getElementById("ctx-ring")?.classList.contains("hidden") ?? null,
    ringStyleDisplay: getComputedStyle(document.getElementById("ctx-ring")).display,
    composerRightText: (document.querySelector(".composer-right")?.innerText ?? "").replace(/\\s+/g, " ").slice(0, 60),
  })`));
  console.log(JSON.stringify(r, null, 1));
  if (!r?.usageChipGone) throw new Error("status-usage 仍存在");
  if (r.ringCount !== 1) throw new Error("ctx-ring 应唯一，got " + r.ringCount);
  if (r.ringHidden !== true) throw new Error("空会话环应隐藏");
  console.log("\n通过 ✅");
  ws.close();
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
