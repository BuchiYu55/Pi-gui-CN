/**
 * 桌面设计评审取证（design_chenge v1.1 分叉 D+C，只读不改）
 * 用法：PI_GUI_CDP_PORT=9226 PI_GUI_USER_DATA=<独立目录> 启动后，node review-desktop.mjs 9226
 * 取证面：窗口/三栏布局、交互元素热区（F2 桌面 24px）、焦点可见、滚动条、空态、
 *        slash 菜单、对比弹窗、字体档分布、圆角档、过渡曲线。
 */
const PORT = process.argv[2] || "9226";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseSafe = (s) => { try { return JSON.parse(s); } catch { return null; } };

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && /Pi/.test(t.title ?? ""));
  if (!page) throw new Error("CDP target 未找到");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  let n = 0;
  const call = (expression) => new Promise((resolve) => {
    const id = ++n;
    const onMsg = (ev) => { try { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener("message", onMsg); resolve(m.result?.result?.value); } } catch { /* 忽略 */ } };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });

  await sleep(3000); // 等 init

  console.log("==== A. 窗口与三栏 ====");
  console.log(parseSafe(await call(`JSON.stringify((() => {
    const side = document.querySelector('.sidebar, #sidebar, aside'); // 侧栏
    const chat = document.getElementById('chat');
    const right = document.getElementById('rightbar') || document.querySelector('.rightbar, .pane');
    const composer = document.getElementById('composer');
    return {
      win: { w: window.innerWidth, h: window.innerHeight },
      side: side ? Math.round(side.getBoundingClientRect().width) : null,
      chatW: chat ? Math.round(chat.getBoundingClientRect().width) : null,
      rightW: right ? Math.round(right.getBoundingClientRect().width) : null,
      composerH: composer ? Math.round(composer.getBoundingClientRect().height) : null,
      bodyMinW: getComputedStyle(document.body).minWidth || '(none)',
      appMinW: (() => { const a = document.getElementById('app'); return a ? getComputedStyle(a).minWidth : null; })(),
    };
  })())`)));

  console.log("==== B. 交互元素热区（<24px 违例清单，F2 桌面档）====");
  const hot = parseSafe(await call(`JSON.stringify((() => {
    const els = [...document.querySelectorAll('button, select, [role="button"], .chip, .st-act, .st-mini')].filter((e) => {
      const r = e.getBoundingClientRect();
      const st = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    });
    const bad = [];
    for (const e of els) {
      const r = e.getBoundingClientRect();
      const st = getComputedStyle(e);
      // 透明外扩热区算数：::after 扩展无法直接量，读 min-width/min-height + padding 估计
      const w = Math.max(r.width, parseFloat(st.minWidth) || 0);
      const h = Math.max(r.height, parseFloat(st.minHeight) || 0);
      if (w < 23.5 || h < 23.5) bad.push({ tag: e.tagName, cls: (e.className.baseVal ?? e.className ?? '').slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), label: e.getAttribute('aria-label') || e.title || e.textContent.trim().slice(0, 12) });
    }
    return { total: els.length, violations: bad.slice(0, 25), badCount: bad.length };
  })())`));
  console.log(`可见交互元素 ${hot.total} 个，<24px 违例 ${hot.badCount} 个：`);
  for (const v of (hot.violations ?? [])) console.log(`  [${v.tag}.${v.cls}] ${v.w}x${v.h} "${v.label}"`);

  console.log("==== C. 焦点可见性 ====");
  console.log(parseSafe(await call(`JSON.stringify((() => {
    const css = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } });
    const fv = css.filter((r) => r.selectorText && r.selectorText.includes(':focus-visible')).length;
    const focus = css.filter((r) => r.selectorText && /:focus(?!-)/.test(r.selectorText)).length;
    // Tab 到第一个可聚焦元素看 outline
    const first = document.querySelector('button, input, select, textarea');
    first?.focus();
    const st = first ? getComputedStyle(first) : null;
    return { focusVisibleRules: fv, focusRules: focus, focusedOutline: st ? st.outlineWidth + ' ' + st.outlineStyle : null };
  })())`)));

  console.log("==== D. 字体档分布（computed 实测）====");
  console.log(parseSafe(await call(`JSON.stringify((() => {
    const dist = {};
    for (const e of document.querySelectorAll('body *')) {
      const st = getComputedStyle(e);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const fs = st.fontSize;
      if (!dist[fs]) dist[fs] = 0;
      dist[fs]++;
    }
    return Object.fromEntries(Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 12));
  })())`)));

  console.log("==== E. 空态与欢迎页 ====");
  console.log(parseSafe(await call(`JSON.stringify({
    welcome: !!document.querySelector('.welcome'),
    welcomeLogo: document.querySelector('.welcome-logo')?.textContent ?? null,
    paneEmpty: [...document.querySelectorAll('.pane-empty')].map((e) => e.textContent.trim().slice(0, 20)),
    sessionEmpty: document.querySelector('.session-empty')?.textContent?.slice(0, 20) ?? null,
  })`)));

  console.log("==== F. slash 菜单 ====");
  await call(`(() => { const i = document.getElementById('input'); i.value = '/'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(400);
  console.log(parseSafe(await call(`JSON.stringify((() => {
    const m = document.getElementById('slash-menu');
    if (!m || m.classList.contains('hidden')) return { open: false };
    const items = [...m.querySelectorAll('.slash-item, [role="option"], button')].slice(0, 50);
    const heights = items.map((i) => Math.round(i.getBoundingClientRect().height));
    return { open: true, items: items.length, minH: Math.min(...heights), maxH: Math.max(...heights) };
  })())`)));
  await call(`(() => { const i = document.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(200);

  console.log("==== G. 滚动条样式 ====");
  console.log(parseSafe(await call(`JSON.stringify((() => {
    const css = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } });
    const sb = css.filter((r) => r.selectorText && r.selectorText.includes('::-webkit-scrollbar')).length;
    return { scrollbarRules: sb };
  })())`)));

  console.log("==== H. 对比弹窗 ====");
  await call(`document.getElementById('btn-compare')?.click(); true`);
  await sleep(400);
  console.log(parseSafe(await call(`JSON.stringify({
    overlay: !!document.querySelector('.cmp-overlay'),
    visible: !document.querySelector('.cmp-overlay')?.classList.contains('hidden'),
    inputs: document.querySelectorAll('.cmp-overlay input, .cmp-overlay textarea').length,
  })`)));
  await call(`(() => { const o = document.querySelector('.cmp-overlay'); if (o) { const b = o.querySelector('.cmp-close, [class*="close"]'); if (b) b.click(); else o.classList.add('hidden'); } return true; })()`);
  await sleep(200);

  console.log("==== I. 通知条 ====");
  console.log(parseSafe(await call(`JSON.stringify({ notice: !!document.getElementById('notice'), hidden: document.getElementById('notice')?.classList.contains('hidden') })`)));

  ws.close();
  console.log("\n取证完成");
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
