/**
 * /压缩 菜单项 + session:compact IPC 链路验证（2026-10-07）
 * 短会话压缩应被 SDK 诚实拒绝（"Nothing to compact"）→ notice 红条显示——链路即通。
 */
const PORT = process.argv[2] || "9229";
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

let ws = null, msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function probe(expr) {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: false,
  });
  if (exceptionDetails) throw new Error("页面表达式异常: " + (exceptionDetails.text ?? ""));
  return result?.value;
}

async function main() {
  const target = await findTarget();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
    }
  };
  await send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});

  // 干净起点
  await probe(`(function(){const b=document.querySelector("#btn-new-session");if(b)b.click();return 1})()`);
  let welcome = false;
  for (let i = 0; i < 75 && !welcome; i++) { await sleep(200); welcome = !!(await probe(`!!document.querySelector("#welcome")`)); }
  if (!welcome) throw new Error("#welcome 未出现");

  let fail = 0;
  const check = (name, ok, detail = "") => {
    console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  — " + detail : ""));
    if (!ok) fail++;
  };

  // A. 输入 / 出现菜单且含 /压缩
  const menuHas = await probe(`(function(){
    const i=document.querySelector("#input");
    i.value="/";
    i.dispatchEvent(new Event("input",{bubbles:true}));
    return 1;
  })()`).then(() => sleep(500)).then(() =>
    probe(`(function(){
      const items=[...document.querySelectorAll("#slash-menu .slash-item")].map(x=>x.textContent);
      return JSON.stringify(items.filter(t=>t.includes("compact")));
    })()`)
  );
  check("A. / 菜单含「/压缩」项", !!(menuHas && menuHas !== "[]"), menuHas);

  // B. preload 暴露 compact 方法
  await probe(`window.pi && window.pi.compact ? 1 : 0`).then((v) => {
    check("B. preload 暴露 compact 方法", v === 1);
  });

  // C. 走真实用户路径：输入 / → 菜单点「/压缩」→ pickSlash → doCompact → notice 反馈
  await probe(`(function(){
    const i=document.querySelector("#input");
    i.value="/";
    i.dispatchEvent(new Event("input",{bubbles:true}));
    return 1;
  })()`);
  await sleep(500);
  const menuState = await probe(`(function(){const m=document.querySelector("#slash-menu");return JSON.stringify({vis:!m.classList.contains("hidden"),items:document.querySelectorAll("#slash-menu .slash-item").length,inputVal:document.querySelector("#input").value})})()`);
  console.log("INFO  菜单状态:", menuState);
  const clicked = await probe(`(function(){
    const items=[...document.querySelectorAll("#slash-menu .slash-item")];
    const it=items.find(x=>x.textContent.includes("compact"));
    if(it){it.click();return 1}
    return 0;
  })()`);
  await sleep(120);
  console.log("INFO  点击后 input 值:", await probe(`document.querySelector("#input").value`), " 菜单 hidden:", await probe(`document.querySelector("#slash-menu").classList.contains("hidden")`));
  console.log("INFO  clicked=", clicked, " noticeText=", await probe(`(document.querySelector("#notice")||{textContent:""}).textContent.slice(0,40)`));
  let notice = "";
  if (clicked) {
    for (let i = 0; i < 50 && !notice; i++) {
      await sleep(150);
      const raw = await probe(`(function(){const n=document.querySelector("#notice");return JSON.stringify({h:n.classList.contains("hidden"),t:n.textContent})})()`);
      if (i < 6) console.log("poll", i, JSON.stringify(raw));
      let v = { h: true, t: "" };
      try { v = JSON.parse(raw ?? "{}"); } catch { /* 重试 */ }
      if (!v.h && String(v.t).includes("compact")) notice = v.t;
    }
  }
  check("C. 菜单点击→压缩执行→notice 反馈（短会话应提示未执行）", !!notice, notice.slice(0, 80));

  ws.close();
  console.log(fail === 0 ? "\n全部通过 ✓" : `\n${fail} 项失败 ✗`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("验证失败:", e.message); process.exit(1); });
