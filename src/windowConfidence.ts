import { Vec3 } from "vec3";

export type WindowConfidenceSample = {
  velocity: Vec3;
  planarSpeed: number;
  dt: number;
  duration?: number;
};

export type WindowConfidenceInput = {
  samples: WindowConfidenceSample[];
  ticksAhead: number;
  featureWindow: number;
  windowAge: number;
  minPlanarSpeed: number;
  minSpeedTrend: number;
  accelerationChanged: boolean;
};

const SPEED_WEIGHT = 0.35;
const DIRECTION_WEIGHT = 0.25;
const TURN_WEIGHT = 0.25;
const ACCELERATION_WEIGHT = 0.15;

const STATIONARY_STOP_PENALTY = 0.6;
const ACCELERATION_REGIME_PENALTY = 0.88;
const HORIZON_DECAY_TICKS = 18;
const LOW_MAGNITUDE_SCALE = 4;
const TINY_PAIR_SCORE = 0.1;
const TINY_ACCEL_PAIR_SCORE = 0.25;
const TURN_DELTA_SCALE = Math.PI * 0.75;
const TURN_VARIANCE_SCALE = Math.PI * 0.5;
const JITTER_SIGN_FLIP_PENALTY = 0.65;
const JITTER_TURN_DEADZONE = 0.08;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function planarMagnitude(vec: Vec3): number {
  return Math.sqrt(vec.x * vec.x + vec.z * vec.z);
}

function stationaryWindow(samples: WindowConfidenceSample[], minPlanarSpeed: number): boolean {
  return samples.every(sample => sample.planarSpeed <= minPlanarSpeed);
}

function speedStabilityScore(samples: WindowConfidenceSample[], minPlanarSpeed: number): number {
  const speeds = samples.map(sample => sample.planarSpeed);
  const meanSpeed = average(speeds);

  // A clean stop is the most coherent possible window for this tracker, so it
  // earns the top score instead of being treated as an ambiguous slowdown.

  const variance = average(speeds.map(speed => (speed - meanSpeed) ** 2));
  const stdDev = Math.sqrt(variance);
  const scale = Math.max(meanSpeed, minPlanarSpeed * LOW_MAGNITUDE_SCALE);
  return clamp01(1 - stdDev / scale);
}

function directionConsistencyScore(samples: WindowConfidenceSample[], minPlanarSpeed: number): number {
  if (samples.length < 2) return 1;

  const pairScores: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const prevMag = planarMagnitude(prev.velocity);
    const currMag = planarMagnitude(curr.velocity);

    // Two near-zero vectors do not fight each other, so they are perfectly
    // coherent for confidence purposes.
    if (prevMag <= minPlanarSpeed && currMag <= minPlanarSpeed) {
      pairScores.push(1);
      continue;
    }

    // If only one side is effectively stopped, the direction is unclear, so
    // we keep the score low rather than pretending it is a meaningful vector.
    if (prevMag <= minPlanarSpeed || currMag <= minPlanarSpeed) {
      pairScores.push(TINY_PAIR_SCORE);
      continue;
    }

    const dot = prev.velocity.x * curr.velocity.x + prev.velocity.z * curr.velocity.z;
    const cosine = dot / (prevMag * currMag);

    // Map cosine similarity from [-1, 1] into [0, 1].
    pairScores.push(clamp01((cosine + 1) / 2));
  }

  return average(pairScores);
}

function accelerationConsistencyScore(samples: WindowConfidenceSample[], minSpeedTrend: number): number {
  if (samples.length < 2) return 1;

  const accelerations: Vec3[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const dt = curr.dt > 0 ? curr.dt : 1;

    accelerations.push(new Vec3((curr.velocity.x - prev.velocity.x) / dt, 0, (curr.velocity.z - prev.velocity.z) / dt));
  }

  if (accelerations.length < 2) return 1;

  const pairScores: number[] = [];
  for (let i = 1; i < accelerations.length; i++) {
    const prev = accelerations[i - 1];
    const curr = accelerations[i];
    const prevMag = planarMagnitude(prev);
    const currMag = planarMagnitude(curr);

    // Two tiny acceleration vectors agree that the motion is basically flat.
    if (prevMag <= minSpeedTrend && currMag <= minSpeedTrend) {
      pairScores.push(1);
      continue;
    }

    // If only one side has meaningful acceleration, the transition is noisy.
    if (prevMag <= minSpeedTrend || currMag <= minSpeedTrend) {
      pairScores.push(TINY_ACCEL_PAIR_SCORE);
      continue;
    }

    const dot = prev.x * curr.x + prev.z * curr.z;
    const cosine = dot / (prevMag * currMag);
    pairScores.push(clamp01((cosine + 1) / 2));
  }

  return average(pairScores);
}

function turnSmoothnessScore(samples: WindowConfidenceSample[], minPlanarSpeed: number): number {
  const turnDeltas: number[] = [];

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];

    // Only compare directions when both samples carry a meaningful velocity
    // vector. A stop on either side does not tell us much about turn smoothness.
    if (prev.planarSpeed <= minPlanarSpeed || curr.planarSpeed <= minPlanarSpeed) {
      continue;
    }

    const prevYaw = Math.atan2(prev.velocity.x, prev.velocity.z);
    const currYaw = Math.atan2(curr.velocity.x, curr.velocity.z);
    let delta = currYaw - prevYaw;

    while (delta <= -Math.PI) delta += Math.PI * 2;
    while (delta > Math.PI) delta -= Math.PI * 2;

    turnDeltas.push(Math.abs(delta));
  }

  if (turnDeltas.length === 0) return 1;

  const meanTurn = average(turnDeltas);
  const turnVariance = average(turnDeltas.map(delta => (delta - meanTurn) ** 2));
  const turnStdDev = Math.sqrt(turnVariance);

  // Large per-tick yaw changes are less trustworthy than gentle, steady ones.
  const magnitudeScore = clamp01(1 - meanTurn / TURN_DELTA_SCALE);

  // A consistent orbit should have low spread between successive turn deltas.
  // A jittery left/right spam should have high spread and get penalized.
  const consistencyScore = clamp01(1 - turnStdDev / TURN_VARIANCE_SCALE);

  return average([magnitudeScore, consistencyScore]);
}

function jitterPenaltyScore(samples: WindowConfidenceSample[], minPlanarSpeed: number): number {
  const signedTurnDeltas: number[] = [];

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];

    // Ignore pairs that do not give us a stable direction vector.
    if (prev.planarSpeed <= minPlanarSpeed || curr.planarSpeed <= minPlanarSpeed) {
      continue;
    }

    const prevYaw = Math.atan2(prev.velocity.x, prev.velocity.z);
    const currYaw = Math.atan2(curr.velocity.x, curr.velocity.z);
    let delta = currYaw - prevYaw;

    while (delta <= -Math.PI) delta += Math.PI * 2;
    while (delta > Math.PI) delta -= Math.PI * 2;

    signedTurnDeltas.push(delta);
  }

  if (signedTurnDeltas.length < 2) return 1;

  let signFlips = 0;
  for (let i = 1; i < signedTurnDeltas.length; i++) {
    const prev = signedTurnDeltas[i - 1];
    const curr = signedTurnDeltas[i];

    // Tiny direction adjustments should not count as jitter by themselves.
    if (Math.abs(prev) < JITTER_TURN_DEADZONE || Math.abs(curr) < JITTER_TURN_DEADZONE) continue;

    if (prev * curr < 0) {
      signFlips++;
    }
  }

  const flipRatio = signFlips / Math.max(1, signedTurnDeltas.length - 1);
  // The more often the turn direction flips, the more chaotic the window is.
  const flipScore = clamp01(1 - flipRatio * JITTER_SIGN_FLIP_PENALTY);
  return flipScore;
}

function coverageScore(windowAge: number, featureWindow: number): number {
  if (featureWindow <= 1) return 1;
  return clamp01((Math.max(1, windowAge) - 1) / (featureWindow - 1));
}

function stopContinuityScore(samples: WindowConfidenceSample[], minPlanarSpeed: number, stationary: boolean): number {
  if (stationary) return 1;

  const stopFraction =
    samples.filter(sample => sample.planarSpeed <= minPlanarSpeed).length / Math.max(1, samples.length);

  // The 0.6 factor says that stop samples matter, but they do not fully erase
  // the confidence of a motion window on their own.
  return clamp01(1 - stopFraction * STATIONARY_STOP_PENALTY);
}

function regimeStabilityScore(stationary: boolean, accelerationChanged: boolean): number {
  if (stationary) return 1;
  return accelerationChanged ? ACCELERATION_REGIME_PENALTY : 1;
}

function horizonScore(ticksAhead: number, stationary: boolean): number {
  if (stationary) return 1;

  const horizonTicks = Math.max(0, Math.floor(ticksAhead) - 1);
  // Every 18 ticks, the future confidence decays by one additional "unit" of
  // uncertainty. This keeps short-horizon movement windows strong and longer
  // projections more cautious.
  return 1 / (1 + horizonTicks / HORIZON_DECAY_TICKS);
}

export function getMovementWindowConfidence(input: WindowConfidenceInput): number {
  const recent = input.samples.slice(-input.featureWindow);
  if (recent.length === 0) return 0;

  const stationary = stationaryWindow(recent, input.minPlanarSpeed);

  const speedScore = speedStabilityScore(recent, input.minPlanarSpeed);
  const directionScore = directionConsistencyScore(recent, input.minPlanarSpeed);
  const turnScore = turnSmoothnessScore(recent, input.minPlanarSpeed);
  const jitterScore = jitterPenaltyScore(recent, input.minPlanarSpeed);
  const accelerationScore = accelerationConsistencyScore(recent, input.minSpeedTrend);
  const coverage = coverageScore(input.windowAge, input.featureWindow);
  const stopContinuity = stopContinuityScore(recent, input.minPlanarSpeed, stationary);
  const regimeStability = regimeStabilityScore(stationary, input.accelerationChanged);
  const horizon = horizonScore(input.ticksAhead, stationary);

  // The base score is a weighted blend of the window's three observed traits:
  // speed stability, direction stability, and acceleration stability.
  const baseScore =
    speedScore * SPEED_WEIGHT +
    directionScore * DIRECTION_WEIGHT +
    turnScore * TURN_WEIGHT +
    accelerationScore * ACCELERATION_WEIGHT;

  // The multiplicative gates express how complete and trustworthy the current
  // window is:
  // - coverage says how much history we have,
  // - jitter says whether the motion is erratic or smooth,
  // - stopContinuity says whether the window is cleanly stationary,
  // - regimeStability says whether acceleration has recently shifted,
  // - horizon says how far into the future we are projecting.
  return clamp01(baseScore * jitterScore * coverage * stopContinuity * regimeStability * horizon);
}
