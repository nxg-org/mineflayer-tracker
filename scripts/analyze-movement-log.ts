import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { Vec3 } from "vec3";
import { EntityTrackerCurvature } from "../src/entityTrackerCurvature";
import { createReplayBot } from "../test/replayBot";
import { extractMovementSamples } from "./extract-movement-samples";

type Vec3Tuple = [number, number, number];

type TrackedInfoEntry = {
  age?: number;
  duration?: number;
  position: Vec3Tuple;
  velocity: Vec3Tuple;
};

type MovementSample = {
  line: number;
  phase: string | null;
  chatTick: number | null;
  shotPlanner: {
    startTick: number;
    tickDuration: number;
    confidence: number | null;
    positionAtPredictionTime: Vec3Tuple;
    predictedPosition: Vec3Tuple | null;
    positionAfterWait: Vec3Tuple | null;
    entityYawDegrees: number | null;
    actualVelocityPerTick: Vec3Tuple | null;
    movementAnalysis: {
      move: Vec3Tuple;
      radial: number;
      tangential: number;
      angleDeg: number;
    } | null;
    predictionError: Vec3Tuple | null;
    trackedHistoryAtPredictionTime: TrackedInfoEntry[] | null;
    trackedHistoryAfterWait: TrackedInfoEntry[] | null;
  };
  replaySnapshot: {
    entityId: number;
    ticksAhead: number;
    currentPosition: Vec3Tuple;
    currentVelocity: Vec3Tuple;
    currentYaw: number;
    currentPitch: number;
    currentOnGround: boolean;
    tracking: {
      initialAge: number;
      avgVel: Vec3Tuple;
      tickInfo: TrackedInfoEntry[] | null;
    } | null;
    predictedPosition: Vec3Tuple | null;
    confidence: number | null;
  } | null;
  derived: {
    distanceError: number | null;
  };
  raw: string;
};

type MovementLog = {
  source: {
    input: string;
    generatedAt: string;
    totalSamples: number;
    phases: string[];
  };
  samples: MovementSample[];
  timeline: Array<{
    phase: string | null;
    startLine: number;
    endLine: number;
    startTick: number;
    endTick: number;
    ageTicks: number;
    sampleCount: number;
    position: Vec3Tuple;
    previousPosition: Vec3Tuple | null;
    deltaFromPrevious: Vec3Tuple;
    entryRelativeDelta: Vec3Tuple;
    confidenceAtEntry: number;
    confidenceAvg: number;
    confidenceMin: number;
    confidenceMax: number;
    distanceErrorAvg: number;
    distanceErrorMax: number;
    rawFirst: string;
    rawLast: string;
  }>;
};

type ReplayIssue = {
  sampleIndex: number;
  line: number;
  startTick: number;
  phase: string | null;
  message: string;
};

type ReplaySampleResult = {
  sampleIndex: number;
  line: number;
  startTick: number;
  phase: string | null;
  confidence: number;
  distanceError: number;
  replayErrorDistance: number;
  predictionConfidence: number;
  snapshotConfidence: number | null;
  snapshotPredictedPosition: Vec3Tuple | null;
  logPredictedPosition: Vec3Tuple | null;
  actualPosition: Vec3Tuple | null;
};

type ReplayReport = {
  inputPath: string;
  sampleCount: number;
  batchCount: number;
  phaseCounts: Record<string, number>;
  confidence: {
    min: number;
    max: number;
    mean: number;
    median: number;
    p10: number;
    p90: number;
    correlationWithDistance: number;
  };
  distanceError: {
    min: number;
    max: number;
    mean: number;
    median: number;
    p90: number;
  };
  batchDistanceError: {
    mean: number;
    median: number;
    p90: number;
    missCount: number;
    missRatio: number;
  };
  misses: {
    threshold: number;
    count: number;
    ratio: number;
    highConfidenceCount: number;
  };
  bucketStats: Array<{
    label: string;
    count: number;
    meanDistance: number;
    missCount: number;
  }>;
  topBatchRuns: BatchRun[];
  topMisses: ReplaySampleResult[];
  issues: ReplayIssue[];
};

type BatchRun = {
  phase: string | null;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
  startTick: number;
  endTick: number;
  sampleCount: number;
  position: Vec3Tuple | null;
  meanConfidence: number;
  meanDistance: number;
  maxDistance: number;
};

type LoadOptions = {
  phase?: string | null;
};

function sameVec3(a: Vec3Tuple, b: Vec3Tuple): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function distance3(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function pearson(xs: number[], ys: number[]): number {
  if (xs.length === 0 || ys.length === 0 || xs.length !== ys.length) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;

  for (let i = 0; i < xs.length; i++) {
    const vx = xs[i] - mx;
    const vy = ys[i] - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }

  return num / Math.sqrt(dx * dy || 1);
}

function formatVec3(vec: Vec3Tuple | null | undefined): string {
  if (!vec) return "null";
  return `(${vec[0].toFixed(3)}, ${vec[1].toFixed(3)}, ${vec[2].toFixed(3)})`;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : "nan";
}

function getActualPosition(sample: MovementSample): Vec3Tuple | null {
  return sample.shotPlanner.positionAfterWait ?? sample.shotPlanner.positionAtPredictionTime ?? null;
}

function buildBatchRuns(samples: MovementSample[]): BatchRun[] {
  const runs: BatchRun[] = [];
  let current: BatchRun | null = null;

  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const position = getActualPosition(sample);
    const sameRun =
      current &&
      current.phase === sample.phase &&
      ((current.position === null && position === null) || (current.position !== null && position !== null && sameVec3(current.position, position)));

    if (!sameRun) {
      if (current) {
        runs.push(current);
      }

      current = {
        phase: sample.phase,
        startIndex: index,
        endIndex: index,
        startLine: sample.line,
        endLine: sample.line,
        startTick: sample.shotPlanner.startTick,
        endTick: sample.shotPlanner.startTick,
        sampleCount: 1,
        position,
        meanConfidence: sample.shotPlanner.confidence ?? 0,
        meanDistance: sample.derived.distanceError ?? 0,
        maxDistance: sample.derived.distanceError ?? 0,
      };
      continue;
    }

    current.endIndex = index;
    current.endLine = sample.line;
    current.endTick = sample.shotPlanner.startTick;
    current.sampleCount += 1;
    current.meanConfidence += sample.shotPlanner.confidence ?? 0;
    current.meanDistance += sample.derived.distanceError ?? 0;
    current.maxDistance = Math.max(current.maxDistance, sample.derived.distanceError ?? 0);
  }

  if (current) {
    runs.push(current);
  }

  for (const run of runs) {
    run.meanConfidence /= Math.max(1, run.sampleCount);
    run.meanDistance /= Math.max(1, run.sampleCount);
  }

  return runs;
}

async function loadMovementLog(inputPath: string, options: LoadOptions = {}): Promise<MovementLog> {
  const resolved = path.resolve(process.cwd(), inputPath);
  if (resolved.endsWith(".json")) {
    const raw = await fs.readFile(resolved, "utf8");
    return JSON.parse(raw) as MovementLog;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "movement-analyze-"));
  const extractedPath = path.join(tempDir, "movement-samples.json");
  await extractMovementSamples(resolved, extractedPath, {
    phase: options.phase,
    pretty: true,
    verbose: false,
  });
  const raw = await fs.readFile(extractedPath, "utf8");
  return JSON.parse(raw) as MovementLog;
}

function seedFromReplaySnapshot(
  tracker: EntityTrackerCurvature,
  bot: ReturnType<typeof createReplayBot>,
  sample: MovementSample,
) {
  const snapshot = sample.replaySnapshot;
  if (!snapshot) {
    throw new Error("expected replay snapshot");
  }

  tracker.trackingData[bot.target.id] ??= {
    tracking: true,
    info: { initialAge: snapshot.tracking?.initialAge ?? 0, avgVel: new Vec3(0, 0, 0), tickInfo: [] },
  };

  tracker.trackingData[bot.target.id].tracking = true;
  if (snapshot.tracking) {
    tracker.trackingData[bot.target.id].info.initialAge = snapshot.tracking.initialAge;
    tracker.trackingData[bot.target.id].info.avgVel = new Vec3(snapshot.tracking.avgVel[0], snapshot.tracking.avgVel[1], snapshot.tracking.avgVel[2]);
    tracker.trackingData[bot.target.id].info.tickInfo = snapshot.tracking.tickInfo.map(entry => ({
      position: new Vec3(entry.position[0], entry.position[1], entry.position[2]),
      velocity: new Vec3(entry.velocity[0], entry.velocity[1], entry.velocity[2]),
      age: entry.age ?? 1,
      duration: entry.duration ?? 1,
    })) as any;
  } else {
    tracker.trackingData[bot.target.id].info.initialAge = 0;
    tracker.trackingData[bot.target.id].info.avgVel = new Vec3(0, 0, 0);
    tracker.trackingData[bot.target.id].info.tickInfo = [];
  }

  bot.target.position.set(snapshot.currentPosition[0], snapshot.currentPosition[1], snapshot.currentPosition[2]);
  bot.target.velocity.set(snapshot.currentVelocity[0], snapshot.currentVelocity[1], snapshot.currentVelocity[2]);
  bot.target.yaw = snapshot.currentYaw;
  bot.target.pitch = snapshot.currentPitch;
  bot.target.onGround = snapshot.currentOnGround;
  bot.target.lastOnGround = snapshot.currentOnGround;
  bot.target.supportingBlockPos = snapshot.currentOnGround
    ? new Vec3(Math.floor(snapshot.currentPosition[0]), Math.floor(snapshot.currentPosition[1]) - 1, Math.floor(snapshot.currentPosition[2]))
    : null;
  bot.entities[bot.target.id] = bot.target;
}

function computeMovementAnalysis(actual: Vec3Tuple, deltaVelocity: Vec3Tuple) {
  const move = [deltaVelocity[0], 0, deltaVelocity[2]] as Vec3Tuple;
  const moveMagnitude = Math.hypot(move[0], move[2]);
  const actualMagnitude = Math.hypot(actual[0], actual[2]);
  if (moveMagnitude <= 1e-4 || actualMagnitude <= 1e-4) {
    return { move, radial: 0, tangential: 0, angleDeg: 0 };
  }

  const dot = actual[0] * move[0] + actual[2] * move[2];
  const cross = actual[0] * move[2] - actual[2] * move[0];
  const cosine = Math.max(-1, Math.min(1, dot / (actualMagnitude * moveMagnitude)));
  return {
    move,
    radial: dot / actualMagnitude,
    tangential: Math.abs(cross) / actualMagnitude,
    angleDeg: (Math.acos(cosine) * 180) / Math.PI,
  };
}

function computeReplayReport(samples: MovementSample[], inputPath: string, missThreshold: number): ReplayReport {
  if (samples.length === 0) {
    return {
      inputPath,
      sampleCount: 0,
      batchCount: 0,
      phaseCounts: {},
      confidence: {
        min: 0,
        max: 0,
        mean: 0,
        median: 0,
        p10: 0,
        p90: 0,
        correlationWithDistance: 0,
      },
      distanceError: {
        min: 0,
        max: 0,
        mean: 0,
        median: 0,
        p90: 0,
      },
      batchDistanceError: {
        mean: 0,
        median: 0,
        p90: 0,
        missCount: 0,
        missRatio: 0,
      },
      misses: {
        threshold: missThreshold,
        count: 0,
        ratio: 0,
        highConfidenceCount: 0,
      },
      bucketStats: [],
      topBatchRuns: [],
      topMisses: [],
      issues: [{ sampleIndex: 0, line: 0, startTick: 0, phase: null, message: "no samples found in log" }],
    };
  }

  const bot = createReplayBot({
    botPosition: new Vec3(0, 1, 0),
    targetPosition: new Vec3(samples[0].shotPlanner.positionAtPredictionTime[0], samples[0].shotPlanner.positionAtPredictionTime[1], samples[0].shotPlanner.positionAtPredictionTime[2]),
    targetVelocity: new Vec3(0, 0, 0),
    targetOnGround: true,
    floorY: 3,
  });

  const tracker = new EntityTrackerCurvature(bot as any);
  tracker.trackEntity(bot.target);

  const results: ReplaySampleResult[] = [];
  const issues: ReplayIssue[] = [];

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    try {
      if (!sample.replaySnapshot) {
        throw new Error("missing replay snapshot");
      }

      seedFromReplaySnapshot(tracker, bot, sample);
      const snapshot = sample.replaySnapshot;
      const prediction = tracker.predictEntityPositionWithConfidence(bot.target, sample.shotPlanner.tickDuration);
      if (!prediction) {
        throw new Error("tracker returned null prediction");
      }

      const actualPosition = sample.shotPlanner.positionAfterWait;
      const logPredicted = sample.shotPlanner.predictedPosition;
      const snapshotPredicted = snapshot.predictedPosition;
      const distanceError = sample.derived.distanceError ?? (actualPosition && logPredicted ? distance3(actualPosition, logPredicted) : 0);
      const replayErrorDistance = snapshotPredicted ? distance3([prediction.position.x, prediction.position.y, prediction.position.z], snapshotPredicted) : 0;

      if (snapshot.confidence !== sample.shotPlanner.confidence) {
        throw new Error(`confidence mismatch: snapshot=${snapshot.confidence} log=${sample.shotPlanner.confidence}`);
      }
      if (snapshotPredicted && logPredicted && !sameVec3(snapshotPredicted, logPredicted)) {
        throw new Error(`predicted position mismatch: snapshot=${formatVec3(snapshotPredicted)} log=${formatVec3(logPredicted)}`);
      }
      if (snapshot.currentPosition && !sameVec3(snapshot.currentPosition, sample.shotPlanner.positionAtPredictionTime)) {
        throw new Error(`current position mismatch: snapshot=${formatVec3(snapshot.currentPosition)} log=${formatVec3(sample.shotPlanner.positionAtPredictionTime)}`);
      }

      results.push({
        sampleIndex: i,
        line: sample.line,
        startTick: sample.shotPlanner.startTick,
        phase: sample.phase,
        confidence: snapshot.confidence ?? 0,
        distanceError,
        replayErrorDistance,
        predictionConfidence: prediction.confidence,
        snapshotConfidence: snapshot.confidence,
        snapshotPredictedPosition: snapshotPredicted,
        logPredictedPosition: logPredicted,
        actualPosition,
      });
    } catch (error) {
      issues.push({
        sampleIndex: i,
        line: sample.line,
        startTick: sample.shotPlanner.startTick,
        phase: sample.phase,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const confidences = results.map(result => result.confidence);
  const distances = results.map(result => result.distanceError);
  const batchRuns = buildBatchRuns(samples);
  const batchDistances = batchRuns.map(run => run.meanDistance);
  const batchMissCount = batchRuns.filter(run => run.meanDistance > missThreshold).length;
  const topBatchRuns = [...batchRuns]
    .sort((a, b) => b.meanDistance - a.meanDistance || b.sampleCount - a.sampleCount)
    .slice(0, 10);
  const phaseCounts: Record<string, number> = {};
  for (const sample of samples) {
    const phase = sample.phase ?? "none";
    phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;
  }

  const buckets = [
    [0, 0.2, "0.0-0.2"],
    [0.2, 0.4, "0.2-0.4"],
    [0.4, 0.6, "0.4-0.6"],
    [0.6, 0.8, "0.6-0.8"],
    [0.8, 1.01, "0.8-1.0"],
  ] as const;

  const bucketStats = buckets.map(([min, max, label]) => {
    const bucketSamples = results.filter(result => result.confidence >= min && result.confidence < max);
    return {
      label,
      count: bucketSamples.length,
      meanDistance: mean(bucketSamples.map(result => result.distanceError)),
      missCount: bucketSamples.filter(result => result.distanceError > missThreshold).length,
    };
  });

  const missCount = results.filter(result => result.distanceError > missThreshold).length;
  const highConfidenceCount = results.filter(result => result.distanceError > missThreshold && result.confidence >= 0.8).length;
  const topMisses = [...results]
    .sort((a, b) => b.distanceError - a.distanceError)
    .slice(0, 10);

  return {
    inputPath,
    sampleCount: results.length,
    batchCount: batchRuns.length,
    phaseCounts,
    confidence: {
      min: confidences.length ? Math.min(...confidences) : 0,
      max: confidences.length ? Math.max(...confidences) : 0,
      mean: mean(confidences),
      median: median(confidences),
      p10: percentile(confidences, 0.1),
      p90: percentile(confidences, 0.9),
      correlationWithDistance: pearson(confidences, distances),
    },
    distanceError: {
      min: distances.length ? Math.min(...distances) : 0,
      max: distances.length ? Math.max(...distances) : 0,
      mean: mean(distances),
      median: median(distances),
      p90: percentile(distances, 0.9),
    },
    batchDistanceError: {
      mean: mean(batchDistances),
      median: median(batchDistances),
      p90: percentile(batchDistances, 0.9),
      missCount: batchMissCount,
      missRatio: batchRuns.length ? batchMissCount / batchRuns.length : 0,
    },
    misses: {
      threshold: missThreshold,
      count: missCount,
      ratio: results.length ? missCount / results.length : 0,
      highConfidenceCount,
    },
    bucketStats,
    topBatchRuns,
    topMisses,
    issues,
  };
}

function parseArgs(argv: string[]) {
  const args = {
    input: "output.log",
    threshold: 0.5,
    phase: null as string | null,
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (current === "--input" || current === "-i") {
      args.input = argv[++i] ?? args.input;
      continue;
    }
    if (current === "--threshold" || current === "-t") {
      args.threshold = Number(argv[++i] ?? args.threshold);
      continue;
    }
    if (current === "--phase") {
      args.phase = argv[++i] ?? null;
      continue;
    }
    positional.push(current);
  }

  if (positional[0]) args.input = positional[0];
  return args;
}

function printReport(report: ReplayReport) {
  console.log(`Input: ${report.inputPath}`);
  console.log(`Samples: ${report.sampleCount}`);
  console.log(`Phases: ${Object.entries(report.phaseCounts).map(([phase, count]) => `${phase}=${count}`).join(", ") || "none"}`);
  console.log("");
  console.log("Confidence");
  console.log(`  mean=${formatNumber(report.confidence.mean)} median=${formatNumber(report.confidence.median)} min=${formatNumber(report.confidence.min)} max=${formatNumber(report.confidence.max)}`);
  console.log(`  p10=${formatNumber(report.confidence.p10)} p90=${formatNumber(report.confidence.p90)} correlationWithDistance=${formatNumber(report.confidence.correlationWithDistance)}`);
  console.log("");
  console.log("Distance");
  console.log(`  mean=${formatNumber(report.distanceError.mean)} median=${formatNumber(report.distanceError.median)} min=${formatNumber(report.distanceError.min)} max=${formatNumber(report.distanceError.max)} p90=${formatNumber(report.distanceError.p90)}`);
  console.log("");
  console.log("Batch-aware Distance");
  console.log(
    `  batches=${report.batchCount} mean=${formatNumber(report.batchDistanceError.mean)} median=${formatNumber(report.batchDistanceError.median)} p90=${formatNumber(report.batchDistanceError.p90)}`
  );
  console.log(
    `  batchMisses=${report.batchDistanceError.missCount} batchMissRatio=${formatNumber(report.batchDistanceError.missRatio * 100)}%`
  );
  console.log("");
  console.log("Misses");
  console.log(`  threshold=${formatNumber(report.misses.threshold)} count=${report.misses.count} ratio=${formatNumber(report.misses.ratio * 100)}% highConfidence=${report.misses.highConfidenceCount}`);
  console.log("");
  console.log("Confidence Buckets");
  for (const bucket of report.bucketStats) {
    console.log(`  ${bucket.label}: count=${bucket.count} meanDistance=${formatNumber(bucket.meanDistance)} missCount=${bucket.missCount}`);
  }
  console.log("");
  console.log("Top Misses");
  for (const miss of report.topMisses) {
    console.log(
      `  tick=${miss.startTick} line=${miss.line} phase=${miss.phase ?? "none"} conf=${formatNumber(miss.confidence)} dist=${formatNumber(miss.distanceError)} replayErr=${formatNumber(miss.replayErrorDistance)} predicted=${formatVec3(miss.logPredictedPosition)} actual=${formatVec3(miss.actualPosition)}`
    );
  }
  console.log("");
  console.log("Batch Runs");
  for (const run of report.topBatchRuns) {
    console.log(
      `  ticks=${run.startTick}-${run.endTick} lines=${run.startLine}-${run.endLine} phase=${run.phase ?? "none"} samples=${run.sampleCount} meanConf=${formatNumber(run.meanConfidence)} meanDist=${formatNumber(run.meanDistance)} maxDist=${formatNumber(run.maxDistance)} pos=${formatVec3(run.position)}`
    );
  }

  if (report.issues.length > 0) {
    console.log("");
    console.log("Replay Issues");
    for (const issue of report.issues) {
      console.log(`  tick=${issue.startTick} line=${issue.line} phase=${issue.phase ?? "none"} -> ${issue.message}`);
    }
  } else {
    console.log("");
    console.log("Replay Issues");
    console.log("  none");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = await loadMovementLog(args.input, { phase: args.phase });
  const report = computeReplayReport(log.samples, args.input, args.threshold);
  printReport(report);

  if (report.issues.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
