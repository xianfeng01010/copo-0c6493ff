"use strict";
/* Copo-owned motion and effects. No third-party character assets or runtime dependencies. */
(() => {
  const copy = { defaultLocale: 'zh-CN', resources: { 'zh-CN': {
    title: '机器人动作', menu: '动作', walk: '走路', run: '奔跑', rocket: '火箭冲刺', spin: '转一圈', orbit: '绕屏一圈',
    bounce: '弹力跳', pogo: '连续蹦', tumble: '弹跳翻滚', hide: '休息', show: '召回机器人', stop: '停止动作', ready: '随时出发', playing: '正在：',
    space: '这里空间不足，换个位置或扩大窗口后再试。', reduced: '已启用减少动态效果，保留显示和隐藏。',
    hidden: '机器人正在休息', stopped: '动作已停止', unavailable: '动作暂不可用'
  } } };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const ease = t => { const u = clamp(t, 0, 1); return u * u * u * (u * (u * 6 - 15) + 10); };
  function orbitPath(b) {
    const r = Math.min(72, (b.right - b.left) / 4, (b.bottom - b.top) / 4), p = [];
    for (const [x, y, start] of [[b.left + r, b.top + r, Math.PI], [b.right - r, b.top + r, -Math.PI / 2],
      [b.right - r, b.bottom - r, 0], [b.left + r, b.bottom - r, Math.PI / 2]]) {
      for (let i = 0; i <= 16; i++) {
        const a = start + i / 16 * Math.PI / 2;
        p.push({ x: clamp(x + Math.cos(a) * r, b.left, b.right), y: clamp(y + Math.sin(a) * r, b.top, b.bottom) });
      }
    }
    p.push({ ...p[0] }); return p;
  }
  const measurements = new WeakMap();
  function pathSample(path, u) {
    if (!measurements.has(path)) {
      const lengths = path.slice(1).map((p, i) => distance(path[i], p));
      measurements.set(path, { lengths, total: lengths.reduce((a, b) => a + b, 0) });
    }
    const { lengths, total } = measurements.get(path);
    if (u >= 1) { const last = path.at(-1), before = path.at(-2) || last; return { ...last, angle: Math.atan2(last.y - before.y, last.x - before.x) }; }
    let d = total * clamp(u, 0, 1);
    for (let i = 0; i < lengths.length; i++) {
      if (d <= lengths[i] || i === lengths.length - 1) {
        const a = path[i], b = path[i + 1];
        return { ...lerp(a, b, lengths[i] ? d / lengths[i] : 1), angle: Math.atan2(b.y - a.y, b.x - a.x) };
      }
      d -= lengths[i];
    }
    return { ...path[0], angle: 0 };
  }
  function safePath(path, safe) {
    return path.slice(1).every((p, i) => {
      const n = Math.max(1, Math.ceil(distance(path[i], p) / 12));
      for (let j = 0; j <= n; j++) if (!safe(lerp(path[i], p, j / n))) return false;
      return true;
    });
  }
  function route(action, home, b, safe) {
    if (b.right < b.left || b.bottom < b.top) return null;
    if (action === 'orbit') {
      if (b.right - b.left < 120 || b.bottom - b.top < 120) return null;
      const loop = orbitPath(b);
      const start = loop[0];
      const entries = [[home], [home, { x: home.x, y: start.y }], [home, { x: start.x, y: home.y }],
        [home, { x: b.right, y: home.y }, { x: b.right, y: start.y }],
        [home, { x: b.left, y: home.y }, { x: b.left, y: start.y }]];
      for (const entry of entries) {
        const path = [...entry, ...loop, ...entry.slice().reverse()];
        if (safePath(path, safe)) return path;
      }
      return null;
    }
    for (let len = action === 'walk' ? 108 : action === 'rocket' ? 260 : 180; len >= 36; len -= 24) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, -1], [0, 1]]) {
        const end = { x: clamp(home.x + dx * len, b.left, b.right), y: clamp(home.y + dy * len, b.top, b.bottom) };
        if (distance(home, end) >= 36 && safePath([home, end], safe)) return [home, end];
      }
    }
    return null;
  }
  function blendPose(from, to, amount) {
    const out = {};
    for (const key of ['x', 'y', 'scale', 'opacity', 'rotation', 'stretch']) {
      if (key === 'stretch' && to[key] === undefined && from[key] === undefined) continue;
      const a = from[key] ?? 0, b = to[key] ?? 0;
      let delta = b - a;
      if (key === 'rotation') delta = ((delta + 540) % 360) - 180;
      out[key] = a + delta * clamp(amount, 0, 1);
    }
    return out;
  }
  const smooth = t => { const v = clamp(t, 0, 1); return v * v * (3 - 2 * v); };
  // Analytic particles use the controller clock: replayable, bounded, no emitter timers or trailing callbacks.
  function lightParticles(action, u, elapsed, size) {
    if (u <= 0 || u >= 1 || !['run', 'rocket', 'spin', 'orbit', 'tumble', 'hide', 'show'].includes(action)) return [];
    const envelope = smooth(u / .16) * smooth((1 - u) / .2), points = [];
    for (let i = 0; i < (['spin', 'tumble'].includes(action) ? 26 : ['run', 'orbit'].includes(action) ? 24 : 38); i++) {
      const seed = (Math.sin(i * 127.1 + 31.7) * 43758.5453) % 1;
      const phase = ((elapsed / (360 + i % 7 * 24) + i * .618034) % 1 + 1) % 1;
      const theta = i * 2.399963 + elapsed * .00055;
      let x, y;
      if (['rocket', 'run', 'orbit'].includes(action)) {
        x = -size * (.34 + phase * (action === 'rocket' ? 1.7 : 1.1));
        y = Math.sin(theta) * size * (.02 + phase * .1);
      } else if (['spin', 'tumble'].includes(action)) {
        const angle = ease(u) * Math.PI * (action === 'tumble' ? 4 : 2) - phase * Math.PI * .85;
        const radius = size * (.49 + phase * .17 + Math.abs(seed) * .04);
        x = Math.cos(angle) * radius; y = Math.sin(angle) * radius;
      } else {
        const assembling = action === 'show' ? 1 - smooth(u) : smooth(u);
        const radius = size * (.16 + assembling * .46) * Math.sqrt(Math.abs(seed));
        x = Math.cos(theta) * radius;
        y = Math.sin(theta) * radius * .82 + size * .12 * assembling;
      }
      points.push({ x, y, radius: Math.max(.7, size * (.012 + Math.abs(seed) * .012) * (1 - phase * .45)),
        alpha: envelope * (['rocket', 'run', 'orbit', 'spin', 'tumble'].includes(action) ? (1 - phase) ** 1.2 : .35 + .5 * Math.sin(phase * Math.PI)), tint: i % 3 });
    }
    return points;
  }
  function ballPose(u, kind = 'bounce') {
    const t = clamp(u, 0, 1);
    if (t <= 0 || t >= 1) return { lift: 0, stretch: 0, impact: 0 };
    if (t < .1) return { lift: 0, stretch: .14 * Math.sin(t / .1 * Math.PI), impact: 0 };
    const heights = kind === 'pogo' ? [1, .9, .65, .35] : kind === 'tumble' ? [1] : [1, .5, .22];
    if (t >= .9) { const end = heights.at(-1) * .18 * (1 - smooth((t - .9) / .1)); return { lift: 0, stretch: end, impact: end }; }
    const total = heights.reduce((sum, h) => sum + Math.sqrt(h), 0);
    let phase = (t - .1) / .8 * total, i = 0;
    while (i < heights.length - 1 && phase > Math.sqrt(heights[i])) phase -= Math.sqrt(heights[i++]);
    const q = clamp(phase / Math.sqrt(heights[i]), 0, 1), h = heights[i];
    const impact = .18 * ((i ? heights[i - 1] : 0) * Math.exp(-q * 22) + h * Math.exp(-(1 - q) * 22));
    return { lift: 4 * q * (1 - q) * h, stretch: impact - .07 * Math.sin(q * Math.PI) * h, impact };
  }
  function walkClouds(u, elapsed, size) {
    if (u <= 0 || u >= 1) return [];
    const envelope = smooth(u / .14) * smooth((1 - u) / .18);
    return Array.from({ length: 4 }, (_, i) => {
      const age = (elapsed / 550 + i / 4) % 1;
      return { x: -size * (.44 + age * .95), y: size * (.22 - age * .14) + Math.sin(i * 2.3) * size * .035,
        radius: size * (.035 + age * .075), alpha: envelope * (1 - age) * .35 };
    });
  }
  function autoReady(s) {
    return s.foreground && !s.reduced && !s.hidden && !s.active && !s.menu && !s.blocked && s.idle &&
      s.now - s.lastAuto >= 60000 && s.now - s.lastInput >= 5000;
  }
  /** Adapter coordinates are viewport CSS pixels, with bounds for the body's top-left.
   * read/write, bounds/safe, visibility/effect and restore are supplied by each surface.
   * An optional millisecond clock keeps cancellation and path behavior deterministic in tests.
   */
  function create(a) {
    const clock = a.clock || { now: () => performance.now(), request: fn => requestAnimationFrame(fn), cancel: id => cancelAnimationFrame(id) };
    let active = null, raf = 0, destroyed = false, hidden = !!a.hidden, origin = null, began = 0, duration = 0, path = null;
    const notify = result => { a.change?.(result); return result; };
    function clear(restore = true) {
      if (raf) clock.cancel(raf); raf = 0;
      origin = null; active = null; a.effect(null); a.visibility(!hidden);
      if (restore) a.restore();
    }
    function frame(now) {
      raf = 0; if (destroyed || !active) return;
      try {
        const action = active, u = clamp((now - began) / duration, 0, 1);
        let p = { ...origin, angle: 0 }, progress = u;
        if (path) {
          const travel = action === 'rocket' ? clamp((u - .12) / .76, 0, 1) : action === 'orbit' ? clamp((u - 350 / duration) / (1 - 350 / duration), 0, 1) : u;
          progress = ease(travel);
          p = pathSample(path, progress);
          a.write({ x: p.x, y: p.y });
        }
        a.effect({ action, u, progress, ...p, elapsed: now - began });
        if (u >= 1) { clear(); notify({ ok: true }); }
        else raf = clock.request(frame);
      } catch (e) { clear(); /* 单帧失败即收场，杜绝 active 卡住禁用全部联动 */ }
    }
    function begin(action, ms, points = null) {
      origin = { ...a.read() }; active = action; began = clock.now(); duration = ms; path = points;
      try {
        a.visibility(true); a.write(origin); a.effect({ action, u: 0, progress: 0, ...origin, angle: points ? pathSample(points, 0).angle : 0, elapsed: 0 });
        raf = clock.request(frame); return notify({ ok: true });
      } catch (e) {
        /* 首帧失败即收场，杜绝 active 卡住禁用宿主全部联动 */
        origin = null; active = null; if (raf) clock.cancel(raf); raf = 0;
        try { a.effect(null); a.visibility(!hidden); } catch (_) {}
        return notify({ ok: false, reason: 'error' });
      }
    }
    const api = {
      get active() { return active; }, get hidden() { return hidden; },
      play(action, opts = {}) {
        if (destroyed || hidden || !['walk', 'run', 'rocket', 'orbit', 'spin', 'bounce', 'pogo', 'tumble'].includes(action)) return { ok: false, reason: 'unavailable' };
        clear(); a.before?.(action);
        if (a.reduced()) { a.restore(); return notify({ ok: false, reason: 'reduced' }); }
        const home = a.read();
        const stationary = ['spin', 'bounce', 'pogo', 'tumble'].includes(action);
        let points = stationary ? null : route(action, home, a.bounds(), a.safe);
        /* 宿主指定终点（旅程模型返场冲刺）：路径安全则用官方剪辑冲刺到该点，否则回退默认路径 */
        if (!stationary && opts && typeof opts.target === 'object' && opts.target) {
          const b = a.bounds(), tg = { x: clamp(opts.target.x, b.left, b.right), y: clamp(opts.target.y, b.top, b.bottom) };
          if (distance(home, tg) >= 36 && safePath([home, tg], a.safe)) points = [home, tg];
        }
        if (!stationary && !points) { a.restore(); return notify({ ok: false, reason: 'space' }); }
        const total = points ? points.slice(1).reduce((s, p, i) => s + distance(points[i], p), 0) : 0;
        return begin(action, action === 'orbit' ? clamp(total / .46, 6000, 14000) : action === 'spin' ? 1250 : action === 'rocket' ? 1050 : action === 'walk' ? 2800 : action === 'run' ? 1400 : action === 'pogo' ? 2500 : action === 'tumble' ? 1900 : 1800, points);
      },
      cancel() { if (destroyed) return; clear(); notify({ ok: true, stopped: true }); },
      hide() {
        if (destroyed) return; clear(); a.before?.('hide'); hidden = true; a.persist?.(true);
        if (a.reduced()) { a.visibility(false); notify({ ok: true }); return; }
        return begin('hide', 1200);
      },
      show() {
        if (destroyed) return; clear(); a.before?.('show'); hidden = false; a.persist?.(false);
        if (a.reduced()) { a.visibility(true); notify({ ok: true }); return; }
        return begin('show', 1200);
      },
      destroy() { if (destroyed) return; clear(false); destroyed = true; a.visibility(false); }
    };
    a.visibility(!hidden); return api;
  }

  /* DOM presentation: one overlay canvas, one accessible shared action menu. */
  function attach(o) {
    const robot = o.robot || globalThis.CopoRobot, target = o.target, visual = o.visual || o.target;
    if (!target || !robot) return null;
    visual.classList.add('copo-motion-character');
    const events = new AbortController(), signal = events.signal;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const t = key => (copy.resources[document.documentElement.lang] || copy.resources[copy.defaultLocale])[key] || copy.resources[copy.defaultLocale][key] || key;
    const bar = document.createElement('div'); bar.className = 'copo-motion-controls'; bar.dataset.robotControls = '';
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = t('menu');
    toggle.setAttribute('aria-label', t('title')); toggle.setAttribute('aria-expanded', 'false');
    const panel = document.createElement('div'); panel.className = 'copo-motion-menu'; panel.hidden = true;
    panel.id = 'copo-motion-menu'; panel.setAttribute('aria-label', t('title')); toggle.setAttribute('aria-controls', panel.id);
    const status = document.createElement('span'); status.className = 'copo-motion-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const buttons = {};
    for (const action of ['walk', 'run', 'rocket', 'spin', 'orbit', 'bounce', 'pogo', 'tumble', 'hide', 'stop']) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = t(action); b.dataset.robotAction = action;
      if (['rocket', 'orbit'].includes(action)) b.className = 'copo-motion-feature';
      buttons[action] = b; panel.appendChild(b);
    }
    panel.appendChild(status); bar.append(panel, toggle);
    /* controls:false：宿主要求隐藏动作入口（联动由页面驱动）——不挂 DOM，内部状态照常维护 */
    if (o.controls !== false) document.body.appendChild(bar);
    const fx = document.createElement('canvas'); fx.className = 'copo-motion-effects'; fx.setAttribute('aria-hidden', 'true'); document.body.appendChild(fx);
    const ctx = fx.getContext('2d');
    let destroyed = false, lastAuto = performance.now(), lastInput = performance.now();
    let saved = false; try { saved = localStorage.getItem('copo.robot.hidden') === 'true'; } catch (_) { /* optional browser storage */ }
    const reduced = () => media.matches;
    let anchor = null, orbitSize = null;
    const read = () => o.read ? o.read() : anchor || (() => { const r = target.getBoundingClientRect(); return { x: r.left, y: r.top }; })();
    const size = () => orbitSize || (o.size ? o.size() : visual.offsetWidth);
    let dock = read();
    const bounds = () => {
      const header = document.querySelector('header, .wb-header');
      const r = header?.getBoundingClientRect();
      return { left: 12, top: Math.max(90, r && r.bottom > 0 && r.top < 100 ? r.bottom + 12 : 90),
        right: innerWidth - size() - 12, bottom: innerHeight - size() - 86 };
    };
    const setPoint = p => {
      anchor = { x: p.x, y: p.y };
      if (o.write) o.write(p);
      else { target.style.position = 'fixed'; target.style.right = 'auto'; target.style.bottom = 'auto'; target.style.left = p.x + 'px'; target.style.top = p.y + 'px'; }
    };
    const blocked = 'header,nav,input,textarea,select,[contenteditable=true],a,button,[role=dialog],[aria-modal=true]';
    let obstacles = null;
    function obstacleRects(selectors) {
      return [...document.querySelectorAll(selectors)].filter(el => !(target.contains(el) || el === target || el.closest('[data-robot-controls],#copo-robot-layer,.wf-robot-fab-wrap'))).map(el => {
        const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' ? r : null;
      }).filter(Boolean);
    }
    function safe(p, selectors = blocked) {
      const s = size(), inset = s * .1, box = { left: p.x + inset, top: p.y + inset, right: p.x + s - inset, bottom: p.y + s - inset };
      return !(selectors === blocked && obstacles ? obstacles : obstacleRects(selectors)).some(r =>
        r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top);

    }
    function resizeCanvas() { const d = Math.min(devicePixelRatio || 1, 2); fx.width = innerWidth * d; fx.height = innerHeight * d; ctx?.setTransform(d, 0, 0, d, 0, 0); }
    resizeCanvas();
    const accent = getComputedStyle(document.body).getPropertyValue('--copo-accent').trim() || '#697d58';
    const neutralPose = { x: 0, y: 0, scale: 1, opacity: 1, rotation: 0, stretch: 0 };
    let pose = { ...neutralPose }, poseAt = 0, settleRaf = 0;
    function writePose(next) {
      pose = next;
      visual.style.opacity = String(pose.opacity); visual.style.rotate = `${pose.rotation}deg`;
      const stretch = 1 + (pose.stretch || 0);
      visual.style.scale = `${pose.scale * stretch} ${pose.scale / stretch}`; visual.style.translate = `${pose.x}px ${pose.y}px`;
    }
    function stopSettling(reset = false) {
      if (settleRaf) cancelAnimationFrame(settleRaf); settleRaf = 0;
      if (reset) writePose({ ...neutralPose });
    }
    function settlePose() {
      stopSettling();
      if (reduced() || destroyed || controller.hidden) { writePose({ ...neutralPose }); return; }
      const from = { ...pose }, start = performance.now();
      const step = now => {
        settleRaf = 0;
        const u = clamp((now - start) / 340, 0, 1), t = u * u * (3 - 2 * u);
        writePose(blendPose(from, neutralPose, t));
        if (u < 1) settleRaf = requestAnimationFrame(step);
        else { writePose({ ...neutralPose }); visual.style.transformOrigin = ''; }
      };
      settleRaf = requestAnimationFrame(step);
    }
    function draw(f) {
      robot.setHeading?.(f && ['walk', 'run', 'rocket', 'orbit'].includes(f.action) ? f.angle : null);
      target.dataset.robotMotion = f?.action || '';
      if (f) visual.style.transformOrigin = '50% 50%';
      if (ctx) ctx.clearRect(0, 0, innerWidth, innerHeight);
      if (!f) { poseAt = 0; settlePose(); return; }
      stopSettling();
      const desired = { ...neutralPose, scale: f.action === 'orbit' ? o.scale?.('orbit') || size() / visual.offsetWidth : 1 };
      if (f.action === 'orbit') desired.x = desired.y = (size() - visual.offsetWidth) / 2;
      const now = performance.now(), dt = poseAt ? clamp((now - poseAt) / 1000, 0, .05) : .016; poseAt = now;
      const apply = () => writePose(blendPose(pose, desired, 1 - Math.exp(-dt * 16)));
      const s = size(), x = f.x + s / 2, y = f.y + s / 2, u = f.u;
      if (f.action === 'spin') {
        desired.rotation = ease(u) * 360; desired.scale = 1 + .07 * Math.sin(Math.PI * u) ** 2;
        desired.stretch = .055 * Math.sin(u * Math.PI * 4) * Math.sin(Math.PI * u);
        if (ctx) paintLights(lightParticles('spin', u, f.elapsed, s), x, y, 0);
        apply(); return;
      }
      if (['bounce', 'pogo', 'tumble'].includes(f.action)) {
        const ball = ballPose(u, f.action), amplitude = Math.min(s * .8, Math.max(s * .08, f.y - bounds().top));
        desired.y = -amplitude * ball.lift; desired.stretch = ball.stretch;
        if (f.action === 'tumble') {
          desired.rotation = 720 * smooth((u - .1) / .8);
          if (ctx) paintLights(lightParticles('tumble', u, f.elapsed, s), x, y - amplitude * ball.lift, 0);
        }
        if (ctx) {
          ctx.save(); ctx.fillStyle = `rgba(64,100,83,${.12 - ball.lift * .06})`;
          ctx.beginPath(); ctx.ellipse(x, y + s * .38, s * (.28 - ball.lift * .12), s * .045, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        }
        apply(); return;
      }
      if (f.action === 'orbit') {
        desired.y -= Math.sin(f.progress * Math.PI * 12) ** 2 * s * .04;
        desired.rotation = Math.cos(f.angle) * 5 * Math.sin(Math.PI * u);
      }
      if (f.action === 'walk' || f.action === 'run') {
        const running = f.action === 'run', phase = f.progress * Math.PI * (running ? 9 : 4), weight = Math.sin(Math.PI * u);
        desired.y = -(Math.sin(phase) ** 2) * s * (running ? .08 : .035) * weight;
        desired.rotation = Math.cos(f.angle) * (running ? 8 : 4) * weight + Math.sin(phase * 2) * weight;
        desired.stretch = Math.cos(phase * 2) * (running ? .04 : .02) * weight;
      }
      if (f.action === 'hide' || f.action === 'show') {
        const dissolve = smooth((u - .12) / .68), visible = f.action === 'show' ? dissolve : 1 - dissolve;
        desired.opacity = smooth(visible);
        desired.scale = .18 + .82 * visible;
        desired.y = (1 - visible) * s * .12;
        // Showing begins at the gathered pose, before the element becomes visible.
        if (u === 0) writePose(desired); else apply();
        if (!ctx) return;
        paintLights(lightParticles(f.action, u, f.elapsed, s), x, y, 0); return;
      }
      if (f.action === 'rocket') {
        const flight = smooth(u / .2) * smooth((1 - u) / .18);
        desired.rotation = -Math.cos(f.angle) * 12 * flight;
        desired.y = -s * .035 * flight;
        if (u < .12) desired.scale = 1 - Math.sin(u / .12 * Math.PI) * .045;
        if (ctx) paintLights(lightParticles('rocket', u, f.elapsed, s), x, y, f.angle);
      } else if (ctx && ['run', 'orbit'].includes(f.action)) {
        paintLights(lightParticles(f.action, u, f.elapsed, s), x, y, f.angle);
      } else if (ctx && f.action === 'walk') {
        ctx.save(); ctx.translate(x, y); ctx.rotate(f.angle);
        for (const cloud of walkClouds(u, f.elapsed, s)) {
          ctx.save(); ctx.translate(cloud.x, cloud.y); ctx.globalAlpha = cloud.alpha;
          ctx.fillStyle = 'rgba(180,175,191,.9)'; ctx.beginPath();
          for (const [dx, dy, r] of [[-.7, .05, .7], [0, -.25, 1], [.8, .1, .65]]) {
            ctx.moveTo((dx + r) * cloud.radius, dy * cloud.radius);
            ctx.arc(dx * cloud.radius, dy * cloud.radius, r * cloud.radius, 0, Math.PI * 2);
          }
          ctx.fill(); ctx.restore();
        }
        ctx.restore();
      }
      apply();
    }
    function paintLights(points, x, y, angle) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
      // Screen-sized shared layer keeps the bloom outside the robot's canvas uncropped.
      for (const p of points) {
        const color = p.tint === 0 ? '244,237,255' : p.tint === 1 ? '183,165,230' : '233,207,158';
        const r = p.radius * 2.2;
        const bloom = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        bloom.addColorStop(0, `rgba(${color},${p.alpha})`);
        bloom.addColorStop(.22, `rgba(${color},${p.alpha * .75})`);
        bloom.addColorStop(1, `rgba(${color},0)`);
        ctx.fillStyle = bloom; ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
        ctx.fillStyle = `rgba(${p.tint === 0 ? '255,251,239' : p.tint === 1 ? '132,111,188' : '209,166,85'},${p.alpha})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    function safeDock(point) {
      const b = bounds();
      const home = { x: clamp(point.x, b.left, Math.max(b.left, b.right)), y: clamp(point.y, b.top, Math.max(b.top, b.bottom)) };
      const resting = blocked + ',h1,h2,h3,h4,p,li';
      const candidates = [home];
      for (const y of [b.top, b.bottom, (b.top + b.bottom) / 2])
        for (const x of [b.right, b.left, (b.left + b.right) / 2]) candidates.push({ x, y });
      return candidates.find(p => safe(p, resting)) || candidates.find(p => safe(p)) || home;
    }
    /* o.anchorOnly=true：宿主自管落位（旅程模型开场在 logo 旁），仅在越界时钳回，不做 safeDock 重定位 */
    if (o.anchorOnly) { const b = bounds(), d0 = read(); setPoint({ x: clamp(d0.x, b.left, Math.max(b.left, b.right)), y: clamp(d0.y, b.top, Math.max(b.top, b.bottom)) }); }
    else setPoint(safeDock(read()));
    const controller = create({ read, write: setPoint, size, bounds, safe, reduced,
      hidden: saved, persist: v => { try { localStorage.setItem('copo.robot.hidden', String(v)); } catch (_) {} },
      before: action => { o.before?.(action); orbitSize = action === 'orbit' && innerWidth < 720 ? 36 : null; obstacles = obstacleRects(blocked); robot.setPerforming?.(true); },
      restore: () => {
        obstacles = null; orbitSize = null; robot.setPerforming?.(false); o.restore?.();
        // Expanding a compact orbit at an edge must preserve the visible pose while its anchor settles inward.
        if (controller.hidden) return;
        const at = read(), b = bounds(), next = { x: clamp(at.x, b.left, Math.max(b.left, b.right)), y: clamp(at.y, b.top, Math.max(b.top, b.bottom)) };
        if (distance(at, next) > .01) {
          setPoint(next); writePose({ ...pose, x: pose.x + at.x - next.x, y: pose.y + at.y - next.y }); settlePose();
        }
      },
      visibility: v => { if (!v) stopSettling(true); target.hidden = !v; target.style.visibility = v ? '' : 'hidden'; robot.setVisible?.(v); o.visibility?.(v); },
      effect: draw, change: result => {
        if (controller.active || result.stopped) lastAuto = performance.now();
        if (result.reason) status.textContent = t(result.reason);
        else status.textContent = controller.active ? t('playing') + t(controller.active) : controller.hidden ? t('hidden') : result.stopped ? t('stopped') : t('ready');
        buttons.hide.textContent = t(controller.hidden ? 'show' : 'hide');
        toggle.textContent = t(controller.hidden ? 'show' : 'menu');
        for (const key of ['walk', 'run', 'rocket', 'spin', 'orbit', 'bounce', 'pogo', 'tumble']) buttons[key].disabled = reduced() || controller.hidden;
      }
    });
    function refresh() {
      buttons.hide.textContent = t(controller.hidden ? 'show' : 'hide');
      for (const key of ['walk', 'run', 'rocket', 'spin', 'orbit', 'bounce', 'pogo', 'tumble']) buttons[key].disabled = reduced() || controller.hidden;
      status.textContent = reduced() ? t('reduced') : controller.hidden ? t('hidden') : t('ready');
      toggle.textContent = t(controller.hidden ? 'show' : 'menu');
    }
    const syncTheme = () => robot.setTheme?.(getComputedStyle(document.body).getPropertyValue('--copo-bg').trim() || getComputedStyle(document.body).backgroundColor);
    syncTheme();
    const themeObserver = new MutationObserver(syncTheme);
    for (const el of [document.documentElement, document.body]) themeObserver.observe(el, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    const themeMedia = matchMedia('(prefers-color-scheme: dark)'); themeMedia.addEventListener('change', syncTheme, { signal });
    refresh();
    const close = () => { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
    toggle.addEventListener('click', () => {
      if (controller.hidden) { controller.show(); refresh(); return; }
      panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded', String(!panel.hidden));
    }, { signal });
    panel.addEventListener('click', e => {
      const action = e.target.closest('[data-robot-action]')?.dataset.robotAction; if (!action) return;
      if (action === 'hide') { controller.hidden ? controller.show() : controller.hide(); close(); toggle.focus({ preventScroll: true }); refresh(); }
      else if (action === 'stop') controller.cancel(); else { const result = controller.play(action); if (result.ok) { close(); toggle.focus({ preventScroll: true }); } }
    }, { signal });
    document.addEventListener('pointerdown', e => { lastInput = performance.now(); if (!bar.contains(e.target)) close(); }, { signal, passive: true });
    document.addEventListener('keydown', e => {
      lastInput = performance.now(); if (e.key === 'Escape') { controller.cancel(); close(); toggle.focus({ preventScroll: true }); }
    }, { signal });
    document.addEventListener('pointermove', () => { lastInput = performance.now(); }, { signal, passive: true });
    document.addEventListener('scroll', () => { lastInput = performance.now(); if (controller.active) controller.cancel(); }, { signal, passive: true, capture: true });
    const onResize = () => { controller.cancel(); resizeCanvas(); dock = read(); setPoint(safeDock(dock)); };
    addEventListener('resize', onResize, { signal });
    globalThis.visualViewport?.addEventListener('resize', onResize, { signal });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { controller.cancel(); robot.setVisible?.(false); } else robot.setVisible?.(!controller.hidden); }, { signal });
    media.addEventListener('change', () => { controller.cancel(); robot.setReducedMotion?.(media.matches); refresh(); }, { signal });
    const interval = setInterval(() => {
      const now = performance.now();
      const blocked = [...document.querySelectorAll('[aria-modal=true],[role=dialog],dialog[open]')].some(el => el.getBoundingClientRect().width > 0) ||
        !!document.activeElement?.matches('input,textarea,select,[contenteditable]:not([contenteditable=false])');
      if (!autoReady({ now, lastAuto, lastInput, foreground: !document.hidden, reduced: reduced(), hidden: controller.hidden,
        active: controller.active, menu: !panel.hidden, blocked, idle: !o.idle || o.idle() })) return;
      lastAuto = now;
      if (o.ambient) o.ambient(); /* 第4轮：移动端同样获得 ambient 生命感（体验层已将动作约束在卡内） */
      else if (innerWidth < 720) robot.poke('nod');
      else controller.play(Math.random() < .5 ? 'spin' : 'walk');
    }, 2500);
    const destroy = () => { if (destroyed) return; destroyed = true; themeObserver.disconnect(); clearInterval(interval); controller.destroy(); events.abort(); bar.remove(); fx.remove(); robot.destroy?.(); o.destroy?.(); };
    addEventListener('pagehide', destroy, { signal });
    return { controller, destroy, get active() { return controller.active; }, get hidden() { return controller.hidden; }, bounds, safe, read, refresh };
  }
  globalThis.CopoRobotMotion = { create, attach, orbitPath, pathSample, safePath, route, autoReady, blendPose, lightParticles, ballPose, walkClouds, runClouds: walkClouds, travelEase: ease, copy };
})();
