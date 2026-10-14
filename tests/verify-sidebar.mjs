/**
 * 侧栏重排验证（2026-10-05 owner 拍板方案①-⑤）：
 * ① ctx-bar 上下文条（工作区名+git，comp-card 首行）
 * ② 已归档降级（设置行右侧，归档态朱砂高亮）
 * ③ 智谱用量单行三段微条（≥70 琥珀 ≥90 朱砂）
 * ④ 版本号挪设置弹层 st-side-foot
 * ⑤ 会话搜索浮层（过滤/高亮/跳转/Esc）
 * 用法：PI_GUI_CDP_PORT=9223 启动测试实例后，node verify-sidebar.mjs 9223
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

const CHECK = String.raw`
(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  await wait(2500); // 等 init / 侧栏树 / ctx-bar 首刷
  const r = {};
  // ① ctx-bar
  const bar = document.getElementById('ctx-bar');
  r.ctxBarVisible = !!bar && !bar.classList.contains('hidden');
  r.ctxWs = document.getElementById('ctx-ws')?.textContent ?? null;
  r.ctxIcon = document.querySelector('#ctx-bar use')?.getAttribute('href') ?? null;
  r.ctxGit = document.getElementById('ctx-git')?.textContent ?? null;
  r.ctxTitleHasPath = /[A-Za-z]:[\\/]/.test(bar?.title ?? '');
  // ② 旧元素消失
  r.footerGitGone = !document.getElementById('footer-git');
  r.piVersionGone = !document.getElementById('pi-version');
  r.zcChipGone = !document.querySelector('.zc-chip');
  r.footRows = document.querySelectorAll('.side-footer .footer-line-row').length;
  const ab = document.getElementById('btn-toggle-archived');
  r.archivedHidden = ab?.classList.contains('hidden') ?? null;
  r.archivedText = ab?.textContent ?? null;
  // ③ zai 微条
  const zt = document.getElementById('footer-zai-text');
  r.zaiSegs = [...zt.querySelectorAll('.zc-seg')].map(s => ({
    lab: s.querySelector('.zc-lab')?.textContent,
    pct: s.querySelector('.zc-pct')?.textContent,
    w: s.querySelector('.zc-fill')?.style.width,
    cls: s.querySelector('.zc-fill')?.className,
  }));
  r.zaiFallbackText = zt.querySelectorAll('.zc-seg').length ? null : zt.textContent;
  r.zaiLineH = Math.round(zt.getBoundingClientRect().height);
  r.zaiNowrap = getComputedStyle(zt).whiteSpace;
  // ④ 归档切换（有归档才测）
  if (!r.archivedHidden && ab) {
    ab.click(); await wait(500);
    r.archBackClass = ab.classList.contains('as-back');
    r.archBackText = ab.textContent;
    ab.click(); await wait(500);
    r.archRestored = !ab.classList.contains('as-back');
  }
  // ⑤ 搜索（入口在新会话旁 + Ctrl+K）
  const bs = document.getElementById('btn-search');
  r.btnInTopActions = !!bs?.closest('.top-actions');
  r.btnSearchSize = bs ? Math.round(bs.getBoundingClientRect().width) + 'x' + Math.round(bs.getBoundingClientRect().height) : null;
  bs.click(); await wait(400);
  const pop = document.getElementById('search-pop');
  r.popOpen = !pop.classList.contains('hidden');
  r.spInitialCount = document.querySelectorAll('#sp-list .sp-item').length;
  const inp = document.getElementById('sp-input');
  const firstName = document.querySelector('#sp-list .sp-item .sp-name')?.textContent ?? '';
  const probe = firstName.slice(0, 2);
  inp.value = probe; inp.dispatchEvent(new Event('input', { bubbles: true })); await wait(200);
  r.probe = probe;
  r.spFilteredCount = document.querySelectorAll('#sp-list .sp-item').length;
  r.spMark = document.querySelector('#sp-list .sp-name mark')?.textContent ?? null;
  r.spMeta = document.querySelector('#sp-list .sp-item .sp-meta')?.textContent ?? null;
  document.querySelector('#sp-list .sp-item')?.click(); await wait(1200);
  r.popClosedAfterJump = pop.classList.contains('hidden');
  r.ctxWsAfter = document.getElementById('ctx-ws')?.textContent ?? null;
  document.getElementById('btn-search').click(); await wait(300);
  r.popReopen = !pop.classList.contains('hidden');
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(150);
  r.popClosedByEsc = pop.classList.contains('hidden');
  // Ctrl+K 唤起
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); await wait(200);
  r.popOpenByCtrlK = !pop.classList.contains('hidden');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); await wait(150);
  r.popClosedByCtrlK = pop.classList.contains('hidden');
  // ⑥ 设置弹层版本号
  document.getElementById('btn-settings').click(); await wait(700);
  r.stFoot = document.getElementById('st-installed-count')?.textContent ?? null;
  document.getElementById('st-close').click(); await wait(100);
  r.stClosed = document.getElementById('settings-overlay').classList.contains('hidden');
  return JSON.stringify(r);
})()
`;

async function main() {
  const target = await findTarget();
  console.log("target:", target.title, target.url);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });

  const call = (expression) =>
    new Promise((resolve, reject) => {
      const id = call.n = (call.n ?? 0) + 1;
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === id) {
          ws.removeEventListener("message", onMsg);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result?.result?.value);
        }
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });

  const r = JSON.parse(await call(CHECK));
  console.log(JSON.stringify(r, null, 1));

  const errs = [];
  const ok = (cond, name) => { if (!cond) errs.push(name); };

  // ①
  ok(r.ctxBarVisible, "ctx-bar 可见");
  ok(typeof r.ctxWs === "string" && r.ctxWs.length > 0, "ctx-bar 有工作区名");
  ok(r.ctxIcon === "#i-folder" || r.ctxIcon === "#i-home", "ctx-bar 图标合法（folder/home）");
  ok(r.ctxTitleHasPath, "ctx-bar title 含完整路径");
  // ②
  ok(r.footerGitGone && r.piVersionGone && r.zcChipGone, "旧元素全删（footer-git/pi-version/zc-chip）");
  ok(r.footRows === 1, "footer 只剩一行 row（设置|归档）");
  if (r.archivedHidden === false) {
    ok(/已归档 \d+/.test(r.archivedText ?? ""), "归档入口文案「已归档 N」");
    ok(r.archBackClass === true && /返回/.test(r.archBackText ?? ""), "归档态 as-back 高亮 + 返回文案");
    ok(r.archRestored === true, "归档态可还原");
  } else {
    console.log("（无归档会话，④ 归档切换断言跳过）");
  }
  // ③
  if (r.zaiSegs?.length) {
    ok(r.zaiSegs.length >= 2, "zai 至少两段（5h/周）");
    ok(r.zaiSegs.every(s => /^(剩\d+|\d+)%$/.test(s.pct ?? "") && s.w), "每段有百分比与微条宽度（剩余量语义：剩X%）");
    const filled = r.zaiSegs.filter(s => /warn|danger/.test(s.cls ?? ""));
    console.log("（zai 阈值段：", filled.length ? filled.map(s => s.lab + ":" + s.pct).join(",") : "无（当前用量都低）", "）");
    ok(r.zaiLineH <= 24, "zai 微条单行（高度 ≤24px，实测 " + r.zaiLineH + "）");
    ok(r.zaiNowrap === "nowrap", "zai nowrap");
  } else {
    ok(/智谱用量/.test(r.zaiFallbackText ?? ""), "zai 降级文案兜底");
  }
  // ⑤
  ok(r.btnInTopActions && r.btnSearchSize, "搜索按钮在新会话旁（top-actions，" + r.btnSearchSize + "）");
  ok(r.popOpen, "搜索浮层可打开");
  ok(r.spInitialCount >= 1, "搜索初始列表非空");
  ok(r.spFilteredCount >= 1 && r.spMark === r.probe, "过滤命中 + mark 高亮=" + r.probe);
  ok(/·/.test(r.spMeta ?? ""), "结果行含工作区/时间 meta");
  ok(r.popClosedAfterJump, "点击结果跳转后浮层关闭");
  ok(typeof r.ctxWsAfter === "string" && r.ctxWsAfter.length > 0, "跳转后 ctx-bar 刷新");
  ok(r.popReopen && r.popClosedByEsc, "Esc 关闭浮层");
  ok(r.popOpenByCtrlK && r.popClosedByCtrlK, "Ctrl+K 开/关浮层");
  // ⑥
  ok(/pi v\d/.test(r.stFoot ?? ""), "版本号在设置弹层 st-side-foot");
  ok(r.stClosed, "设置弹层可关闭");

  ws.close();
  if (errs.length) { console.error("\n❌ 断言失败:", errs); process.exit(1); }
  console.log("\n✅ 侧栏重排 ①-⑤ 验证全绿");
}

main().catch((e) => { console.error("验证脚本失败:", e.message, "\nSTACK:", e.stack); process.exit(1); });
