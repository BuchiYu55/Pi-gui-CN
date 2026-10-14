/**
 * pi-gui UI 自动化验证：CDP 注入检查 DOM（不截图、不抢前台，规避 PrintWindow 旧帧坑）
 * 用法：先 PI_GUI_CDP_PORT=9223 启动测试实例，再 node verify-ui.mjs 9223
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

// 页面端检查脚本（独立文件读入，规避多层转义坑）
const CHECK = (
  await import("node:fs")
).readFileSync(new URL("./verify-page.js", import.meta.url), "utf8");

const FINISH_CHECK = String.raw`
(() => {
  const input = document.getElementById('input');
  input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
  const v1 = input.value;
  const menuHiddenAfter = document.getElementById('slash-menu').classList.contains('hidden');
  // 复测 Esc 关闭路径
  input.value = '/co';
  input.dispatchEvent(new Event('input', {bubbles: true}));
  const visible2 = !document.getElementById('slash-menu').classList.contains('hidden');
  const labels2 = [...document.querySelectorAll('#slash-menu .slash-label')].map(x => x.textContent);
  input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  const hiddenAfterEsc = document.getElementById('slash-menu').classList.contains('hidden');
  input.value = '';
  return JSON.stringify({v1, menuHiddenAfter, visible2, labels2, hiddenAfterEsc});
})()
`;

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

  await sleep(2500); // 等 init（createSession/models/commands 加载）

  const r1 = await call(CHECK);
  console.log("== 静态结构 + 菜单弹出 ==");
  console.log(r1);

  const r2 = await call(FINISH_CHECK);
  console.log("== 回车选中 / Esc 关闭 ==");
  console.log(r2);

  ws.close();
  process.exit(0);
}

const nextId = { n: 1 };

main().catch((e) => { console.error("VERIFY FAILED:", e); process.exit(1); });
