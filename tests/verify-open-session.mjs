/**
 * 端到端验证：点击侧栏历史会话 → 中间区渲染完整历史 → 可继续对话
 * 前置：PI_GUI_CDP_PORT=9223 启动测试实例，且 userData 配置里已有带历史会话的工作区
 * 用法：node verify-open-session.mjs 9223
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

  await sleep(3000); // 等 init

  // 1) 点击第一个历史会话条目
  const clicked = await call(String.raw`
    (() => {
      const items = [...document.querySelectorAll(".session-item")];
      if (!items.length) return JSON.stringify({ ok: false, reason: "no session items", groups: document.querySelectorAll(".ws-group").length });
      const it = items[0];
      const name = it.querySelector(".session-name")?.textContent ?? "";
      const meta = it.querySelector(".session-meta")?.textContent ?? "";
      it.click();
      return JSON.stringify({ ok: true, name: name.slice(0, 50), meta });
    })()
  `);
  console.log("== 点击会话 ==", clicked);
  const c = JSON.parse(clicked);
  if (!c.ok) { ws.close(); process.exit(1); }

  // 2) 等待 createSession + renderHistory（含 MCP 后台连接，给足时间）
  await sleep(9000);

  // 3) 检查：消息数、welcome 是否消失、notice 文本、composer 是否可用
  const after = await call(String.raw`
    (() => {
      const msgs = document.querySelectorAll("#chat .msg").length;
      const welcome = !!document.querySelector("#chat .welcome");
      const notice = document.getElementById("notice")?.textContent ?? "";
      const noticeHidden = document.getElementById("notice")?.classList.contains("hidden") ?? true;
      const inputDisabled = document.getElementById("input").disabled;
      const current = document.querySelector(".session-item.current .session-name")?.textContent?.slice(0, 40) ?? null;
      const userBubbles = document.querySelectorAll("#chat .msg-user").length;
      const assistantMsgs = document.querySelectorAll("#chat .msg-assistant").length;
      const chatHeight = document.getElementById("chat")?.scrollHeight ?? 0;
      return JSON.stringify({ msgs, userBubbles, assistantMsgs, welcome, notice, noticeHidden, inputDisabled, current, chatHeight });
    })()
  `);
  console.log("== 打开后状态 ==", after);
  const a = JSON.parse(after);
  const pass = a.msgs > 0 && !a.welcome && a.userBubbles > 0;
  console.log(pass ? "✅ 历史会话渲染成功：消息已显示，welcome 已消失" : "❌ 验证失败");
  console.log(`   消息 ${a.msgs} 条（用户 ${a.userBubbles} / assistant ${a.assistantMsgs}），welcome=${a.welcome}，当前会话=${a.current}`);
  ws.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("verify failed:", e.message); process.exit(1); });
