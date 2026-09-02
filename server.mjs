import { createServer } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CALIBRATION_PHASES,
  FINAL_SCORE_CONFIG,
  STAGES,
  STAGE_LABELS,
  advanceCalibrationPhase,
  calibrationPhaseTrials,
  calibrationReport,
  calibrationResponses,
  calibrationState,
  completionSummary,
  computePurchaseAnalytics,
  computeResourceFeedback,
  preferencePracticeTrials,
  publicCalibrationTrial,
  publicPurchaseTrial,
  purchasePracticeTrials,
  purchaseTrials,
  qualityFlags,
  resourcePracticeTrials,
  resourceTaskTrials,
  validationTrials,
} from './lib/experiment-core.mjs';
import { hashSeed, mean, round, shuffled } from './lib/math.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(ROOT, 'web');
const STIMULI_DIR = path.join(ROOT, 'public', 'stimuli');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'study2-data.json');
const PORT = Number(process.env.PORT || 3020);
const HOST = process.env.HOST || '127.0.0.1';
const PARTICIPANT_PASSWORD = process.env.PARTICIPANT_ENTRY_PASSWORD || 'Zx123456';
const RESEARCHER_PASSWORD = process.env.RESEARCHER_PASSWORD || 'Zx123456';
const AUTH_SECRET = process.env.AUTH_SECRET || 'study2-local-auth-secret-change-before-public-use';
const PROTOCOL_VERSION = '3.0.0';
const VALIDATION_THRESHOLD = 0.85;

const EMPTY_STORE = { version: 3, participants: [], sessions: [], assignments: [], trials: [], surveys: [], events: [] };
let writeQueue = Promise.resolve();

function now() { return new Date().toISOString(); }

function normalizeStore(store) {
  for (const key of ['participants', 'sessions', 'assignments', 'trials', 'surveys', 'events']) if (!Array.isArray(store[key])) store[key] = [];
  store.version = 3;
  for (const participant of store.participants) participant.participantNumber ||= participant.code;
  for (const session of store.sessions) {
    if (session.stage === 'ranking') session.stage = 'calibration';
    session.calibrationAttempt ||= 1;
    session.calibrationPhase ||= 'within_full_pair';
    session.validationAttempt ||= session.calibrationAttempt;
    session.costLearningStep ||= 'overview';
    session.assignmentMethod ||= 'legacy_balanced_randomization';
    session.protocolVersion ||= '2.x-legacy';
    session.stageIndex = Math.max(0, STAGES.indexOf(session.stage));
  }
  return store;
}

async function ensureDataFile() {
  await mkdir(DATA_DIR, { recursive: true });
  try { await stat(DATA_FILE); } catch { await writeFile(DATA_FILE, JSON.stringify(EMPTY_STORE, null, 2), 'utf8'); }
}

async function readStore() {
  await ensureDataFile();
  return normalizeStore(JSON.parse(await readFile(DATA_FILE, 'utf8')));
}

function mutateStore(mutator) {
  const task = writeQueue.then(async () => {
    const store = await readStore();
    const result = await mutator(store);
    const temporary = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(store, null, 2), 'utf8');
    await rename(temporary, DATA_FILE);
    return result;
  });
  writeQueue = task.then(() => undefined, () => undefined);
  return task;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function signRole(role, hours = 12) {
  const expires = Date.now() + hours * 60 * 60 * 1000;
  const payload = `${role}.${expires}`;
  return `${payload}.${createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url')}`;
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('='); return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

function hasRole(request, role) {
  const token = parseCookies(request)[role === 'researcher' ? 'study2_researcher' : 'study2_participant'];
  if (!token) return false;
  const [tokenRole, expiry, signature] = token.split('.');
  if (tokenRole !== role || !signature || Number(expiry) < Date.now()) return false;
  return safeEqual(signature, createHmac('sha256', AUTH_SECRET).update(`${tokenRole}.${expiry}`).digest('base64url'));
}

function cookieHeader(name, value, maxAge = 43200) { return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`; }
function json(res, status, payload, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(payload)); }

async function readJson(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 1_000_000) throw new HttpError(413, '请求内容过大'); chunks.push(chunk); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function sanitizeText(value, max = 200) { return String(value ?? '').trim().slice(0, max); }
function normalizeParticipantNumber(value) { return sanitizeText(value, 30).toUpperCase().replace(/\s+/g, ''); }
function allocationFromParticipantNumber(code) {
  const suffix = code.match(/(\d+)$/)?.[1];
  if (!suffix) throw new HttpError(400, '被试编号必须以数字结尾，例如 S2-001');
  const number = Number(suffix.slice(-9));
  return { group: number % 2 === 1 ? 'scarcity' : 'abundance', number, pricePattern: number % 5 };
}
function advanceSession(session, stage) { session.stage = stage; session.stageIndex = Math.max(0, STAGES.indexOf(stage)); session.updatedAt = now(); if (stage === 'complete') { session.status = 'completed'; session.completedAt = now(); } }
function addEvent(store, session, type, details = {}) { store.events.push({ id: randomUUID(), sessionId: session.id, participantId: session.participantId, type, details, createdAt: now() }); }
function surveyFor(store, sessionId, type) { return store.surveys.find((survey) => survey.sessionId === sessionId && survey.type === type); }

function setSurvey(store, session, type, payload) {
  const existing = surveyFor(store, session.id, type);
  if (existing) { existing.payload = payload; existing.updatedAt = now(); return existing; }
  const survey = { id: randomUUID(), sessionId: session.id, participantId: session.participantId, type, payload, createdAt: now(), updatedAt: now() };
  store.surveys.push(survey); return survey;
}

async function listStimuli() {
  return (await readdir(STIMULI_DIR)).filter((file) => /^(A|B|C|D)\d+_V1\.png$/i.test(file)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

async function buildAssignments(sessionId, patternIndex) {
  const files = await listStimuli();
  if (files.length < 25) throw new Error('实验材料不足25张，请检查实验材料文件夹');
  const categories = ['A', 'B', 'C', 'D'];
  const pools = Object.fromEntries(categories.map((category) => [category, shuffled(files.filter((file) => file.startsWith(category)), `${sessionId}:category:${category}`)]));
  const cursors = Object.fromEntries(categories.map((category) => [category, 0]));
  const duplicatePattern = ['A', 'B', 'C', 'D', 'A']; const assignments = [];
  for (let setIndex = 0; setIndex < 5; setIndex += 1) {
    const setFiles = [...categories, duplicatePattern[setIndex]].map((category) => pools[category][cursors[category]++]);
    shuffled(setFiles, `${sessionId}:set:${setIndex}`).forEach((file, position) => assignments.push({
      id: randomUUID(), sessionId, stimId: file.replace(/\.png$/i, ''), fileName: file, imageUrl: `/stimuli/${encodeURIComponent(file)}`,
      category: file[0].toUpperCase(), setId: String.fromCharCode(65 + setIndex), positionInSet: position + 1,
      setIndex, pricePattern: patternIndex, cost: null, likingRank: null, eloScore: null, eloVolatility: null, btlScore: null, createdAt: now(),
    }));
  }
  return assignments;
}

function getRecord(store, sessionId, participantCode) {
  const session = store.sessions.find((entry) => entry.id === sessionId); if (!session) return null;
  const participant = store.participants.find((entry) => entry.id === session.participantId);
  return participant?.code === participantCode ? { session, participant } : null;
}

function stageTrials(store, session, stage, predicate = () => true) {
  return store.trials.filter((trial) => trial.sessionId === session.id && trial.stage === stage && predicate(trial)).sort((a, b) => a.trialIndex - b.trialIndex);
}

function participantFeedback(group) {
  return group === 'scarcity'
    ? '根据你的回答，你当前可支配资源水平低于同龄大学生平均水平。与多数同龄人相比，你在日常任务和消费选择中可能需要更谨慎地安排资源，并更多考虑资源是否足够。接下来系统为你生成的资源账户初始余额为10点，进入后续环节的账户要求为10点。当前资源点数可能影响最终奖励，请留意账户变化。'
    : '根据你的回答，你当前可支配资源水平高于同龄大学生平均水平。与多数同龄人相比，你在日常任务和消费选择中拥有相对更宽松的资源空间。接下来系统为你生成的资源账户初始余额为10点，进入后续环节的账户要求为10点。当前资源点数可能影响最终奖励，请认真完成任务并留意账户变化。';
}

function publicResourceTrial(trial) {
  if (!trial) return null;
  return trial.type === 'dot_comparison'
    ? { index: trial.index, type: trial.type, leftDots: trial.leftDots, rightDots: trial.rightDots, dotSeed: trial.dotSeed }
    : { index: trial.index, type: trial.type, leftShape: trial.leftShape, rightShape: trial.rightShape };
}

function sameRankDiagnostics(responses) {
  const same = responses.filter((trial) => trial.trialType === 'same_rank' && trial.chosenStimId); const itemCounts = new Map();
  for (const trial of same) {
    for (const id of [trial.leftStimId, trial.rightStimId]) { if (!itemCounts.has(id)) itemCounts.set(id, { shown: 0, chosen: 0 }); itemCounts.get(id).shown += 1; }
    itemCounts.get(trial.chosenStimId).chosen += 1;
  }
  const itemBias = [...itemCounts.entries()].map(([stimId, value]) => ({ stimId, shown: value.shown, chosenRate: value.shown ? value.chosen / value.shown : null }));
  return {
    leftChoiceRate: same.length ? same.filter((trial) => trial.response === 'left').length / same.length : null,
    maximumItemDeviation: itemBias.length ? Math.max(...itemBias.filter((item) => item.shown >= 2).map((item) => Math.abs(item.chosenRate - 0.5)), 0) : null,
    potentiallyBiasedItems: itemBias.filter((item) => item.shown >= 3 && (item.chosenRate <= 0.20 || item.chosenRate >= 0.80)),
  };
}

function experimentBase(session, participant) { return { participantCode: participant.code, stage: session.stage, stageLabel: STAGE_LABELS[session.stage], stageIndex: session.stageIndex, totalStages: STAGES.length - 1 }; }

async function experimentState(store, session, participant) {
  const assignments = store.assignments.filter((entry) => entry.sessionId === session.id); const base = experimentBase(session, participant);
  if (session.stage === 'preference_practice') {
    const trials = preferencePracticeTrials(assignments, session.id); const responses = stageTrials(store, session, 'preference_practice');
    return { ...base, completed: responses.length, total: trials.length, trial: publicCalibrationTrial(trials[responses.length]) };
  }
  if (session.stage === 'calibration') return { ...base, ...calibrationState(store, session, assignments) };
  if (session.stage === 'validation') {
    const trials = validationTrials(assignments, session.id, session.validationAttempt); const responses = stageTrials(store, session, 'validation', (trial) => trial.attempt === session.validationAttempt);
    const different = responses.filter((trial) => trial.trialType === 'different_rank'); const rate = different.length ? different.filter((trial) => trial.consistent).length / different.length : null;
    return { ...base, completed: responses.length, total: trials.length, consistencyRate: rate, validationFailed: responses.length === trials.length && (rate ?? 0) < VALIDATION_THRESHOLD, trial: publicCalibrationTrial(trials[responses.length]) };
  }
  if (session.stage === 'resource_feedback') return { ...base, feedbackText: participantFeedback(session.group) };
  if (session.stage === 'resource_practice') {
    const trials = resourcePracticeTrials(session.id); const responses = stageTrials(store, session, 'resource_practice');
    return { ...base, completed: responses.length, total: 6, trial: publicResourceTrial(trials[responses.length]) };
  }
  if (session.stage === 'resource_task') {
    const trials = resourceTaskTrials(session.id); const responses = stageTrials(store, session, 'resource_task');
    const needBlockCheck = (responses.length === 45 && !surveyFor(store, session.id, 'block_check_1')) || (responses.length === 90 && !surveyFor(store, session.id, 'block_check_2'));
    return { ...base, completed: responses.length, total: 90, balance: session.balance, needBlockCheck, trial: needBlockCheck ? null : publicResourceTrial(trials[responses.length]) };
  }
  if (session.stage === 'cost_learning') {
    const groups = [5, 10, 15, 20, 25].map((cost) => ({ cost, items: assignments.filter((item) => item.cost === cost).map((item) => ({ stimId: item.stimId, imageUrl: item.imageUrl })) }));
    const practice = purchasePracticeTrials(assignments, session.id); const responses = stageTrials(store, session, 'purchase_practice');
    return { ...base, mode: session.costLearningStep, costGroups: groups, practiceCompleted: responses.length, practiceTotal: practice.length, practiceTrial: publicPurchaseTrial(practice[responses.length]), comprehensionAttempts: session.costComprehensionAttempts || 0 };
  }
  if (session.stage === 'purchase') {
    const trials = purchaseTrials(assignments, session.id); const responses = stageTrials(store, session, 'purchase');
    return { ...base, completed: responses.length, total: 80, budget: session.budget, remaining: 80 - responses.length, trial: publicPurchaseTrial(trials[responses.length]) };
  }
  if (session.stage === 'complete') return { ...base, summary: completionSummary(stageTrials(store, session, 'purchase'), session.budget) };
  return base;
}

async function handleRegister(request, res) {
  if (!hasRole(request, 'participant')) return json(res, 401, { error: '请先输入被试入口密码' });
  const body = await readJson(request); const code = normalizeParticipantNumber(body.participantNumber); const name = sanitizeText(body.name, 60); const gender = sanitizeText(body.gender, 30); const age = Number(body.age); const major = sanitizeText(body.major, 80); const contact = sanitizeText(body.contact, 80);
  if (!code || !/^[A-Z0-9_-]{2,30}$/.test(code)) return json(res, 400, { error: '请输入主试告知的有效被试编号，仅可包含字母、数字、短横线或下划线' });
  if (!name || !gender || !Number.isFinite(age) || age < 15 || age > 80 || !major || body.consent !== true) return json(res, 400, { error: '请完整填写基本信息并确认知情同意' });
  const result = await mutateStore(async (store) => {
    if (store.participants.some((participant) => String(participant.code).toUpperCase() === code)) throw new HttpError(409, '该被试编号已经登记，请使用下方“继续已有实验”');
    const allocation = allocationFromParticipantNumber(code); const participantId = randomUUID(); const sessionId = randomUUID();
    const participant = { id: participantId, code, participantNumber: code, name, gender, age, major, contact, consent: true, createdAt: now() };
    const session = { id: sessionId, participantId, group: allocation.group, assignmentMethod: 'participant_number_parity', allocationNumber: allocation.number, protocolVersion: PROTOCOL_VERSION, protocolConfig: { validationThreshold: VALIDATION_THRESHOLD, validationDifferentRankTrials: 30, validationSameRankTrials: 15, resourceTrials: 90, purchaseTrials: 80, initialBudget: 1000, finalScoreConfig: FINAL_SCORE_CONFIG }, stage: 'baseline', stageIndex: 0, status: 'active', balance: 10, budget: 1000, calibrationAttempt: 1, calibrationPhase: 'within_full_pair', validationAttempt: 1, costLearningStep: 'overview', createdAt: now(), updatedAt: now() };
    const assignments = await buildAssignments(sessionId, allocation.pricePattern);
    store.participants.push(participant); store.sessions.push(session); store.assignments.push(...assignments); addEvent(store, session, 'participant_registered', { protocolVersion: PROTOCOL_VERSION, assignmentMethod: session.assignmentMethod, participantNumber: code, stimulusCount: 25 });
    return { code, sessionId };
  });
  return json(res, 201, result);
}

async function handleResume(request, res) {
  if (!hasRole(request, 'participant')) return json(res, 401, { error: '请先输入被试入口密码' });
  const code = sanitizeText((await readJson(request)).code, 40).toUpperCase(); const store = await readStore(); const participant = store.participants.find((entry) => entry.code.toUpperCase() === code); const session = participant ? [...store.sessions].reverse().find((entry) => entry.participantId === participant.id) : null;
  if (!participant || !session) return json(res, 404, { error: '未找到该被试编号对应的实验记录' });
  return json(res, 200, { code: participant.code, sessionId: session.id, completed: session.status === 'completed' });
}

async function handleExperimentState(request, res, url) {
  if (!hasRole(request, 'participant')) return json(res, 401, { error: '入口权限已失效，请重新输入被试密码' });
  const store = await readStore(); const record = getRecord(store, sanitizeText(url.searchParams.get('session'), 80), sanitizeText(url.searchParams.get('code'), 40));
  if (!record) return json(res, 404, { error: '未找到实验记录' });
  return json(res, 200, await experimentState(store, record.session, record.participant));
}

function validateScalePayload(payload, keys) { return keys.every((key) => Number(payload[key]) >= 1 && Number(payload[key]) <= 7); }

async function handleExperimentSubmit(request, res) {
  if (!hasRole(request, 'participant')) return json(res, 401, { error: '入口权限已失效，请重新输入被试密码' });
  const body = await readJson(request); const sessionId = sanitizeText(body.sessionId, 80); const code = sanitizeText(body.code, 40); const action = sanitizeText(body.action, 80);
  const result = await mutateStore(async (store) => {
    const record = getRecord(store, sessionId, code); if (!record) throw new HttpError(404, '未找到实验记录');
    const { session, participant } = record; const assignments = store.assignments.filter((entry) => entry.sessionId === session.id);

    if (action === 'baseline') {
      if (session.stage !== 'baseline') throw new HttpError(409, '当前不在基线问卷阶段');
      const payload = body.payload || {}; if (!validateScalePayload(payload, ['mood', 'hunger', 'sleepQuality'])) throw new HttpError(400, '请完成全部实验状态问题');
      setSurvey(store, session, 'baseline', payload); advanceSession(session, 'preference_practice'); addEvent(store, session, 'baseline_completed');
    } else if (action === 'preference_practice_response') {
      if (session.stage !== 'preference_practice') throw new HttpError(409, '当前不在视觉偏好练习阶段');
      const trials = preferencePracticeTrials(assignments, session.id); const responses = stageTrials(store, session, 'preference_practice'); const trial = trials[responses.length];
      if (!trial || body.trialKey !== trial.key) throw new HttpError(409, '练习试次不匹配，请刷新页面');
      const response = body.response === 'left' ? 'left' : body.response === 'right' ? 'right' : null; if (!response) throw new HttpError(400, '请选择左侧或右侧图形');
      store.trials.push({ id: randomUUID(), sessionId, participantId: participant.id, stage: 'preference_practice', trialIndex: responses.length, leftStimId: trial.left.stimId, rightStimId: trial.right.stimId, response, chosenStimId: response === 'left' ? trial.left.stimId : trial.right.stimId, rtMs: Number(body.rtMs) || null, createdAt: now() });
      if (responses.length + 1 === trials.length) { advanceSession(session, 'calibration'); session.calibrationPhase = 'within_full_pair'; addEvent(store, session, 'preference_practice_completed'); }
      return { ok: true, feedbackText: response === 'left' ? '你选择了左侧图形' : '你选择了右侧图形' };
    } else if (action === 'calibration_response') {
      if (session.stage !== 'calibration') throw new HttpError(409, '当前不在视觉偏好任务阶段');
      const phase = session.calibrationPhase; const trials = calibrationPhaseTrials(store, session, assignments, phase); const phaseResponses = calibrationResponses(store, session, phase); const trial = trials[phaseResponses.length];
      if (!trial || body.trialKey !== trial.key) throw new HttpError(409, '当前试次已变化，请刷新页面');
      const response = body.response === 'left' ? 'left' : body.response === 'right' ? 'right' : null; const chosenStimId = response === 'left' ? trial.left.stimId : response === 'right' ? trial.right.stimId : null;
      store.trials.push({ id: randomUUID(), sessionId, participantId: participant.id, stage: 'calibration', attempt: session.calibrationAttempt, phase, sequence: calibrationResponses(store, session).length, trialIndex: phaseResponses.length, trialKey: trial.key, pairId: trial.pairId, repeat: trial.repeat, anchorRank: trial.anchorRank, leftStimId: trial.left.stimId, rightStimId: trial.right.stimId, leftSetId: trial.left.setId, rightSetId: trial.right.setId, expectedStimId: trial.expectedStimId, response, chosenStimId, consistent: trial.expectedStimId ? chosenStimId === trial.expectedStimId : null, responseMethod: sanitizeText(body.responseMethod || 'keyboard', 20), rtMs: Number.isFinite(Number(body.rtMs)) ? Math.max(0, Math.round(Number(body.rtMs))) : null, timeout: !response || Boolean(body.timeout), createdAt: now() });
      if (phaseResponses.length + 1 === trials.length) {
        const transition = advanceCalibrationPhase(store, session, assignments); addEvent(store, session, 'calibration_phase_completed', { phase, trials: trials.length, nextPhase: transition.phase });
        if (transition.complete) {
          const report = calibrationReport(store, session, assignments); setSurvey(store, session, 'calibration_quality', report); session.validationAttempt = session.calibrationAttempt; advanceSession(session, 'validation'); addEvent(store, session, 'liking_calibration_completed', report);
          return { ok: true, calibrationComplete: true, stabilityGrade: report.stabilityGrade };
        }
        return { ok: true, phaseComplete: true, nextPhase: transition.phase };
      }
      return { ok: true };
    } else if (action === 'validation_response') {
      if (session.stage !== 'validation') throw new HttpError(409, '当前不在视觉偏好确认阶段');
      const trials = validationTrials(assignments, session.id, session.validationAttempt); const responses = stageTrials(store, session, 'validation', (trial) => trial.attempt === session.validationAttempt); const trial = trials[responses.length];
      if (!trial || body.trialKey !== trial.key) throw new HttpError(409, '当前试次已变化，请刷新页面');
      const response = body.response === 'left' ? 'left' : body.response === 'right' ? 'right' : null; const chosenStimId = response === 'left' ? trial.left.stimId : response === 'right' ? trial.right.stimId : null;
      const saved = { id: randomUUID(), sessionId, participantId: participant.id, stage: 'validation', attempt: session.validationAttempt, trialIndex: responses.length, trialKey: trial.key, pairId: trial.pairId, trialType: trial.type, leftStimId: trial.left.stimId, rightStimId: trial.right.stimId, leftLiking: trial.left.likingRank, rightLiking: trial.right.likingRank, response, chosenStimId, consistent: trial.preferredStimId ? chosenStimId === trial.preferredStimId : null, rtMs: Number(body.rtMs) || null, timeout: !response, createdAt: now() };
      store.trials.push(saved);
      if (responses.length + 1 === trials.length) {
        const finished = [...responses, saved]; const different = finished.filter((entry) => entry.trialType === 'different_rank'); const rate = different.filter((entry) => entry.consistent).length / different.length;
        const report = { differentRankConsistencyRate: round(rate), passed: rate >= VALIDATION_THRESHOLD, threshold: VALIDATION_THRESHOLD, ...sameRankDiagnostics(finished) }; setSurvey(store, session, 'validation_quality', report);
        if (rate >= VALIDATION_THRESHOLD) { advanceSession(session, 'resource_feedback'); addEvent(store, session, 'liking_validation_passed', report); } else addEvent(store, session, 'liking_validation_failed', report);
      }
      return { ok: true };
    } else if (action === 'restart_calibration') {
      if (session.stage !== 'validation') throw new HttpError(409, '当前无法重新进行偏好校准');
      const validation = surveyFor(store, session.id, 'validation_quality')?.payload; if (!validation || validation.passed) throw new HttpError(409, '当前不需要重新校准');
      session.calibrationAttempt += 1; session.validationAttempt = session.calibrationAttempt; session.calibrationPhase = 'within_full_pair'; assignments.forEach((item) => { item.likingRank = null; item.eloScore = null; item.eloVolatility = null; item.btlScore = null; item.cost = null; }); advanceSession(session, 'calibration'); addEvent(store, session, 'liking_calibration_restarted', { attempt: session.calibrationAttempt });
    } else if (action === 'advance_feedback') {
      if (session.stage !== 'resource_feedback') throw new HttpError(409, '当前阶段不匹配'); advanceSession(session, 'resource_practice');
    } else if (action === 'resource_practice_response') {
      if (session.stage !== 'resource_practice') throw new HttpError(409, '当前不在资源任务练习阶段');
      const trials = resourcePracticeTrials(session.id); const responses = stageTrials(store, session, 'resource_practice'); const trial = trials[responses.length]; const allowed = trial?.type === 'dot_comparison' ? ['left', 'right'] : ['same', 'different']; const response = allowed.includes(body.response) ? body.response : null;
      if (!trial || !response) throw new HttpError(400, '请选择一个答案'); const correct = response === trial.correctResponse;
      store.trials.push({ id: randomUUID(), sessionId, participantId: participant.id, stage: 'resource_practice', trialIndex: responses.length, trialType: trial.type, response, expectedResponse: trial.correctResponse, actualCorrect: correct, rtMs: Number(body.rtMs) || null, createdAt: now() });
      if (responses.length + 1 === 6) { session.balance = 10; advanceSession(session, 'resource_task'); addEvent(store, session, 'resource_practice_completed'); }
      return { ok: true, correct, practiceComplete: responses.length + 1 === 6 };
    } else if (action === 'resource_response') {
      if (session.stage !== 'resource_task') throw new HttpError(409, '当前不在资源账户任务阶段');
      const trials = resourceTaskTrials(session.id); const responses = stageTrials(store, session, 'resource_task'); if ((responses.length === 45 && !surveyFor(store, session.id, 'block_check_1')) || responses.length >= 90) throw new HttpError(409, '请先完成阶段体验问卷');
      const trial = trials[responses.length]; const allowed = trial.type === 'dot_comparison' ? ['left', 'right'] : ['same', 'different']; const response = allowed.includes(body.response) ? body.response : null; const feedback = computeResourceFeedback(session, trial, response); const balanceBefore = session.balance;
      session.balance += feedback.outcome === 'win' ? feedback.points : -feedback.points; session.updatedAt = now();
      store.trials.push({ id: randomUUID(), sessionId, participantId: participant.id, stage: 'resource_task', trialIndex: responses.length, trialType: trial.type, stimulus: trial.type === 'dot_comparison' ? { leftDots: trial.leftDots, rightDots: trial.rightDots, dotSeed: trial.dotSeed } : { leftShape: trial.leftShape, rightShape: trial.rightShape }, response, expectedResponse: trial.correctResponse, actualCorrect: feedback.actualCorrect, feedbackMode: feedback.feedbackMode, feedbackOutcome: feedback.outcome, pointsDelta: feedback.outcome === 'win' ? feedback.points : -feedback.points, balanceBefore, balanceAfter: session.balance, rtMs: Number(body.rtMs) || null, timeout: !response, createdAt: now() });
      return { ok: true, feedbackOutcome: feedback.outcome, pointsDelta: feedback.outcome === 'win' ? feedback.points : -feedback.points, balance: session.balance };
    } else if (action === 'block_check') {
      if (session.stage !== 'resource_task') throw new HttpError(409, '当前阶段不匹配'); const block = Number(body.block); const completed = stageTrials(store, session, 'resource_task').length;
      if ((block === 1 && completed !== 45) || (block === 2 && completed !== 90)) throw new HttpError(400, '阶段问卷位置无效'); const payload = body.payload || {}; if (!validateScalePayload(payload, ['insufficient', 'worry', 'careful', 'confidence'])) throw new HttpError(400, '请完成全部题目');
      setSurvey(store, session, `block_check_${block}`, payload); if (block === 2) { advanceSession(session, 'manipulation_check'); addEvent(store, session, 'resource_task_completed', { finalBalance: session.balance }); }
    } else if (action === 'manipulation_check') {
      if (session.stage !== 'manipulation_check') throw new HttpError(409, '当前阶段不匹配'); const payload = body.payload || {};
      if (Object.keys(payload).length < 14 || !Object.values(payload).every((value) => Number(value) >= 1 && Number(value) <= 7)) throw new HttpError(400, '请完成全部题目');
      setSurvey(store, session, 'manipulation_check', payload); session.costLearningStep = 'overview'; advanceSession(session, 'cost_learning');
    } else if (action === 'cost_overview_complete') {
      if (session.stage !== 'cost_learning' || session.costLearningStep !== 'overview') throw new HttpError(409, '当前阶段不匹配'); session.costLearningStep = 'practice'; session.updatedAt = now();
    } else if (action === 'purchase_practice_response') {
      if (session.stage !== 'cost_learning' || session.costLearningStep !== 'practice') throw new HttpError(409, '当前不在购买练习阶段');
      const trials = purchasePracticeTrials(assignments, session.id); const responses = stageTrials(store, session, 'purchase_practice'); const trial = trials[responses.length]; const response = ['left', 'right', 'skip'].includes(body.response) ? body.response : null;
      if (!trial || !response) throw new HttpError(400, '请选择购买A、购买B或本轮不购买'); store.trials.push({ id: randomUUID(), sessionId, participantId: participant.id, stage: 'purchase_practice', trialIndex: responses.length, pairId: trial.pairId, leftStimId: trial.left.stimId, rightStimId: trial.right.stimId, leftCost: trial.left.cost, rightCost: trial.right.cost, response, rtMs: Number(body.rtMs) || null, createdAt: now() });
      if (responses.length + 1 === trials.length) session.costLearningStep = 'comprehension'; return { ok: true, practiceComplete: responses.length + 1 === trials.length };
    } else if (action === 'cost_comprehension') {
      if (session.stage !== 'cost_learning' || session.costLearningStep !== 'comprehension') throw new HttpError(409, '当前不在理解检查阶段'); const answers = body.answers || {};
      const checks = { priceMeaning: answers.priceMeaning === 'cost', costExample: Number(answers.costExample) === 15, skipCost: Number(answers.skipCost) === 0, remainingRule: answers.remainingRule === 'retained' };
      session.costComprehensionAttempts = (session.costComprehensionAttempts || 0) + 1; if (!Object.values(checks).every(Boolean)) return { correct: false, checks, attempts: session.costComprehensionAttempts };
      setSurvey(store, session, 'cost_comprehension', { correct: true, attempts: session.costComprehensionAttempts, answers }); session.budget = 1000; advanceSession(session, 'purchase'); addEvent(store, session, 'purchase_task_started', { initialBudget: 1000, totalTrials: 80, finalScoreConfig: FINAL_SCORE_CONFIG }); return { correct: true };
    } else if (action === 'purchase_response') {
      if (session.stage !== 'purchase') throw new HttpError(409, '当前不在连续购买任务阶段'); const trials = purchaseTrials(assignments, session.id); const responses = stageTrials(store, session, 'purchase'); const trial = trials[responses.length];
      if (!trial || body.trialKey !== trial.key) throw new HttpError(409, '当前试次已变化，请刷新页面'); let response = ['left', 'right', 'skip'].includes(body.response) ? body.response : null; if (body.timeout && !response) response = 'skip'; if (!response) throw new HttpError(400, '请选择购买A、购买B或本轮不购买');
      const chosen = response === 'left' ? trial.left : response === 'right' ? trial.right : null; if (chosen && chosen.cost > session.budget) throw new HttpError(400, '当前剩余代币不足以购买该物品');
      const budgetBefore = session.budget; const spent = chosen?.cost || 0; const remainingTrials = 80 - responses.length; const budgetPerTrial = budgetBefore / remainingTrials; const targetBudget = 1000 * remainingTrials / 80; const leftPricePressure = trial.left.cost / Math.max(budgetPerTrial, 0.001); const rightPricePressure = trial.right.cost / Math.max(budgetPerTrial, 0.001); session.budget -= spent; session.updatedAt = now();
      const saved = { id: randomUUID(), sessionId, participantId: participant.id, stage: 'purchase', trialIndex: responses.length, trialType: trial.type, pairId: trial.pairId, repeat: trial.repeat, leftStimId: trial.left.stimId, rightStimId: trial.right.stimId, leftLiking: trial.left.likingRank, rightLiking: trial.right.likingRank, leftCost: trial.left.cost, rightCost: trial.right.cost, deltaLikingRightMinusLeft: trial.right.likingRank - trial.left.likingRank, deltaCostRightMinusLeft: trial.right.cost - trial.left.cost, response, chosenStimId: chosen?.stimId || null, chosenLiking: chosen?.likingRank || null, chosenCost: chosen?.cost || 0, spent, budgetBefore, budgetAfter: session.budget, remainingTrials, budgetPerTrial: round(budgetPerTrial, 6), targetBudget: round(targetBudget, 6), budgetDeviation: round(budgetBefore - targetBudget, 6), leftPricePressure: round(leftPricePressure, 6), rightPricePressure: round(rightPricePressure, 6), meanPricePressure: round((leftPricePressure + rightPricePressure) / 2, 6), rtMs: Number(body.rtMs) || null, timeout: Boolean(body.timeout), responseMethod: sanitizeText(body.responseMethod || 'keyboard', 20), createdAt: now() };
      store.trials.push(saved);
      if (responses.length + 1 === 80) {
        const finished = [...responses, saved]; const analytics = computePurchaseAnalytics(finished); setSurvey(store, session, 'purchase_behavior_summary', analytics); setSurvey(store, session, 'computational_model', analytics?.modelComparison || {}); advanceSession(session, 'post_check'); addEvent(store, session, 'purchase_task_completed', { ...completionSummary(finished, session.budget), wtpPerLiking: analytics?.wtpPerLiking, budgetSensitivity: analytics?.budgetSensitivity });
      }
      return { ok: true, budget: session.budget };
    } else if (action === 'post_check') {
      if (session.stage !== 'post_check') throw new HttpError(409, '当前阶段不匹配'); const payload = body.payload || {};
      if (!validateScalePayload(payload, ['feedbackBelief', 'resourcePerformanceRelation', 'taskInfluence']) || !sanitizeText(payload.studyPurpose, 1000)) throw new HttpError(400, '请完成全部实验后问题');
      setSurvey(store, session, 'post_check', payload); advanceSession(session, 'economic_background'); addEvent(store, session, 'post_check_completed');
    } else if (action === 'economic_background') {
      if (session.stage !== 'economic_background') throw new HttpError(409, '当前阶段不匹配'); const payload = body.payload || {};
      const monthlyLivingExpense = Number(payload.monthlyLivingExpense); const monthlyDisposableAmount = Number(payload.monthlyDisposableAmount);
      if (!Number.isFinite(monthlyLivingExpense) || monthlyLivingExpense < 0 || monthlyLivingExpense > 100000 || !Number.isFinite(monthlyDisposableAmount) || monthlyDisposableAmount < 0 || monthlyDisposableAmount > 100000 || !validateScalePayload(payload, ['disposableAdequacy', 'economicPressure'])) throw new HttpError(400, '请完成全部生活费与可支配情况问题');
      setSurvey(store, session, 'economic_background', { ...payload, monthlyLivingExpense, monthlyDisposableAmount }); setSurvey(store, session, 'quality_flags', { flags: qualityFlags(store, session), retainedForMainAnalysis: true, sensitivityAnalysisRecommended: true }); advanceSession(session, 'complete'); addEvent(store, session, 'experiment_completed');
    } else throw new HttpError(400, '未知操作');
    return { ok: true };
  });
  return json(res, 200, result ?? { ok: true });
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function surveyPayload(store, sessionId, type) { return surveyFor(store, sessionId, type)?.payload || null; }

function manipulationScarcityIndex(payload) {
  if (!payload) return null;
  const direct = ['resource_insufficient', 'resource_worry', 'resource_careful', 'resource_tight', 'resource_consume'].map((key) => Number(payload[key])).filter(Number.isFinite);
  const reversed = ['resource_enough', 'resource_confidence'].map((key) => 8 - Number(payload[key])).filter(Number.isFinite);
  const values = [...direct, ...reversed];
  return values.length === 7 ? mean(values) : null;
}

function dataCompleteness(store, session, resource, purchases, validation) {
  const checks = [
    ['基线状态', Boolean(surveyFor(store, session.id, 'baseline'))],
    ['偏好校准', Boolean(surveyFor(store, session.id, 'calibration_quality'))],
    ['偏好验证通过', Boolean(validation?.passed)],
    ['90次资源任务', resource.length === 90],
    ['操纵检验', Boolean(surveyFor(store, session.id, 'manipulation_check'))],
    ['价格理解检查', Boolean(surveyFor(store, session.id, 'cost_comprehension'))],
    ['80次购买任务', purchases.length === 80],
    ['实验后问题', Boolean(surveyFor(store, session.id, 'post_check'))],
    ['末尾经济情况', Boolean(surveyFor(store, session.id, 'economic_background'))],
  ];
  return { proportion: checks.filter(([, present]) => present).length / checks.length, missing: checks.filter(([, present]) => !present).map(([label]) => label) };
}

function summarizeSession(store, session) {
  const participant = store.participants.find((entry) => entry.id === session.participantId); const resource = stageTrials(store, session, 'resource_task'); const purchases = stageTrials(store, session, 'purchase'); const calibration = surveyPayload(store, session.id, 'calibration_quality'); const validation = surveyPayload(store, session.id, 'validation_quality'); const manipulation = surveyPayload(store, session.id, 'manipulation_check'); const economic = surveyPayload(store, session.id, 'economic_background'); const analytics = surveyPayload(store, session.id, 'purchase_behavior_summary') || computePurchaseAnalytics(purchases); const flags = qualityFlags(store, session); const completeness = dataCompleteness(store, session, resource, purchases, validation);
  return { sessionId: session.id, participantId: participant?.id, code: participant?.code, participantNumber: participant?.participantNumber || participant?.code, name: participant?.name, gender: participant?.gender, age: participant?.age, major: participant?.major, group: session.group, assignmentMethod: session.assignmentMethod, protocolVersion: session.protocolVersion, stage: session.stage, stageLabel: STAGE_LABELS[session.stage], status: session.status, dataCompleteness: round(completeness.proportion), missingComponents: completeness.missing, calibrationAttempt: session.calibrationAttempt, calibrationTrials: calibration?.totalTrials ?? calibrationResponses(store, session).length, calibrationGrade: calibration?.stabilityGrade ?? null, calibrationStability: calibration?.compositeStability ?? null, splitHalfSpearman: calibration?.splitHalfSpearman ?? null, validationConsistency: validation?.differentRankConsistencyRate ?? null, validationPassed: validation?.passed ?? null, resourceTrials: resource.length, resourceAccuracy: resource.length ? mean(resource.map((trial) => trial.actualCorrect ? 1 : 0)) : null, resourceTimeoutRate: resource.length ? resource.filter((trial) => trial.timeout).length / resource.length : null, resourceBalance: session.balance, manipulationScarcityIndex: manipulationScarcityIndex(manipulation), purchaseTrials: purchases.length, purchaseRate: analytics?.purchaseRate ?? null, averagePurchaseCost: analytics?.averagePurchaseCost ?? null, averagePurchaseLiking: analytics?.averagePurchaseLiking ?? null, resourceEfficiency: analytics?.resourceEfficiency ?? null, budgetSensitivity: analytics?.budgetSensitivity ?? null, wtpPerLiking: analytics?.wtpPerLiking ?? null, lambdaBasePerToken: analytics?.lambdaBasePerToken ?? null, purchaseThresholdTheta: analytics?.purchaseThresholdTheta ?? null, repeatedProbeSwitchRate: analytics?.repeatedProbeSwitchRate ?? null, conflictRtSlowingMs: analytics?.conflictRtSlowingMs ?? null, monthlyLivingExpense: economic?.monthlyLivingExpense ?? null, monthlyDisposableAmount: economic?.monthlyDisposableAmount ?? null, disposableAdequacy: economic?.disposableAdequacy ?? null, economicPressure: economic?.economicPressure ?? null, finalBudget: session.budget, qualityFlags: flags, createdAt: session.createdAt, updatedAt: session.updatedAt, completedAt: session.completedAt || null };
}

function buildVisualizations(store) {
  const sessionById = new Map(store.sessions.map((session) => [session.id, session]));
  const resourceTrajectory = ['scarcity', 'abundance'].map((group) => ({
    group,
    points: Array.from({ length: 90 }, (_, trialIndex) => {
      const rows = store.trials.filter((trial) => trial.stage === 'resource_task' && trial.trialIndex === trialIndex && sessionById.get(trial.sessionId)?.group === group);
      return { x: trialIndex + 1, value: rows.length ? round(mean(rows.map((trial) => trial.balanceAfter)), 3) : null, n: rows.length };
    }).filter((point) => point.value !== null),
  }));
  const purchaseTrajectory = ['scarcity', 'abundance'].map((group) => ({
    group,
    points: Array.from({ length: 8 }, (_, bin) => {
      const rows = store.trials.filter((trial) => trial.stage === 'purchase' && Math.floor(trial.trialIndex / 10) === bin && sessionById.get(trial.sessionId)?.group === group);
      return { x: bin + 1, label: `${bin * 10 + 1}–${bin * 10 + 10}`, purchaseRate: rows.length ? round(mean(rows.map((trial) => trial.response === 'left' || trial.response === 'right' ? 1 : 0)), 4) : null, budget: rows.length ? round(mean(rows.map((trial) => trial.budgetAfter)), 2) : null, meanSpend: rows.length ? round(mean(rows.map((trial) => trial.spent)), 3) : null, n: rows.length };
    }).filter((point) => point.purchaseRate !== null),
  }));
  const manipulationSummary = ['scarcity', 'abundance'].map((group) => { const values = store.sessions.filter((session) => session.group === group).map((session) => manipulationScarcityIndex(surveyPayload(store, session.id, 'manipulation_check'))).filter(Number.isFinite); return { group, meanScarcityExperience: values.length ? round(mean(values), 3) : null, n: values.length }; });
  return { resourceTrajectory, purchaseTrajectory, manipulationSummary };
}

async function handleResearcherSummary(request, res) {
  if (!hasRole(request, 'researcher')) return json(res, 401, { error: '请先登录研究者端' });
  const store = await readStore(); const sessions = store.sessions.map((session) => summarizeSession(store, session)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const groupSummary = ['scarcity', 'abundance'].map((group) => { const rows = sessions.filter((row) => row.group === group); const completed = rows.filter((row) => row.status === 'completed'); const average = (field) => mean(completed.map((row) => row[field]).filter(Number.isFinite)); return { group, participants: rows.length, completed: completed.length, meanPurchaseRate: average('purchaseRate'), meanAverageCost: average('averagePurchaseCost'), meanFinalBudget: average('finalBudget'), meanEfficiency: average('resourceEfficiency'), meanBudgetSensitivity: average('budgetSensitivity'), meanWtpPerLiking: average('wtpPerLiking'), meanLambda: average('lambdaBasePerToken'), meanCalibrationStability: average('calibrationStability'), meanValidationConsistency: average('validationConsistency'), meanResourceAccuracy: average('resourceAccuracy'), meanManipulationScarcity: average('manipulationScarcityIndex'), meanCompleteness: average('dataCompleteness') }; });
  return json(res, 200, { allocationRule: '主试编号数字尾号：奇数=稀缺组，偶数=富足组；该规则仅在研究者端显示。', totals: { participants: store.participants.length, sessions: sessions.length, active: sessions.filter((row) => row.status === 'active').length, completed: sessions.filter((row) => row.status === 'completed').length, completeDatasets: sessions.filter((row) => row.dataCompleteness === 1).length, flagged: sessions.filter((row) => row.qualityFlags.length).length }, groupSummary, visualizations: buildVisualizations(store), sessions });
}

function csvEscape(value) { if (value === null || value === undefined) return ''; const text = typeof value === 'object' ? JSON.stringify(value) : String(value); return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function rowsToCsv(rows) { if (!rows.length) return '\uFEFF'; const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))]; return `\uFEFF${[headers.map(csvEscape).join(','), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(','))].join('\n')}`; }

function dictionaryRows() {
  return [
    { table: 'participants', field: 'participantNumber', description: '主试预先告知的被试编号；数字尾号奇数分配稀缺组、偶数分配富足组' },
    { table: 'sessions', field: 'protocolVersion / protocolConfig', description: '每名被试登记时冻结的程序版本与关键阈值，便于识别不同版本或中途升级记录' },
    { table: 'assignments', field: 'likingRank', description: '个体化喜爱等级，1=最低，5=最高；由成对比较校准产生' },
    { table: 'assignments', field: 'eloScore / btlScore', description: 'Elo连续喜爱强度与Bradley–Terry潜在偏好参数' },
    { table: 'calibration', field: 'phase', description: `偏好校准阶段：${CALIBRATION_PHASES.join(' / ')}` },
    { table: 'validation_quality', field: 'differentRankConsistencyRate', description: '30轮不同等级验证中选择较高喜爱等级的比例，阈值0.85' },
    { table: 'resource_task', field: 'feedbackMode', description: 'manipulated=资源操纵反馈；true=图形匹配真实反馈' },
    { table: 'purchase', field: 'meanPricePressure', description: '两物品平均价格÷当轮平均可用预算' },
    { table: 'purchase', field: 'budgetDeviation', description: '实际预算减线性目标预算' },
    { table: 'purchase_behavior_summary', field: 'wtpPerLiking', description: '动态三选一softmax估计的每提高一个喜爱等级愿意支付代币数' },
    { table: 'purchase_behavior_summary', field: 'lambdaBasePerToken', description: '动态softmax估计的基础代币边际心理价值' },
    { table: 'ddm_ready', field: 'choiceRight / rtSeconds', description: '仅保留A/B二选一反应；choiceRight为右侧选择指标，rtSeconds为秒，可直接用于层级DDM或LBA预处理' },
    { table: 'ddm_ready', field: 'deltaLiking / deltaCost', description: '右侧减左侧的喜爱等级差与价格差；可作为漂移率协变量' },
    { table: 'ddm_ready', field: 'meanPricePressure / budgetDeviation', description: '动态预算压力与相对线性预算目标的偏离；可作为阈值或漂移率的时变协变量' },
    { table: 'computational_model', field: 'AIC / BIC / cvLogLoss', description: '单维、静态整合和动态预算模型的比较指标' },
    { table: 'quality_flags', field: 'flags', description: '质量标记仅用于敏感性分析，不自动删除被试' },
    { table: 'economic_background', field: 'monthlyLivingExpense / monthlyDisposableAmount', description: '全部实验任务结束后测量的每月生活费总额与必要开支后可自由支配金额' },
    { table: 'participant_summary', field: 'dataCompleteness / missingComponents', description: '九项关键阶段的数据完整比例与缺失环节列表' },
  ];
}

async function handleExport(request, res, url) {
  if (!hasRole(request, 'researcher')) return json(res, 401, { error: '请先登录研究者端' }); const store = await readStore(); const type = url.searchParams.get('type') || 'participants'; let rows;
  if (type === 'master') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="study2-complete-backup-${new Date().toISOString().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' }); res.end(JSON.stringify(store, null, 2)); return; }
  if (type === 'participants') rows = store.sessions.map((session) => summarizeSession(store, session));
  else if (type === 'purchases') rows = store.trials.filter((trial) => trial.stage === 'purchase');
  else if (type === 'resource') rows = store.trials.filter((trial) => trial.stage === 'resource_task');
  else if (type === 'calibration') rows = store.trials.filter((trial) => trial.stage === 'calibration');
  else if (type === 'validation') rows = store.trials.filter((trial) => trial.stage === 'validation');
  else if (type === 'assignments') rows = store.assignments;
  else if (type === 'surveys') rows = store.surveys.map((survey) => ({ ...survey, payload: JSON.stringify(survey.payload) }));
  else if (type === 'models') rows = store.sessions.map((session) => ({ sessionId: session.id, participantId: session.participantId, ...(surveyPayload(store, session.id, 'purchase_behavior_summary') || {}) })).map((row) => ({ ...row, modelComparison: JSON.stringify(row.modelComparison || {}) }));
  else if (type === 'ddm') rows = store.trials.filter((trial) => trial.stage === 'purchase' && (trial.response === 'left' || trial.response === 'right')).map((trial) => {
    const session = store.sessions.find((entry) => entry.id === trial.sessionId); const participant = store.participants.find((entry) => entry.id === trial.participantId);
    return { participantCode: participant?.code, participantId: trial.participantId, sessionId: trial.sessionId, group: session?.group, trialIndex: trial.trialIndex, trialType: trial.trialType, pairId: trial.pairId, repeat: trial.repeat, choiceRight: trial.response === 'right' ? 1 : 0, rtSeconds: Number.isFinite(trial.rtMs) ? round(trial.rtMs / 1000, 6) : null, timeout: trial.timeout, leftStimId: trial.leftStimId, rightStimId: trial.rightStimId, leftLiking: trial.leftLiking, rightLiking: trial.rightLiking, deltaLiking: trial.deltaLikingRightMinusLeft, leftCost: trial.leftCost, rightCost: trial.rightCost, deltaCost: trial.deltaCostRightMinusLeft, budgetBefore: trial.budgetBefore, remainingTrials: trial.remainingTrials, budgetPerTrial: trial.budgetPerTrial, targetBudget: trial.targetBudget, budgetDeviation: trial.budgetDeviation, meanPricePressure: trial.meanPricePressure };
  });
  else if (type === 'audit') rows = store.sessions.map((session) => { const row = summarizeSession(store, session); return { participantNumber: row.participantNumber, participantId: row.participantId, sessionId: row.sessionId, group: row.group, protocolVersion: row.protocolVersion, stage: row.stage, status: row.status, dataCompleteness: row.dataCompleteness, missingComponents: JSON.stringify(row.missingComponents), calibrationAttempt: row.calibrationAttempt, validationPassed: row.validationPassed, resourceTrials: row.resourceTrials, purchaseTrials: row.purchaseTrials, qualityFlags: JSON.stringify(row.qualityFlags), updatedAt: row.updatedAt }; });
  else if (type === 'trajectories') { const visualizations = buildVisualizations(store); rows = [...visualizations.resourceTrajectory.flatMap((series) => series.points.map((point) => ({ analysis: 'resource_balance', group: series.group, trialOrBin: point.x, label: point.x, value: point.value, n: point.n }))), ...visualizations.purchaseTrajectory.flatMap((series) => series.points.flatMap((point) => [{ analysis: 'purchase_rate', group: series.group, trialOrBin: point.x, label: point.label, value: point.purchaseRate, n: point.n }, { analysis: 'remaining_budget', group: series.group, trialOrBin: point.x, label: point.label, value: point.budget, n: point.n }, { analysis: 'mean_spend', group: series.group, trialOrBin: point.x, label: point.label, value: point.meanSpend, n: point.n }])), ...visualizations.manipulationSummary.map((row) => ({ analysis: 'manipulation_scarcity_index', group: row.group, trialOrBin: null, label: 'post_resource', value: row.meanScarcityExperience, n: row.n }))]; }
  else if (type === 'quality') rows = store.sessions.map((session) => { const participant = store.participants.find((entry) => entry.id === session.participantId); return { participantNumber: participant?.participantNumber || participant?.code, group: session.group, sessionId: session.id, participantId: session.participantId, calibration: JSON.stringify(surveyPayload(store, session.id, 'calibration_quality')), validation: JSON.stringify(surveyPayload(store, session.id, 'validation_quality')), flags: JSON.stringify(qualityFlags(store, session)) }; });
  else if (type === 'events') rows = store.events; else if (type === 'dictionary') rows = dictionaryRows(); else return json(res, 400, { error: '未知导出类型' });
  const csv = rowsToCsv(rows); res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="study2-${type}-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' }); res.end(csv);
}

async function handleDeleteParticipant(request, res, url) {
  if (!hasRole(request, 'researcher')) return json(res, 401, { error: '请先登录研究者端' }); const participantId = sanitizeText(url.searchParams.get('id'), 80); if (!participantId) return json(res, 400, { error: '缺少被试ID' });
  const result = await mutateStore((store) => { const participant = store.participants.find((entry) => entry.id === participantId); if (!participant) throw new HttpError(404, '未找到被试'); const sessionIds = store.sessions.filter((entry) => entry.participantId === participantId).map((entry) => entry.id); store.participants = store.participants.filter((entry) => entry.id !== participantId); store.sessions = store.sessions.filter((entry) => entry.participantId !== participantId); store.assignments = store.assignments.filter((entry) => !sessionIds.includes(entry.sessionId)); store.trials = store.trials.filter((entry) => !sessionIds.includes(entry.sessionId)); store.surveys = store.surveys.filter((entry) => !sessionIds.includes(entry.sessionId)); store.events = store.events.filter((entry) => !sessionIds.includes(entry.sessionId)); return { deleted: participant.code }; });
  return json(res, 200, result);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
async function serveFile(res, filePath, fallback = false) { try { const body = await readFile(filePath); res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': path.extname(filePath) === '.png' ? 'public, max-age=86400' : 'no-cache' }); res.end(body); } catch { if (fallback) return serveFile(res, path.join(WEB_DIR, 'index.html')); return json(res, 404, { error: '文件不存在' }); } }

const server = createServer(async (request, res) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`); const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/api/health' && request.method === 'GET') return json(res, 200, { ok: true, version: 2, stimuli: (await listStimuli()).length, calibrationPhases: CALIBRATION_PHASES.length });
    if (pathname === '/api/auth/participant' && request.method === 'POST') { const body = await readJson(request); if (!safeEqual(body.password || '', PARTICIPANT_PASSWORD)) return json(res, 401, { error: '被试入口密码不正确' }); return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('study2_participant', signRole('participant')) }); }
    if (pathname === '/api/auth/researcher' && request.method === 'POST') { const body = await readJson(request); if (!safeEqual(body.password || '', RESEARCHER_PASSWORD)) return json(res, 401, { error: '研究者密码不正确' }); return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('study2_researcher', signRole('researcher')) }); }
    if (pathname === '/api/auth/logout' && request.method === 'POST') return json(res, 200, { ok: true }, { 'Set-Cookie': [cookieHeader('study2_participant', '', 0), cookieHeader('study2_researcher', '', 0)] });
    if (pathname === '/api/participants/register' && request.method === 'POST') return handleRegister(request, res);
    if (pathname === '/api/sessions/resume' && request.method === 'POST') return handleResume(request, res);
    if (pathname === '/api/experiment/state' && request.method === 'GET') return handleExperimentState(request, res, url);
    if (pathname === '/api/experiment/submit' && request.method === 'POST') return handleExperimentSubmit(request, res);
    if (pathname === '/api/researcher/summary' && request.method === 'GET') return handleResearcherSummary(request, res);
    if (pathname === '/api/researcher/export' && request.method === 'GET') return handleExport(request, res, url);
    if (pathname === '/api/researcher/participant' && request.method === 'DELETE') return handleDeleteParticipant(request, res, url);
    if (pathname.startsWith('/stimuli/')) return serveFile(res, path.join(STIMULI_DIR, path.basename(pathname)));
    if (pathname === '/styles.css') return serveFile(res, path.join(WEB_DIR, 'styles.css'));
    if (pathname === '/app.js') return serveFile(res, path.join(WEB_DIR, 'app.js'));
    if (pathname === '/favicon.svg') return serveFile(res, path.join(WEB_DIR, 'favicon.svg'));
    return serveFile(res, path.join(WEB_DIR, 'index.html'), true);
  } catch (error) { const status = error instanceof HttpError ? error.status : 500; if (status === 500) console.error(error); return json(res, status, { error: status === 500 ? '服务器暂时无法处理请求' : error.message }); }
});

await ensureDataFile();
server.listen(PORT, HOST, () => { console.log(`Study 2 已启动：http://${HOST}:${PORT}`); console.log(`被试入口密码：${PARTICIPANT_PASSWORD}`); console.log(`研究者密码：${RESEARCHER_PASSWORD}`); });
