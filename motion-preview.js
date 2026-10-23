'use strict';
(() => {
  const resources = { 'zh-CN': { hint: '从右下角选择动作。这里留出完整空间，体验绕屏、冲刺和隐藏召回。' } };
  const text = resources[document.documentElement.lang] || resources['zh-CN'];
  document.getElementById('preview-copy').textContent = text.hint;
  const target = document.getElementById('preview-robot'), visual = document.getElementById('preview-body');
  CopoRobot.mount(visual, { size: 84 });
  globalThis.CopoWebsiteRobotMotion = CopoRobotMotion.attach({ target, visual, robot: CopoRobot,
    restore: () => CopoRobot.setState('idle') });
})();
