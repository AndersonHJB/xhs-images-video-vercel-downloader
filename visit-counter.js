// Keep visit reporting independent from the media parsing and download flow.
(() => {
  const container = document.querySelector('[data-visit-counter]');
  if (!container || container.dataset.initialized) return;
  container.dataset.initialized = 'true';

  const toggle = container.querySelector('[data-visit-toggle]');
  const content = container.querySelector('[data-visit-content]');
  const mobileTotal = container.querySelector('[data-visit-mobile-total]');
  const mobileViewport = window.matchMedia('(max-width: 620px), (max-width: 960px) and (max-height: 500px), (hover: none) and (pointer: coarse) and (max-width: 960px)');
  let desktopCollapsed = false;
  let scheduleCollisionCheck = () => {};
  const setCollapsed = (collapsed) => {
    container.dataset.collapsed = String(collapsed);
    content.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? '展开访问统计' : '收起访问统计');
    toggle.title = collapsed ? '展开访问统计' : '收起访问统计';
    scheduleCollisionCheck();
  };
  if (toggle && content) {
    toggle.hidden = false;
    setCollapsed(mobileViewport.matches);
    toggle.addEventListener('click', () => {
      const collapsed = container.dataset.collapsed !== 'true';
      if (!mobileViewport.matches) desktopCollapsed = collapsed;
      setCollapsed(collapsed);
    });
    mobileViewport.addEventListener('change', () => {
      setCollapsed(mobileViewport.matches || desktopCollapsed);
    });

    const collapseMobile = () => {
      if (mobileViewport.matches && container.dataset.collapsed !== 'true') setCollapsed(true);
    };
    // Hide in place when the compact pill would cover a media control.
    let collisionFrame = 0;
    scheduleCollisionCheck = () => {
      if (collisionFrame) return;
      collisionFrame = window.requestAnimationFrame(() => {
        collisionFrame = 0;
        let obstructing = false;
        if (mobileViewport.matches && container.dataset.collapsed === 'true') {
          const pill = container.getBoundingClientRect();
          const controls = document.querySelectorAll('a, button, input, textarea, select, label, video, [role="button"]');
          obstructing = [...controls].some((element) => {
            if (container.contains(element)) return false;
            const rect = element.getBoundingClientRect();
            if (!rect.width || !rect.height || rect.right <= pill.left || rect.left >= pill.right
              || rect.bottom <= pill.top || rect.top >= pill.bottom) return false;
            const style = window.getComputedStyle(element);
            return style.visibility !== 'hidden' && style.opacity !== '0';
          });
        }
        const value = String(obstructing);
        if (container.dataset.obstructing !== value) container.dataset.obstructing = value;
      });
    };
    window.addEventListener('scroll', () => {
      collapseMobile();
      scheduleCollisionCheck();
    }, { passive: true });
    window.addEventListener('resize', scheduleCollisionCheck, { passive: true });
    window.visualViewport?.addEventListener('resize', scheduleCollisionCheck, { passive: true });
    const layoutObserver = new ResizeObserver(scheduleCollisionCheck);
    layoutObserver.observe(document.body);
    layoutObserver.observe(container);
    scheduleCollisionCheck();
    document.addEventListener('pointerdown', (event) => {
      if (!container.contains(event.target)) collapseMobile();
    }, { passive: true });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') collapseMobile();
    });
  }

  const totalElement = container.querySelector('[data-visit-total]');
  const statusElement = container.querySelector('[data-visit-status]');
  const domain = location.hostname.toLowerCase();
  const isLocal = !domain.includes('.')
    || /(^|\.)(localhost|local|test|invalid|example)$/.test(domain)
    || /^\d+\.\d+\.\d+\.\d+$/.test(domain)
    || domain.includes(':');

  // Never send local development visits to the counter service.
  if (!['http:', 'https:'].includes(location.protocol) || isLocal) {
    statusElement.textContent = '本地预览不计入统计';
    return;
  }

  statusElement.textContent = '正在读取访问统计…';
  let hasTotal = false;
  const showUnavailable = () => {
    if (!hasTotal) statusElement.textContent = '访问统计暂时不可用';
  };
  const timeout = window.setTimeout(showUnavailable, 8000);

  // Subscribe before loading the SDK. Do not use data-target: it would
  // overwrite the formatted number after dispatching this event.
  window.addEventListener('bftcounter:update', (event) => {
    const data = event.detail;
    if (!data?.ok || data.domain !== domain || data.project
      || !Number.isSafeInteger(data.total) || data.total < 0) return;

    hasTotal = true;
    window.clearTimeout(timeout);
    totalElement.textContent = data.total.toLocaleString('zh-CN');
    if (mobileTotal) {
      mobileTotal.textContent = new Intl.NumberFormat('zh-CN', {
        notation: 'compact', maximumFractionDigits: 1, roundingMode: 'floor'
      }).format(data.total);
    }
    scheduleCollisionCheck();
    statusElement.textContent = '按当前域名汇总页面浏览次数';
  });

  const script = document.createElement('script');
  script.src = 'https://counter.bornforthis.cn/counter.js';
  script.async = true;
  script.dataset.domain = domain;
  script.addEventListener('error', () => {
    window.clearTimeout(timeout);
    showUnavailable();
  }, { once: true });

  // The official SDK reports one hit and reads stats on load. Loading it once
  // is enough; calling BFTCounter.hit() here would count the same page twice.
  document.head.append(script);
})();
