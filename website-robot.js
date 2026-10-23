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
    hop: null,                                         /* 弹力跳（第5轮）：拋物线主弧+落地小弹 */
    step: null, ambientAt: 0,                          /* 自主小动作：微徘徊 / 下次调度时刻 */
    idleAt: performance.now(), lastPointer: null,
    pokeCount: 0, busyUntil: 0, mode: "free",
    bubbleUntil: 0, lastBubbleAt: 0,
    sectionSeen: {}, wanderAt: 0, curious: false, squintSince: 0,
    lastPD: 0, lastPAt: 0, dodgeAt: 0,                 /* 指针距离/时刻与躲避节流 */
    reentry: null, outSince: 0,                        /* 返场状态机 / 出舞台计时 */
  };
  const pad = () => Math.round(SIZE() * .6);
  const safeB = () => parseFloat(cssVar("--copo-robot-safe-b")) || 0;
  const clampX = x => Math.max(pad(), Math.min(innerWidth - SIZE() - pad(), x));
  const clampY = y => Math.max(84, Math.min(innerHeight - SIZE() - pad() - safeB(), y));

  /* 舞台只注册模块内具有实际视觉边框的卡片，不能退回section/container。 */
  const CARD_SELECTOR = ".hero-case-preview,.value-card,.workbench-public-tool,.journey-node,.service-directory,.animated-demo-screen,.project-card,.status-list>li,.faq-contact-card";
  const stageCards = [...document.querySelectorAll("main " + CARD_SELECTOR.split(",").join(",main "))]
    .filter(card => !card.closest("[inert]") && !card.querySelector(CARD_SELECTOR));
  stageCards.forEach((card,i) => { card.dataset.robotStage = `${card.closest("section")?.id || "home"}:${card.classList[0]}:${i}`; });
  let chosenCard = null;
  function stageRectOf(card) {
    if (!card || !stageCards.includes(card)) return null;
    const r = card.getBoundingClientRect();
    return r.width > SIZE()+24 && r.height > SIZE()+24 ? Object.assign(r,{element:card}) : null;
  }
  function currentSection() {
    const focusY = innerHeight * .48;
    const ranked = stageCards.map(card => {
      const r = stageRectOf(card); if (!r) return null;
      const left = Math.max(pad(),r.left), right = Math.min(innerWidth-pad(),r.right);
      const top = Math.max(84,r.top), bottom = Math.min(innerHeight-pad()-safeB(),r.bottom);
      if (right-left < SIZE()+12 || bottom-top < SIZE()+12) return null;
      const distance = Math.abs((top+bottom)/2-focusY);
      return {card,score:distance-(card===chosenCard?42:0)};
    }).filter(Boolean).sort((a,b)=>a.score-b.score);
    chosenCard = ranked[0]?.card || null;
    return chosenCard;
  }
  const inRect = (p, r, m = 10) => !!r && p.x >= r.left - m && p.x + SIZE() <= r.right + m && p.y >= r.top - m && p.y + SIZE() <= r.bottom + m;
  let liveStage = null; /* 主循环节流更新，帧循环免重复测量 */

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
    state.travel = null;
    if (pendingTravel) { clearTimeout(pendingTravel); pendingTravel = 0; }
    state.reentry = null; /* 抓起即中止返场（含蓄力计时，随 timers 清理） */
    cancelHop(); /* 抓起即中止弹力跳 */
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
  let scrollVP = 0, settleTimer = 0, nearStopTimer = 0, lastNavAt = performance.now();
  let recallUntil = 0; /* 边缘登场→跳台窗口：期间 followModule 不抢跑（防止照停靠点近走替代跳台） */
  /* 注：滚动计算为同步节流，无 rAF 句柄 */
  /* 卡片内空位扫描：边列优先、逐行推进，探测机器人中心点（不压正文/交互物）；
     宽卡加中列与 30%/70% 分位列（FAQ 等密集卡正文满铺，只有栏间缝隙可站） */
  let freePointCache = { key: "", points: [] };
  function stageFreePoints(stage) {
    // 在舞台与可见视口的交集内找完整站位，不能把卡外点 clamp 后当卡内点。
    const left = Math.max(stage.left + 12, pad());
    const right = Math.min(stage.right - SIZE() - 12, innerWidth - SIZE() - pad());
    const top = Math.max(stage.top + 14, 84);
    const bottom = Math.min(stage.bottom - SIZE() - 12, innerHeight - SIZE() - pad() - safeB());
    const key = (stage.element?.dataset.robotStage || "") + [left, right, top, bottom, SIZE()].map(Math.round).join(":");
    if (key === freePointCache.key) return freePointCache.points;
    const out = [];
    if (right >= left && bottom >= top) {
      const cols = [left, right, (left + right) / 2, left + (right-left)*.3, left + (right-left)*.7];
      for (let y = top; y <= bottom; y += 28) {
        for (const x of cols) {
          // 身体中心与四角都不得覆盖正文和按钮，保留8px视觉边距。
          const clear = [[8,8],[SIZE()-8,8],[SIZE()/2,SIZE()/2],[8,SIZE()-8],[SIZE()-8,SIZE()-8]]
            .every(([dx,dy]) => { const el = probe(x+dx,y+dy); return el && stage.element.contains(el) && (!isBlockedEl(el) || el.closest(NO_STOP) === stage.element); });
          if (clear) out.push({x,y});
        }
        if (out.length >= 18) break;
      }
    }
    freePointCache = { key, points: out };
    return out;
  }
  function currentSectionPt() {
    const stage = stageRectOf(currentSection());
    if (!stage) return null;
    const pts = stageFreePoints(stage);
    if (pts.length) {
      if (isMobile()) return pts[pts.length - 1]; /* 移动端偏好靠下空位 */
      /* 桌面：就近侧（左右轮换偏好保留：优先离当前锚点同侧的空位） */
      const side = state.anchor ? Math.sign(state.anchor.x - innerWidth / 2) || 1 : 1;
      const same = pts.filter(p => Math.sign(p.x - innerWidth / 2) === side);
      return (same[0] || pts[0]);
    }
    /* 卡片内全被占：不再停靠卡外"站台"——返回 null，由调用方门式退场等待换卡（第4轮：杜绝舞台外） */
    return null;
  }
  /* 走/跑过去：travel 状态机由主帧循环推进（匀速段 + 到达减速 + 行进朝向 + 步态起伏 + 速度尾迹）。
   * 跑动起步先蓄力：官方 curious 动作状态 + squash 挤压 240ms 再出发（冲刺前的压身蓄力）。 */
  let pendingTravel = 0;
  function launchTravel(pt, run) {
    const dist = Math.hypot(pt.x - state.x, pt.y - state.y);
    state.travel = { to: pt, v: run ? 920 : 380, run, t: 0, dist, born: performance.now() };
    state.mode = "free";
    robot.setPerforming?.(true);   /* 行进中弱化剪辑摇摆（引擎 displayFrame） */
  }
  function travelTo(pt) {
    const dist = Math.hypot(pt.x - state.x, pt.y - state.y);
    const run = scrollVP > 1600 || dist > 640;
    if (run && !state.reentry) {
      if (pendingTravel) return;
      react("curious", 900); robot.poke("squash");
      pendingTravel = later(() => { pendingTravel = 0; if (!disposed && !state.drag && !state.fly && !performing()) launchTravel(pt, run); }, 240);
      return;
    }
    launchTravel(pt, run);
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
      const re = state.reentry;
      if (re && re.phase === "walk" && Math.hypot(tr.to.x - re.pad.x, tr.to.y - re.pad.y) < 6) { beginReentryCharge(); return; }
      react(tr.run ? "happy" : "idle", tr.run ? 1400 : 0);    /* 跑到了：开心 */
      if (tr.run) robot.poke("bounce");
    }
  }
  /* ---- 弹力跳（第5轮）：蓄力后沿抛物线跃向新锚点，落地挤压+两次递减小弹——
   * 与拖拽弹力球同源的"弹"感，取代 rocket 直线冲刺（用户反馈：换台生硬、缺弹力跳）。
   * 位移由帧循环推进；空中不做卡内钳制（弧线需要越出卡顶）。 ---- */
  function startHop(from, to) {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < 1) return null; // 近距离也连续移动，不能用place跳过已经展示的蓄势。
    const h = Math.max(0, Math.min(38, dist * .09, Math.min(from.y, to.y) - 84));
    const dur = Math.max(360, Math.min(680, 300 + dist * .48));
    state.hop = { fx: from.x, fy: from.y, tx: to.x, ty: to.y, seg: 0, u: 0,
      arcs: [{ h, dur }, { h: Math.min(4, h * .08), dur: 180 }] };
    robot.setPerforming?.(true); /* 空中削弱剪辑摇摆 */
    return state.hop;
  }
  function cancelHop() {
    if (!state.hop) return;
    state.hop = null;
    robot.stretch(0, 0); robot.setHeading?.(null); robot.setPerforming?.(false);
  }
  function stepHop(dt) {
    const hp = state.hop; if (!hp) return;
    const arc = hp.arcs[hp.seg];
    hp.u = Math.min(1, hp.u + dt / arc.dur);
    const u = hp.u;
    state.x = hp.fx + (hp.tx - hp.fx) * u;
    state.y = hp.fy + (hp.ty - hp.fy) * u - arc.h * 4 * u * (1 - u);
    /* 速度方向（抛物线导数）：升空拉伸、下落前倾，弹性观感来源 */
    const dxp = hp.tx - hp.fx, dyp = (hp.ty - hp.fy) - arc.h * 4 * (1 - 2 * u);
    if (dxp || dyp) {
      const ang = Math.atan2(dyp, dxp || .0001);
      robot.setHeading?.(ang);
      robot.stretch(.025 + .035 * Math.sin(Math.PI * u), ang * 180 / Math.PI);
    }
    if (u >= 1) {
      hp.fx = hp.tx; hp.fy = hp.ty; hp.u = 0; hp.seg += 1;
      // 仅一个<=4px的小回弹，不再叠加引擎bounce的额外弹性。
      if (hp.seg >= hp.arcs.length) {
        place({ x: hp.tx, y: hp.ty });
        state.hop = null;
        robot.stretch(0, 0); robot.setHeading?.(null); robot.setPerforming?.(false);
        const re = state.reentry;
        if (re && re.phase === "jump") { /* 跳台收尾：开心落定，多陪一会儿 */
          state.reentry = null;
          stayUntil = Math.max(stayUntil, performance.now() + 4200);
          react("happy", 1600); robot.poke("nod");
        } else react("happy", 1100); /* 漫游小跳：轻快收尾 */
      }
    }
  }
  /* ---- 返场/跳台（舞台=卡片）：原地蓄力（curious+挤压 260ms）后弹力跳进卡片锚点。
   * 全程位移皆有动画——没有瞬移；蓄力位不在卡外（机器人不停留、不行进在舞台外）。 */
  function startReentry(anchor) {
    if (!anchor || reduced || disposed || performing() || robot.gating || state.drag || state.fly || state.travel || state.hop || pendingTravel || formMode || !visible || motion?.hidden) return false;
    if (Math.hypot(anchor.x - state.x, anchor.y - state.y) < 60) { travelTo(anchor); return true; } /* 近距：直接走回即可 */
    state.reentry = { anchor, pad: { x: state.x, y: state.y }, phase: "walk" }; /* pad=原地，仅保留字段兼容相位读取 */
    beginReentryCharge();
    return true;
  }
  function beginReentryCharge() {
    const re = state.reentry; if (!re || re.phase !== "walk") return;
    re.phase = "charge";
    re.chargeStarted = performance.now();
    react("suspicious", 1200); robot.look(Math.sign(re.anchor.x-state.x)*.85, -.15, 1.2);            /* 蓄力动作状态（官方 curious + 挤压压身） */
    re.chargeTimer = later(() => {
      const cur = state.reentry; if (cur !== re) return;
      // 蓄力期间卡片仍可能移动：起跳前以当前几何重验终点。
      const currentStage = stageRectOf(currentSection());
      if (!currentStage || !inRect(re.anchor, currentStage, 0)) {
        const next = currentSectionPt();
        if (!next && currentStage) { state.reentry = null; robot.stretch(0, 0); return; }
        re.anchor = next || { x: clampX(innerWidth - SIZE() - pad()), y: 84 };
      }
      cur.phase = "jump";
      if (!startHop({ x: state.x, y: state.y }, re.anchor)) { /* 极近距：直接走回 */
        state.reentry = null;
        travelTo(re.anchor);
      }
    }, 680);
  }
  function followModule() {
    if (reduced || !visible) return;
    if (motion?.hidden) { /* 退场中收到跟随请求（停稳兜底）：边缘登场并随即跳台 */
      if (!formMode && !state.reentry) recallFromEdge();
      return;
    }
    if (performance.now() < recallUntil) return; /* 边缘登场→跳台独占窗口：不抢跑 */
    if (performing() || state.drag || state.fly || state.travel || pendingTravel || state.reentry || formMode) return;
    const pt = currentSectionPt();
    const stage = stageRectOf(currentSection());
    if (!pt) {
      /* 没有可见舞台时到右上角候场；没有安全空位时保留角色等待。 */
      if (!stage) startReentry({ x: clampX(innerWidth - SIZE() - pad()), y: 84 });
      // 卡内暂时无安全空位时保持可见，不用隐藏来冒充舞台内驻留。
      return;
    }
    const outside = stage && !inRect({ x: state.x, y: state.y }, stage, 26);
    const dist = Math.hypot(pt.x - state.x, pt.y - state.y);
    if (outside) { startReentry(pt); return; } /* 换舞台：原地蓄力 → rocket 跳进新卡 */
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
  /* ---- 原位置唤醒 → 蓄力弹力跳进当前卡片 ---- */
  function recallFromEdge() {
    if (reduced || formMode || state.reentry || disposed) return;
    const anchor = currentSectionPt();
    if (!anchor) return;
    recallUntil = performance.now() + 6000; /* 登场+跳台独占窗口：settle/nearStop 不再触发 followModule 抢跑 */
    // 显示/唤醒沿用最后的实际位置，不因目标改变而切换到另一条屏幕边。
    state.anchor = { x: state.x, y: state.y };
    reappear();
    let tries = 0;
    const tryJump = () => {
      if (disposed) { recallUntil = 0; return; }
      if (motion?.hidden || state.reentry || state.drag || state.fly || formMode) { recallUntil = 0; return; } /* 已在跳/用户接管 */
      if ((robot.gating || performing() || state.travel || state.hop || pendingTravel) && ++tries < 20) { later(tryJump, 240); return; } /* 等门式登场/行程收尾 */
      /* 终点：登场前捕获的锚点仍在当前卡内就用它（不受 place(dock) 污染）；舞台已换则现算 */
      const st = stageRectOf(currentSection());
      const tgt = st && inRect(anchor, st, 12) ? anchor : (currentSectionPt() || anchor);
      if (!startReentry(tgt) && ++tries < 20) { later(tryJump, 240); return; }
      recallUntil = 0;
    };
    later(tryJump, 520);
  }
  /* ---- 卡内自由运动（第4轮）：机器人把当前卡片当舞台，在卡内空位间漫游，
   * 并按卡片"功能"做风味小动作（定价卡旁开心、FAQ 旁好奇、表单旁赞许……）。
   * 移动端同样参与——此前手机端机器人几乎完全静止。 ---- */
  const SECTION_ACTS = [
    { sec: ".hero-rich", els: ".hero-actions .button, .hero-demo-link", state: "happy" },
    { sec: "#advantages", els: ".value-card", state: "curious" },
    { sec: ".showcase-section", els: ".service-tag-cloud a", state: "curious" },
    { sec: "#demo", els: ".animated-demo-screen", state: "listening" },
    { sec: "#pricing", els: ".project-card, .project-visual .offer-badge", state: "happy" },
    { sec: "#status", els: ".status-list li", state: "curious" },
    { sec: "#faq", els: ".faq-list summary", state: "curious" },
    { sec: "#inquiry", els: ".closing-actions .button, #inquiry-dialog", state: "approving" },
  ];
  function stageFlavor(sec) {
    if (!sec) return null;
    return SECTION_ACTS.find(a => sec.matches(a.sec) || sec.closest(a.sec)) || null;
  }
  /* force: 验收钩子可指定分支（"walk"|"hop"|"act"）；缺省按权重随机 */
  let roamWhy = ""; /* 最近一次漫游未触发的守卫原因（诊断） */
  function roamInStage(force) {
    roamWhy = "";
    if (reduced || disposed || !visible || motion?.hidden || performing() || robot.gating) { roamWhy = "busy"; return false; }
    if (state.drag || state.fly || state.travel || state.reentry || state.hop || pendingTravel || formMode || state.mode === "sleep") { roamWhy = "journey"; return false; }
    if (document.querySelector("dialog[open], [aria-modal='true']")) { roamWhy = "modal"; return false; } /* 模态框打开时不漫游 */
    const sec = currentSection(), stage = stageRectOf(sec);
    if (!stage || !state.anchor || !inRect(state.anchor, stage, 12)) { roamWhy = "anchor-out"; return false; } /* 锚点不在卡内：交给旅程/看护 */
    const pts = stageFreePoints(stage).filter(p => Math.hypot(p.x - state.anchor.x, p.y - state.anchor.y) >= 120);
    if (!pts.length || force === "act") {
      const act = stageFlavor(sec);
      const el = act && sec.querySelector(act.els);
      if (el) lookAtEl(el);
      react(act ? act.state : "curious", 2200); robot.poke("nod");
      // 没有第二个安全落脚点时仍响应本卡内容，避免遮挡正文来凑位移。
      return force !== "walk" && force !== "hop";
    }
    /* 风味：优先走向本卡功能元素旁的空位，并看向该元素 */
    const act = stageFlavor(sec);
    let lookEl = null, target = null;
    if (act && act.els) {
      const vis = [...sec.querySelectorAll(act.els)].filter(el => {
        const r = el.getBoundingClientRect();
        return r.width && r.bottom > stage.top && r.top < stage.bottom;
      });
      if (vis.length) {
        lookEl = vis[Math.floor(rng() * vis.length)];
        const r = lookEl.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        target = pts.slice().sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0];
      }
    }
    if (!target) target = pts[Math.floor(rng() * pts.length)];
    const roll = force === "walk" ? 0 : force === "hop" ? .8 : force === "act" ? .9 : rng();
    if (roll < .7) { /* 步行过去，到达后看向功能元素并带上该卡的表情 */
      launchTravel(target, false);
      if (lookEl) later(() => {
        if (disposed || !idleish()) return;
        lookAtEl(lookEl);
        react(stageFlavor(currentSection())?.state || "curious", 1800);
      }, 1800);
      return true;
    }
    if (roll < .85) { /* 卡内弹力小跳（第5轮：拋物线+落地小弹）——移动端同样可用 */
      robot.poke("squash"); react("curious", 600);
      const dest = { x: target.x, y: target.y };
      later(() => {
        if (disposed || state.drag || state.fly || state.travel || state.reentry || state.hop || pendingTravel || performing()) return;
        if (!startHop({ x: state.x, y: state.y }, dest)) launchTravel(dest, false);
      }, 200);
      return true;
    }
    /* 原地风味动作：看向功能元素 + 表情 + 点头 */
    if (lookEl) lookAtEl(lookEl);
    react(act ? act.state : "curious", 2200);
    robot.poke("nod");
    return true;
  }
  on(document, "toggle", () => { freePointCache.key = ""; }, true);
  on(globalThis, "resize", () => { freePointCache.key = ""; });
  let roamAt = 0; /* 下次卡内漫游时刻（700ms 看护循环调度） */
  on(globalThis, "scroll", () => {
    lastNavAt = performance.now();
    /* 计算用同步节流（不包 rAF）：页面 rAF 被节流/遮挡时旅程状态机仍然工作 */
    const now = performance.now(), dt = now - scrollLastT;
    if (dt < 24) return;
    scrollLastT = now;
    const v = Math.abs(scrollY - lastScrollY) / dt * 1000;
    lastScrollY = scrollY;
    scrollVP = v;
    /* 静止退场后再次滚动：减速（或离散跳转）时从屏幕边缘门式登场，随即蓄力跳进当前卡片 */
    if (motion?.hidden && !formMode && !reduced && !state.reentry && (v < 900 || dt > 120)) recallFromEdge();
    if (reduced || !visible) return;
    state.idleAt = now; /* 滚动是活动，重置闲置计时 */
    /* 连续快速滚动换舞台：从当前实际位置接续蓄力，不隐藏换边。
       离散跳转（键盘/脚本瞬时滚动，事件间隔大）不适用——交给停稳跳台。 */
    if (v > 2400 && dt < 120 && !motion?.hidden && !state.reentry && !formMode && !performing()) {
      const st0 = stageRectOf(currentSection());
      if (st0 && !inRect({ x: state.x, y: state.y }, st0, 30)) {
        cancelHop(); state.travel = null; state.reentry = null;
        if (pendingTravel) { clearTimeout(pendingTravel); pendingTravel = 0; }
        state.anchor = { x: state.x, y: state.y };
        followModule();
      }
    }
    /* 滚动甩掉了进行中的行程：目标已不在当前卡片 → 就地取消，等待跳台 */
    if (state.travel) {
      const st1 = stageRectOf(currentSection());
      if (st1 && !inRect(state.travel.to, st1, 40)) {
        state.travel = null;
        robot.setHeading?.(null); robot.stretch(0, 0); robot.setPerforming?.(false);
        state.anchor = { x: state.x, y: state.y };
      }
    }
    if (state.hop) {
      const st2 = stageRectOf(currentSection());
      if (st2 && !inRect({ x: state.hop.tx, y: state.hop.ty }, st2, 40)) {
        cancelHop(); state.reentry = null;
        state.anchor = { x: state.x, y: state.y };
      }
    }
    if (state.mode === "drag" || state.mode === "sleep") return;
    if (v > 2600) react("surprised", 700);
    else if (v > 1400) {
      if (!state.squintSince) state.squintSince = now;
      else if (now - state.squintSince > 1200 && idleish()) react("suspicious", 1500);
    } else state.squintSince = 0;
    /* 停稳兜底 380ms（用户要求：等页面稳定；此前 travel 中会漏排，第4轮修复） */
    clearTimeout(settleTimer);
    settleTimer = later(followModule, 380);
    /* "即将停止"提前跳台：舞台已换（锚点不在当前卡）且滚动减速 → 140ms 防抖即跳，
       不必等完全停稳——用户要看到"卡片将停时蓄力跳到新舞台" */
    if (v > 0 && v < 900 && state.anchor) {
      const st = liveStage || stageRectOf(currentSection());
      if (st && !inRect(state.anchor, st, 26)) {
        clearTimeout(nearStopTimer);
        nearStopTimer = later(followModule, 140);
      }
    }
  }, { passive: true });
  /* 页面静止 2s 门式退场（表单陪伴/拖拽/表演/反应中不退场）；并承担舞台看护与返场收尾 */
  every(() => {
    if (reduced || disposed || !visible) return;
    const now = performance.now();
    liveStage = stageRectOf(currentSection());
    /* 舞台看护：拖拽/投掷落点或 resize 后不在当前卡片内 → 1.4s 后原地蓄力跳回；
       卡满且人在卡外 → 门式退场等待换卡（第4轮：任何情况都不停靠舞台外） */
    if (!state.travel && !state.hop && !state.drag && !state.fly && !state.reentry && !pendingTravel && !formMode && !performing() && !motion?.hidden) {
      const target = currentSectionPt();
      const out = liveStage && !inRect({ x: state.x, y: state.y }, liveStage, 30);
      if (liveStage && target && inRect(target, liveStage, 12) && out) {
        if (!state.outSince) state.outSince = now;
        else if (now - state.outSince > 280) { state.outSince = 0; startReentry(target); }
      } else if (liveStage && !target && out) {
        if (!state.outSince) state.outSince = now;
        else if (now - state.outSince > 280) { state.outSince = 0; robot.look(0, -.3, 1.5); }
      } else state.outSince = 0;
    } else state.outSince = 0;
    /* 卡内漫游：空闲且锚点在卡内 → 每 9–20s 换个空位或做按卡风味动作（移动端同样参与） */
    if (!roamAt) roamAt = now + 4000 + rng() * 6000;
    else if (now >= roamAt && !state.drag && !state.fly && !state.travel && !state.hop && !state.reentry && !pendingTravel && !formMode && !motion?.hidden && !performing()) {
      if (now - lastNavAt < 4000) roamAt = now + 2600; /* 用户正活跃：稍后再说 */
      else { roamInStage(); roamAt = now + (9 + rng() * 11) * 1000; }
    }
    if (motion?.hidden) return;
    /* travel 超时兜底：页面 rAF 被节流时旅程不挂死（真实场景 6s 内必然到达） */
    if (state.travel && now - state.travel.born > 6000) {
      place(state.travel.to); state.travel = null;
      robot.setHeading?.(null); robot.stretch(0, 0); robot.setPerforming?.(false);
    }
    const still = !liveStage && now - lastNavAt > 2000 && now >= stayUntil && !formMode && !state.drag && !state.fly && !state.travel && !state.hop && !state.reentry
      && !robot.gating && !performing() && state.mode !== "react";
    if (still) followModule();
  }, 140);
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
  function scheduleWander() { /* 第4轮：拖拽/投掷结束等时机提示看护循环尽早安排一次卡内漫游 */
    if (!reduced) roamAt = Math.min(roamAt || Infinity, performance.now() + 2600);
  }
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
      /* 弹力跳：拋物线主弧+落地小弹（位移/朝向/拉伸由 stepHop 推进，帧循环尾部统一写 transform） */
      if (state.hop) stepHop(dt);
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
      if (!state.hop) /* 弹力跳自管朝向（速度方向），不被此处置空 */
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
      const fd = logic.floatDrift(now, (state.mode === "sleep" ? .45 : 1) * (state.drag || state.fly ? .3 : 1) * driftWeight * (state.travel || state.hop || state.reentry ? 0 : 1));
      let px = state.x + fd[0] + sdx, py = state.y + fd[1] + sdy;
      /* 自由漂浮钳在舞台（卡片）内：锚点在卡片内时，微徘徊/漂浮不越出卡片（弹力跳空中不钳制——弧线需越出卡顶） */
      if (!state.travel && !state.reentry && !state.hop && liveStage && inRect({x:px,y:py}, liveStage, 0)) {
        px = Math.max(liveStage.left + 4, Math.min(liveStage.right - SIZE() - 4, px));
        py = Math.max(liveStage.top + 4, Math.min(liveStage.bottom - SIZE() - 4, py));
      }
      px = clampX(px); py = clampY(py);
      layer.style.transform = `translate3d(${px.toFixed(2)}px, ${py.toFixed(2)}px, 0)`;
      if (state.reentry?.phase === "charge") {
        const re=state.reentry, u=Math.max(0,Math.min(1,(now-re.chargeStarted)/420));
        const dir=Math.sign(re.anchor.x-state.x)||1, pull=Math.sin(u*Math.PI/2);
        // 头部原地压低、反向抵住拉力，末段轻颤；不添加手或固定边框点。
        const tremble=u>.65?Math.sin(now*.045)*.65:0;
        host.style.transformOrigin="50% 82%";
        host.style.transform=`translate(${-dir*7*pull+tremble}px,${4*pull}px) rotate(${-dir*7*pull}deg) scale(${1+.12*pull},${1-.24*pull})`;
      } else if (!state.drag && !state.fly) {
        host.style.transformOrigin="50% 50%";
        host.style.transform = `scale(${logic.breath(now).toFixed(4)})`;
      }
    }
    drainPokes(now, false); /* 门效结束后补放排队戳动/庆祝 */
    frameId = requestAnimationFrame(frame);
  }
  const startFrame = () => { if (!frameId && !disposed && visible && !reduced && !document.hidden) frameId = requestAnimationFrame(frame); };
  function stopLegacy() {
    for (const id of timers) clearTimeout(id); timers.clear();
    state.drag = null; state.fly = null; state.step = null; state.hop = null; if (pendingTravel) pendingTravel = 0;
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
      /* 动作状态回归：闲置时偶发卡片内对角火箭冲刺（官方 rocket 剪辑，含蓄力与光尾）；
         第4轮起移动端同样参与。舞台一律现算（liveStage 可能滞后于滚动），旅程/返场中不做自主位移。 */
      if (state.travel || state.reentry || state.hop || pendingTravel || state.drag || state.fly) return;
      const st = stageRectOf(currentSection());
      const inSt = !!st && !!state.anchor && inRect(state.anchor, st, 12) && inRect({ x: state.x, y: state.y }, st, 14);
      if (inSt && rng() < .16) {
        const far = currentSectionPt();
        if (far && inRect(far, st, 12) && Math.hypot(far.x - state.x, far.y - state.y) > 220) {
          motion.controller.play('rocket', { target: far });
          return;
        }
      }
      switch (logic.pickAmbient(rng)) {
        case 'gaze': robot.look((rng() * 2 - 1) * .9, (rng() * 2 - 1) * .35, 2); break;
        case 'hum': react('humming', 2600); robot.poke('nod'); break;
        case 'step': { /* 卡内短步：终点取卡内空位（不用视口边界随机走，防走出当前卡） */
          let done = null;
          if (inSt) {
            const near = stageFreePoints(st).filter(p => {
              const d = Math.hypot(p.x - state.x, p.y - state.y);
              return d >= 60 && d <= 200;
            });
            if (near.length) done = motion.controller.play('walk', { target: near[Math.floor(rng() * near.length)] });
          }
          if (!done || done.ok === false) state.step = { dx: (rng() * 2 - 1) * 22, dy: (rng() * 2 - 1) * 12, t: 0, dur: 520 };
          break;
        }
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
    get hopping() { return !!state.hop; },
    get reentry() { return state.reentry ? state.reentry.phase : null; },
    get hidden() { return !!motion?.hidden; },
    get stageId() { return currentSection()?.dataset.robotStage || ""; },
    get stageBounds() { const r=stageRectOf(currentSection()); return r?{left:r.left,top:r.top,right:r.right,bottom:r.bottom}:null; },
    get hopInfo() { return state.hop ? {height:state.hop.arcs[0].h,rebounds:state.hop.arcs.length-1,reboundHeight:state.hop.arcs[1].h,segment:state.hop.seg}:null; },
    get inStage() { const st = stageRectOf(currentSection()); return !!st && inRect({ x: state.x, y: state.y }, st, 30); },
    get roamReady() { /* 诊断：卡内漫游的守卫快照（验收排查用） */
      const st = stageRectOf(currentSection());
      return { hidden: !!motion?.hidden, active: !!motion?.active, gating: !!robot.gating, travel: !!state.travel, reentry: !!state.reentry,
        anchor: state.anchor ? [Math.round(state.anchor.x), Math.round(state.anchor.y)] : null, anchorInStage: !!st && !!state.anchor && inRect(state.anchor, st, 12), freePts: st ? stageFreePoints(st).length : 0, why: roamWhy };
    },
    target: currentSectionPt,
    follow: followModule,
    roam: mode => { roamAt = 0; return roamInStage(mode); },
    jump: pt => startReentry(pt || currentSectionPt()),
  };

  /* ---- 用户真实用途联动（机器人对访客在网站里的实际操作做出反应） ---- */
  function lookAtEl(el) {
    const r = el.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const [gx, gy] = logic.gazeFrom(hr, r.left + r.width / 2, r.top + r.height / 2);
    robot.look(gx, gy, 2.4);
  }
  /* 1) 需求表单陪伴：聚焦 → 走到对话框旁 listening（等你说话）；打字 → writing（帮你记录）；
        停顿 1.8s 回 listening；整体失焦 → 退出陪伴回常规。（步行过去，不瞬移） */
  const inForm = el => !!(el && el.closest && el.closest("#inquiry-form, #inquiry-dialog"));
  on(document, "focusin", e => {
    if (!inForm(e.target) || reduced) return;
    formMode = true; state.idleAt = performance.now();
    const now = performance.now();
    if (now - formTeleportAt > 45000 && !state.drag && !state.fly && !state.travel && !pendingTravel && !state.reentry && !performing() && !robot.gating) {
      const dlg = document.getElementById("inquiry-dialog");
      if (dlg) {
        /* 卡内陪伴：取当前卡内离对话框最近的空位（第4轮：不再站到卡片外对话框右侧） */
        const st = liveStage || stageRectOf(currentSection());
        let spot = null;
        if (st) {
          const r = dlg.getBoundingClientRect(), fx = r.right + 36, fy = r.top + 30;
          spot = stageFreePoints(st).slice().sort((a, b) => Math.hypot(a.x - fx, a.y - fy) - Math.hypot(b.x - fx, b.y - fy))[0] || null;
        }
        if (spot) { formTeleportAt = now; travelTo(spot); }
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
