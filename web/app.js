const app = document.querySelector('#app');
let cleanups = [];
let researcherData = null;
let researcherTab = 'overview';

const svg = {
  arrow: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11m-4-4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 5-5 5 5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  download: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v9m-3-3 3 3 3-3M4 15h12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function cleanup() {
  cleanups.forEach((dispose) => { try { dispose(); } catch {} });
  cleanups = [];
}

function later(callback, delay) {
  const timer = setTimeout(callback, delay);
  cleanups.push(() => clearTimeout(timer));
  return timer;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function pct(value, digits = 1) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(digits)}%` : '—';
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
}

function lineChart(series, valueKey, { min = 0, max = 1, yLabel = '', xLabel = '' } = {}) {
  const width = 760; const height = 260; const left = 54; const right = 18; const top = 18; const bottom = 42; const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const allPoints = series.flatMap((entry) => entry.points.filter((point) => Number.isFinite(Number(point[valueKey]))));
  if (!allPoints.length) return '<div class="chart-empty">尚无足够数据形成轨迹</div>';
  const xValues = allPoints.map((point) => Number(point.x)); const xMin = Math.min(...xValues); const xMax = Math.max(...xValues); const yMin = Number(min); const yMax = Number(max);
  const x = (value) => left + (Number(value) - xMin) / Math.max(1, xMax - xMin) * plotWidth;
  const y = (value) => top + (yMax - Number(value)) / Math.max(1e-9, yMax - yMin) * plotHeight;
  const grid = Array.from({ length: 5 }, (_, index) => { const value = yMin + (yMax - yMin) * index / 4; const py = y(value); return `<line x1="${left}" y1="${py}" x2="${width - right}" y2="${py}" class="chart-grid"/><text x="${left - 8}" y="${py + 4}" text-anchor="end" class="chart-label">${value >= 10 ? value.toFixed(0) : value.toFixed(2)}</text>`; }).join('');
  const lines = series.map((entry) => { const points = entry.points.filter((point) => Number.isFinite(Number(point[valueKey]))).map((point) => `${x(point.x)},${y(point[valueKey])}`).join(' '); if (!points) return ''; return `<polyline points="${points}" class="chart-line ${entry.group}"/><g class="chart-dots">${entry.points.filter((point) => Number.isFinite(Number(point[valueKey]))).map((point) => `<circle cx="${x(point.x)}" cy="${y(point[valueKey])}" r="2.4" class="${entry.group}"><title>${entry.group === 'scarcity' ? '稀缺组' : '富足组'} · ${point.label || point.x}: ${formatNumber(point[valueKey], valueKey === 'purchaseRate' ? 3 : 1)} · n=${point.n}</title></circle>`).join('')}</g>`; }).join('');
  return `<div class="chart-legend"><span><i class="scarcity"></i>稀缺组</span><span><i class="abundance"></i>富足组</span></div><svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(yLabel)}随${escapeHtml(xLabel)}变化曲线">${grid}<line x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}" class="chart-axis"/><line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" class="chart-axis"/>${lines}<text x="${width / 2}" y="${height - 8}" text-anchor="middle" class="chart-title">${escapeHtml(xLabel)}</text><text x="14" y="${height / 2}" text-anchor="middle" transform="rotate(-90 14 ${height / 2})" class="chart-title">${escapeHtml(yLabel)}</text></svg>`;
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '请求失败，请稍后重试');
  return payload;
}

function setBusy(button, busy, label = '正在提交…') {
  if (!button) return;
  if (!button.dataset.originalLabel) button.dataset.originalLabel = button.innerHTML;
  button.disabled = busy;
  button.innerHTML = busy ? label : button.dataset.originalLabel;
}

function formError(form, message) {
  form.querySelector('.form-error')?.remove();
  form.insertAdjacentHTML('beforeend', `<p class="form-error" role="alert">${escapeHtml(message)}</p>`);
}

function brandHeader() {
  return `<header class="site-header"><a class="brand" href="/"><span class="brand-mark">S2</span><span><span class="brand-title">价值表征与资源决策</span><span class="brand-subtitle">Study 2 · 连续消费实验</span></span></a><span class="header-chip">本地研究平台</span></header>`;
}

function renderHome() {
  cleanup();
  document.title = 'Study 2｜价值表征与资源决策';
  app.innerHTML = `<main class="home-simple"><section class="home-simple-inner"><h1>Study 2</h1><p>心理学实验研究平台</p><div class="home-actions"><a class="btn secondary" href="/researcher">研究者登录</a><a class="btn" href="/start">被试入口</a></div><div class="home-note">价值表征与动态资源决策实验</div></section></main>`;
}

function renderStart() {
  cleanup();
  document.title = '被试入口｜Study 2';
  if (sessionStorage.getItem('study2-participant-gate') === 'open') return renderParticipantForms();
  app.innerHTML = `<main class="center-page"><section class="card elevated form-card"><a class="back-link" href="/">${svg.back} 返回首页</a><p class="eyebrow">PARTICIPANT</p><h1 class="form-title">被试入口</h1><p class="form-copy">请输入实验员提供的入口密码。验证通过后，可登记新被试或继续已有实验。</p><form id="participant-gate" class="form-grid"><div class="field"><label for="gate-password">入口密码</label><input id="gate-password" name="password" type="password" autocomplete="current-password" required autofocus></div><button class="btn full" type="submit">验证并继续 ${svg.arrow}</button></form></section></main>`;
  const form = document.querySelector('#participant-gate');
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); const button = form.querySelector('button'); setBusy(button, true, '正在验证…');
    try { await api('/api/auth/participant', { method: 'POST', body: JSON.stringify({ password: new FormData(form).get('password') }) }); sessionStorage.setItem('study2-participant-gate', 'open'); renderParticipantForms(); }
    catch (error) { formError(form, error.message); setBusy(button, false); }
  });
}

function renderParticipantForms() {
  cleanup();
  app.innerHTML = `<main class="center-page"><section class="card elevated form-card wide"><a class="back-link" href="/">${svg.back} 返回首页</a><p class="eyebrow">PARTICIPANT</p><h1 class="form-title">被试信息登记</h1><p class="form-copy">请先填写主试告知的被试编号。系统会使用该编号完成实验分组和数据匹配；中途退出后也使用同一编号继续。</p><form id="register-form" class="form-grid"><div class="field"><label>被试编号（由主试告知）*</label><input name="participantNumber" maxlength="30" placeholder="例如 S2-001" autocomplete="off" required><span class="field-help">请严格按照主试提供的编号填写，编号必须以数字结尾。</span></div><div class="form-grid two"><div class="field"><label>姓名 *</label><input name="name" maxlength="60" autocomplete="name" required></div><div class="field"><label>性别 *</label><select name="gender" required><option value="">请选择</option><option>男</option><option>女</option><option>其他 / 不便回答</option></select></div><div class="field"><label>年龄 *</label><input name="age" type="number" min="15" max="80" required></div><div class="field"><label>专业 *</label><input name="major" maxlength="80" required></div></div><div class="field"><label>联系方式（选填）</label><input name="contact" maxlength="80" autocomplete="tel"><span class="field-help">仅用于实验安排或被试费核对。</span></div><label class="consent-row"><input name="consent" type="checkbox" required><span>我已了解实验包含知觉判断与选择任务，自愿参加，并知道可以随时联系实验员。</span></label><button class="btn full" type="submit">登记并开始实验 ${svg.arrow}</button></form><div class="form-divider">继续已有实验</div><form id="resume-form" class="form-grid"><div class="field"><label>被试编号</label><input name="code" placeholder="输入主试告知的被试编号" autocomplete="off" required></div><button class="btn full secondary" type="submit">继续已有实验</button></form></section></main>`;
  const register = document.querySelector('#register-form');
  register.addEventListener('submit', async (event) => {
    event.preventDefault(); const button = register.querySelector('button[type="submit"]'); setBusy(button, true, '正在登记…'); const data = Object.fromEntries(new FormData(register));
    try {
      const result = await api('/api/participants/register', { method: 'POST', body: JSON.stringify({ participantNumber: data.participantNumber, name: data.name, gender: data.gender, age: Number(data.age), major: data.major, contact: data.contact, consent: data.consent === 'on' }) });
      location.href = `/experiment?code=${encodeURIComponent(result.code)}&session=${encodeURIComponent(result.sessionId)}`;
    } catch (error) { formError(register, error.message); setBusy(button, false); }
  });
  const resume = document.querySelector('#resume-form');
  resume.addEventListener('submit', async (event) => {
    event.preventDefault(); const button = resume.querySelector('button'); setBusy(button, true, '正在查找…');
    try { const result = await api('/api/sessions/resume', { method: 'POST', body: JSON.stringify({ code: new FormData(resume).get('code') }) }); location.href = `/experiment?code=${encodeURIComponent(result.code)}&session=${encodeURIComponent(result.sessionId)}`; }
    catch (error) { formError(resume, error.message); setBusy(button, false); }
  });
}

function experimentContext() {
  const params = new URLSearchParams(location.search);
  return { code: params.get('code') || '', sessionId: params.get('session') || '' };
}

async function submitExperiment(context, action, payload = {}) {
  return api('/api/experiment/submit', { method: 'POST', body: JSON.stringify({ code: context.code, sessionId: context.sessionId, action, ...payload }) });
}

async function renderExperiment() {
  cleanup();
  const context = experimentContext();
  if (!context.code || !context.sessionId) { app.innerHTML = `<main class="center-page"><section class="card form-card"><h1 class="form-title">缺少实验信息</h1><p class="form-copy">请从被试入口登记或输入被试编号继续。</p><a class="btn" href="/start">前往被试入口</a></section></main>`; return; }
  app.innerHTML = `<main class="loading-screen"><div class="spinner"></div><p>正在载入实验进度…</p></main>`;
  try { const state = await api(`/api/experiment/state?code=${encodeURIComponent(context.code)}&session=${encodeURIComponent(context.sessionId)}`); document.title = `${state.stageLabel}｜Study 2`; renderStage(state, context); }
  catch (error) { app.innerHTML = `<main class="center-page"><section class="card form-card"><h1 class="form-title">无法载入实验</h1><p class="form-error">${escapeHtml(error.message)}</p><a class="btn secondary" href="/start">返回被试入口</a></section></main>`; }
}

function experimentFrame(state, content, withinProgress = '') {
  const overall = Math.min(100, Math.max(0, state.stageIndex / state.totalStages * 100));
  const progress = withinProgress || `第 ${Math.min(state.stageIndex + 1, state.totalStages)} / ${state.totalStages} 部分`;
  app.innerHTML = `<div class="experiment-shell">${brandHeader()}<div class="experiment-progress"><div><div class="progress-track"><span style="width:${overall}%"></span></div><span>${escapeHtml(progress)}</span></div></div><main class="experiment-main"><div class="experiment-meta"><div><div class="stage-name">${escapeHtml(state.stageLabel)}</div><div class="stage-meta">被试编号：${escapeHtml(state.participantCode)}</div></div></div><section class="experiment-card">${content}</section></main></div>`;
}

function stageHeading(title, copy = '') { return `<div class="stage-heading"><h1>${escapeHtml(title)}</h1>${copy ? `<p>${escapeHtml(copy)}</p>` : ''}</div>`; }

function renderStage(state, context) {
  const renderers = {
    baseline: renderBaseline,
    preference_practice: renderPreferencePractice,
    calibration: renderCalibration,
    validation: renderValidation,
    resource_feedback: renderResourceFeedback,
    resource_practice: renderResourcePractice,
    resource_task: renderResourceTask,
    manipulation_check: renderManipulationCheck,
    cost_learning: renderCostLearning,
    purchase: renderPurchase,
    post_check: renderPostCheck,
    economic_background: renderEconomicBackground,
    complete: renderComplete,
  };
  (renderers[state.stage] || renderUnknown)(state, context);
}

function scaleQuestion(name, label, anchors = ['完全不同意', '完全同意']) {
  return `<div class="question"><div class="question-label">${escapeHtml(label)}</div><div class="scale-anchors"><span>${escapeHtml(anchors[0])}</span><span>${escapeHtml(anchors[1])}</span></div><div class="scale">${[1, 2, 3, 4, 5, 6, 7].map((number) => `<label><input type="radio" name="${escapeHtml(name)}" value="${number}" required><span>${number}</span></label>`).join('')}</div></div>`;
}

function renderBaseline(state, context) {
  const content = `${stageHeading('实验开始前状态', '请只根据此刻的实际状态作答。答案没有对错，预计用时约1分钟。')}<form id="baseline-form" class="question-list">${scaleQuestion('mood', '我此刻整体心情良好。')}${scaleQuestion('hunger', '我此刻感到饥饿。')}${scaleQuestion('sleepQuality', '我昨晚的睡眠质量良好。')}<div class="action-row"><button class="btn" type="submit">提交并继续 ${svg.arrow}</button></div></form>`;
  experimentFrame(state, content);
  const form = document.querySelector('#baseline-form');
  form.addEventListener('submit', async (event) => { event.preventDefault(); const button = form.querySelector('button'); setBusy(button, true); try { await submitExperiment(context, 'baseline', { payload: Object.fromEntries(new FormData(form)) }); renderExperiment(); } catch (error) { formError(form, error.message); setBusy(button, false); } });
}

function pairChoiceMarkup(trial, prompt = '请选择你更喜欢的图形') {
  return `<p class="trial-prompt">${escapeHtml(prompt)}</p><div class="choice-grid"><button id="choice-left" class="choice-card" type="button"><img src="${trial.left.imageUrl}" alt="左侧抽象图形"><span class="key">按F键或点击：选择左侧</span></button><div class="choice-vs"><span>或</span></div><button id="choice-right" class="choice-card" type="button"><img src="${trial.right.imageUrl}" alt="右侧抽象图形"><span class="key">按J键或点击：选择右侧</span></button></div><p class="keyboard-note">键盘操作：F键选择左侧图形，J键选择右侧图形。</p>`;
}

function bindTrialKeys(map) {
  const handler = (event) => {
    if (event.repeat || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const callback = map[event.key.toLowerCase()]; if (callback) { event.preventDefault(); callback('keyboard'); }
  };
  window.addEventListener('keydown', handler); cleanups.push(() => window.removeEventListener('keydown', handler));
}

function runPairTrial(state, context, options) {
  const progress = options.progress;
  experimentFrame(state, `<div class="fixation" aria-label="注视点">+</div>`, progress);
  later(() => {
    const card = document.querySelector('.experiment-card'); if (!card) return;
    card.innerHTML = `${stageHeading(options.title, options.copy)}<p class="trial-counter">${escapeHtml(options.counter)}</p>${pairChoiceMarkup(options.trial, options.prompt)}`;
    const started = performance.now(); let submitting = false;
    const respond = async (response, method = 'mouse', timeout = false) => {
      if (submitting) return; submitting = true;
      document.querySelectorAll('.choice-card').forEach((node) => { node.disabled = true; });
      try {
        const result = await submitExperiment(context, options.action, { trialKey: options.trial.key, response, responseMethod: method, timeout, rtMs: response ? performance.now() - started : null });
        if (options.feedback) { card.innerHTML = `<div class="simple-feedback">${escapeHtml(result.feedbackText || options.feedback(response))}</div>`; later(renderExperiment, 600); }
        else { card.innerHTML = '<div class="blank-interval" aria-hidden="true"></div>'; later(renderExperiment, 300); }
      } catch (error) { alert(error.message); renderExperiment(); }
    };
    document.querySelector('#choice-left').addEventListener('click', () => respond('left', 'mouse'));
    document.querySelector('#choice-right').addEventListener('click', () => respond('right', 'mouse'));
    bindTrialKeys({ f: (method) => respond('left', method), j: (method) => respond('right', method) });
    if (options.timeoutMs) later(() => respond(null, 'timeout', true), options.timeoutMs);
  }, options.fixationMs ?? 500);
}

function instructionKey(context, suffix) { return `study2:${context.sessionId}:${suffix}`; }

function renderPreferencePractice(state, context) {
  const key = instructionKey(context, 'preference-practice-instructions');
  if (!sessionStorage.getItem(key)) {
    const content = `${stageHeading('视觉偏好任务操作说明', '请先完成4次练习，熟悉左右图形选择。')}<div class="instruction-list"><div class="instruction-step">每轮会同时呈现左右两个抽象图形。</div><div class="instruction-step">按F键选择左侧图形，按J键选择右侧图形；也可以直接点击相应图形。</div><div class="instruction-step">本任务没有客观正确答案，请按照第一感觉作答。练习结果不进入正式分析。</div></div><div class="action-row"><button id="start-preference-practice" class="btn">开始4次练习 ${svg.arrow}</button></div>`;
    experimentFrame(state, content, `视觉偏好练习 0 / 4`);
    document.querySelector('#start-preference-practice').addEventListener('click', () => { sessionStorage.setItem(key, 'done'); renderPreferencePractice(state, context); });
    return;
  }
  if (!state.trial) return renderExperiment();
  runPairTrial(state, context, { title: '视觉偏好任务练习', copy: '请按照自己的第一感觉选择更喜欢的图形。', counter: `练习 ${state.completed + 1} / ${state.total}`, progress: `视觉偏好练习 ${state.completed} / ${state.total}`, prompt: '请选择你更喜欢的图形', trial: state.trial, action: 'preference_practice_response', fixationMs: 0, feedback: (response) => response === 'left' ? '你选择了左侧图形' : '你选择了右侧图形' });
}

function renderCalibration(state, context) {
  const key = instructionKey(context, 'calibration-instructions');
  if (!sessionStorage.getItem(key)) {
    const content = `${stageHeading('视觉偏好任务', '接下来通过多轮两两比较，稳定建立你对25个抽象图形的个人喜爱等级。')}<div class="instruction-list"><div class="instruction-step">每轮先出现注视点，然后呈现两个图形。</div><div class="instruction-step">请只根据主观喜爱程度选择，不考虑图形可能代表的价格或其他含义。</div><div class="instruction-step">任务包含组内全配对、重复确认和跨组校准。部分图形会再次出现，这是稳定性测量的一部分。</div><div class="instruction-step">按F键选择左侧图形，按J键选择右侧图形；也可以直接点击相应图形。</div></div><div class="action-row"><button id="start-calibration" class="btn">开始正式偏好任务 ${svg.arrow}</button></div>`;
    experimentFrame(state, content, '视觉偏好任务准备');
    document.querySelector('#start-calibration').addEventListener('click', () => { sessionStorage.setItem(key, 'done'); renderCalibration(state, context); });
    return;
  }
  if (!state.trial) return renderExperiment();
  runPairTrial(state, context, { title: '视觉偏好任务', copy: '请根据主观喜爱程度，选择你更喜欢的图形。', counter: `${state.phaseLabel} · 第 ${state.completed + 1} / ${state.total} 轮`, progress: `${state.phaseLabel} ${state.completed} / ${state.total}`, prompt: '请选择你更喜欢的图形', trial: state.trial, action: 'calibration_response', timeoutMs: 180000 });
}

function renderValidation(state, context) {
  if (state.validationFailed) {
    const content = `${stageHeading('偏好结果需要重新校准', `不同喜爱等级比较的一致率为 ${pct(state.consistencyRate)}，未达到85%的预设质量标准。系统将重新进行成对比较校准。`)}<p class="form-copy">这不是对错判断，而是为了保证后续价格任务中的个体喜爱等级足够稳定。</p><div class="action-row"><button id="restart-calibration" class="btn">重新进行成对比较校准</button></div>`;
    experimentFrame(state, content, `偏好确认 ${state.completed} / ${state.total}`);
    document.querySelector('#restart-calibration').addEventListener('click', async (event) => { setBusy(event.currentTarget, true); try { await submitExperiment(context, 'restart_calibration'); sessionStorage.removeItem(instructionKey(context, 'calibration-instructions')); renderExperiment(); } catch (error) { alert(error.message); setBusy(event.currentTarget, false); } });
    return;
  }
  if (!state.trial) return renderExperiment();
  runPairTrial(state, context, { title: '视觉偏好确认', copy: '请继续按照主观喜爱程度选择。该部分用于验证喜爱等级的稳定性。', counter: `第 ${state.completed + 1} / ${state.total} 轮`, progress: `偏好确认 ${state.completed} / ${state.total}`, prompt: '请选择你更喜欢的图形', trial: state.trial, action: 'validation_response', timeoutMs: 180000 });
}

function renderResourceFeedback(state, context) {
  experimentFrame(state, `${stageHeading('任务信息', '请认真阅读资源账户说明。')}<div class="feedback-copy">${escapeHtml(state.feedbackText)}</div><div class="action-row"><button id="advance-feedback" class="btn">我已阅读，进入练习 ${svg.arrow}</button></div>`);
  document.querySelector('#advance-feedback').addEventListener('click', async (event) => { setBusy(event.currentTarget, true); try { await submitExperiment(context, 'advance_feedback'); renderExperiment(); } catch (error) { alert(error.message); setBusy(event.currentTarget, false); } });
}

function dotPositions(count, seed) {
  let value = seed >>> 0; const random = () => { value += 0x6d2b79f5; let t = value; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return Array.from({ length: count }, () => `<span class="dot" style="left:${8 + random() * 84}%;top:${8 + random() * 84}%"></span>`).join('');
}

function resourceStimulus(trial, interactive = true) {
  if (trial.type === 'dot_comparison') return `<p class="trial-prompt">哪一侧的点更多？</p><div class="dot-grid"><button id="resource-left" class="dot-panel" type="button" ${interactive ? '' : 'disabled'} aria-label="左侧点阵">${dotPositions(trial.leftDots, trial.dotSeed)}</button><button id="resource-right" class="dot-panel" type="button" ${interactive ? '' : 'disabled'} aria-label="右侧点阵">${dotPositions(trial.rightDots, trial.dotSeed + 911)}</button></div><p class="keyboard-note">键盘操作：F键表示左侧点更多，J键表示右侧点更多。</p>`;
  return `<p class="trial-prompt">两个图形是否相同？</p><div class="dot-grid"><div class="shape-panel"><span class="shape ${trial.leftShape}"></span></div><div class="shape-panel"><span class="shape ${trial.rightShape}"></span></div></div><div class="action-row"><button id="resource-left" class="btn secondary" type="button">按F键或点击：相同</button><button id="resource-right" class="btn secondary" type="button">按J键或点击：不同</button></div>`;
}

function renderResourcePractice(state, context) {
  const key = instructionKey(context, 'resource-practice-instructions');
  if (!sessionStorage.getItem(key)) {
    const content = `${stageHeading('资源账户任务操作说明', '正式任务前先完成6次真实反馈练习。')}<div class="instruction-list"><div class="instruction-step">点数比较：判断左侧或右侧区域中的点更多。</div><div class="instruction-step">图形匹配：判断两个图形是否相同。</div><div class="instruction-step">练习顺序为4次点数比较和2次图形匹配，练习只显示正确/错误，不改变正式账户。</div><div class="instruction-step">正式任务每轮限时3秒，请在看清后尽快作答。</div></div><div class="action-row"><button id="start-resource-practice" class="btn">开始6次练习 ${svg.arrow}</button></div>`;
    experimentFrame(state, content, '资源任务练习 0 / 6');
    document.querySelector('#start-resource-practice').addEventListener('click', () => { sessionStorage.setItem(key, 'done'); renderResourcePractice(state, context); });
    return;
  }
  if (!state.trial) return renderExperiment();
  experimentFrame(state, `${stageHeading('资源账户任务练习', '练习结果不计入正式账户。')}<p class="trial-counter">练习 ${state.completed + 1} / 6</p>${resourceStimulus(state.trial)}`, `资源任务练习 ${state.completed} / 6`);
  const started = performance.now(); let submitting = false;
  const leftResponse = state.trial.type === 'dot_comparison' ? 'left' : 'same'; const rightResponse = state.trial.type === 'dot_comparison' ? 'right' : 'different';
  const respond = async (response) => {
    if (submitting) return; submitting = true;
    try { const result = await submitExperiment(context, 'resource_practice_response', { response, rtMs: performance.now() - started }); document.querySelector('.experiment-card').innerHTML = `<div class="simple-feedback ${result.correct ? 'correct' : 'incorrect'}">${result.correct ? '✓ 正确' : '✗ 错误'}</div>`; later(renderExperiment, 650); }
    catch (error) { alert(error.message); renderExperiment(); }
  };
  document.querySelector('#resource-left').addEventListener('click', () => respond(leftResponse)); document.querySelector('#resource-right').addEventListener('click', () => respond(rightResponse)); bindTrialKeys({ f: () => respond(leftResponse), j: () => respond(rightResponse) });
}

function renderResourceTask(state, context) {
  if (state.needBlockCheck) return renderBlockCheck(state, context);
  if (!state.trial) return renderExperiment();
  experimentFrame(state, `<div class="fixation">+</div>`, `资源账户任务 ${state.completed} / ${state.total}`);
  later(() => {
    const card = document.querySelector('.experiment-card'); if (!card) return;
    card.innerHTML = `${stageHeading('资源账户任务', '请在3秒内完成判断，并留意每轮后的账户反馈。')}<div class="resource-status"><div class="status-box"><span>当前余额</span><strong>${state.balance}</strong></div><div class="status-box"><span>通关要求</span><strong>10</strong></div><div class="status-box"><span>任务进度</span><strong>${state.completed + 1} / ${state.total}</strong></div></div>${resourceStimulus(state.trial)}`;
    const started = performance.now(); let submitting = false;
    const leftResponse = state.trial.type === 'dot_comparison' ? 'left' : 'same'; const rightResponse = state.trial.type === 'dot_comparison' ? 'right' : 'different';
    const respond = async (response) => {
      if (submitting) return; submitting = true;
      try { const result = await submitExperiment(context, 'resource_response', { response, rtMs: response ? performance.now() - started : null }); card.innerHTML = `<div class="feedback-overlay"><div><div class="feedback-symbol ${result.feedbackOutcome === 'win' ? 'win' : 'loss'}">${result.feedbackOutcome === 'win' ? '+' : '−'}</div><h1>${result.feedbackOutcome === 'win' ? '获得2点' : '失去2点'}</h1><p class="form-copy">当前资源余额：<strong>${result.balance}</strong>点</p></div></div>`; later(renderExperiment, 800); }
      catch (error) { alert(error.message); renderExperiment(); }
    };
    document.querySelector('#resource-left').addEventListener('click', () => respond(leftResponse)); document.querySelector('#resource-right').addEventListener('click', () => respond(rightResponse)); bindTrialKeys({ f: () => respond(leftResponse), j: () => respond(rightResponse) }); later(() => respond(null), 3000);
  }, 500);
}

function renderBlockCheck(state, context) {
  const block = state.completed === 45 ? 1 : 2;
  const content = `${stageHeading(`阶段${block}体验问卷`, '请根据此刻的真实感受作答。')}<form id="block-form" class="question-list">${scaleQuestion('insufficient', '我感觉当前可用资源不足。')}${scaleQuestion('worry', '我担心资源不够完成后续任务。')}${scaleQuestion('careful', '我需要谨慎使用当前资源。')}${scaleQuestion('confidence', '我对自己的资源状况有信心。')}<div class="action-row"><button class="btn" type="submit">提交并继续 ${svg.arrow}</button></div></form>`;
  experimentFrame(state, content, `资源账户任务 ${state.completed} / ${state.total}`);
  const form = document.querySelector('#block-form'); form.addEventListener('submit', async (event) => { event.preventDefault(); const button = form.querySelector('button'); setBusy(button, true); try { await submitExperiment(context, 'block_check', { block, payload: Object.fromEntries(new FormData(form)) }); renderExperiment(); } catch (error) { formError(form, error.message); setBusy(button, false); } });
}

const manipulationItems = [
  ['resource_insufficient', '我感觉当前可用资源不足。'], ['resource_worry', '我担心资源不够完成后续任务。'], ['resource_careful', '我需要谨慎使用当前资源。'], ['resource_tight', '我觉得当前资源处于紧张状态。'], ['resource_consume', '我在后续任务中需要认真考虑资源消耗。'], ['resource_enough', '我觉得当前资源足够完成后续任务。'], ['resource_confidence', '我对自己的资源状况有信心。'], ['stress', '我现在感到有压力。'], ['anxiety', '我现在感到紧张或不安。'], ['reward_worry', '我担心自己无法获得额外奖励。'], ['motivation', '我完成任务的动机很强。'], ['engagement', '我对当前任务感到投入。'], ['excitement', '我感到兴奋。'], ['challenge', '我觉得当前任务具有挑战性。'],
];

function renderManipulationCheck(state, context) {
  const content = `${stageHeading('任务体验问卷', '请回想刚才的资源账户任务，根据当前真实感受作答。')}<form id="mc-form" class="question-list">${manipulationItems.map(([name, label]) => scaleQuestion(name, label)).join('')}<div class="action-row"><button class="btn" type="submit">提交并继续 ${svg.arrow}</button></div></form>`;
  experimentFrame(state, content); const form = document.querySelector('#mc-form'); form.addEventListener('submit', async (event) => { event.preventDefault(); const button = form.querySelector('button'); setBusy(button, true); try { await submitExperiment(context, 'manipulation_check', { payload: Object.fromEntries(new FormData(form)) }); renderExperiment(); } catch (error) { formError(form, error.message); setBusy(button, false); } });
}

function renderCostGroups(groups) {
  return `<div class="cost-groups">${groups.map((group) => `<section class="cost-column"><h3>${group.cost}代币</h3>${group.items.map((item) => `<img src="${item.imageUrl}" alt="价格为${group.cost}代币的抽象图形">`).join('')}</section>`).join('')}</div>`;
}

function purchaseChoiceMarkup(trial, budget = null, practice = false) {
  const leftDisabled = !practice && trial.left.cost > budget; const rightDisabled = !practice && trial.right.cost > budget;
  return `<div class="choice-grid"><button id="purchase-left" class="choice-card" type="button" ${leftDisabled ? 'disabled' : ''}><img src="${trial.left.imageUrl}" alt="物品A"><span class="price">${trial.left.cost}代币</span><span class="key">按F键或点击：购买A${leftDisabled ? '（余额不足）' : ''}</span></button><div class="choice-vs"><span>或</span></div><button id="purchase-right" class="choice-card" type="button" ${rightDisabled ? 'disabled' : ''}><img src="${trial.right.imageUrl}" alt="物品B"><span class="price">${trial.right.cost}代币</span><span class="key">按J键或点击：购买B${rightDisabled ? '（余额不足）' : ''}</span></button></div><div class="skip-row"><button id="purchase-skip" class="btn secondary" type="button">按空格键或点击：本轮不购买</button></div>`;
}

function renderCostLearning(state, context) {
  if (state.mode === 'overview') {
    const content = `${stageHeading('连续购买任务说明', '你将使用1000个代币完成80轮连续购买选择。')}<div class="instruction-list"><div class="instruction-step">每轮呈现两个抽象物品及其购买价格，可以购买其中一个，也可以本轮不购买。</div><div class="instruction-step">购买会消耗相应代币；不购买不消耗代币；未花完的代币会保留到后续轮次。</div><div class="instruction-step">最终得分＝购买物品喜爱积分之和＋剩余代币折算分；每剩余20个代币折算1分。</div><div class="instruction-step">目标不是一味省钱或全部购买，而是在有限预算下选择值得购买的物品，避免过早耗尽代币。</div></div>${renderCostGroups(state.costGroups)}<div class="action-row"><button id="start-purchase-practice" class="btn">开始4次购买练习 ${svg.arrow}</button></div>`;
    experimentFrame(state, content); document.querySelector('#start-purchase-practice').addEventListener('click', async (event) => { setBusy(event.currentTarget, true); try { await submitExperiment(context, 'cost_overview_complete'); renderExperiment(); } catch (error) { alert(error.message); setBusy(event.currentTarget, false); } }); return;
  }
  if (state.mode === 'practice') {
    if (!state.practiceTrial) return renderExperiment();
    const content = `${stageHeading('连续购买任务练习', '练习选择不会扣除代币，也不计入最终得分。')}<div class="budget-banner"><div class="budget-box primary"><span>练习预算</span><strong>1000</strong></div><div class="budget-box"><span>练习进度</span><strong>${state.practiceCompleted + 1} / ${state.practiceTotal}</strong></div></div>${purchaseChoiceMarkup(state.practiceTrial, 1000, true)}`;
    experimentFrame(state, content, `购买练习 ${state.practiceCompleted} / ${state.practiceTotal}`); const started = performance.now(); let submitting = false;
    const choose = async (response, method = 'mouse') => { if (submitting) return; submitting = true; try { await submitExperiment(context, 'purchase_practice_response', { response, rtMs: performance.now() - started, responseMethod: method }); document.querySelector('.experiment-card').innerHTML = '<div class="simple-feedback">选择已记录；练习不扣除代币</div>'; later(renderExperiment, 650); } catch (error) { alert(error.message); renderExperiment(); } };
    document.querySelector('#purchase-left').addEventListener('click', () => choose('left')); document.querySelector('#purchase-right').addEventListener('click', () => choose('right')); document.querySelector('#purchase-skip').addEventListener('click', () => choose('skip')); bindTrialKeys({ f: (method) => choose('left', method), j: (method) => choose('right', method), ' ': (method) => choose('skip', method) }); return;
  }
  const content = `${stageHeading('购买规则理解检查', '全部回答正确后才能进入正式任务。')}<form id="cost-check" class="question-list"><div class="question"><div class="question-label">图形旁边的5、10、15、20、25代币表示什么？</div><label class="option-row"><input type="radio" name="priceMeaning" value="cost" required>购买该物品需要付出的代币成本</label><label class="option-row"><input type="radio" name="priceMeaning" value="reward" required>选择该物品能够获得的奖励点数</label></div><div class="question"><div class="question-label">购买标价15代币的物品会消耗多少代币？</div><div class="scale compact">${[5, 15, 25].map((number) => `<label><input type="radio" name="costExample" value="${number}" required><span>${number}</span></label>`).join('')}</div></div><div class="question"><div class="question-label">选择“本轮不购买”会消耗多少代币？</div><div class="scale compact">${[0, 5, 10].map((number) => `<label><input type="radio" name="skipCost" value="${number}" required><span>${number}</span></label>`).join('')}</div></div><div class="question"><div class="question-label">未花完的代币会怎样？</div><label class="option-row"><input type="radio" name="remainingRule" value="retained" required>保留到后续轮次并进入最终计分</label><label class="option-row"><input type="radio" name="remainingRule" value="lost" required>每轮结束后清零</label></div><div class="action-row"><button class="btn" type="submit">提交检查并开始正式任务 ${svg.arrow}</button></div></form>`;
  experimentFrame(state, content, '购买规则理解检查'); const form = document.querySelector('#cost-check'); form.addEventListener('submit', async (event) => { event.preventDefault(); const button = form.querySelector('button'); setBusy(button, true); try { const result = await submitExperiment(context, 'cost_comprehension', { answers: Object.fromEntries(new FormData(form)) }); if (!result.correct) { formError(form, '仍有答案不正确。请重新阅读规则后再作答。'); setBusy(button, false); return; } renderExperiment(); } catch (error) { formError(form, error.message); setBusy(button, false); } });
}

function renderPurchase(state, context) {
  if (!state.trial) return renderExperiment();
  experimentFrame(state, '<div class="fixation">+</div>', `连续购买 ${state.completed} / ${state.total}`);
  later(() => {
    const card = document.querySelector('.experiment-card'); if (!card) return;
    card.innerHTML = `${stageHeading('连续购买任务', '请同时考虑个人喜好、价格、剩余代币和后续购买机会。')}<div class="budget-banner"><div class="budget-box primary"><span>当前剩余代币</span><strong>${state.budget}</strong></div><div class="budget-box"><span>当前轮次</span><strong>${state.completed + 1} / ${state.total}</strong></div><div class="budget-box"><span>后续剩余轮次</span><strong>${Math.max(0, state.remaining - 1)}</strong></div></div>${purchaseChoiceMarkup(state.trial, state.budget)}<p class="keyboard-note">未花完的代币会保留到后续轮次。请按照你认为最合适的方式选择。</p>`;
    const started = performance.now(); let submitting = false; const leftDisabled = state.trial.left.cost > state.budget; const rightDisabled = state.trial.right.cost > state.budget;
    const choose = async (response, method = 'mouse', timeout = false) => { if (submitting) return; submitting = true; document.querySelectorAll('[id^="purchase-"]').forEach((node) => { node.disabled = true; }); try { await submitExperiment(context, 'purchase_response', { trialKey: state.trial.key, response, responseMethod: method, timeout, rtMs: performance.now() - started }); card.innerHTML = '<div class="blank-interval"></div>'; later(renderExperiment, 300); } catch (error) { alert(error.message); renderExperiment(); } };
    document.querySelector('#purchase-left').addEventListener('click', () => { if (!leftDisabled) choose('left'); }); document.querySelector('#purchase-right').addEventListener('click', () => { if (!rightDisabled) choose('right'); }); document.querySelector('#purchase-skip').addEventListener('click', () => choose('skip')); bindTrialKeys({ f: (method) => { if (!leftDisabled) choose('left', method); }, j: (method) => { if (!rightDisabled) choose('right', method); }, ' ': (method) => choose('skip', method) }); later(() => choose(null, 'timeout', true), 180000);
  }, 500);
}

function renderPostCheck(state, context) {
  const content = `${stageHeading('实验后问题', '请根据整个实验过程中的真实想法作答。回答仅用于质量控制。')}<form id="post-form" class="question-list">${scaleQuestion('feedbackBelief', '我认为资源账户反馈完全由自己的表现决定。')}${scaleQuestion('resourcePerformanceRelation', '我觉得资源余额与自身表现密切相关。')}${scaleQuestion('taskInfluence', '我认为前面的资源任务影响了后续购买选择。')}<div class="field"><label>你认为本研究真正想考察什么？</label><textarea name="studyPurpose" maxlength="1000" required></textarea></div><div class="field"><label>你是否怀疑资源反馈的真实性？请简要说明。</label><textarea name="suspicion" maxlength="1000"></textarea></div><div class="action-row"><button class="btn" type="submit">提交并继续 ${svg.arrow}</button></div></form>`;
  experimentFrame(state, content); const form = document.querySelector('#post-form'); form.addEventListener('submit', async (event) => { event.preventDefault(); const button = form.querySelector('button'); setBusy(button, true); try { await submitExperiment(context, 'post_check', { payload: Object.fromEntries(new FormData(form)) }); renderExperiment(); } catch (error) { formError(form, error.message); setBusy(button, false); } });
}

function renderEconomicBackground(state, context) {
  const content = `${stageHeading('最后：生活费与可支配情况', '这是实验的最后一页。请按照近期实际情况作答；这些问题特意安排在全部选择任务之后。')}<form id="economic-form" class="question-list"><div class="field"><label>你每月获得的生活费总额约为多少元？</label><input name="monthlyLivingExpense" type="number" min="0" max="100000" step="1" required></div><div class="field"><label>扣除住宿、基本饮食等必要开支后，你每月可自由支配的金额约为多少元？</label><input name="monthlyDisposableAmount" type="number" min="0" max="100000" step="1" required></div>${scaleQuestion('disposableAdequacy', '我觉得自己目前可自由支配的金额比较充足。')}${scaleQuestion('economicPressure', '我近期感到自己的可支配资源比较紧张。')}<div class="action-row"><button class="btn" type="submit">提交并完成实验 ${svg.arrow}</button></div></form>`;
  experimentFrame(state, content, '最后一部分');
  const form = document.querySelector('#economic-form');
  form.addEventListener('submit', async (event) => { event.preventDefault(); const button = form.querySelector('button'); setBusy(button, true); try { await submitExperiment(context, 'economic_background', { payload: Object.fromEntries(new FormData(form)) }); renderExperiment(); } catch (error) { formError(form, error.message); setBusy(button, false); } });
}

function renderComplete(state) {
  const summary = state.summary;
  experimentFrame(state, `<div class="complete-card"><div class="complete-mark">✓</div><h1 class="form-title">实验已完成</h1><p class="form-copy">感谢你的认真参与。请保存被试编号并联系实验员确认。</p><div class="summary-grid"><div class="summary-item"><span>最终剩余代币</span><strong>${summary.finalBudget}</strong></div><div class="summary-item"><span>购买轮数</span><strong>${summary.purchased}</strong></div><div class="summary-item"><span>不购买轮数</span><strong>${summary.skipped}</strong></div><div class="summary-item"><span>综合得分</span><strong>${summary.finalScore}</strong></div></div><p class="success">你的被试编号：<strong>${escapeHtml(state.participantCode)}</strong></p><div class="action-row"><a class="btn secondary" href="/">返回首页</a></div></div>`, '全部完成');
}

function renderUnknown(state) { experimentFrame(state, `${stageHeading('暂时无法显示当前阶段', '请联系实验员。')}<div class="action-row"><button id="reload" class="btn secondary">重新载入</button></div>`); document.querySelector('#reload').addEventListener('click', renderExperiment); }

function renderResearcher() {
  cleanup(); document.title = '研究者端｜Study 2';
  app.innerHTML = `<main class="center-page"><section class="card elevated form-card"><a class="back-link" href="/">${svg.back} 返回首页</a><p class="eyebrow">RESEARCHER</p><h1 class="form-title">研究者登录</h1><p class="form-copy">输入研究者密码后，可查看实验进度、偏好校准质量、分组结果和动态模型指标。</p><form id="researcher-login" class="form-grid"><div class="field"><label>研究者密码</label><input name="password" type="password" autocomplete="current-password" required autofocus></div><button class="btn full" type="submit">登录研究者端 ${svg.arrow}</button></form></section></main>`;
  const form = document.querySelector('#researcher-login'); form.addEventListener('submit', async (event) => { event.preventDefault(); const button = form.querySelector('button'); setBusy(button, true); try { await api('/api/auth/researcher', { method: 'POST', body: JSON.stringify({ password: new FormData(form).get('password') }) }); await loadResearcherDashboard(); } catch (error) { formError(form, error.message); setBusy(button, false); } });
}

async function loadResearcherDashboard() {
  cleanup(); app.innerHTML = `<main class="loading-screen"><div class="spinner"></div><p>正在整理实验数据…</p></main>`;
  try { researcherData = await api('/api/researcher/summary'); renderResearcherDashboard(); } catch { renderResearcher(); }
}

function badgeGroup(group) { return `<span class="badge ${group === 'scarcity' ? 'scarcity' : ''}">${group === 'scarcity' ? '稀缺组' : '充裕组'}</span>`; }

function renderResearcherDashboard() {
  cleanup(); const data = researcherData;
  app.innerHTML = `<div class="researcher-shell">${brandHeader()}<main class="researcher-main"><header class="researcher-header"><div><h1>Study 2 研究者端</h1><p>成对偏好校准 · 连续消费 · 动态认知计算</p></div><div><button id="refresh-dashboard" class="btn small secondary">刷新数据</button> <button id="logout-researcher" class="btn small ghost">退出</button></div></header><nav class="tabs">${[['overview', '总览'], ['sessions', '被试与质量'], ['exports', '数据导出']].map(([id, label]) => `<button class="tab ${researcherTab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('')}</nav><div id="dashboard-content">${researcherTab === 'overview' ? overviewHtml(data) : researcherTab === 'sessions' ? sessionsHtml(data) : exportsHtml()}</div></main></div>`;
  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => { researcherTab = button.dataset.tab; renderResearcherDashboard(); }));
  document.querySelector('#refresh-dashboard').addEventListener('click', loadResearcherDashboard);
  document.querySelector('#logout-researcher').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); renderResearcher(); });
  document.querySelectorAll('[data-delete-participant]').forEach((button) => button.addEventListener('click', async () => { if (!confirm(`确定删除被试 ${button.dataset.code} 及其全部实验数据吗？`)) return; button.disabled = true; try { await api(`/api/researcher/participant?id=${encodeURIComponent(button.dataset.deleteParticipant)}`, { method: 'DELETE' }); await loadResearcherDashboard(); } catch (error) { alert(error.message); button.disabled = false; } }));
}

function overviewHtml(data) {
  const groupRows = data.groupSummary.map((row) => `<tr><td>${badgeGroup(row.group)}</td><td>${row.participants}</td><td>${row.completed}</td><td>${pct(row.meanCompleteness)}</td><td>${formatNumber(row.meanCalibrationStability, 3)}</td><td>${pct(row.meanValidationConsistency)}</td><td>${pct(row.meanResourceAccuracy)}</td><td>${formatNumber(row.meanManipulationScarcity, 2)}</td><td>${pct(row.meanPurchaseRate)}</td><td>${formatNumber(row.meanAverageCost)}</td><td>${formatNumber(row.meanFinalBudget, 0)}</td><td>${formatNumber(row.meanEfficiency, 4)}</td><td>${formatNumber(row.meanBudgetSensitivity, 3)}</td><td>${formatNumber(row.meanWtpPerLiking, 2)}</td><td>${formatNumber(row.meanLambda, 4)}</td></tr>`).join('');
  const resourceSeries = data.visualizations?.resourceTrajectory || []; const purchaseSeries = data.visualizations?.purchaseTrajectory || []; const manipulation = data.visualizations?.manipulationSummary || [];
  const manipulationBars = manipulation.map((row) => `<div class="metric-bar-row"><span>${badgeGroup(row.group)}</span><div class="metric-bar"><i style="width:${Number.isFinite(row.meanScarcityExperience) ? Math.max(0, Math.min(100, row.meanScarcityExperience / 7 * 100)) : 0}%"></i></div><strong>${formatNumber(row.meanScarcityExperience, 2)}</strong><small>n=${row.n}</small></div>`).join('');
  return `<section class="stat-grid five"><article class="card stat-card"><span>被试人数</span><strong>${data.totals.participants}</strong></article><article class="card stat-card"><span>进行中</span><strong>${data.totals.active}</strong></article><article class="card stat-card"><span>已完成</span><strong>${data.totals.completed}</strong></article><article class="card stat-card"><span>完整数据</span><strong>${data.totals.completeDatasets}</strong></article><article class="card stat-card"><span>质量标记</span><strong>${data.totals.flagged}</strong></article></section><p class="allocation-note">${escapeHtml(data.allocationRule)}</p><section class="card panel"><h2>分组核心指标</h2><div class="table-wrap"><table><thead><tr><th>分组</th><th>人数</th><th>完成</th><th>完整度</th><th>校准稳定性</th><th>验证一致率</th><th>资源正确率</th><th>稀缺体验指数</th><th>购买率</th><th>平均购买价格</th><th>最终代币</th><th>资源效率</th><th>预算敏感性</th><th>每级喜爱WTP</th><th>代币边际价值λ</th></tr></thead><tbody>${groupRows}</tbody></table></div></section><section class="dashboard-grid"><article class="card panel chart-panel"><h2>资源余额逐试次轨迹</h2>${lineChart(resourceSeries, 'value', { min: 0, max: 45, yLabel: '平均余额', xLabel: '资源任务试次' })}</article><article class="card panel chart-panel"><h2>购买率（每10轮）</h2>${lineChart(purchaseSeries, 'purchaseRate', { min: 0, max: 1, yLabel: '购买率', xLabel: '购买任务区段' })}</article><article class="card panel chart-panel"><h2>剩余代币轨迹（每10轮）</h2>${lineChart(purchaseSeries, 'budget', { min: 0, max: 1000, yLabel: '平均剩余代币', xLabel: '购买任务区段' })}</article><article class="card panel"><h2>操纵检验：稀缺体验指数（1–7）</h2><div class="metric-bars">${manipulationBars || '<div class="chart-empty">尚无操纵检验数据</div>'}</div></article></section><section class="card panel model-note"><h2>计算与质量框架</h2><p>偏好阶段计算 Elo、Bradley–Terry、循环一致性、重测一致性、Kendall’s W、split-half 与稳定性等级；30次不同等级验证必须达到85%，否则完整重校准并重新验证。购买阶段比较四种三选一 softmax 模型，输出 AIC、BIC、五折交叉验证、λ、θ、WTP、重复探针和反应时指标。完整性与质量标记只用于核查和敏感性分析，不自动删除被试。</p></section>`;
}

function sessionsHtml(data) {
  if (!data.sessions.length) return '<div class="card empty-state">尚无被试记录</div>';
  const rows = data.sessions.map((row) => `<tr><td>${escapeHtml(row.participantNumber)}</td><td>${escapeHtml(row.name)}</td><td>${badgeGroup(row.group)}</td><td>${escapeHtml(row.protocolVersion || '—')}</td><td>${escapeHtml(row.stageLabel)}</td><td><span class="badge ${row.status === 'completed' ? 'complete' : ''}">${row.status === 'completed' ? '已完成' : '进行中'}</span></td><td>${pct(row.dataCompleteness)}${row.missingComponents.length ? `<br><small title="${escapeHtml(row.missingComponents.join('、'))}">缺${row.missingComponents.length}项</small>` : '<br><small>完整</small>'}</td><td>第${row.calibrationAttempt}次<br><small>${row.calibrationTrials}轮 · 等级${escapeHtml(row.calibrationGrade || '—')}</small></td><td>${pct(row.validationConsistency)}</td><td>${row.resourceTrials}/90<br><small>正确率 ${pct(row.resourceAccuracy)}</small></td><td>${formatNumber(row.manipulationScarcityIndex, 2)}</td><td>${row.purchaseTrials}/80</td><td>${formatNumber(row.finalBudget, 0)}</td><td>${pct(row.purchaseRate)}</td><td>${formatNumber(row.wtpPerLiking, 2)}</td><td>${formatNumber(row.budgetSensitivity, 3)}</td><td>${row.qualityFlags.length ? `<span class="badge warning" title="${escapeHtml(row.qualityFlags.join('、'))}">${row.qualityFlags.length}项</span>` : '—'}</td><td><button class="btn small danger" data-delete-participant="${row.participantId}" data-code="${escapeHtml(row.code)}">删除</button></td></tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr><th>主试编号</th><th>姓名</th><th>分组</th><th>协议版本</th><th>阶段</th><th>状态</th><th>数据完整度</th><th>偏好校准</th><th>验证一致率</th><th>资源任务</th><th>稀缺体验</th><th>购买任务</th><th>剩余代币</th><th>购买率</th><th>WTP/喜爱等级</th><th>预算敏感性</th><th>质量标记</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function exportsHtml() {
  const exports = [
    ['participants', '被试汇总', '基本信息、分组、进度、校准质量和核心行为/模型指标。'],
    ['calibration', '偏好校准试次', '全配对、相邻重测、跨组锚定和自适应补测的逐试次数据。'],
    ['validation', '偏好确认试次', '45轮确认、一致性与相同等级项目偏好。'],
    ['resource', '资源任务试次', '90轮知觉判断、真实正确率、操纵/真实反馈和余额变化。'],
    ['purchases', '连续购买试次', '80轮选择、价格、预算、RT、预算偏离和价格压力。'],
    ['assignments', '刺激—喜爱—价格映射', '25张图形的set、价格、Elo、BTL和最终喜爱等级。'],
    ['models', '计算模型结果', 'softmax模型比较、WTP、λ、θ、预算敏感性和AB证据权重。'],
    ['ddm', 'DDM／LBA分析就绪数据', '仅含有效A/B选择，已整理RT（秒）、左右选择、价值差、价格差和动态预算协变量。'],
    ['quality', '质量与稳健性', '校准、验证、漏反应、偏侧和怀疑度标记。'],
    ['audit', '数据完整性审计', '逐被试列出九个关键环节、缺失部分、尝试次数和质量标记。'],
    ['trajectories', '后台图表数据', '资源余额、购买率、剩余预算和操纵检验的分组聚合数据。'],
    ['surveys', '全部问卷', '基线、阶段问卷、操纵检验、理解检查与实验后问题。'],
    ['events', '实验事件日志', '注册、阶段转换、重校准与完成事件。'],
    ['dictionary', '数据字典', '关键字段、计算指标和分析含义。'],
    ['master', '完整主库备份', '包含所有被试、会话、刺激映射、试次、问卷和事件的完整JSON备份。'],
  ];
  return `<section class="export-grid">${exports.map(([type, title, copy]) => `<article class="card export-card"><h3>${title}</h3><p>${copy}</p><a class="btn small secondary" href="/api/researcher/export?type=${type}">${svg.download} 下载${type === 'master' ? 'JSON' : 'CSV'}</a></article>`).join('')}</section><p class="field-help" style="margin-top:18px">CSV使用UTF-8编码。完整JSON可作为每日主库备份；分组与技术指标只在研究者端出现。</p>`;
}

function route() {
  if (location.pathname === '/') renderHome();
  else if (location.pathname === '/start') renderStart();
  else if (location.pathname === '/experiment') renderExperiment();
  else if (location.pathname === '/researcher') renderResearcher();
  else renderHome();
}

route();
