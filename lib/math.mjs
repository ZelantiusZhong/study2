export function hashSeed(value) {
  let h = 2166136261;
  const text = String(value);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(items, seedText) {
  const output = [...items];
  const rng = mulberry32(hashSeed(seedText));
  for (let i = output.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

export function mean(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? sum(finite) / finite.length : null;
}

export function median(values) {
  const finite = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return null;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[mid] : (finite[mid - 1] + finite[mid]) / 2;
}

export function variance(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (finite.length < 2) return 0;
  const center = mean(finite);
  return finite.reduce((total, value) => total + (value - center) ** 2, 0) / (finite.length - 1);
}

export function standardDeviation(values) {
  return Math.sqrt(variance(values));
}

export function pearson(left, right) {
  const pairs = left.map((value, index) => [Number(value), Number(right[index])])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (pairs.length < 3) return null;
  const aMean = mean(pairs.map(([a]) => a));
  const bMean = mean(pairs.map(([, b]) => b));
  let numerator = 0;
  let aDenominator = 0;
  let bDenominator = 0;
  for (const [a, b] of pairs) {
    numerator += (a - aMean) * (b - bMean);
    aDenominator += (a - aMean) ** 2;
    bDenominator += (b - bMean) ** 2;
  }
  const denominator = Math.sqrt(aDenominator * bDenominator);
  return denominator ? numerator / denominator : null;
}

function ranks(values) {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const output = Array(values.length).fill(0);
  let cursor = 0;
  while (cursor < sorted.length) {
    let end = cursor + 1;
    while (end < sorted.length && sorted[end].value === sorted[cursor].value) end += 1;
    const averageRank = (cursor + 1 + end) / 2;
    for (let i = cursor; i < end; i += 1) output[sorted[i].index] = averageRank;
    cursor = end;
  }
  return output;
}

export function spearman(left, right) {
  if (left.length !== right.length || left.length < 3) return null;
  return pearson(ranks(left), ranks(right));
}

export function logistic(value) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

export function softmax(values) {
  const maxValue = Math.max(...values);
  const exponentials = values.map((value) => Math.exp(clamp(value - maxValue, -50, 50)));
  const denominator = sum(exponentials) || 1;
  return exponentials.map((value) => value / denominator);
}

function dot(left, right) {
  let value = 0;
  for (let i = 0; i < left.length; i += 1) value += left[i] * right[i];
  return value;
}

export function fitConditionalLogit(rows, featureBuilder, parameterCount, options = {}) {
  const iterations = options.iterations ?? 700;
  const learningRate = options.learningRate ?? 0.025;
  const l2 = options.l2 ?? 0.015;
  const beta = Array(parameterCount).fill(0);
  const firstMoment = Array(parameterCount).fill(0);
  const secondMoment = Array(parameterCount).fill(0);
  const beta1 = 0.9;
  const beta2 = 0.999;
  const epsilon = 1e-8;

  if (!rows.length) return { beta, nll: null, accuracy: null, probabilities: [] };

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const gradient = Array(parameterCount).fill(0);
    for (const row of rows) {
      const features = featureBuilder(row);
      const probabilities = softmax(features.map((entry) => dot(beta, entry)));
      for (let alternative = 0; alternative < features.length; alternative += 1) {
        const residual = (alternative === row.choiceIndex ? 1 : 0) - probabilities[alternative];
        for (let parameter = 0; parameter < parameterCount; parameter += 1) {
          gradient[parameter] += residual * features[alternative][parameter];
        }
      }
    }
    for (let parameter = 0; parameter < parameterCount; parameter += 1) {
      gradient[parameter] = gradient[parameter] / rows.length - l2 * beta[parameter];
      firstMoment[parameter] = beta1 * firstMoment[parameter] + (1 - beta1) * gradient[parameter];
      secondMoment[parameter] = beta2 * secondMoment[parameter] + (1 - beta2) * gradient[parameter] ** 2;
      const mHat = firstMoment[parameter] / (1 - beta1 ** iteration);
      const vHat = secondMoment[parameter] / (1 - beta2 ** iteration);
      beta[parameter] += learningRate * mHat / (Math.sqrt(vHat) + epsilon);
      beta[parameter] = clamp(beta[parameter], -12, 12);
    }
  }

  return evaluateConditionalLogit(rows, featureBuilder, beta);
}

export function evaluateConditionalLogit(rows, featureBuilder, beta) {
  if (!rows.length) return { beta: [...beta], nll: null, accuracy: null, probabilities: [] };
  let nll = 0;
  let correct = 0;
  const probabilities = [];
  for (const row of rows) {
    const features = featureBuilder(row);
    const p = softmax(features.map((entry) => dot(beta, entry)));
    probabilities.push(p);
    nll -= Math.log(Math.max(1e-12, p[row.choiceIndex]));
    const predicted = p.indexOf(Math.max(...p));
    if (predicted === row.choiceIndex) correct += 1;
  }
  return { beta: [...beta], nll, accuracy: correct / rows.length, probabilities };
}

export function fitBinaryLogit(rows, featureBuilder, parameterCount, options = {}) {
  const iterations = options.iterations ?? 700;
  const learningRate = options.learningRate ?? 0.025;
  const l2 = options.l2 ?? 0.02;
  const beta = Array(parameterCount).fill(0);
  const firstMoment = Array(parameterCount).fill(0);
  const secondMoment = Array(parameterCount).fill(0);
  const beta1 = 0.9;
  const beta2 = 0.999;
  if (!rows.length) return { beta, nll: null, accuracy: null };

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const gradient = Array(parameterCount).fill(0);
    for (const row of rows) {
      const features = featureBuilder(row);
      const probability = logistic(dot(beta, features));
      const residual = row.outcome - probability;
      for (let parameter = 0; parameter < parameterCount; parameter += 1) {
        gradient[parameter] += residual * features[parameter];
      }
    }
    for (let parameter = 0; parameter < parameterCount; parameter += 1) {
      gradient[parameter] = gradient[parameter] / rows.length - l2 * beta[parameter];
      firstMoment[parameter] = beta1 * firstMoment[parameter] + (1 - beta1) * gradient[parameter];
      secondMoment[parameter] = beta2 * secondMoment[parameter] + (1 - beta2) * gradient[parameter] ** 2;
      const mHat = firstMoment[parameter] / (1 - beta1 ** iteration);
      const vHat = secondMoment[parameter] / (1 - beta2 ** iteration);
      beta[parameter] += learningRate * mHat / (Math.sqrt(vHat) + 1e-8);
      beta[parameter] = clamp(beta[parameter], -12, 12);
    }
  }

  let nll = 0;
  let correct = 0;
  for (const row of rows) {
    const probability = logistic(dot(beta, featureBuilder(row)));
    nll -= row.outcome ? Math.log(Math.max(probability, 1e-12)) : Math.log(Math.max(1 - probability, 1e-12));
    if ((probability >= 0.5 ? 1 : 0) === row.outcome) correct += 1;
  }
  return { beta, nll, accuracy: correct / rows.length };
}

export function round(value, digits = 4) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}
