(() => {
  if (typeof window.__localQuotaIndicator === 'function') return;

  const settingsSelector = '[role="navigation"] [data-testid="settings-button"]';
  const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
  const date = new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
  });

  const host = document.createElement('div');
  host.id = 'local-quota-indicator';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { display:flex; flex:none; align-items:center; gap:3px; padding-inline-start:4px;
      margin:2px 0 4px; color-scheme:light; }
    :host([data-compact]) { justify-content:center; padding-inline-start:0; }
    .gemini { --accent:#1b64bb; --track:#cfdef2; }
    .claude { --accent:#a84724; --track:#efd9cf; }
    .badge { position:relative; display:grid; place-items:center; width:26px; height:26px;
      padding:0; border:0; border-radius:50%; background:transparent; cursor:default; }
    .badge:hover { background:#20242c0b; }
    .badge:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
    .ring { position:absolute; width:16px; height:16px; border-radius:50%;
      background:conic-gradient(var(--accent) var(--five, 0%), var(--track) 0);
      mask:radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.7px)); }
    .core { position:absolute; width:7px; height:7px; border-radius:50%;
      background:linear-gradient(to top, var(--accent) var(--week, 0%), var(--track) 0); }
    .ring.missing, .core.missing { background:#dce0e6; }
    .tip { position:fixed; inset:auto; margin:0; width:236px; max-width:calc(100vw - 16px);
      max-height:calc(100vh - 16px); overflow:auto; padding:11px 13px; box-sizing:border-box;
      border:1px solid #d7dde6; border-radius:8px; box-shadow:0 4px 18px #172a421f;
      background:#fff; color:#20242c; font:12px/1.45 system-ui, 'Microsoft YaHei UI', sans-serif; }
    .title { margin:0 0 8px; font-size:13px; font-weight:650; }
    .title::before { content:''; display:inline-block; width:7px; height:7px;
      border-radius:50%; background:var(--accent); margin-inline-end:6px; }
    .amount { display:flex; justify-content:space-between; gap:10px; font-variant-numeric:tabular-nums; }
    .amount + .amount { margin-top:6px; }
    .reset { margin:0 0 6px; color:#4c586a; font-size:11px; }
    .note { margin:7px 0 0; color:#4c586a; }
  `;
  shadow.append(style);

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  let openTip = null;

  function createBadge(theme, name, matches) {
    const button = element('button', 'badge ' + theme);
    button.type = 'button';
    button.setAttribute('aria-label', name);
    const ring = element('span', 'ring missing');
    const core = element('span', 'core missing');
    button.append(ring, core);
    const tip = element('div', 'tip ' + theme);
    tip.id = 'local-quota-tip-' + theme;
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('popover', 'manual');
    button.setAttribute('aria-describedby', tip.id);
    shadow.append(button, tip);

    let hideTimer = 0;
    function position() {
      const bounds = button.getBoundingClientRect();
      tip.style.left = Math.max(8, Math.min(bounds.right + 6, innerWidth - tip.offsetWidth - 8)) + 'px';
      tip.style.top = Math.max(8, Math.min(bounds.bottom - tip.offsetHeight, innerHeight - tip.offsetHeight - 8)) + 'px';
    }
    function show() {
      clearTimeout(hideTimer);
      if (openTip && openTip !== tip) openTip.hidePopover();
      if (!tip.matches(':popover-open')) tip.showPopover();
      openTip = tip;
      position();
    }
    function hide() {
      if (tip.matches(':popover-open')) tip.hidePopover();
      if (openTip === tip) openTip = null;
    }
    function scheduleHide() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!button.matches(':hover,:focus-visible') && !tip.matches(':hover')) hide();
      }, 125);
    }

    button.addEventListener('pointerenter', show);
    button.addEventListener('pointerleave', scheduleHide);
    button.addEventListener('focus', show);
    button.addEventListener('blur', scheduleHide);
    button.addEventListener('click', show);
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !tip.matches(':popover-open')) return;
      event.stopPropagation();
      hide();
    });
    tip.addEventListener('pointerenter', () => clearTimeout(hideTimer));
    tip.addEventListener('pointerleave', scheduleHide);

    function value(bucket) {
      return typeof bucket?.remaining === 'number' ? percent.format(bucket.remaining) : '暂无数据';
    }
    function draw(marker, property, bucket) {
      const known = typeof bucket?.remaining === 'number';
      marker.classList.toggle('missing', !known);
      if (known) marker.style.setProperty(property, bucket.remaining * 100 + '%');
      else marker.style.removeProperty(property);
    }
    function render(result) {
      const group = result?.data?.groups.find((entry) => matches.test(entry.name));
      const five = group?.buckets.find((bucket) => bucket.period === '5h');
      const weekly = group?.buckets.find((bucket) => bucket.period === 'weekly');
      draw(ring, '--five', five);
      draw(core, '--week', weekly);
      button.setAttribute('aria-label', name + '，5 小时 ' + value(five) + '，每周 ' + value(weekly));
      tip.replaceChildren(element('p', 'title', name));
      for (const [label, bucket] of [['外环 · 5 小时', five], ['内球 · 每周', weekly]]) {
        const row = element('div', 'amount');
        row.append(element('span', '', label), element('strong', '', value(bucket)));
        tip.append(row);
        if (bucket?.resetAt != null) tip.append(element('p', 'reset', date.format(bucket.resetAt) + ' 重置'));
      }
      if (result?.error) {
        tip.append(element('p', 'note', group ? '更新失败，正在显示上次结果。' : '暂时无法读取额度。'));
      } else if (!result?.data) {
        tip.append(element('p', 'note', '正在读取额度…'));
      }
      if (tip.matches(':popover-open')) position();
    }

    return { render, hide, dispose: () => { clearTimeout(hideTimer); hide(); } };
  }

  const badges = [
    createBadge('gemini', 'Gemini Models', /^gemini(?: models?)?$/i),
    createBadge('claude', 'Claude and GPT models', /claude.*gpt|gpt.*claude/i)
  ];
  let lastHeartbeat = Date.now();
  let renderKey = '';
  let frame = 0;

  function mount() {
    const settings = document.querySelector(settingsSelector);
    if (!settings?.parentElement) {
      badges.forEach((badge) => badge.hide());
      host.remove();
      return;
    }
    const nav = settings.closest('[role="navigation"]');
    host.toggleAttribute('data-compact', nav.getBoundingClientRect().width <= 96);
    if (host.nextElementSibling !== settings) settings.before(host);
  }

  const observer = new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; mount(); });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const watchdog = setInterval(() => {
    if (Date.now() - lastHeartbeat >= 30_000) dispose();
  }, 6_000);

  function dispose() {
    observer.disconnect();
    cancelAnimationFrame(frame);
    clearInterval(watchdog);
    badges.forEach((badge) => badge.dispose());
    host.remove();
    if (window.__localQuotaIndicator === update) delete window.__localQuotaIndicator;
  }

  function update(result) {
    lastHeartbeat = Date.now();
    mount();
    const key = String(result?.data?.updatedAt ?? '') + '|' + String(result?.error ?? '');
    if (renderKey === key) return;
    renderKey = key;
    badges.forEach((badge) => badge.render(result));
  }

  window.__localQuotaIndicator = Object.assign(update, { dispose });
})();
