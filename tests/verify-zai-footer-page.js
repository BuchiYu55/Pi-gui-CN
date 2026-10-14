(async () => {
  const out = { checks: [] };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  // 等 zai footer 渲染（接口轮询+60s缓存，给足时间）
  let el = null;
  for (let i = 0; i < 20; i++) {
    el = document.getElementById("footer-zai-text");
    if (el && el.children.length > 0) break;
    await wait(1000);
  }
  if (!el) return { fail: "footer-zai-text 不存在" };
  const chips = [...el.children].map(c => c.textContent);
  const css = getComputedStyle(el);
  out.chips = chips;
  out.display = css.display;
  out.flexWrap = css.flexWrap;
  out.whiteSpace = css.whiteSpace;
  out.textOverflow = css.textOverflow;
  const has5h = chips.some(t => /5h/.test(t));
  const hasWeek = chips.some(t => /周/.test(t));
  const hasMcp = chips.some(t => /MCP/.test(t));
  out.checks.push(["芯片含 5h", has5h]);
  out.checks.push(["芯片含 周", hasWeek]);
  out.checks.push(["MCP 段已移除", !hasMcp]); // 2026-10-10 owner 拍板：TIME_LIMIT 段不显示
  out.checks.push(["flex wrap 生效", css.display === "flex" && css.flexWrap === "wrap"]);
  // 每个芯片不折行且整体可换行 = 任何宽度完整可见
  const chipNoWrap = [...el.children].every(c => getComputedStyle(c).whiteSpace === "nowrap");
  out.checks.push(["芯片内部 nowrap", chipNoWrap]);
  out.pass = out.checks.every(c => c[1]);
  return out;
})();
