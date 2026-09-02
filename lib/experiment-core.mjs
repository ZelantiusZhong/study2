import { randomUUID } from 'node:crypto';
import {
  clamp,
  evaluateConditionalLogit,
  fitBinaryLogit,
  fitConditionalLogit,
  hashSeed,
  mean,
  median,
  mulberry32,
  round,
  shuffled,
  softmax,
  spearman,
  sum,
} from './math.mjs';

export const STAGES = [
  'baseline',
  'preference_practice',
  'calibration',
  'validation',
  'resource_feedback',
  'resource_practice',
  'resource_task',
  'manipulation_check',
  'cost_learning',
  'purchase',
  'post_check',
  'economic_background',
  'complete',
];

export const STAGE_LABELS = {
  baseline: '基线问卷',
  preference_practice: '视觉偏好任务练习',
  calibration: '视觉偏好任务',
  validation: '视觉偏好确认',
  resource_feedback: '任务信息',
  resource_practice: '资源账户任务练习',
  resource_task: '资源账户任务',
  manipulation_check: '任务体验问卷',
  cost_learning: '连续购买任务练习',
  purchase: '连续购买任务',
  post_check: '实验后问题',
  economic_background: '生活与可支配情况',
  complete: '实验完成',
};

export const CALIBRATION_PHASES = [
  'within_full_pair',
  'within_adjacent_retest',
  'within_adjacent_retest_r2',
  'cross_set_anchor_mid',
  'cross_set_anchor_extremes',
  'cross_set_adaptive',
];

const CALIBRATION_PHASE_LABELS = {
  within_full_pair: '偏好比较（一）',
  within_adjacent_retest: '偏好比较（二）',
  within_adjacent_retest_r2: '偏好补充确认',
  cross_set_anchor_mid: '跨组偏好比较（一）',
  cross_set_anchor_extremes: '跨组偏好比较（二）',
  cross_set_adaptive: '偏好稳定性补充',
};

const ELO_K = {
  within_full_pair: 32,
  within_adjacent_retest: 24,
  within_adjacent_retest_r2: 24,
  cross_set_anchor_mid: 20,
  cross_set_anchor_extremes: 20,
  cross_set_adaptive: 20,
};

export const FINAL_SCORE_CONFIG = Object.freeze({ alphaLiking: 1, gammaReserve: 1, tokensPerReservePoint: 20 });

function pairKey(a, b) {
  return [a, b].sort().join('|');
}

function stimulusPublic(item, includeCost = false) {
  const output = { stimId: item.stimId, imageUrl: item.imageUrl };
  if (includeCost) output.cost = item.cost;
  return output;
}

function makePairTrial(sessionId, phase, index, first, second, options = {}) {
  const flip = options.forceFlip ?? (hashSeed(`${sessionId}:${phase}:${index}:${first.stimId}:${second.stimId}`) % 2 === 0);
  const left = flip ? second : first;
  const right = flip ? first : second;
  return {
    key: `${phase}:${index}:${pairKey(first.stimId, second.stimId)}`,
    phase,
    index,
    left,
    right,
    expectedStimId: options.expectedStimId ?? null,
    anchorRank: options.anchorRank ?? null,
    pairId: options.pairId ?? pairKey(first.stimId, second.stimId),
    repeat: options.repeat ?? null,
  };
}

function groupBySet(assignments) {
  const output = new Map();
  for (const item of assignments) {
    if (!output.has(item.setId)) output.set(item.setId, []);
    output.get(item.setId).push(item);
  }
  return output;
}

export function preferencePracticeTrials(assignments, sessionId) {
  const candidates = shuffled(assignments, `${sessionId}:preference-practice`).slice(0, 4);
  const pairs = [[candidates[0], candidates[1]], [candidates[2], candidates[3]]];
  const trials = [];
  for (const [pairIndex, pair] of pairs.entries()) {
    if (!pair[0] || !pair[1]) continue;
    trials.push(makePairTrial(sessionId, 'preference_practice', trials.length, pair[0], pair[1], { forceFlip: false, repeat: pairIndex + 1 }));
    trials.push(makePairTrial(sessionId, 'preference_practice', trials.length, pair[0], pair[1], { forceFlip: true, repeat: pairIndex + 1 }));
  }
  return trials;
}

export function calibrationResponses(store, session, phase = null) {
  return store.trials
    .filter((trial) => trial.sessionId === session.id && trial.stage === 'calibration' && trial.attempt === session.calibrationAttempt)
    .filter((trial) => !phase || trial.phase === phase)
    .sort((a, b) => a.sequence - b.sequence);
}

export function computeElo(assignments, responses, phases = CALIBRATION_PHASES) {
  const ratings = new Map(assignments.map((item) => [item.stimId, { score: 1500, comparisons: 0, volatility: 200 }]));
  const allowed = new Set(phases);
  for (const response of responses.filter((entry) => allowed.has(entry.phase)).sort((a, b) => a.sequence - b.sequence)) {
    if (!response.chosenStimId || response.timeout) continue;
    const loserId = response.chosenStimId === response.leftStimId ? response.rightStimId : response.leftStimId;
    const winner = ratings.get(response.chosenStimId);
    const loser = ratings.get(loserId);
    if (!winner || !loser) continue;
    const expectedWin = 1 / (1 + 10 ** ((loser.score - winner.score) / 400));
    const k = ELO_K[response.phase] ?? 24;
    winner.score = clamp(winner.score + k * (1 - expectedWin), 1100, 1900);
    loser.score = clamp(loser.score - k * (1 - expectedWin), 1100, 1900);
    winner.comparisons += 1;
    loser.comparisons += 1;
    winner.volatility = Math.max(50, 200 / Math.sqrt(1 + winner.comparisons));
    loser.volatility = Math.max(50, 200 / Math.sqrt(1 + loser.comparisons));
  }
  return ratings;
}

function rankWithinSets(assignments, ratings) {
  const ranks = new Map();
  for (const [setId, items] of groupBySet(assignments)) {
    const ordered = [...items].sort((a, b) => {
      const difference = (ratings.get(b.stimId)?.score ?? 1500) - (ratings.get(a.stimId)?.score ?? 1500);
      return difference || a.stimId.localeCompare(b.stimId);
    });
    ordered.forEach((item, index) => ranks.set(item.stimId, { setId, rank: ordered.length - index }));
  }
  return ranks;
}

function withinFullPairTrials(assignments, sessionId) {
  const trials = [];
  for (const items of groupBySet(assignments).values()) {
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        trials.push({ first: items[i], second: items[j] });
      }
    }
  }
  return shuffled(trials, `${sessionId}:within-full`).map((entry, index) => makePairTrial(sessionId, 'within_full_pair', index, entry.first, entry.second));
}

function adjacentRetestTrials(assignments, sessionId, responses) {
  const ratings = computeElo(assignments, responses, ['within_full_pair']);
  const ranks = rankWithinSets(assignments, ratings);
  const bySet = groupBySet(assignments);
  const candidates = [];
  for (const [setId, items] of bySet) {
    const byRank = new Map(items.map((item) => [ranks.get(item.stimId).rank, item]));
    for (let low = 1; low < 5; low += 1) {
      const lower = byRank.get(low);
      const higher = byRank.get(low + 1);
      candidates.push({ lower, higher, setId, low, high: low + 1 });
    }
  }
  return shuffled(candidates, `${sessionId}:adjacent-r1`).map((entry, index) => makePairTrial(
    sessionId,
    'within_adjacent_retest',
    index,
    entry.lower,
    entry.higher,
    { expectedStimId: entry.higher.stimId, pairId: `${entry.setId}:${entry.low}-${entry.high}` },
  ));
}

function adjacentRetestRound2Trials(assignments, sessionId, responses) {
  const r1 = responses.filter((entry) => entry.phase === 'within_adjacent_retest');
  const inconsistent = r1.filter((entry) => entry.chosenStimId && entry.expectedStimId && entry.chosenStimId !== entry.expectedStimId);
  if (!inconsistent.length) return [];
  const ratings = computeElo(assignments, responses, ['within_full_pair', 'within_adjacent_retest']);
  const ranks = rankWithinSets(assignments, ratings);
  const bySet = groupBySet(assignments);
  const flagged = new Set();
  for (const response of inconsistent) {
    const leftRank = ranks.get(response.leftStimId);
    const rightRank = ranks.get(response.rightStimId);
    if (!leftRank || !rightRank || leftRank.setId !== rightRank.setId) continue;
    const low = Math.min(leftRank.rank, rightRank.rank);
    const high = Math.max(leftRank.rank, rightRank.rank);
    flagged.add(`${leftRank.setId}:${low}-${high}`);
    if (low > 1) flagged.add(`${leftRank.setId}:${low - 1}-${low}`);
    if (high < 5) flagged.add(`${leftRank.setId}:${high}-${high + 1}`);
  }
  const candidates = [];
  for (const key of flagged) {
    const [setId, range] = key.split(':');
    const [low, high] = range.split('-').map(Number);
    const items = bySet.get(setId) || [];
    const lower = items.find((item) => ranks.get(item.stimId)?.rank === low);
    const higher = items.find((item) => ranks.get(item.stimId)?.rank === high);
    if (!lower || !higher) continue;
    candidates.push({ lower, higher, setId, low, high, repeat: 1 });
    candidates.push({ lower, higher, setId, low, high, repeat: 2 });
  }
  return shuffled(candidates, `${sessionId}:adjacent-r2`).slice(0, 40).map((entry, index) => makePairTrial(
    sessionId,
    'within_adjacent_retest_r2',
    index,
    entry.lower,
    entry.higher,
    { expectedStimId: entry.higher.stimId, pairId: `${entry.setId}:${entry.low}-${entry.high}`, repeat: entry.repeat, forceFlip: entry.repeat === 2 },
  ));
}

function crossAnchorMidTrials(assignments, sessionId, responses) {
  const ratings = computeElo(assignments, responses, ['within_full_pair', 'within_adjacent_retest', 'within_adjacent_retest_r2']);
  const ranks = rankWithinSets(assignments, ratings);
  const sets = [...groupBySet(assignments).keys()].sort();
  const candidates = [];
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const first = assignments.find((item) => item.setId === sets[i] && ranks.get(item.stimId)?.rank === 3);
      const second = assignments.find((item) => item.setId === sets[j] && ranks.get(item.stimId)?.rank === 3);
      candidates.push({ first, second, repeat: 1, pairId: `${sets[i]}-${sets[j]}-r3` });
      candidates.push({ first, second, repeat: 2, pairId: `${sets[i]}-${sets[j]}-r3` });
    }
  }
  return shuffled(candidates, `${sessionId}:cross-mid`).map((entry, index) => makePairTrial(
    sessionId,
    'cross_set_anchor_mid',
    index,
    entry.first,
    entry.second,
    { anchorRank: 3, repeat: entry.repeat, pairId: entry.pairId, forceFlip: entry.repeat === 2 },
  ));
}

function crossAnchorExtremeTrials(assignments, sessionId, responses) {
  const ratings = computeElo(assignments, responses, ['within_full_pair', 'within_adjacent_retest', 'within_adjacent_retest_r2', 'cross_set_anchor_mid']);
  const ranks = rankWithinSets(assignments, ratings);
  const sets = [...groupBySet(assignments).keys()].sort();
  const candidates = [];
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      for (const anchorRank of [1, 5]) {
        const first = assignments.find((item) => item.setId === sets[i] && ranks.get(item.stimId)?.rank === anchorRank);
        const second = assignments.find((item) => item.setId === sets[j] && ranks.get(item.stimId)?.rank === anchorRank);
        candidates.push({ first, second, anchorRank, pairId: `${sets[i]}-${sets[j]}-r${anchorRank}` });
      }
    }
  }
  return shuffled(candidates, `${sessionId}:cross-extreme`).map((entry, index) => makePairTrial(
    sessionId,
    'cross_set_anchor_extremes',
    index,
    entry.first,
    entry.second,
    { anchorRank: entry.anchorRank, pairId: entry.pairId },
  ));
}

function fitBradleyTerry(assignments, responses) {
  const ids = assignments.map((item) => item.stimId);
  const index = new Map(ids.map((id, position) => [id, position]));
  const strength = Array(ids.length).fill(1);
  const wins = Array(ids.length).fill(0.5);
  const comparisons = Array.from({ length: ids.length }, () => Array(ids.length).fill(0));
  for (const response of responses) {
    if (!response.chosenStimId || response.timeout) continue;
    const left = index.get(response.leftStimId);
    const right = index.get(response.rightStimId);
    const winner = index.get(response.chosenStimId);
    if (![left, right, winner].every(Number.isInteger)) continue;
    comparisons[left][right] += 1;
    comparisons[right][left] += 1;
    wins[winner] += 1;
  }
  for (let iteration = 0; iteration < 250; iteration += 1) {
    const next = strength.map((current, i) => {
      let denominator = 0;
      for (let j = 0; j < strength.length; j += 1) {
        if (i !== j && comparisons[i][j]) denominator += comparisons[i][j] / Math.max(1e-9, strength[i] + strength[j]);
      }
      return denominator ? wins[i] / denominator : current;
    });
    const geometricMean = Math.exp(mean(next.map((value) => Math.log(Math.max(value, 1e-9))))) || 1;
    for (let i = 0; i < strength.length; i += 1) strength[i] = clamp(next[i] / geometricMean, 1e-4, 1e4);
  }
  return new Map(ids.map((id, i) => [id, Math.log(strength[i])]));
}

function cycleConsistency(assignments, responses) {
  const full = responses.filter((entry) => entry.phase === 'within_full_pair' && entry.chosenStimId && !entry.timeout);
  let cycles = 0;
  let total = 0;
  for (const items of groupBySet(assignments).values()) {
    const beats = new Set();
    for (const response of full) {
      if (!items.some((item) => item.stimId === response.leftStimId)) continue;
      const loser = response.chosenStimId === response.leftStimId ? response.rightStimId : response.leftStimId;
      beats.add(`${response.chosenStimId}>${loser}`);
    }
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        for (let k = j + 1; k < items.length; k += 1) {
          const [a, b, c] = [items[i].stimId, items[j].stimId, items[k].stimId];
          if ((beats.has(`${a}>${b}`) && beats.has(`${b}>${c}`) && beats.has(`${c}>${a}`)) ||
              (beats.has(`${b}>${a}`) && beats.has(`${c}>${b}`) && beats.has(`${a}>${c}`))) cycles += 1;
          total += 1;
        }
      }
    }
  }
  return total ? cycles / total : 0;
}

function testRetestAgreement(responses) {
  const groups = new Map();
  for (const response of responses.filter((entry) => entry.phase === 'cross_set_anchor_mid' && entry.chosenStimId && !entry.timeout)) {
    if (!groups.has(response.pairId)) groups.set(response.pairId, []);
    groups.get(response.pairId).push(response.chosenStimId);
  }
  const comparisons = [...groups.values()].filter((choices) => choices.length >= 2);
  return comparisons.length ? mean(comparisons.map((choices) => choices[0] === choices[1] ? 1 : 0)) : null;
}

function rankSetsFromAnchor(assignments, responses, anchorRank) {
  const setScores = new Map([...groupBySet(assignments).keys()].map((setId) => [setId, 0]));
  for (const response of responses.filter((entry) => entry.anchorRank === anchorRank && entry.chosenStimId && !entry.timeout)) {
    const winner = assignments.find((item) => item.stimId === response.chosenStimId);
    if (winner) setScores.set(winner.setId, setScores.get(winner.setId) + 1);
  }
  return [...setScores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([setId]) => setId);
}

function kendallW(rankings) {
  if (rankings.length < 2 || rankings.some((ranking) => ranking.length !== rankings[0].length)) return null;
  const objects = rankings[0];
  const rankSums = new Map(objects.map((id) => [id, 0]));
  for (const ranking of rankings) ranking.forEach((id, index) => rankSums.set(id, rankSums.get(id) + index + 1));
  const n = objects.length;
  const m = rankings.length;
  const center = m * (n + 1) / 2;
  const squared = sum([...rankSums.values()].map((value) => (value - center) ** 2));
  const denominator = m ** 2 * (n ** 3 - n);
  return denominator ? 12 * squared / denominator : null;
}

function eloRmse(assignments, responses, ratings) {
  const errors = [];
  for (const response of responses.filter((entry) => entry.chosenStimId && !entry.timeout)) {
    const left = ratings.get(response.leftStimId)?.score ?? 1500;
    const right = ratings.get(response.rightStimId)?.score ?? 1500;
    const predictedLeft = 1 / (1 + 10 ** ((right - left) / 400));
    const actualLeft = response.chosenStimId === response.leftStimId ? 1 : 0;
    errors.push((actualLeft - predictedLeft) ** 2);
  }
  return Math.sqrt(mean(errors) ?? 0);
}

function splitHalfReliability(assignments, responses) {
  const usable = responses.filter((entry) => entry.chosenStimId && !entry.timeout);
  const odd = fitBradleyTerry(assignments, usable.filter((_, index) => index % 2));
  const even = fitBradleyTerry(assignments, usable.filter((_, index) => index % 2 === 0));
  return spearman(assignments.map((item) => odd.get(item.stimId) ?? 0), assignments.map((item) => even.get(item.stimId) ?? 0));
}

function quickCalibrationDiagnostics(assignments, responses) {
  const retest = testRetestAgreement(responses);
  const rankings = [1, 3, 5].map((rank) => rankSetsFromAnchor(assignments, responses, rank));
  const w = kendallW(rankings);
  const splitHalf = splitHalfReliability(assignments, responses);
  return { retest, kendallW: w, splitHalf };
}

function adaptiveTrials(assignments, sessionId, responses) {
  // Freeze the adaptive plan from all pre-adaptive evidence. Responses collected
  // during the adaptive phase must not change the remaining trial list.
  const basis = responses.filter((entry) => entry.phase !== 'cross_set_adaptive');
  const diagnostics = quickCalibrationDiagnostics(assignments, basis);
  const r1Inconsistent = basis.filter((entry) => entry.phase === 'within_adjacent_retest' && entry.expectedStimId && entry.chosenStimId !== entry.expectedStimId);
  const needsSupplement = r1Inconsistent.length > 4 || (diagnostics.retest ?? 0) < 0.75 || (diagnostics.kendallW ?? 0) < 0.60 || (diagnostics.splitHalf ?? 0) < 0.60;
  if (!needsSupplement) return [];
  const ratings = computeElo(assignments, basis);
  const flaggedIds = new Set(r1Inconsistent.flatMap((entry) => [entry.leftStimId, entry.rightStimId]));
  if (!flaggedIds.size) {
    [...ratings.entries()].sort((a, b) => b[1].volatility - a[1].volatility).slice(0, 8).forEach(([id]) => flaggedIds.add(id));
  }
  const candidates = [];
  for (const stimId of flaggedIds) {
    const first = assignments.find((item) => item.stimId === stimId);
    if (!first) continue;
    const others = assignments
      .filter((item) => item.setId !== first.setId)
      .sort((a, b) => Math.abs((ratings.get(a.stimId)?.score ?? 1500) - (ratings.get(first.stimId)?.score ?? 1500)) - Math.abs((ratings.get(b.stimId)?.score ?? 1500) - (ratings.get(first.stimId)?.score ?? 1500)));
    if (others[0]) candidates.push({ first, second: others[0] });
  }
  const unique = [];
  const seen = new Set();
  for (const candidate of shuffled(candidates, `${sessionId}:adaptive`)) {
    const key = pairKey(candidate.first.stimId, candidate.second.stimId);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  while (unique.length < 15) {
    const rank = unique.length % 5 + 1;
    const ranks = rankWithinSets(assignments, ratings);
    const pool = assignments.filter((item) => ranks.get(item.stimId)?.rank === rank);
    const rotated = shuffled(pool, `${sessionId}:adaptive-fill:${unique.length}`);
    if (rotated.length < 2) break;
    const candidate = { first: rotated[0], second: rotated.find((item) => item.setId !== rotated[0].setId) };
    if (!candidate.second) break;
    const key = pairKey(candidate.first.stimId, candidate.second.stimId);
    if (!seen.has(key)) { seen.add(key); unique.push(candidate); } else break;
  }
  return unique.slice(0, 15).map((entry, index) => makePairTrial(sessionId, 'cross_set_adaptive', index, entry.first, entry.second, { pairId: pairKey(entry.first.stimId, entry.second.stimId) }));
}

export function calibrationPhaseTrials(store, session, assignments, phase = session.calibrationPhase) {
  const responses = calibrationResponses(store, session);
  if (phase === 'within_full_pair') return withinFullPairTrials(assignments, session.id);
  if (phase === 'within_adjacent_retest') return adjacentRetestTrials(assignments, session.id, responses);
  if (phase === 'within_adjacent_retest_r2') return adjacentRetestRound2Trials(assignments, session.id, responses);
  if (phase === 'cross_set_anchor_mid') return crossAnchorMidTrials(assignments, session.id, responses);
  if (phase === 'cross_set_anchor_extremes') return crossAnchorExtremeTrials(assignments, session.id, responses);
  if (phase === 'cross_set_adaptive') return adaptiveTrials(assignments, session.id, responses);
  return [];
}

export function advanceCalibrationPhase(store, session, assignments) {
  let currentIndex = CALIBRATION_PHASES.indexOf(session.calibrationPhase);
  while (currentIndex < CALIBRATION_PHASES.length - 1) {
    currentIndex += 1;
    session.calibrationPhase = CALIBRATION_PHASES[currentIndex];
    const trials = calibrationPhaseTrials(store, session, assignments);
    if (trials.length) return { complete: false, phase: session.calibrationPhase };
  }
  return { complete: true, phase: 'complete' };
}

export function calibrationReport(store, session, assignments) {
  const responses = calibrationResponses(store, session);
  const ratings = computeElo(assignments, responses);
  const btl = fitBradleyTerry(assignments, responses);
  const cycleRate = cycleConsistency(assignments, responses);
  const retest = testRetestAgreement(responses);
  const crossW = kendallW([1, 3, 5].map((rank) => rankSetsFromAnchor(assignments, responses, rank)));
  const rmse = eloRmse(assignments, responses, ratings);
  const timeoutRate = responses.length ? responses.filter((entry) => entry.timeout).length / responses.length : 0;
  const splitHalf = splitHalfReliability(assignments, responses);
  const cycleScore = 1 - Math.min(1, cycleRate / 0.20);
  const retestScore = retest ?? 0;
  const kendallScore = crossW ?? 0;
  const eloScore = 1 - Math.min(1, rmse / 0.50);
  const timeoutScore = 1 - Math.min(1, timeoutRate / 0.30);
  const splitHalfScore = Math.max(0, splitHalf ?? 0);
  const composite = cycleScore * 0.17 + retestScore * 0.21 + kendallScore * 0.20 + eloScore * 0.17 + timeoutScore * 0.10 + splitHalfScore * 0.15;
  const grade = composite >= 0.80 ? 'A' : composite >= 0.55 ? 'B' : 'C';
  const ranks = rankWithinSets(assignments, ratings);
  for (const assignment of assignments) {
    assignment.likingRank = ranks.get(assignment.stimId)?.rank ?? null;
    const setIndex = Number.isInteger(assignment.setIndex) ? assignment.setIndex : Math.max(0, assignment.setId.charCodeAt(0) - 65);
    const pricePattern = Number.isInteger(assignment.pricePattern) ? assignment.pricePattern : 0;
    assignment.cost = assignment.likingRank ? [5, 10, 15, 20, 25][(assignment.likingRank - 1 + setIndex + pricePattern) % 5] : null;
    assignment.eloScore = round(ratings.get(assignment.stimId)?.score ?? 1500, 3);
    assignment.eloVolatility = round(ratings.get(assignment.stimId)?.volatility ?? 200, 3);
    assignment.btlScore = round(btl.get(assignment.stimId) ?? 0, 5);
    assignment.calibrationAttempt = session.calibrationAttempt;
  }
  const lowConfidenceSets = [];
  for (const [setId, items] of groupBySet(assignments)) {
    const averageVolatility = mean(items.map((item) => ratings.get(item.stimId)?.volatility ?? 200));
    if (averageVolatility > 75) lowConfidenceSets.push(setId);
  }
  return {
    attempt: session.calibrationAttempt,
    totalTrials: responses.length,
    phaseCounts: Object.fromEntries(CALIBRATION_PHASES.map((phase) => [phase, responses.filter((entry) => entry.phase === phase).length])),
    cycleConsistencyRate: round(cycleRate),
    testRetestAgreement: round(retest),
    crossLevelKendallW: round(crossW),
    eloModelRmse: round(rmse),
    splitHalfSpearman: round(splitHalf),
    timeoutRate: round(timeoutRate),
    compositeStability: round(composite),
    stabilityGrade: grade,
    lowConfidenceSets,
    adaptiveSupplementCount: responses.filter((entry) => entry.phase === 'cross_set_adaptive').length,
  };
}

export function calibrationState(store, session, assignments) {
  const phase = session.calibrationPhase || 'within_full_pair';
  const trials = calibrationPhaseTrials(store, session, assignments, phase);
  const responses = calibrationResponses(store, session, phase);
  const current = trials[responses.length];
  return {
    phase,
    phaseLabel: CALIBRATION_PHASE_LABELS[phase] || '偏好比较',
    phaseIndex: CALIBRATION_PHASES.indexOf(phase) + 1,
    phaseTotal: CALIBRATION_PHASES.length,
    completed: responses.length,
    total: trials.length,
    overallCompleted: calibrationResponses(store, session).length,
    trial: current ? {
      key: current.key,
      left: stimulusPublic(current.left),
      right: stimulusPublic(current.right),
    } : null,
  };
}

export function validationTrials(assignments, sessionId, attempt = 1) {
  const different = [];
  const same = [];
  for (let i = 0; i < assignments.length; i += 1) {
    for (let j = i + 1; j < assignments.length; j += 1) {
      const first = assignments[i];
      const second = assignments[j];
      if (first.setId === second.setId && first.likingRank !== second.likingRank) different.push({ first, second, type: 'different_rank' });
      if (first.setId !== second.setId && first.likingRank === second.likingRank) same.push({ first, second, type: 'same_rank' });
    }
  }
  const picked = [
    ...shuffled(different, `${sessionId}:validation:${attempt}:different`).slice(0, 30),
    ...shuffled(same, `${sessionId}:validation:${attempt}:same`).slice(0, 15),
  ];
  return shuffled(picked, `${sessionId}:validation:${attempt}:order`).map((entry, index) => {
    const trial = makePairTrial(sessionId, 'validation', index, entry.first, entry.second, { pairId: pairKey(entry.first.stimId, entry.second.stimId) });
    return {
      ...trial,
      type: entry.type,
      preferredStimId: entry.type === 'different_rank'
        ? (entry.first.likingRank > entry.second.likingRank ? entry.first.stimId : entry.second.stimId)
        : null,
    };
  });
}

function dotTrial(sessionId, namespace, index, config = {}) {
  const rng = mulberry32(hashSeed(`${sessionId}:${namespace}:${index}`));
  const minimum = config.minimum ?? 30;
  const maximum = config.maximum ?? 50;
  const differenceMin = config.differenceMin ?? 1;
  const differenceMax = config.differenceMax ?? 3;
  const difference = differenceMin + Math.floor(rng() * (differenceMax - differenceMin + 1));
  const low = minimum + Math.floor(rng() * (maximum - minimum - difference + 1));
  const leftHigher = rng() >= 0.5;
  return {
    index,
    type: 'dot_comparison',
    leftDots: leftHigher ? low + difference : low,
    rightDots: leftHigher ? low : low + difference,
    dotSeed: hashSeed(`${sessionId}:${namespace}:dots:${index}`),
    correctResponse: leftHigher ? 'left' : 'right',
  };
}

function shapeTrial(sessionId, namespace, index, forceMatch = null) {
  const rng = mulberry32(hashSeed(`${sessionId}:${namespace}:${index}`));
  const shapes = ['circle', 'square', 'triangle', 'diamond'];
  const leftShape = shapes[Math.floor(rng() * shapes.length)];
  const same = forceMatch ?? rng() >= 0.5;
  const alternatives = shapes.filter((shape) => shape !== leftShape);
  const rightShape = same ? leftShape : alternatives[Math.floor(rng() * alternatives.length)];
  return { index, type: 'shape_matching', leftShape, rightShape, correctResponse: same ? 'same' : 'different' };
}

export function resourcePracticeTrials(sessionId) {
  return [
    dotTrial(sessionId, 'resource-practice', 0, { minimum: 15, maximum: 25 }),
    dotTrial(sessionId, 'resource-practice', 1, { minimum: 15, maximum: 25 }),
    shapeTrial(sessionId, 'resource-practice', 2, true),
    dotTrial(sessionId, 'resource-practice', 3),
    dotTrial(sessionId, 'resource-practice', 4),
    shapeTrial(sessionId, 'resource-practice', 5, false),
  ];
}

export function resourceTaskTrials(sessionId) {
  const output = [];
  for (let block = 0; block < 18; block += 1) {
    const shapePosition = 1 + (hashSeed(`${sessionId}:shape-position:${block}`) % 3);
    for (let slot = 0; slot < 5; slot += 1) {
      const index = block * 5 + slot;
      output.push(slot === shapePosition ? shapeTrial(sessionId, 'resource-formal', index) : dotTrial(sessionId, 'resource-formal', index));
    }
  }
  return output;
}

export function computeResourceFeedback(session, trial, response) {
  const actualCorrect = Boolean(response) && response === trial.correctResponse;
  if (trial.type === 'shape_matching') {
    return { actualCorrect, feedbackMode: 'true', outcome: actualCorrect ? 'win' : 'loss', points: 2 };
  }
  if (!response) return { actualCorrect: false, feedbackMode: 'manipulated', outcome: 'loss', points: 2 };
  const balance = session.balance;
  const remaining = 90 - trial.index;
  let outcome;
  if (session.group === 'scarcity') {
    if (remaining <= 8) {
      if (balance < 10) outcome = 'win';
      else if (balance > 11) outcome = 'loss';
      else outcome = hashSeed(`${session.id}:scarcity-final:${trial.index}`) % 3 ? 'loss' : 'win';
    } else if (balance <= 4) outcome = 'win';
    else if (balance >= 10) outcome = 'loss';
    else if (balance >= 8) outcome = hashSeed(`${session.id}:scarcity-high:${trial.index}`) % 5 ? 'loss' : 'win';
    else outcome = hashSeed(`${session.id}:scarcity-mid:${trial.index}`) % 2 ? 'win' : 'loss';
  } else {
    const target = Math.min(35, 10 + 27 * (trial.index / 89));
    if (balance >= 38) outcome = 'loss';
    else if (remaining <= 12 && balance < 31) outcome = 'win';
    else if (balance < target) outcome = 'win';
    else outcome = hashSeed(`${session.id}:abundance:${trial.index}`) % 5 < 3 ? 'win' : 'loss';
  }
  return { actualCorrect, feedbackMode: 'manipulated', outcome, points: 2 };
}

export function purchasePracticeTrials(assignments, sessionId) {
  const conflict = [];
  const ordered = [...assignments];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const first = ordered[i];
      const second = ordered[j];
      if ((first.likingRank - second.likingRank) * (first.cost - second.cost) > 0) conflict.push([first, second]);
    }
  }
  const fallback = conflict.length ? shuffled(conflict, `${sessionId}:purchase-practice`) : [[assignments[0], assignments[1]], [assignments[2], assignments[3]]];
  const pairs = fallback.slice(0, 2);
  const trials = [];
  pairs.forEach(([first, second], pairIndex) => {
    trials.push({ ...makePairTrial(sessionId, 'purchase_practice', trials.length, first, second, { forceFlip: false, pairId: `practice-${pairIndex}` }), type: 'practice' });
    trials.push({ ...makePairTrial(sessionId, 'purchase_practice', trials.length, first, second, { forceFlip: true, pairId: `practice-${pairIndex}` }), type: 'practice' });
  });
  return trials;
}

function pairPools(assignments) {
  const lowConflict = [];
  const conflict = [];
  const costAdvantage = [];
  for (let i = 0; i < assignments.length; i += 1) {
    for (let j = i + 1; j < assignments.length; j += 1) {
      const first = assignments[i];
      const second = assignments[j];
      const likingDifference = first.likingRank - second.likingRank;
      const costDifference = first.cost - second.cost;
      if (likingDifference && likingDifference * costDifference < 0) lowConflict.push([first, second]);
      if (likingDifference && likingDifference * costDifference > 0) conflict.push([first, second]);
      if (Math.abs(likingDifference) <= 1 && Math.abs(costDifference) >= 10) costAdvantage.push([first, second]);
    }
  }
  return { lowConflict, conflict, costAdvantage };
}

function takePairs(pool, count, seedText, excluded = new Set()) {
  const available = shuffled(pool, seedText).filter(([a, b]) => !excluded.has(pairKey(a.stimId, b.stimId)));
  const output = [];
  for (let index = 0; index < count; index += 1) {
    if (!available.length) break;
    output.push(available[index % available.length]);
  }
  return output;
}

export function purchaseTrials(assignments, sessionId) {
  const pools = pairPools(assignments);
  const probePairs = takePairs(pools.conflict, 10, `${sessionId}:probe-pairs`);
  const probeKeys = new Set(probePairs.map(([a, b]) => pairKey(a.stimId, b.stimId)));
  const ordinary = [
    ...takePairs(pools.lowConflict, 20, `${sessionId}:low`).map((pair) => ({ type: 'low_conflict', pair })),
    ...takePairs(pools.conflict, 20, `${sessionId}:conflict`, probeKeys).map((pair) => ({ type: 'liking_cost_conflict', pair })),
    ...takePairs(pools.costAdvantage, 20, `${sessionId}:cost`).map((pair) => ({ type: 'cost_advantage', pair })),
  ];
  const schedule = Array(80).fill(null);
  const earlyPositions = [3, 7, 11, 15, 19, 23, 27, 31, 35, 39];
  const latePositions = [42, 46, 50, 54, 58, 62, 66, 70, 74, 78];
  probePairs.forEach(([first, second], probeIndex) => {
    const pairId = `budget-probe-${probeIndex + 1}`;
    schedule[earlyPositions[probeIndex]] = { type: 'budget_pressure', pair: [first, second], pairId, repeat: 'early', forceFlip: probeIndex % 2 === 0 };
    schedule[latePositions[probeIndex]] = { type: 'budget_pressure', pair: [first, second], pairId, repeat: 'late', forceFlip: probeIndex % 2 !== 0 };
  });
  const shuffledOrdinary = shuffled(ordinary, `${sessionId}:ordinary-order`);
  let ordinaryIndex = 0;
  for (let index = 0; index < schedule.length; index += 1) {
    if (!schedule[index]) {
      schedule[index] = { ...shuffledOrdinary[ordinaryIndex], forceFlip: ordinaryIndex % 2 === 0 };
      ordinaryIndex += 1;
    }
  }
  return schedule.map((entry, index) => {
    const [first, second] = entry.pair;
    const trial = makePairTrial(sessionId, 'purchase', index, first, second, {
      pairId: entry.pairId || pairKey(first.stimId, second.stimId),
      repeat: entry.repeat || null,
      forceFlip: entry.forceFlip,
    });
    return { ...trial, type: entry.type };
  });
}

function linearSlope(values) {
  if (values.length < 2) return null;
  const xMean = (values.length - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - xMean) * (value - yMean);
    denominator += (index - xMean) ** 2;
  });
  return denominator ? numerator / denominator : null;
}

function choiceRows(purchases) {
  return purchases.map((trial) => ({
    trialIndex: trial.trialIndex,
    choiceIndex: trial.response === 'left' ? 0 : trial.response === 'right' ? 1 : 2,
    leftLiking: trial.leftLiking,
    rightLiking: trial.rightLiking,
    leftCost: trial.leftCost,
    rightCost: trial.rightCost,
    pressure: clamp(Number(trial.meanPricePressure || 0), 0, 5),
  }));
}

const modelSpecs = {
  liking_only: {
    count: 2,
    features: (row) => [[row.leftLiking, 0], [row.rightLiking, 0], [0, 1]],
  },
  cost_only: {
    count: 2,
    features: (row) => [[-row.leftCost / 5, 0], [-row.rightCost / 5, 0], [0, 1]],
  },
  static_integration: {
    count: 3,
    features: (row) => [[row.leftLiking, -row.leftCost / 5, 0], [row.rightLiking, -row.rightCost / 5, 0], [0, 0, 1]],
  },
  dynamic_budget: {
    count: 5,
    features: (row) => [
      [row.leftLiking, -row.leftCost / 5, -(row.leftCost / 5) * row.pressure, 0, 0],
      [row.rightLiking, -row.rightCost / 5, -(row.rightCost / 5) * row.pressure, 0, 0],
      [0, 0, 0, 1, row.pressure],
    ],
  },
};

function crossValidateModel(rows, spec) {
  let logLoss = 0;
  let correct = 0;
  let count = 0;
  for (let fold = 0; fold < 5; fold += 1) {
    const training = rows.filter((row) => row.trialIndex % 5 !== fold);
    const testing = rows.filter((row) => row.trialIndex % 5 === fold);
    const fitted = fitConditionalLogit(training, spec.features, spec.count, { iterations: 350 });
    const evaluated = evaluateConditionalLogit(testing, spec.features, fitted.beta);
    logLoss += evaluated.nll ?? 0;
    correct += (evaluated.accuracy ?? 0) * testing.length;
    count += testing.length;
  }
  return { cvLogLoss: count ? logLoss / count : null, cvAccuracy: count ? correct / count : null };
}

export function computePurchaseAnalytics(purchases) {
  if (!purchases.length) return null;
  const bought = purchases.filter((trial) => trial.response === 'left' || trial.response === 'right');
  const spent = sum(bought.map((trial) => trial.spent));
  const likingSum = sum(bought.map((trial) => trial.chosenLiking));
  const thirds = [purchases.slice(0, 27), purchases.slice(27, 54), purchases.slice(54)];
  const thirdSpend = thirds.map((part) => sum(part.map((trial) => trial.spent)));
  const rows = choiceRows(purchases);
  const fittedModels = {};
  for (const [name, spec] of Object.entries(modelSpecs)) {
    const fitted = fitConditionalLogit(rows, spec.features, spec.count);
    const cv = crossValidateModel(rows, spec);
    fittedModels[name] = {
      beta: fitted.beta.map((value) => round(value, 6)),
      nll: round(fitted.nll),
      accuracy: round(fitted.accuracy),
      aic: round(2 * spec.count + 2 * fitted.nll),
      bic: round(Math.log(rows.length) * spec.count + 2 * fitted.nll),
      cvLogLoss: round(cv.cvLogLoss),
      cvAccuracy: round(cv.cvAccuracy),
    };
  }
  const dynamic = fittedModels.dynamic_budget.beta;
  const medianPressure = median(rows.map((row) => row.pressure)) ?? 0;
  const lambdaBasePerToken = dynamic[1] / 5;
  const lambdaAtMedianPerToken = (dynamic[1] + dynamic[2] * medianPressure) / 5;
  const wtpPerLiking = lambdaAtMedianPerToken > 0 ? dynamic[0] / lambdaAtMedianPerToken : null;
  const abRows = purchases
    .filter((trial) => trial.response === 'left' || trial.response === 'right')
    .map((trial) => ({
      outcome: trial.response === 'right' ? 1 : 0,
      deltaLiking: trial.rightLiking - trial.leftLiking,
      deltaCost: trial.rightCost - trial.leftCost,
      pressure: clamp(Number(trial.meanPricePressure || 0), 0, 5),
    }));
  const abModel = fitBinaryLogit(abRows, (row) => [1, row.deltaLiking, -row.deltaCost / 5, -(row.deltaCost / 5) * row.pressure], 4);
  const buyModel = fitBinaryLogit(purchases.map((trial) => ({ outcome: trial.response === 'skip' ? 0 : 1, pressure: trial.meanPricePressure })), (row) => [1, clamp(Number(row.pressure || 0), 0, 5)], 2);
  const dynamicProbabilities = fitConditionalLogit(rows, modelSpecs.dynamic_budget.features, 5).probabilities;
  const entropy = mean(dynamicProbabilities.map((probabilities) => -sum(probabilities.map((probability) => probability * Math.log(Math.max(probability, 1e-12))))));
  const conflict = purchases.filter((trial) => trial.trialType === 'liking_cost_conflict' || trial.trialType === 'budget_pressure');
  const lowConflict = purchases.filter((trial) => trial.trialType === 'low_conflict');
  const expensiveLiked = conflict.filter((trial) => {
    const highLikedSide = trial.leftLiking > trial.rightLiking ? 'left' : 'right';
    return trial.response === highLikedSide;
  }).length;
  const cheap = conflict.filter((trial) => {
    const lowCostSide = trial.leftCost < trial.rightCost ? 'left' : 'right';
    return trial.response === lowCostSide;
  }).length;
  const probeGroups = new Map();
  for (const trial of purchases.filter((entry) => entry.trialType === 'budget_pressure')) {
    if (!probeGroups.has(trial.pairId)) probeGroups.set(trial.pairId, []);
    probeGroups.get(trial.pairId).push(trial);
  }
  const matchedProbes = [...probeGroups.values()].filter((entries) => entries.length === 2).map((entries) => entries.sort((a, b) => a.trialIndex - b.trialIndex));
  const probeSwitchRate = matchedProbes.length
    ? mean(matchedProbes.map(([early, late]) => (early.chosenStimId || 'skip') !== (late.chosenStimId || 'skip') ? 1 : 0))
    : null;
  const probeConservationShiftRate = matchedProbes.length
    ? mean(matchedProbes.map(([early, late]) => late.response === 'skip' || late.chosenCost < early.chosenCost ? 1 : 0))
    : null;
  const lowConflictRt = median(lowConflict.filter((trial) => !trial.timeout).map((trial) => trial.rtMs));
  const conflictRt = median(conflict.filter((trial) => !trial.timeout).map((trial) => trial.rtMs));
  return {
    totalSpent: spent,
    purchaseRate: round(bought.length / purchases.length),
    skipRate: round(1 - bought.length / purchases.length),
    averagePurchaseCost: round(mean(bought.map((trial) => trial.chosenCost))),
    averagePurchaseLiking: round(mean(bought.map((trial) => trial.chosenLiking))),
    resourceEfficiency: spent ? round(likingSum / spent, 6) : null,
    earlySpend: thirdSpend[0],
    middleSpend: thirdSpend[1],
    lateSpend: thirdSpend[2],
    earlySpendShare: spent ? round(thirdSpend[0] / spent) : null,
    middleSpendShare: spent ? round(thirdSpend[1] / spent) : null,
    lateSpendShare: spent ? round(thirdSpend[2] / spent) : null,
    spendingRateSlope: round(linearSlope(purchases.map((trial) => trial.spent))),
    conflictHighLikingHighCostRate: conflict.length ? round(expensiveLiked / conflict.length) : null,
    conflictLowCostRate: conflict.length ? round(cheap / conflict.length) : null,
    conflictSkipRate: conflict.length ? round(conflict.filter((trial) => trial.response === 'skip').length / conflict.length) : null,
    repeatedProbeSwitchRate: round(probeSwitchRate),
    repeatedProbeConservationShiftRate: round(probeConservationShiftRate),
    lowConflictMedianRtMs: round(lowConflictRt, 1),
    conflictMedianRtMs: round(conflictRt, 1),
    conflictRtSlowingMs: Number.isFinite(conflictRt) && Number.isFinite(lowConflictRt) ? round(conflictRt - lowConflictRt, 1) : null,
    rtCautionProxy: Number.isFinite(conflictRt) && Number.isFinite(lowConflictRt) && lowConflictRt > 0 ? round(conflictRt / lowConflictRt, 4) : null,
    budgetSensitivity: round(-buyModel.beta[1]),
    betaLiking: round(dynamic[0]),
    lambdaBasePerToken: round(lambdaBasePerToken, 6),
    lambdaBudgetInteractionPerToken: round(dynamic[2] / 5, 6),
    lambdaAtMedianPressurePerToken: round(lambdaAtMedianPerToken, 6),
    purchaseThresholdTheta: round(dynamic[3]),
    thresholdBudgetInteraction: round(dynamic[4]),
    wtpPerLiking: round(wtpPerLiking),
    choiceConsistencyTauProxy: round(Math.sqrt(dynamic[0] ** 2 + dynamic[1] ** 2)),
    decisionEntropy: round(entropy),
    abChoiceIntercept: round(abModel.beta[0]),
    abDeltaLikingWeight: round(abModel.beta[1]),
    abDeltaCostWeight: round(abModel.beta[2]),
    abCostPressureInteraction: round(abModel.beta[3]),
    abModelAccuracy: round(abModel.accuracy),
    modelComparison: fittedModels,
  };
}

export function completionSummary(purchases, finalBudget) {
  const bought = purchases.filter((trial) => trial.response === 'left' || trial.response === 'right');
  const likingSum = sum(bought.map((trial) => trial.chosenLiking));
  const reserveScore = finalBudget / FINAL_SCORE_CONFIG.tokensPerReservePoint;
  return {
    finalBudget,
    purchased: bought.length,
    skipped: purchases.length - bought.length,
    likingSum,
    reserveScore: round(reserveScore, 2),
    finalScore: round(FINAL_SCORE_CONFIG.alphaLiking * likingSum + FINAL_SCORE_CONFIG.gammaReserve * reserveScore, 2),
  };
}

export function qualityFlags(store, session) {
  const flags = [];
  const survey = (type) => store.surveys.find((entry) => entry.sessionId === session.id && entry.type === type)?.payload;
  const calibration = survey('calibration_quality');
  const validation = survey('validation_quality');
  const post = survey('post_check');
  const economic = survey('economic_background');
  const calibrationTrials = store.trials.filter((trial) => trial.sessionId === session.id && trial.stage === 'calibration' && trial.attempt === session.calibrationAttempt);
  const resource = store.trials.filter((trial) => trial.sessionId === session.id && trial.stage === 'resource_task');
  const purchases = store.trials.filter((trial) => trial.sessionId === session.id && trial.stage === 'purchase');
  if (calibration?.stabilityGrade === 'C') flags.push('calibration_grade_c');
  if ((calibration?.timeoutRate ?? 0) > 0.20) flags.push('high_calibration_timeout');
  if (validation && validation.differentRankConsistencyRate < 0.85) flags.push('validation_failed');
  if (calibrationTrials.length >= 40 && calibrationTrials.filter((trial) => Number.isFinite(trial.rtMs) && trial.rtMs < 250).length / calibrationTrials.length > 0.20) flags.push('high_fast_calibration_rate');
  if (resource.length && mean(resource.map((trial) => trial.actualCorrect ? 1 : 0)) < 0.55) flags.push('low_resource_accuracy');
  if (resource.length && resource.filter((trial) => trial.timeout).length / resource.length > 0.20) flags.push('high_resource_timeout');
  if (resource.length >= 30 && resource.filter((trial) => Number.isFinite(trial.rtMs) && trial.rtMs < 150).length / resource.length > 0.20) flags.push('high_fast_resource_rate');
  if (purchases.length && purchases.filter((trial) => trial.timeout).length / purchases.length > 0.20) flags.push('high_purchase_timeout');
  if (purchases.length >= 30 && purchases.filter((trial) => Number.isFinite(trial.rtMs) && trial.rtMs < 250).length / purchases.length > 0.20) flags.push('high_fast_purchase_rate');
  if (purchases.length) {
    const leftRight = purchases.filter((trial) => trial.response === 'left' || trial.response === 'right');
    const leftRate = leftRight.length ? leftRight.filter((trial) => trial.response === 'left').length / leftRight.length : 0.5;
    if (leftRate < 0.10 || leftRate > 0.90) flags.push('extreme_side_bias');
  }
  if (post?.suspicion && String(post.suspicion).trim().length >= 10) flags.push('reported_feedback_suspicion');
  if (session.status === 'completed' && !economic) flags.push('missing_economic_background');
  return flags;
}

export function publicCalibrationTrial(trial) {
  return trial ? { key: trial.key, left: stimulusPublic(trial.left), right: stimulusPublic(trial.right) } : null;
}

export function publicPurchaseTrial(trial) {
  return trial ? {
    key: trial.key,
    type: trial.type,
    pairId: trial.pairId,
    repeat: trial.repeat,
    left: stimulusPublic(trial.left, true),
    right: stimulusPublic(trial.right, true),
  } : null;
}

export function newEvent(sessionId, type, details = {}) {
  return { id: randomUUID(), sessionId, type, details, createdAt: new Date().toISOString() };
}
