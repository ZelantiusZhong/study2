import { readFile } from 'node:fs/promises';

const base = 'http://127.0.0.1:3020';
let participantCookie = '';
let researcherCookie = '';

async function request(path, { method = 'GET', body, role = 'participant' } = {}) {
  const cookie = role === 'researcher' ? researcherCookie : participantCookie;
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    const token = setCookie.split(';')[0];
    if (role === 'researcher') researcherCookie = token;
    else participantCookie = token;
  }
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

function latentPreference(stimId) {
  return (stimId.charCodeAt(0) - 64) * 100 + Number(stimId.match(/\d+/)?.[0] || 0);
}

await request('/api/auth/participant', { method: 'POST', body: { password: 'Zx123456' } });
const testParticipantNumber = `S2-T${String(Date.now()).slice(-8)}1`;
const registered = await request('/api/participants/register', {
  method: 'POST',
  body: { participantNumber: testParticipantNumber, name: '自动化测试', gender: '其他 / 不便回答', age: 22, major: '测试专业', contact: '', consent: true },
});
const context = { sessionId: registered.sessionId, code: registered.code };
const submit = (action, extra = {}) => request('/api/experiment/submit', { method: 'POST', body: { ...context, action, ...extra } });
const state = () => request(`/api/experiment/state?session=${context.sessionId}&code=${context.code}`);
const dataStore = async () => JSON.parse(await readFile(new URL('../data/study2-data.json', import.meta.url), 'utf8'));

await submit('baseline', { payload: { mood: 5, hunger: 2, sleepQuality: 5 } });

let current = await state();
while (current.stage === 'preference_practice') {
  await submit('preference_practice_response', { trialKey: current.trial.key, response: 'left', rtMs: 300 });
  current = await state();
}

let calibrationResponseCount = 0;
async function driveCalibration() {
  let attemptCount = 0;
  while (current.stage === 'calibration') {
    if (!current.trial) throw new Error(`Calibration state missing trial: ${JSON.stringify(current)}`);
    const response = latentPreference(current.trial.left.stimId) >= latentPreference(current.trial.right.stimId) ? 'left' : 'right';
    await submit('calibration_response', { trialKey: current.trial.key, response, responseMethod: 'keyboard', rtMs: 420 });
    attemptCount += 1; calibrationResponseCount += 1;
    if (attemptCount > 180) throw new Error('Calibration exceeded expected maximum');
    current = await state();
  }
  if (current.stage !== 'validation' || attemptCount < 110) throw new Error(`Calibration did not finish correctly: stage=${current.stage}, n=${attemptCount}`);
  return attemptCount;
}

async function driveValidation(pass) {
  for (let i = 0; i < 45; i += 1) {
    current = await state();
    const store = await dataStore();
    const ranks = new Map(store.assignments.filter((item) => item.sessionId === context.sessionId).map((item) => [item.stimId, item.likingRank]));
    const leftRank = ranks.get(current.trial.left.stimId); const rightRank = ranks.get(current.trial.right.stimId);
    const sameRankResponse = latentPreference(current.trial.left.stimId) >= latentPreference(current.trial.right.stimId) ? 'left' : 'right';
    const higherRankResponse = leftRank > rightRank ? 'left' : 'right';
    const response = leftRank === rightRank ? sameRankResponse : pass ? higherRankResponse : higherRankResponse === 'left' ? 'right' : 'left';
    await submit('validation_response', { trialKey: current.trial.key, response, rtMs: 380 });
  }
}

const firstCalibrationCount = await driveCalibration();
await driveValidation(false);
current = await state();
if (current.stage !== 'validation' || !current.validationFailed || current.consistencyRate >= 0.85) throw new Error('Failed validation did not trigger the 85% recalibration gate');
await submit('restart_calibration');
current = await state();
const secondCalibrationCount = await driveCalibration();
await driveValidation(true);

current = await state();
if (current.stage !== 'resource_feedback') throw new Error(`Validation did not advance: ${current.stage}`);
await submit('advance_feedback');

for (let i = 0; i < 6; i += 1) {
  current = await state();
  const trial = current.trial;
  const response = trial.type === 'dot_comparison' ? (trial.leftDots > trial.rightDots ? 'left' : 'right') : (trial.leftShape === trial.rightShape ? 'same' : 'different');
  await submit('resource_practice_response', { response, rtMs: 350 });
}

current = await state();
while (current.stage === 'resource_task') {
  if (current.needBlockCheck) {
    await submit('block_check', { block: current.completed === 45 ? 1 : 2, payload: { insufficient: 4, worry: 4, careful: 5, confidence: 4 } });
  } else {
    const trial = current.trial;
    const response = trial.type === 'dot_comparison' ? (trial.leftDots > trial.rightDots ? 'left' : 'right') : (trial.leftShape === trial.rightShape ? 'same' : 'different');
    await submit('resource_response', { response, rtMs: 470 });
  }
  current = await state();
}

await submit('manipulation_check', { payload: { resource_insufficient: 5, resource_worry: 5, resource_careful: 5, resource_tight: 5, resource_consume: 5, resource_enough: 3, resource_confidence: 3, stress: 4, anxiety: 4, reward_worry: 4, motivation: 5, engagement: 5, excitement: 4, challenge: 4 } });
await submit('cost_overview_complete');

for (let i = 0; i < 4; i += 1) {
  await submit('purchase_practice_response', { response: ['left', 'right', 'skip', 'left'][i], rtMs: 410 });
}

const comprehension = await submit('cost_comprehension', { answers: { priceMeaning: 'cost', costExample: '15', skipCost: '0', remainingRule: 'retained' } });
if (!comprehension.correct) throw new Error('Comprehension check did not pass');

for (let i = 0; i < 80; i += 1) {
  current = await state();
  const store = await dataStore();
  const assignmentMap = new Map(store.assignments.filter((item) => item.sessionId === context.sessionId).map((item) => [item.stimId, item]));
  const left = assignmentMap.get(current.trial.left.stimId);
  const right = assignmentMap.get(current.trial.right.stimId);
  const leftUtility = left.likingRank * 6 - left.cost;
  const rightUtility = right.likingRank * 6 - right.cost;
  let response = Math.max(leftUtility, rightUtility) < 2 ? 'skip' : leftUtility >= rightUtility ? 'left' : 'right';
  if (response === 'left' && current.trial.left.cost > current.budget) response = 'skip';
  if (response === 'right' && current.trial.right.cost > current.budget) response = 'skip';
  await submit('purchase_response', { trialKey: current.trial.key, response, rtMs: 520 + (i % 9) * 20 });
}

await submit('post_check', { payload: { feedbackBelief: 4, resourcePerformanceRelation: 4, taskInfluence: 4, studyPurpose: '自动化测试', suspicion: '' } });
current = await state();
if (current.stage !== 'economic_background') throw new Error(`Economic background is not the final questionnaire stage: ${current.stage}`);
await submit('economic_background', { payload: { monthlyLivingExpense: 2200, monthlyDisposableAmount: 900, disposableAdequacy: 4, economicPressure: 4 } });
current = await state();
if (current.stage !== 'complete') throw new Error(`Completion mismatch: ${JSON.stringify(current)}`);

await request('/api/auth/researcher', { method: 'POST', body: { password: 'Zx123456' }, role: 'researcher' });
const evenNumber = `S2-T${String(Date.now()).slice(-8)}2`;
const evenRegistered = await request('/api/participants/register', { method: 'POST', body: { participantNumber: evenNumber, name: '偶数分组测试', gender: '其他 / 不便回答', age: 22, major: '测试专业', contact: '', consent: true } });
const summary = await request('/api/researcher/summary', { role: 'researcher' });
const row = summary.sessions.find((item) => item.code === context.code);
const evenRow = summary.sessions.find((item) => item.code === evenRegistered.code);
if (!row || row.status !== 'completed' || row.group !== 'scarcity' || row.dataCompleteness !== 1 || !row.calibrationGrade || row.purchaseTrials !== 80) throw new Error('Researcher summary missing completed metrics, allocation, or completeness');
if (!evenRow || evenRow.group !== 'abundance') throw new Error('Even experimenter-issued ID did not enter the abundance group');
if (!summary.visualizations?.resourceTrajectory || !summary.visualizations?.purchaseTrajectory || !summary.visualizations?.manipulationSummary) throw new Error('Researcher visualizations missing');
const completedStore = await dataStore();
const assignments = completedStore.assignments.filter((item) => item.sessionId === context.sessionId);
for (const setId of [...new Set(assignments.map((item) => item.setId))]) {
  const setItems = assignments.filter((item) => item.setId === setId);
  if (setItems.length !== 5 || new Set(setItems.map((item) => item.likingRank)).size !== 5) throw new Error(`Set ${setId} does not contain one item at each liking rank`);
  if (new Set(setItems.map((item) => item.cost)).size !== 5) throw new Error(`Set ${setId} does not contain one item at each price level`);
  if (!['A', 'B', 'C', 'D'].every((category) => setItems.some((item) => item.category === category))) throw new Error(`Set ${setId} violates category balance`);
}
for (let rank = 1; rank <= 5; rank += 1) {
  if (new Set(assignments.filter((item) => item.likingRank === rank).map((item) => item.cost)).size !== 5) throw new Error(`Liking rank ${rank} is confounded with price`);
}
const purchases = completedStore.trials.filter((trial) => trial.sessionId === context.sessionId && trial.stage === 'purchase');
const typeCounts = Object.fromEntries(['low_conflict', 'liking_cost_conflict', 'cost_advantage', 'budget_pressure'].map((type) => [type, purchases.filter((trial) => trial.trialType === type).length]));
if (Object.values(typeCounts).some((count) => count !== 20)) throw new Error(`Purchase type balance failed: ${JSON.stringify(typeCounts)}`);
const probeCounts = new Map();
for (const trial of purchases.filter((trial) => trial.trialType === 'budget_pressure')) probeCounts.set(trial.pairId, (probeCounts.get(trial.pairId) || 0) + 1);
if (probeCounts.size !== 10 || [...probeCounts.values()].some((count) => count !== 2)) throw new Error('Repeated budget probe pairing failed');
const modelPayload = completedStore.surveys.find((survey) => survey.sessionId === context.sessionId && survey.type === 'purchase_behavior_summary')?.payload;
if (!modelPayload?.modelComparison?.dynamic_budget || modelPayload.repeatedProbeSwitchRate === undefined || modelPayload.conflictRtSlowingMs === undefined) throw new Error('Advanced purchase analytics missing');
for (const exportType of ['calibration', 'validation', 'resource', 'purchases', 'models', 'ddm', 'quality', 'audit', 'trajectories']) {
  const csv = await request(`/api/researcher/export?type=${exportType}`, { role: 'researcher' });
  if (String(csv).length < 40 || !String(csv).includes(',')) throw new Error(`CSV export failed: ${exportType}`);
}
const master = await request('/api/researcher/export?type=master', { role: 'researcher' });
if (!Array.isArray(master.participants) || !master.participants.some((participant) => participant.code === context.code)) throw new Error('Complete JSON backup failed');
await request(`/api/researcher/participant?id=${row.participantId}`, { method: 'DELETE', role: 'researcher' });
await request(`/api/researcher/participant?id=${evenRow.participantId}`, { method: 'DELETE', role: 'researcher' });

console.log(`Study 2 V3 smoke test passed: experimenter-issued ID allocation, failed 85% gate → full recalibration (${firstCalibrationCount}+${secondCalibrationCount} comparisons) → second 45-trial validation, 6 resource practices, 90 resource trials, 4 purchase practices, 80 formal purchases (20×4 balanced types, 10 repeated probes), final economic questionnaire, dashboard trajectories, 9 core CSV checks, complete JSON backup, and cleanup.`);
