"use strict";
/* =====================================================================
 * Copo 官网首页 · 交互机器人体验层
 * 依赖：robot.js（globalThis.CopoRobot，官方剪辑驱动引擎 v2）
 *       website.js 先行渲染 #main 并暴露 globalThis.CopoWebsite.text
 * 职责：随机安全锚点出没与游走、指针注视/靠近反应、点击戳动、拖拽投掷、
 *       滚动反应、闲置入睡与唤醒、区块感知气泡、移动端与 reduced-motion 合规。
 * 结构：纯逻辑挂 globalThis.CopoWebsiteRobotLogic（可单测）；DOM 层自守卫，
 *       首页以外/依赖缺失时静默不渲染，不影响页面其余功能。
 * ===================================================================== */
(() => {
  /* ---------------- 纯逻辑（供 vm 单测） ---------------- */
  const INTERACTIVE = "a,button,input,textarea,select,label,summary,[role=button],[contenteditable=true]";
  const isInteractiveEl = el => !!(el && el.closest && el.closest(INTERACTIVE));
  /* 禁停区：交互物之外，标题/段落/列表等文本块也不停靠（视觉验收：机器人不得压住正文文案） */
  const NO_STOP = INTERACTIVE + ",h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dt,dd,td,th";
  const isBlockedEl = el => !!(el && el.closest && el.closest(NO_STOP));
  /* 官方注视公式（xx）：[(px-cx)/(w*2), -(py-cy)/(w*2)]，钳制 ±1 */
  function gazeFrom(rect, px, py) {
    const clamp = v => Math.max(-1, Math.min(1, v));
    const w = Math.max(1, rect.width);
    return [clamp((px - (rect.left + w / 2)) / (w * 2)), clamp(-(py - (rect.top + rect.height / 2)) / (w * 2))];
  }
  /* 锚点过滤：探测函数 probe(x,y) 返回命中元素；交互物/文本块/空值剔除 */
  function filterAnchors(candidates, probe) {
    return candidates.filter(pt => {
      const el = probe(pt.x, pt.y);
      return !!el && !isBlockedEl(el);
    });
  }
  function pickAnchor(list, rng, avoid) {
    if (!list.length) return null;
    let pool = list.length > 1 && avoid != null ? list.filter(p => p !== avoid) : list;
    if (!pool.length) pool = list;
    return pool[Math.floor(rng() * pool.length) % pool.length];
  }
  function wanderDelay(rng, min = 14, max = 22) { return (min + rng() * (max - min)) * 1000; }
  /* 自主生命感：漂浮（慢正弦微位移）与呼吸（尺度起伏），叠加在锚点之上不参与碰撞 */
  function floatDrift(t, amp = 1) {
    return [Math.sin(t * .0011) * 3.5 * amp, Math.sin(t * .0007 + 1.3) * 2.5 * amp];
  }
  function breath(t, amp = 1) { return 1 + Math.sin(t * .0016) * .015 * amp; }
  /* 自主行为调度：加权随机选择下一个"自己会做的小动作" */
  const AMBIENT = [["gaze", .28], ["hum", .18], ["step", .18], ["tilt", .13], ["listen", .13], ["morph", .1]];
  function pickAmbient(rng) {
    let r = rng() * AMBIENT.reduce((s, a) => s + a[1], 0);
    for (const [k, w] of AMBIENT) { if ((r -= w) < 0) return k; }
    return "gaze";
  }
  function ambientDelay(rng, min = 4, max = 9) { return (min + rng() * (max - min)) * 1000; }
  /* ---- 弹力球物理（拖拽弹簧跟随 / 松手重力弹跳），半隐欧拉、帧率无关 ---- */
  /* springStep：欠阻尼弹簧追目标（k 刚度、c 阻尼），返回 [x,y,vx,vy] —— 拖拽滞后与弹性的手感来源 */
  function springStep(pos, vel, target, dt, k = 170, c = 16) {
    const d = Math.max(.001, Math.min(.05, dt));
    const ax = (target[0] - pos[0]) * k - vel[0] * c;
    const ay = (target[1] - pos[1]) * k - vel[1] * c;
    const vx = vel[0] + ax * d, vy = vel[1] + ay * d;
    return [pos[0] + vx * d, pos[1] + vy * d, vx, vy];
  }
  /* softBounds：弹力球边界 —— 越界反弹（bounce 衰减）并钳回，返回 {x,y,vx,vy,hit}（hit=本帧撞边） */
  function softBounds(pos, vel, box, bounce = .55) {
    let { x, y, vx, vy } = { x: pos[0], y: pos[1], vx: vel[0], vy: vel[1] }, hit = 0;
    if (x < box[0]) { x = box[0]; if (vx < 0) { vx *= -bounce; hit = 1; } }
    if (x > box[2]) { x = box[2]; if (vx > 0) { vx *= -bounce; hit = 1; } }
    if (y < box[1]) { y = box[1]; if (vy < 0) { vy *= -bounce; hit = 1; } }
    if (y > box[3]) { y = box[3]; if (vy > 0) { vy *= -bounce; hit = 1; } }
    return { x, y, vx, vy, hit };
  }
  /* 拖拽中的拟人情绪决策（纯函数）：被抓紧张 / 迎风或被挤眯眼(suspicious) / 晃晕 / 抓太久无聊 */
  function dragMood({ heldMs = 0, reversals = 0, speed = 0, edgePress = false } = {}) {
    if (reversals >= 6 && heldMs > 2200) return "confused";
    if (edgePress || speed > 2.2) return "suspicious";
    if (heldMs > 5200) return "bored";
    return "scared";
  }
  /* 松手落点情绪：高抛受惊→大笑 / 中速笑 / 轻放赞许（被好好对待） */
  function dropMood(speed = 0) {
    if (speed > 1.8) return "scared";
    if (speed > .55) return "laughing";
    return "approving";
  }
  /* 形体轮换（官方 25 体形取 9 的运用）：每次出门换副新样子 */
  const BASE_BODIES = ["sphere", "heartChubby", "cloud", "square"];
  function pickBody(rng, avoid) {
    let pool = BASE_BODIES.filter(b => b !== avoid);
    if (!pool.length) pool = BASE_BODIES.slice();
    return pool[Math.floor(rng() * pool.length) % pool.length];
  }
  /* 表单陪伴阶段：聚焦中且刚打过字=writing（帮你记录），停顿转回 listening（等你继续说） */
  function formStage({ focused = false, lastType = 0, now = 0 } = {}) {
    if (!focused) return null;
    return now - lastType < 1800 ? "writing" : "listening";
  }
  /* 闲置阶段：<30s 无、<60s drowsy、≥60s sleeping */
  function idleStage(idleMs, drowsyAt = 30000, sleepAt = 60000) {
    if (idleMs >= sleepAt) return "sleeping";
    if (idleMs >= drowsyAt) return "drowsy";
    return null;
  }
  const logic = { gazeFrom, filterAnchors, pickAnchor, wanderDelay, idleStage, isInteractiveEl, isBlockedEl,
    floatDrift, breath, pickAmbient, ambientDelay, springStep, softBounds, dragMood, dropMood, pickBody, formStage };
  globalThis.CopoWebsiteRobotLogic = logic;

  /* ---------------- DOM 层 ---------------- */
  const robot = globalThis.CopoRobot;
  const site = globalThis.CopoWebsite;
  if (!robot || !site || document.body.dataset.page !== "home") return;
  const t = path => site.text(path);
  const label = t("landing.robot.label");
  if (!label) return; /* 文案缺失时静默退出 */

  let reduced = !!(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const finePointer = !!(typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches);
  const isMobile = () => innerWidth < 720;
  const SIZE = () => (isMobile() ? 64 : 104);
  const rng = Math.random;
  const events = new AbortController(), timers = new Set(), intervals = new Set();
  let disposed = false, visible = true, frameId = 0, motion = null, observer = null, compact = false;
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (!disposed) fn(); }, ms); timers.add(id); return id; };
  const every = (fn, ms) => { const id = setInterval(fn, ms); intervals.add(id); return id; };
  const on = (node, name, fn, options = {}) => node.addEventListener(name, fn, { ...options, signal: events.signal });
  const performing = () => !!motion?.active || !!motion?.hidden;
  /* 静止退场宽限：开场亮相旅程（入场粒子→走到 logo 旁站定）约 12s 内不判"静止"，
   * 每次门式重现/传送后再宽限 3s——避免"刚出现就消失"的闪隐节奏。 */
  let stayUntil = performance.now() + 12000;
  const reappear = () => { stayUntil = Math.max(stayUntil, performance.now() + 3000); return motion?.controller.show(); };


  /* 配色：与官网 tokens 同源（墨色机身 + 纸白眼睛 + 苔绿点缀） */
  const cssVar = name => getComputedStyle(document.body).getPropertyValue(name).trim();
  const ink = cssVar("--copo-ink") || "#202e2b";
  const bg = cssVar("--copo-bg") || "#ece6e8";
  const accent = cssVar("--copo-accent") || "#246b54";

  const layer = document.createElement("div");
  layer.id = "copo-robot-layer";
  layer.setAttribute("aria-hidden", "false");
  const hit = document.createElement("button");
  hit.type = "button";
  hit.id = "copo-robot-hit";
  hit.className = "copo-robot-hit";
  hit.setAttribute("aria-label", label);
  hit.title = label;
  const host = document.createElement("span");
  host.className = "copo-robot-host";
  host.setAttribute("aria-hidden", "true");
  hit.appendChild(host);
  const bubble = document.createElement("span");
  bubble.id = "copo-robot-bubble";
  bubble.className = "copo-robot-bubble";
  bubble.setAttribute("role", "status");
  bubble.setAttribute("aria-live", "polite");
  layer.appendChild(hit);
  layer.appendChild(bubble);
  document.body.appendChild(layer);

  if (!robot.mount(host, { size: SIZE(), ink, bg, accent, shadow: "rgba(32, 46, 43, .22)" })) return;
  robot.setState("humming");

  /* ---- 位置与锚点 ---- */
  const state = {
    x: 0, y: 0, anchor: null,
    drag: null, fly: null,                             /* 拖拽 / 投掷 */
    step: null, ambientAt: 0,                          /* 自主小动作：微徘徊 / 下次调度时刻 */
    idleAt: performance.now(), lastPointer: null,
    pokeCount: 0, busyUntil: 0, mode: "free",
    bubbleUntil: 0, lastBubbleAt: 0,
    sectionSeen: {}, wanderAt: 0, curious: false, squintSince: 0,
    lastPD: 0, lastPAt: 0, dodgeAt: 0,                 /* 指针距离/时刻与躲避节流 */
  };
  const pad = () => Math.round(SIZE() * .6);
  const safeB = () => parseFloat(cssVar("--copo-robot-safe-b")) || 0;
  const clampX = x => Math.max(pad(), Math.min(innerWidth - SIZE() - pad(), x));
  const clampY = y => Math.max(84, Math.min(innerHeight - SIZE() - pad() - safeB(), y));

  function probe(x, y) {
    const prev = layer.style.visibility;
    layer.style.visibility = "hidden";
    const el = document.elementFromPoint(x, y);
    layer.style.visibility = prev;
    return el;
  }
  function sectionCandidates() {
    const pts = [];
    const vw = innerWidth, vh = innerHeight;
    if (isMobile()) {
      /* 移动端：底部两角（safe-area 由 CSS 底距承担），不遮挡中栏内容 */
      pts.push({ x: vw - SIZE() - 20, y: vh - SIZE() - 96 }, { x: 20, y: vh - SIZE() - 150 });
      return filterAnchors(pts.map(p => ({ x: clampX(p.x), y: clampY(p.y) })), probe);
    }
    const sections = [...document.querySelectorAll("main section, main .workbench-anchor")];
    const vis = sections.filter(s => { const r = s.getBoundingClientRect(); return r.bottom > 120 && r.top < vh - 80; });
    for (const s of vis.slice(0, 4)) {
      const r = s.getBoundingClientRect();
      const side = Math.random() < .5 ? 1 : -1;
      pts.push(
        { x: side > 0 ? vw - SIZE() * 1.4 : SIZE() * .4, y: r.top + r.height * .3 },
        { x: side > 0 ? vw - SIZE() * 1.4 : SIZE() * .4, y: r.top + r.height * .7 },
        { x: vw * (.24 + rng() * .5), y: Math.max(90, r.top - SIZE() * .5) }, /* 区块间隙 */
      );
    }
    return filterAnchors(pts.map(p => ({ x: clampX(p.x), y: clampY(p.y) })), probe);
  }
  function place(pt) { state.x = pt.x; state.y = pt.y; state.anchor = pt;
    layer.style.transform = `translate3d(${Math.round(pt.x)}px, ${Math.round(pt.y)}px, 0)`; /* rAF 停摆时也立即就位 */ }
  function teleport(pt, opts = {}) {
    place(pt); layer.style.transform = `translate3d(${pt.x}px, ${pt.y}px, 0)`;
    /* 每次出门换副新样子（基础形体池避开当前）；表单陪伴传送保持当前形体不打断陪伴氛围 */
    if (!opts.keepBody) robot.setBody(pickBody(rng, robot.body), 12);
    if (!motion?.hidden) reappear();
  }
  function spawn() {
    /* 开场：叠放在顶部 logo 上出现（门式粒子=从 logo 冒出），入场后走到旁边站定；
       无法定位 logo 时退回常规锚点。 */
    const brand = !isMobile() && document.querySelector("#site-header .brand, header .brand, .brand");
    if (brand) {
      const r = brand.getBoundingClientRect();
      place({ x: clampX(r.left + r.width / 2 - SIZE() / 2), y: clampY(r.top - SIZE() * .12) });
    } else {
      const a = pickAnchor(sectionCandidates(), rng, null);
      place(a || { x: innerWidth - SIZE() * 1.6, y: innerHeight * .4 });
    }
  }
  spawn();

  /* ---- 气泡 ---- */
  let bubbleTimer = 0;
  function showBubble(text, ms = 4000) {
    const now = performance.now();
    if (now - state.lastBubbleAt < 60000) return false;
    state.lastBubbleAt = now; state.bubbleUntil = now + ms;
    bubble.textContent = text;
    layer.classList.add("copo-robot-bubbling");
    clearTimeout(bubbleTimer);
    bubbleTimer = later(() => layer.classList.remove("copo-robot-bubbling"), ms);
    return true;
  }

  /* ---- 反应调度：transient 优先于游走/入睡；到期自动回落基态 ---- */
  function react(key, ms) {
    if (performing()) return;
    robot.setState(key);
    state.busyUntil = performance.now() + ms;
    state.mode = "react";
  }
  const idleish = () => ["idle", "humming", "listening", "thinking", "waiting"].includes(robot.state);
  let formMode = false, formTypedAt = 0, formTeleportAt = 0;
  /* 反应到期恢复 free 并回基态（happy/laughing/scared 等无 next 的状态不会自己走）；
   * 表单陪伴模式（writing/listening）由 formStage 管理不在此回落 */
  function settleReact(now) {
    if (state.mode === "react" && now > state.busyUntil) state.mode = "free";
    if (!formMode && state.mode === "free" && now > state.busyUntil && !idleish() && !robot.gating && !state.drag && !state.fly)
      robot.setState("idle");
  }

  /* ---- 指针：注视 + 靠近（桌面） ---- */
  let pointerRaf = 0, lastMove = 0;
  function onPointerMove(e) {
    state.lastPointer = { x: e.clientX, y: e.clientY };
    state.idleAt = performance.now();
    if (state.mode === "sleep") wake();
    if (pointerRaf || reduced || isMobile() || performing() || !visible) return;
    lastMove = e.clientX + e.clientY;
    pointerRaf = requestAnimationFrame(() => {
      pointerRaf = 0;
      const p = state.lastPointer; if (!p) return;
      const rect = host.getBoundingClientRect();
      const [gx, gy] = logic.gazeFrom(rect, p.x, p.y);
      robot.look(gx, gy, 1.1);
      if (state.drag || state.mode === "sleep") return;
      const d = Math.hypot(p.x - (rect.left + rect.width / 2), p.y - (rect.top + rect.height / 2));
      /* 调皮躲避：指针高速冲向它 → 受惊侧闪再好奇回望（节流 2.5s） */
      const nowP = performance.now();
      if (state.lastPAt && d < 190) {
        const closing = (state.lastPD - d) / Math.max(8, nowP - state.lastPAt);
        if (closing > 1.8 && nowP - (state.dodgeAt || 0) > 2500 && !robot.gating) {
          state.dodgeAt = nowP;
          react("scared", 900);
          robot.poke("spin", { turns: 1 });
          const ang = Math.atan2(p.y - (rect.top + rect.height / 2), p.x - (rect.left + rect.width / 2));
          state.step = { dx: -Math.cos(ang) * 26, dy: -Math.sin(ang) * 20, t: 0, dur: 360 };
          later(() => { if (idleish()) react("curious", 1500); }, 420); /* 闪完偷偷回看 */
        }
      }
      state.lastPD = d; state.lastPAt = nowP;
      if (d < 150 && idleish() && !state.curious) { state.curious = true; react("curious", 1600); }
      else if (d > 230 && state.curious && idleish()) { state.curious = false; robot.setState("idle"); }
    });
  }
  on(globalThis, "pointermove", onPointerMove, { passive: true });
  on(globalThis, "keydown", () => { state.idleAt = performance.now(); if (state.mode === "sleep") wake(); }, { passive: true });

  /* ---- 点击/键盘：随机戳动；每 5 次庆祝 + 星光 ---- */
  const POKES = [["spin", { turns: 2 }], ["spin", { turns: 1 }], ["bounce", null], ["nod", null], ["nod", null]];
  function celebrate() {
    react("celebrate", 3200);
    robot.setBody("sparkle", 2.6);
    robot.burst(16);
    showBubble(t("landing.robot.celebrate"), 3200);
  }
  /* 戳动排队：门效（出/入）进行中的点击不丢弃——先计数缓存，门效结束且可见时
   * 由帧循环依序补放（220ms 步进），庆祝同样等门效后触发。
   * 解决：重现聚入动画（1.2s）内连点被整段吞掉、毫无反馈的体验缺口。 */
  let pokeQueue = 0, pokeCelebrate = false, pokeLastAt = 0;
  function drainPokes(now, immediate) {
    if (robot.gating || motion?.hidden) return;
    if (pokeCelebrate) { pokeCelebrate = false; pokeQueue = 0; pokeLastAt = now; celebrate(); return; }
    if (pokeQueue > 0 && (immediate || now - pokeLastAt >= 220)) {
      pokeQueue -= 1; pokeLastAt = now;
      const [kind, opts] = POKES[Math.floor(rng() * POKES.length)];
      robot.poke(kind, opts || undefined);
      state.busyUntil = now + 800;
    }
  }
  function pokeOnce() {
    state.pokeCount += 1;
    state.idleAt = performance.now();
    if (state.pokeCount % 5 === 0) pokeCelebrate = true;
    else pokeQueue = Math.min(pokeQueue + 1, 3); /* 上限防连点堆积 */
    if (!robot.gating) drainPokes(performance.now(), true);
  }
  on(hit, "click", e => {
    if (suppressClick || (state.drag && state.drag.moved)) { suppressClick = false; return; } /* 拖拽结束不触发点击 */
    pokeOnce();
  });

  /* ---- 拖拽（弹簧物理）与松手弹力球 ----
   * 机器人不再贴指针：欠阻尼弹簧滞后跟随（弹力球手感），速度方向拉伸变形，
   * 指针拖出视口时被橡皮筋软钳制在界内（消除边缘切割），撞边挤压变形。 */
  const bounds = () => [pad(), 84, innerWidth - SIZE() - pad(), innerHeight - SIZE() - pad() - safeB()];
  let suppressClick = false;
  hit.style.touchAction = "none";
  on(hit, "pointerdown", e => {
    if (e.button !== 0 || motion?.hidden) return;
    const current = { x: state.x, y: state.y };
    motion?.controller.cancel(); place(current);
    layer.style.transform = `translate3d(${current.x}px, ${current.y}px, 0)`;
    suppressClick = false;
    if (reduced) return;
    e.preventDefault();
    state.drag = { ox: e.clientX - state.x, oy: e.clientY - state.y,
      tx: state.x, ty: state.y, svx: 0, svy: 0,
      heldAt: performance.now(), reversals: 0, lastDir: 0, moved: false, moodAt: 0 };
    state.mode = "drag";
    state.fly = null;
    state.step = null; /* 中断微徘徊 */
    try { hit.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件无 active pointer 时容忍 */ }
    robot.setState("scared");       /* 被抓起：受惊小转（拟人挣扎） */
    robot.poke("spin", { turns: 1 });
    robot.look(0, -.3, .8);
  });
  on(hit, "pointermove", e => {
    const d = state.drag; if (!d) return;
    d.tx = e.clientX - d.ox; d.ty = e.clientY - d.oy;
    const dir = Math.sign(e.movementX || d.tx - state.x);
    if (dir && d.lastDir && dir !== d.lastDir && Math.abs(d.tx - state.x) > 8) d.reversals += 1;
    if (dir) d.lastDir = dir;
    if (Math.hypot(d.tx - state.x, d.ty - state.y) > 6) d.moved = true;
    state.idleAt = performance.now();
  });
  /* 弹簧跟随与拟人情绪在主帧循环里积分（stepDrag 由 frame 调用） */
  function stepDrag(dt, now) {
    const d = state.drag; if (!d) return;
    /* 目标距离截断：指针甩太快时机器人沿方向最多领先追赶 260px，避免弹簧速度爆炸 */
    let tx = d.tx, ty = d.ty;
    const ddx = tx - state.x, ddy = ty - state.y, lead = Math.hypot(ddx, ddy);
    if (lead > 260) { tx = state.x + ddx / lead * 260; ty = state.y + ddy / lead * 260; }
    const sp = logic.springStep([state.x, state.y], [d.svx, d.svy], [tx, ty], dt / 1000);
    d.svx = Math.max(-3400, Math.min(3400, sp[2])); d.svy = Math.max(-3400, Math.min(3400, sp[3]));
    const bb = logic.softBounds([sp[0], sp[1]], [d.svx, d.svy], bounds());
    state.x = bb.x; state.y = bb.y; d.svx = bb.vx; d.svy = bb.vy;
    if (bb.hit) robot.poke("squash");  /* 撞边挤压（弹力球） */
    const speed = Math.hypot(d.svx, d.svy) / 1000;  /* px/ms */
    robot.stretch(Math.min(.3, speed * .16), Math.atan2(d.svy, d.svx) * 180 / Math.PI);
    const bx = bounds();
    const nearEdge = bb.x <= bx[0] + 3 || bb.x >= bx[2] - 3 || bb.y <= bx[1] + 3 || bb.y >= bx[3] - 3;
    if (now - d.moodAt > 400) {
      const mood = logic.dragMood({ heldMs: now - d.heldAt, reversals: d.reversals, speed, edgePress: nearEdge });
      if (robot.state !== mood) {
        robot.setState(mood);
        if (mood === "confused") robot.poke("spin", { turns: 1 });  /* 晃晕了 */
      }
      d.moodAt = now;
    }
  }
  function endDrag(e) {
    const d = state.drag; if (!d) return;
    state.drag = null; suppressClick = d.moved;
    const speed = Math.hypot(d.svx, d.svy) / 1000;   /* px/ms */
    const mood = logic.dropMood(speed);
    state.mode = "free";
    if (mood === "approving") {
      /* 轻放：被好好对待 → 赞许点头，原地小弹 */
      react("approving", 1800);
      robot.poke("bounce"); robot.poke("nod");
      robot.stretch(0, 0);
    } else {
      /* 弹力球：残余速度 + 重力，落地/撞边反弹并挤压，静止后先惊后笑收尾 */
      state.fly = { vx: d.svx * .92, vy: d.svy * .92, settle: "laughing", restAt: 0, laughAt: 0, bornAt: performance.now() };
      robot.setState(mood);
    }
    state.idleAt = performance.now();
    scheduleWander();
  }
  on(hit, "pointerup", endDrag);
  on(hit, "pointercancel", endDrag);

  /* ---- 旅程跟随（用户定义的行为模型）----
   * 开场出现在 logo 旁；滚动停稳 ~380ms 后走/跑到当前模块（速度随滚动快慢）；
   * 页面静止 2s 门式退场，再次滚动在当前模块旁重新出现。 */
  let lastScrollY = scrollY, scrollLastT = 0;
  let scrollVP = 0, settleTimer = 0, lastNavAt = performance.now();
  /* 注：滚动计算为同步节流，无 rAF 句柄 */
  function currentSectionPt() {
    if (isMobile()) { /* 移动端：当前 section 下缘的底部两角取近者 */
      const secs = [...document.querySelectorAll("main section")];
      let best = null;
      for (const s of secs) { const r = s.getBoundingClientRect(); if (r.top <= innerHeight * .45 && r.bottom >= innerHeight * .45) { best = s; break; } }
      const y = clampY((best ? best.getBoundingClientRect().bottom : innerHeight) - SIZE() - 24);
      const cands = [{ x: clampX(innerWidth - SIZE() - 18), y }, { x: clampX(18), y }];
      const ok = filterAnchors(cands, probe);
      return ok[0] || cands[0];
    }
    const secs = [...document.querySelectorAll("main section")];
    let best = null;
    for (const s of secs) { const r = s.getBoundingClientRect(); if (r.top <= innerHeight * .45 && r.bottom >= innerHeight * .45) { best = s; break; } }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    const side = state.anchor && state.anchor.x < innerWidth / 2 ? 1 : -1; /* 左右轮换槽 */
    const pts = [
      { x: side > 0 ? innerWidth - SIZE() - pad() - 8 : pad() + 6, y: clampY(r.top + r.height * .35) },
      { x: side > 0 ? innerWidth - SIZE() - pad() - 8 : pad() + 6, y: clampY(r.top + r.height * .7) },
    ].map(p => ({ x: clampX(p.x), y: p.y }));
    const ok = filterAnchors(pts, probe);
    return ok[0] || null;
  }
  /* 走/跑过去：travel 状态机由主帧循环推进（匀速段 + 到达减速 + 行进朝向 + 步态起伏 + 速度尾迹） */
  function travelTo(pt) {
    const dist = Math.hypot(pt.x - state.x, pt.y - state.y);
    const run = scrollVP > 1600 || dist > 640;
    state.travel = { to: pt, v: run ? 920 : 380, run, t: 0, dist, born: performance.now() };
    state.mode = "free";
    robot.setPerforming?.(true);   /* 行进中弱化剪辑摇摆（引擎 displayFrame） */
  }
  function stepTravel(dt, now) {
    const tr = state.travel; if (!tr) return;
    tr.t += dt;
    const left = Math.hypot(tr.to.x - state.x, tr.to.y - state.y);
    const v = tr.v * Math.min(1, left / 120 + .12);          /* 到达前减速 */
    const step = Math.min(left, v * dt / 1000);
    if (left > 1) {
      const ux = (tr.to.x - state.x) / Math.hypot(tr.to.x - state.x, tr.to.y - state.y) || 0;
      const uy = (tr.to.y - state.y) / Math.hypot(tr.to.x - state.x, tr.to.y - state.y) || 1;
      state.x += ux * step; state.y += uy * step;
      robot.setHeading?.(Math.atan2(uy, ux));
      robot.stretch(Math.min(.22, tr.run ? .2 : .06), Math.atan2(uy, ux) * 180 / Math.PI); /* run 时尾迹明显 */
    }
    if (left <= 3) {
      place({ x: tr.to.x, y: tr.to.y }); /* 到达同帧写定 transform（帧循环下方不再读 state.travel） */
      state.travel = null;
      robot.setHeading?.(null);
      robot.stretch(0, 0);
      robot.setPerforming?.(false);
      state.anchor = { ...tr.to };
      react(tr.run ? "happy" : "idle", tr.run ? 1400 : 0);    /* 跑到了：开心 */
      if (tr.run) robot.poke("bounce");
    }
  }
  function followModule() {
    if (reduced || performing() || state.drag || state.fly || state.travel || formMode || !visible) return;
    if (motion?.hidden) return;
    const pt = currentSectionPt(); if (!pt) return;
    const dist = Math.hypot(pt.x - state.x, pt.y - state.y);
    if (dist < 90) { robot.look(Math.sign(pt.x - state.x) * .5, 0, 1.5); return; }
    travelTo(pt);
  }
  /* 开场第二幕：入场粒子落定后，从 logo 上方走到旁边安全锚点站定（旅程模型） */
  function introWalk() {
    if (reduced || isMobile() || performing() || state.drag || state.fly || state.travel || formMode || !visible || motion?.hidden) return;
    const brand = document.querySelector("#site-header .brand, header .brand, .brand");
    if (!brand) return;
    const r = brand.getBoundingClientRect();
    let pt = { x: clampX(r.right + 28), y: clampY(r.top + r.height / 2 - SIZE() / 2) };
    const el = probe(pt.x + SIZE() / 2, pt.y + SIZE() / 2);
    if (!el || isBlockedEl(el)) pt = pickAnchor(sectionCandidates(), rng, null) || pt;
    if (Math.hypot(pt.x - state.x, pt.y - state.y) > 90) travelTo(pt);
    else robot.look(.6, 0, 1.6);
  }
  on(globalThis, "scroll", () => {
    lastNavAt = performance.now();
    /* 静止退场后再次滚动：在当前模块旁重新出现 */
    if (motion?.hidden && !formMode && !reduced) {
      const pt = currentSectionPt();
      if (pt) place(pt);
      reappear();
    }
    /* 计算用同步节流（不包 rAF）：页面 rAF 被节流/遮挡时旅程状态机仍然工作 */
    const now = performance.now(), dt = now - scrollLastT;
    if (dt < 24) return;
    scrollLastT = now;
    if (reduced || performing() || !visible) return;
    const v = Math.abs(scrollY - lastScrollY) / dt * 1000;
    lastScrollY = scrollY;
    scrollVP = v;
    state.idleAt = now; /* 滚动是活动，重置闲置计时 */
    if (state.mode === "drag" || state.mode === "sleep" || state.travel) return;
    if (v > 2600) react("surprised", 700);
    else if (v > 1400) {
      if (!state.squintSince) state.squintSince = now;
      else if (now - state.squintSince > 1200 && idleish()) react("suspicious", 1500);
    } else state.squintSince = 0;
    /* 滚动停稳后再过去（用户要求：等页面稳定） */
    clearTimeout(settleTimer);
    settleTimer = later(followModule, 380);
  }, { passive: true });
  /* 页面静止 2s 门式退场（表单陪伴/拖拽/表演/反应中不退场） */
  every(() => {
    if (reduced || disposed || !visible || motion?.hidden) return;
    const now = performance.now();
    /* travel 超时兜底：页面 rAF 被节流时旅程不挂死（真实场景 6s 内必然到达） */
    if (state.travel && now - state.travel.born > 6000) {
      place(state.travel.to); state.travel = null;
      robot.setHeading?.(null); robot.stretch(0, 0); robot.setPerforming?.(false);
    }
    const still = now - lastNavAt > 2000 && now >= stayUntil && !formMode && !state.drag && !state.fly && !state.travel
      && !robot.gating && !performing() && state.mode !== "react";
    if (still) { state.travel = null; robot.setPerforming?.(false); pokeQueue = 0; pokeCelebrate = false; motion?.controller?.hide?.(); }
  }, 700);
  /* 其他活动同样视作"在场"：指针/键盘/聚焦刷新在场时刻 */
  on(document, "pointermove", () => { lastNavAt = performance.now(); }, { passive: true });
  on(document, "keydown", () => { lastNavAt = performance.now(); }, { passive: true });
  on(document, "focusin", () => { lastNavAt = performance.now(); }, true);

  /* ---- 闲置入睡 / 唤醒 ---- */
  function wake() {
    state.mode = "free";
    react("waking", 1600);
    layer.classList.remove("copo-robot-sleeping");
  }
  every(() => {
    if (document.hidden || !visible || performing() || state.mode === "drag" || state.mode === "teleport" || state.fly || state.travel) return;
    const now = performance.now();
    const stage = logic.idleStage(now - state.idleAt);
    if (state.mode === "sleep") return;
    if (stage === "sleeping") {
      state.mode = "sleep";
      robot.setState("sleeping");
      layer.classList.add("copo-robot-sleeping");
      showBubble(t("landing.robot.sleep"), 6000);
    } else if (stage === "drowsy" && idleish()) robot.setState("drowsy");
  }, 4000);

  /* ---- 区块感知气泡 ---- */
  const SECTION_HOOKS = [
    { id: "pricing", key: "pricing", state: "happy" },
    { id: "faq", key: "faq", state: "curious" },
    { id: "inquiry", key: "inquiry", state: "approving" },
  ];
  if ("IntersectionObserver" in globalThis && !reduced) {
    const seen = state.sectionSeen;
    const io = observer = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!visible || performing() || !en.isIntersecting || en.intersectionRatio < .3) continue;
        const hook = SECTION_HOOKS.find(h => en.target.id === h.id);
        if (!hook || seen[hook.id] || state.mode === "drag" || state.mode === "sleep") continue;
        seen[hook.id] = true;
        if (performance.now() - state.lastBubbleAt < 180000) continue;
        react(hook.state, 2400);
        showBubble(t(`landing.robot.${hook.key}`), 4600);
      }
    }, { threshold: [.3, .6] });
    for (const h of SECTION_HOOKS) { const el = document.getElementById(h.id); if (el) io.observe(el); }
  }

  /* One position owner: shared motion while performing, gentle idle drift otherwise.
   * 旅程跟随（travel）由本帧循环推进：位移/朝向/步态起伏。 */
  function scheduleWander() { /* 旧 60s 游走已被旅程跟随（滚动→模块）取代，保留空函数兼容调用 */ }
  let frameLast = 0;
  function frame(now) {
    frameId = 0;
    if (disposed || document.hidden || !visible || reduced) return;
    if (!performing()) {
      const dt = frameLast ? Math.min(50, now - frameLast) : 16.7;
      frameLast = now;
      /* 拖拽弹簧跟随（含拉伸/撞边挤压/拟人情绪） */
      if (state.drag) stepDrag(dt, now);
      /* 旅程跟随：走/跑到目标模块（位移+朝向+尾迹），步态正弦起伏 */
      if (state.travel) {
        stepTravel(dt, now);
        if (state.travel) layer.style.transform = `translate3d(${(state.x).toFixed(2)}px, ${(state.y + Math.sin(now * (state.travel.run ? .03 : .018)) * 3).toFixed(2)}px, 0)`;
      }
      /* 松手弹力球：重力 + 边界反弹挤压 + 贴底地面摩擦，静止后先惊后笑收尾 */
      if (state.fly) {
        const f = state.fly, dts = dt / 1000, bx = bounds();
        f.vy += 2600 * dts; f.vx *= Math.pow(.5, dts * .9);   /* 重力 + 微空气阻尼 */
        if (state.y >= bx[3] - 1) f.vx *= Math.pow(.02, dts);  /* 贴底地面摩擦：弹力球终会停下 */
        const bb = logic.softBounds([state.x + f.vx * dts, state.y + f.vy * dts], [f.vx, f.vy], bounds(), .55);
        state.x = bb.x; state.y = bb.y; f.vx = bb.vx; f.vy = bb.vy;
        if (bb.hit) robot.poke("bounce");                      /* 弹跳挤压 */
        if (!f.laughAt && now - f.bornAt > 700) { f.laughAt = 1; robot.setState("laughing"); }
        const spd = Math.hypot(f.vx, f.vy);
        robot.stretch(Math.min(.3, spd / 1000 * .14), Math.atan2(f.vy, f.vx) * 180 / Math.PI);
        if (spd < 140) {
          if (!f.restAt) f.restAt = now;
          if (now - f.restAt > 300) { state.fly = null; robot.stretch(0, 0); react(f.settle, 1600); robot.poke("bounce"); }
        } else f.restAt = 0;
      }
      const moving = state.drag || state.fly;
      robot.setHeading?.(moving && Math.hypot(moving.svx ?? moving.vx, moving.svy ?? moving.vy) > 200 ? Math.atan2(moving.svy ?? moving.vy, moving.svx ?? moving.vx) : null);
      settleReact(now);
      /* 微徘徊（dodge 侧闪/ambient step）：正弦包络叠加位移，不改锚点 */
      let sdx = 0, sdy = 0;
      if (state.step) {
        state.step.t += dt;
        const u = Math.min(1, state.step.t / state.step.dur);
        const env = Math.sin(Math.PI * u);
        sdx = state.step.dx * env; sdy = state.step.dy * env;
        if (u >= 1) state.step = null;
      }
      const driftWeight = Math.min(1, (now - state.idleAt) / 450);
      const fd = logic.floatDrift(now, (state.mode === "sleep" ? .45 : 1) * (state.drag || state.fly ? .3 : 1) * driftWeight);
      layer.style.transform = `translate3d(${(state.x + fd[0] + sdx).toFixed(2)}px, ${(state.y + fd[1] + sdy).toFixed(2)}px, 0)`;
      if (!state.drag && !state.fly) host.style.transform = `scale(${logic.breath(now).toFixed(4)})`;
    }
    drainPokes(now, false); /* 门效结束后补放排队戳动/庆祝 */
    frameId = requestAnimationFrame(frame);
  }
  const startFrame = () => { if (!frameId && !disposed && visible && !reduced && !document.hidden) frameId = requestAnimationFrame(frame); };
  function stopLegacy() {
    for (const id of timers) clearTimeout(id); timers.clear();
    state.drag = null; state.fly = null; state.step = null;
    robot.stretch(0, 0);
    layer.classList.remove("copo-robot-bubbling", "copo-robot-sleeping");
    state.mode = "free"; state.busyUntil = performance.now() + 1000;
  }
  motion = globalThis.CopoRobotMotion?.attach({ target: layer, visual: hit, robot,
    controls: false, /* 官网隐藏动作入口：表演改为跟随用户真实用途联动触发 */
    anchorOnly: true, /* 旅程模型自管落位（开场 logo 旁），不做 safeDock 角落重定位 */
    size: () => compact ? (isMobile() ? 36 : 64) : SIZE(), scale: () => (isMobile() ? 36 : 64) / SIZE(), read: () => ({ x: state.x, y: state.y }),
    write: p => { state.x = p.x; state.y = p.y; layer.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`; },
    before: action => { stopLegacy(); compact = action === 'orbit'; },
    ambient: () => {
      switch (logic.pickAmbient(rng)) {
        case 'gaze': robot.look((rng() * 2 - 1) * .9, (rng() * 2 - 1) * .35, 2); break;
        case 'hum': react('humming', 2600); robot.poke('nod'); break;
        case 'step': motion.controller.play('walk'); break;
        case 'tilt': robot.poke('nod'); break;
        case 'listen': robot.look(0, -.25, 2.2); react('listening', 2400); break;
        case 'morph': robot.setBody(['sparkle', 'star6', 'heart', 'gem', 'clover'][Math.floor(rng() * 5)], 3.5); robot.poke('spin', { turns: 1 }); break;
      }
    },
    idle: () => !state.drag && !state.fly && state.mode !== "react",
    restore: () => { compact = false; state.mode = "free"; state.idleAt = performance.now(); if (!robot.settledFor("idle")) robot.setState("idle"); },
    visibility: v => {
      visible = v;
      if (!v) { stopLegacy(); if (frameId) cancelAnimationFrame(frameId); frameId = 0; }
      else startFrame();
    },
    destroy: () => {
      disposed = true; stopLegacy(); intervals.forEach(clearInterval); intervals.clear(); events.abort(); observer?.disconnect();
      if (frameId) cancelAnimationFrame(frameId); if (pointerRaf) cancelAnimationFrame(pointerRaf);
      layer.remove();
    }
  });
  globalThis.CopoWebsiteRobotMotion = motion;
  /* 旅程跟随调试/验收钩子（只读 + 手动触发，供浏览器验收与测试） */
  globalThis.CopoWebsiteRobotJourney = {
    get traveling() { return !!state.travel; },
    get hidden() { return !!motion?.hidden; },
    target: currentSectionPt,
    follow: followModule,
  };

  /* ---- 用户真实用途联动（机器人对访客在网站里的实际操作做出反应） ---- */
  function lookAtEl(el) {
    const r = el.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const [gx, gy] = logic.gazeFrom(hr, r.left + r.width / 2, r.top + r.height / 2);
    robot.look(gx, gy, 2.4);
  }
  /* 1) 需求表单陪伴：聚焦 → 传送到对话框旁 listening（等你说话）；打字 → writing（帮你记录）；
        停顿 1.8s 回 listening；整体失焦 → 退出陪伴回常规。 */
  const inForm = el => !!(el && el.closest && el.closest("#inquiry-form, #inquiry-dialog"));
  on(document, "focusin", e => {
    if (!inForm(e.target) || reduced) return;
    formMode = true; state.idleAt = performance.now();
    const now = performance.now();
    if (now - formTeleportAt > 45000 && !state.drag && !state.fly && !performing() && !robot.gating) {
      const dlg = document.getElementById("inquiry-dialog");
      if (dlg) {
        const r = dlg.getBoundingClientRect();
        const spot = { x: clampX(Math.min(innerWidth - SIZE() - pad(), r.right + 36)), y: clampY(r.top + 30) };
        const el = probe(spot.x + SIZE() / 2, spot.y + SIZE() / 2);
        if (el && !isBlockedEl(el)) { formTeleportAt = now; teleport(spot, { keepBody: true }); }
      }
    }
    if (robot.state !== "writing") react("listening", 3600);
  }, true);
  on(document, "input", e => {
    if (!inForm(e.target) || reduced) return;
    formTypedAt = performance.now(); state.idleAt = formTypedAt;
    if (robot.state !== "writing") robot.setState("writing");
  }, true);
  every(() => {
    if (!formMode || reduced || state.drag || state.fly || performing()) return;
    const stage = logic.formStage({ focused: formMode, lastType: formTypedAt, now: performance.now() });
    if (stage && robot.state !== stage && (robot.state === "writing" || robot.state === "listening" || idleish()))
      robot.setState(stage);
  }, 900);
  on(document, "focusout", e => {
    if (!inForm(e.target)) return;
    later(() => {
      const a = document.activeElement;
      if (!inForm(a)) {
        formMode = false;
        if (["writing", "listening"].includes(robot.state)) robot.setState("idle");
      }
    }, 140);
  }, true);
  /* 2) 意图达成（生成/下载/复制草稿、打开飞书）：庆祝 + 星光 */
  on(document, "click", e => {
    const b = e.target.closest && e.target.closest("#generate-inquiry, #copy-draft, #open-feishu, #inquiry-form button[type=submit]");
    if (!b || reduced || performing()) return;
    react("celebrate", 2600);
    robot.poke("spin", { turns: 1 });
    robot.burst(12);
  }, true);
  /* 3) CTA/服务标签点击（表达委托意图）：高兴点头（节流 8s） */
  let ctaAt = 0;
  on(document, "click", e => {
    const b = e.target.closest && e.target.closest("main a.button, .faq-contact-action, [data-service]");
    if (!b || reduced || performing() || state.drag) return;
    const now = performance.now();
    if (now - ctaAt < 8000) return;
    ctaAt = now;
    react("happy", 1800); robot.poke("nod");
  }, true);
  /* 4) FAQ 展开问题：好奇歪头看那条 */
  on(document, "click", e => {
    const s = e.target.closest && e.target.closest(".faq-list summary");
    if (!s || reduced || performing()) return;
    react("curious", 2400); lookAtEl(s);
  }, true);
  /* 5) 阅读中划选文本（≥15 字）：好奇看向选区（节流 6s） */
  let selAt = 0;
  on(document, "selectionchange", () => {
    if (reduced || performing() || state.drag) return;
    const now = performance.now();
    if (now - selAt < 6000) return;
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    if ((sel.toString() || "").length < 15) return;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r.width && !r.height) return;
    selAt = now;
    react("curious", 1800);
    lookAtEl({ getBoundingClientRect: () => r });
  });
  /* 6) 语言切换：先惊讶（语言变了？）再高兴点头 */
  on(document, "change", e => {
    if (e.target.id !== "locale-select" || reduced || performing()) return;
    react("surprised", 900);
    later(() => { react("happy", 1600); robot.poke("nod"); }, 900);
  }, true);
  on(document, "visibilitychange", () => {
    if (document.hidden) { if (frameId) cancelAnimationFrame(frameId); frameId = 0; if (pointerRaf) cancelAnimationFrame(pointerRaf); pointerRaf = 0; }
    else startFrame();
  });
  const reducedMedia = matchMedia("(prefers-reduced-motion: reduce)");
  on(reducedMedia, "change", () => { reduced = reducedMedia.matches; if (frameId) cancelAnimationFrame(frameId); frameId = 0; host.style.transform = ""; startFrame(); });
  startFrame();
  let mountedSize = SIZE();
  on(globalThis, "resize", () => {
    state.x = clampX(state.x); state.y = clampY(state.y);
    const s = SIZE();
    if (s !== mountedSize) { /* 跨移动/桌面断点（含手机横竖屏）：按新尺寸重挂 */
      mountedSize = s;
      const old = host.querySelector("canvas");
      if (old) old.remove();
      robot.mount(host, { size: s, ink, bg, accent, shadow: "rgba(32, 46, 43, .22)" });
      robot.setState(state.mode === "sleep" ? "sleeping" : "idle");
      robot.setVisible(visible);
    }
  }, { passive: true });

  /* Entry uses the same cancellable door sequence as recall. */
  if (reduced) layer.classList.add("copo-robot-still");
  else if (!motion?.hidden) {
    reappear();
    later(introWalk, 1700); /* 入场粒子落定后走到 logo 旁站定 */
  }
})();
