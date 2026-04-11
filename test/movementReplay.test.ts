import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Vec3 } from "vec3";
import { EntityTrackerCurvature } from "../src/entityTrackerCurvature";
import { createReplayBot } from "./replayBot";

type Vec3Tuple = [number, number, number];

type MovementSample = {
  startTick: number;
  tickDuration: number;
  confidence: number;
  actual: Vec3Tuple;
  actualLastV: Vec3Tuple;
  actualRelativeDelta: Vec3Tuple;
  trackedInfoStart?: Array<{
    age?: number;
    duration?: number;
    position: Vec3Tuple;
    velocity: Vec3Tuple;
  }>;
  trackedInfoEnd?: Array<{
    age?: number;
    duration?: number;
    position: Vec3Tuple;
    velocity: Vec3Tuple;
  }>;
  trackedInfo: Array<{
    age?: number;
    duration?: number;
    position: Vec3Tuple;
    velocity: Vec3Tuple;
  }>;
};

type MovementTimelineSegment = {
  startTick: number;
  endTick: number;
  ageTicks: number;
  position: Vec3Tuple;
  deltaFromPrevious: Vec3Tuple;
};

type MovementLog = {
  source: {
    input: string;
    generatedAt: string;
    totalSamples: number;
    phases: string[];
  };
  samples: MovementSample[];
  timeline: MovementTimelineSegment[];
};

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function sameVec3(a: Vec3Tuple, b: Vec3Tuple) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

async function loadMovementLog(): Promise<MovementLog> {
  const filePath = path.resolve(process.cwd(), "movement-samples.json");
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as MovementLog;
}

function setEntityState(
  bot: ReturnType<typeof createReplayBot>,
  actual: Vec3Tuple,
  velocity: Vec3Tuple,
) {
  bot.target.position.set(actual[0], actual[1], actual[2]);
  bot.target.velocity.set(velocity[0], velocity[1], velocity[2]);
  bot.target.yaw = Math.PI / 2;
  bot.target.onGround = velocity[1] === 0;
  bot.entities[bot.target.id] = bot.target;
}

function seedTrackedHistory(
  tracker: EntityTrackerCurvature,
  bot: ReturnType<typeof createReplayBot>,
  sample: MovementSample,
) {
  const trackedInfo = sample.trackedInfoStart?.length
    ? sample.trackedInfoStart
    : sample.trackedInfo.length > 0
      ? sample.trackedInfo
      : [{
    position: sample.actual,
    velocity: sample.actualLastV,
  }];

  const tickInfo = trackedInfo.map((entry, index) => ({
    position: new Vec3(entry.position[0], entry.position[1], entry.position[2]),
    velocity: new Vec3(entry.velocity[0], entry.velocity[1], entry.velocity[2]),
    age: entry.age ?? index + 1,
    duration: entry.duration ?? 1,
  }));

  tracker.trackingData[bot.target.id] ??= {
    tracking: true,
    info: { initialAge: 1, avgVel: new Vec3(0, 0, 0), tickInfo: [] },
  };

  tracker.trackingData[bot.target.id].tracking = true;
  tracker.trackingData[bot.target.id].info.initialAge = 1;
  tracker.trackingData[bot.target.id].info.avgVel = tickInfo[tickInfo.length - 1]?.velocity.clone() ?? new Vec3(0, 0, 0);
  tracker.trackingData[bot.target.id].info.tickInfo = tickInfo as any;

  const latest = trackedInfo[trackedInfo.length - 1] ?? {
    position: sample.actual,
    velocity: sample.actualLastV,
  };
  setEntityState(bot, latest.position, latest.velocity);
}

test("replayed real movement window keeps segment ages and confidence in sync", async () => {
  const log = await loadMovementLog();
  assert.ok(log.samples.length > 0, "expected raw samples in movement log");
  assert.ok(log.timeline.length > 0, "expected timeline segments in movement log");
  const hasStartSnapshots = log.samples.some(sample => (sample.trackedInfoStart?.length ?? 0) > 0);

  const expandedPositions = log.timeline.flatMap(segment => Array.from({ length: segment.ageTicks }, () => segment.position));
  assert.equal(
    expandedPositions.length,
    log.samples.length,
    "timeline expansion should reconstruct the raw sample count"
  );

  const bot = createReplayBot({
    botPosition: new Vec3(0, 1, 0),
    targetPosition: new Vec3(log.samples[0].actual[0], log.samples[0].actual[1], log.samples[0].actual[2]),
    targetVelocity: new Vec3(0, 0, 0),
    targetOnGround: true,
    floorY: 0,
  });

  const tracker = new EntityTrackerCurvature(bot as any);
  tracker.trackEntity(bot.target);

  const replayedConfidence: number[] = [];

  for (let i = 0; i < log.samples.length; i++) {
    const sample = log.samples[i];
    seedTrackedHistory(tracker, bot, sample);

    const prediction = tracker.predictEntityPositionWithConfidence(bot.target, sample.tickDuration);
    assert.ok(prediction, `expected replay prediction for sample ${i}`);

    replayedConfidence.push(prediction.confidence);
  }

  const stationaryPosition = log.timeline[0].position;
  const stationarySamples = log.samples.filter(sample => sameVec3(sample.actual, stationaryPosition));
  const movingSamples = log.samples.filter(sample => !sameVec3(sample.actual, stationaryPosition));
  const firstMovingIndex = log.samples.findIndex(sample => !sameVec3(sample.actual, stationaryPosition));

  assert.ok(firstMovingIndex >= 0, "expected a movement transition in the replay log");

  assert.equal(stationarySamples.length + movingSamples.length, log.samples.length, "raw sample partition should cover the full log");
  assert.ok(replayedConfidence.every(confidence => confidence >= 0 && confidence <= 1), "replayed confidence should stay inside [0, 1]");

  const recordedConfidence = log.samples.map(sample => sample.confidence);
  const confidenceDeltas = replayedConfidence
    .map((confidence, index) => {
      const sample = log.samples[index];
      if (!sample.trackedInfoStart || sample.trackedInfoStart.length === 0) return null;
      return Math.abs(confidence - recordedConfidence[index]);
    })
    .filter((value): value is number => value !== null);
  const confidenceDeltaMean = mean(confidenceDeltas);
  const confidenceDeltaMax = Math.max(...confidenceDeltas);

  const firstLogged = log.samples[0];
  const lastLogged = log.samples[log.samples.length - 1];
  const firstReplay = replayedConfidence[0];
  const lastReplay = replayedConfidence[replayedConfidence.length - 1];
  const stationarySegment = log.timeline.find(segment => segment.deltaFromPrevious[0] === 0 && segment.deltaFromPrevious[2] === 0);

  console.log(
    [
      `[replay-summary] samples=${log.samples.length} segments=${log.timeline.length}`,
      `bootstrap=${hasStartSnapshots ? "yes" : "no"}`,
      `firstConfidence=${firstLogged.confidence.toFixed(4)} replayed=${firstReplay.toFixed(4)} tick=${firstLogged.startTick}`,
      `lastConfidence=${lastLogged.confidence.toFixed(4)} replayed=${lastReplay.toFixed(4)} tick=${lastLogged.startTick}`,
      `meanDelta=${confidenceDeltaMean.toFixed(6)} maxDelta=${confidenceDeltaMax.toFixed(6)}`,
      stationarySegment
        ? `stationarySegmentAge=${stationarySegment.ageTicks} confidenceAvg=${stationarySegment.confidenceAvg.toFixed(4)}`
        : `stationarySegment=none`,
    ].join(" | ")
  );

  if (hasStartSnapshots) {
    assert.ok(
      confidenceDeltaMean < 0.001,
      `replayed confidence should stay close to the recorded log curve, got mean delta ${confidenceDeltaMean.toFixed(6)}`
    );
    assert.ok(
      confidenceDeltaMax < 0.001,
      `replayed confidence should not drift far from the recorded log curve, got max delta ${confidenceDeltaMax.toFixed(6)}`
    );
  }
});
