import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { Vec3 } from "vec3";
import { extractMovementSamples } from "../scripts/extract-movement-samples";
import { EntityTrackerCurvature } from "../src/entityTrackerCurvature";
import { createReplayBot } from "./replayBot";

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
      tickInfo: TrackedInfoEntry[];
    } | null;
    predictedPosition: Vec3Tuple | null;
    confidence: number | null;
  } | null;
  derived: {
    distanceError: number | null;
  };
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

function sameVec3(a: Vec3Tuple, b: Vec3Tuple) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function distance3(a: Vec3Tuple, b: Vec3Tuple) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function roundTo(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function vec3LikeToTuple(value: { x: number; y: number; z: number } | null | undefined): Vec3Tuple | null {
  if (!value) return null;
  return [value.x, value.y, value.z];
}

function dumpReplayState(
  sample: MovementSample,
  tracker: EntityTrackerCurvature,
  bot: ReturnType<typeof createReplayBot>,
  prediction: { position: Vec3; confidence: number } | null,
  error: unknown,
) {
  const physicsCtx = bot.physicsUtil.getPhysicsCtx(bot.physicsUtil.engine, bot.target);
  const trackedEntry = tracker.trackingData[bot.target.id];
  const dump = {
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    sample: {
      line: sample.line,
      phase: sample.phase,
      chatTick: sample.chatTick,
      raw: sample.raw,
      shotPlanner: sample.shotPlanner,
      replaySnapshot: sample.replaySnapshot,
      derived: sample.derived,
    },
    replayBot: {
      target: {
        id: bot.target.id,
        position: vec3LikeToTuple(bot.target.position),
        velocity: vec3LikeToTuple(bot.target.velocity),
        yaw: bot.target.yaw,
        pitch: bot.target.pitch,
        onGround: bot.target.onGround,
        lastOnGround: bot.target.lastOnGround,
        supportingBlockPos: vec3LikeToTuple(bot.target.supportingBlockPos),
        isInWater: bot.target.isInWater,
        isUnderWater: bot.target.isUnderWater,
        isInLava: bot.target.isInLava,
        isUnderLava: bot.target.isUnderLava,
        isInWeb: bot.target.isInWeb,
        isCollidedHorizontally: bot.target.isCollidedHorizontally,
        isCollidedHorizontallyMinor: bot.target.isCollidedHorizontallyMinor,
        isCollidedVertically: bot.target.isCollidedVertically,
        swimming: bot.target.swimming,
        sprinting: bot.target.sprinting,
        crouching: bot.target.crouching,
        fallFlying: bot.target.fallFlying,
        elytraFlying: bot.target.elytraFlying,
        canFly: bot.target.canFly,
        flying: bot.target.flying,
      },
      controlState: bot.controlState,
      physicsState: {
        pos: vec3LikeToTuple(physicsCtx.state.pos),
        vel: vec3LikeToTuple(physicsCtx.state.vel),
        yaw: physicsCtx.state.yaw,
        pitch: physicsCtx.state.pitch,
        onGround: physicsCtx.state.onGround,
        lastOnGround: physicsCtx.state.lastOnGround,
        supportingBlockPos: vec3LikeToTuple(physicsCtx.state.supportingBlockPos),
        isInWater: physicsCtx.state.isInWater,
        isUnderWater: physicsCtx.state.isUnderWater,
        isInLava: physicsCtx.state.isInLava,
        isUnderLava: physicsCtx.state.isUnderLava,
        isInWeb: physicsCtx.state.isInWeb,
        isCollidedHorizontally: physicsCtx.state.isCollidedHorizontally,
        isCollidedHorizontallyMinor: physicsCtx.state.isCollidedHorizontallyMinor,
        isCollidedVertically: physicsCtx.state.isCollidedVertically,
        swimming: physicsCtx.state.swimming,
        sprinting: physicsCtx.state.sprinting,
        crouching: physicsCtx.state.crouching,
        fallFlying: physicsCtx.state.fallFlying,
        elytraFlying: physicsCtx.state.elytraFlying,
        canFly: physicsCtx.state.canFly,
        flying: physicsCtx.state.flying,
      },
      trackedEntry: trackedEntry
        ? {
            tracking: trackedEntry.tracking,
            info: {
              initialAge: trackedEntry.info.initialAge,
              avgVel: vec3LikeToTuple(trackedEntry.info.avgVel),
              tickInfo: trackedEntry.info.tickInfo.map(entry => ({
                age: entry.age,
                duration: entry.duration,
                position: vec3LikeToTuple(entry.position),
                velocity: vec3LikeToTuple(entry.velocity),
              })),
            },
          }
        : null,
      prediction: prediction
        ? {
            position: vec3LikeToTuple(prediction.position),
            confidence: prediction.confidence,
          }
        : null,
    },
  };

  console.error(JSON.stringify(dump, null, 2));
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

function getSamplePosition(sample: MovementSample): Vec3Tuple {
  return sample.shotPlanner.positionAfterWait ?? sample.shotPlanner.positionAtPredictionTime;
}

async function loadMovementLog(): Promise<MovementLog> {
  const rawLogPath = process.env.MOVEMENT_LOG_PATH?.trim();
  const filePath = rawLogPath
    ? path.resolve(process.cwd(), rawLogPath)
    : path.resolve(process.cwd(), "movement-samples.json");

  if (rawLogPath) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "movement-replay-"));
    const extractedPath = path.join(tempDir, "movement-samples.json");
    await extractMovementSamples(filePath, extractedPath, { pretty: true, verbose: false });
    const raw = await fs.readFile(extractedPath, "utf8");
    return JSON.parse(raw) as MovementLog;
  }

  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as MovementLog;
}

function seedFromReplaySnapshot(
  tracker: EntityTrackerCurvature,
  bot: ReturnType<typeof createReplayBot>,
  sample: MovementSample,
) {
  const snapshot = sample.replaySnapshot;
  assert.ok(snapshot, "expected replay snapshot");

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
    ? new Vec3(
        Math.floor(snapshot.currentPosition[0]),
        Math.floor(snapshot.currentPosition[1]) - 1,
        Math.floor(snapshot.currentPosition[2]),
      )
    : null;
  bot.entities[bot.target.id] = bot.target;
}

test("replayed real movement window keeps segment ages and confidence in sync", async () => {
  const log = await loadMovementLog();

  assert.ok(log.samples.length > 0, "expected raw samples in movement log");
  assert.ok(log.timeline.length > 0, "expected timeline segments in movement log");
  assert.ok(
    log.samples.every(sample => sample.replaySnapshot !== null),
    "expected every shot-planner entry to include a replay snapshot"
  );

  const expandedPositions = log.timeline.flatMap(segment => Array.from({ length: segment.ageTicks }, () => segment.position));
  assert.equal(
    expandedPositions.length,
    log.samples.length,
    "timeline expansion should reconstruct the raw sample count"
  );

  const firstSamplePosition = getSamplePosition(log.samples[0]);
  const bot = createReplayBot({
    botPosition: new Vec3(0, 1, 0),
    targetPosition: new Vec3(firstSamplePosition[0], firstSamplePosition[1], firstSamplePosition[2]),
    targetVelocity: new Vec3(0, 0, 0),
    targetOnGround: true,
    floorY: 3,
  });

  const tracker = new EntityTrackerCurvature(bot as any);
  tracker.trackEntity(bot.target);

  const replayedConfidence: number[] = [];

  for (let i = 0; i < log.samples.length; i++) {
    const sample = log.samples[i];
    let prediction: { position: Vec3; confidence: number } | null = null;
    try {
      assert.ok(sample.replaySnapshot, `expected replay snapshot for sample ${i}`);
      seedFromReplaySnapshot(tracker, bot, sample);

      const snapshot = sample.replaySnapshot;
      assert.equal(snapshot.ticksAhead, sample.shotPlanner.tickDuration, `ticksAhead should match at sample ${i}`);
      assert.deepEqual(snapshot.currentPosition, sample.shotPlanner.positionAtPredictionTime, `currentPosition should match at sample ${i}`);
      assert.deepEqual(snapshot.predictedPosition, sample.shotPlanner.predictedPosition, `predictedPosition should match at sample ${i}`);
      assert.equal(snapshot.confidence, sample.shotPlanner.confidence, `confidence should match at sample ${i}`);
      assert.deepEqual(snapshot.tracking?.tickInfo ?? null, sample.shotPlanner.trackedHistoryAtPredictionTime, `tracked history should match at sample ${i}`);
      assert.equal(
        sample.shotPlanner.entityYawDegrees,
        Number(((snapshot.currentYaw * 180) / Math.PI).toFixed(1)),
        `entityYawDegrees should match the snapshot yaw at sample ${i}`
      );

      assert.deepEqual(
        [bot.target.position.x, bot.target.position.y, bot.target.position.z],
        snapshot.currentPosition,
        `seeded target position should match snapshot at sample ${i}`
      );
      assert.deepEqual(
        [bot.target.velocity.x, bot.target.velocity.y, bot.target.velocity.z],
        snapshot.currentVelocity,
        `seeded target velocity should match snapshot at sample ${i}`
      );
      assert.equal(bot.target.yaw, snapshot.currentYaw, `seeded target yaw should match snapshot at sample ${i}`);
      assert.equal(bot.target.pitch, snapshot.currentPitch, `seeded target pitch should match snapshot at sample ${i}`);
      assert.equal(bot.target.onGround, snapshot.currentOnGround, `seeded target onGround should match snapshot at sample ${i}`);

      prediction = tracker.predictEntityPositionWithConfidence(bot.target, sample.shotPlanner.tickDuration);
      assert.ok(prediction, `expected replay prediction for sample ${i}`);

      replayedConfidence.push(prediction.confidence);

      assert.equal(
        prediction.confidence,
        snapshot.confidence,
        `confidence should match the captured replay snapshot at sample ${i}`
      );
      assert.deepEqual(
        [prediction.position.x, prediction.position.y, prediction.position.z],
        snapshot.predictedPosition,
        `predicted position should match the captured replay snapshot at sample ${i}`
      );
      assert.deepEqual(
        snapshot.predictedPosition,
        sample.shotPlanner.predictedPosition,
        `predicted position in the snapshot should match the logged shot-planner output at sample ${i}`
      );
      assert.equal(
        snapshot.confidence,
        sample.shotPlanner.confidence,
        `confidence in the snapshot should match the logged shot-planner output at sample ${i}`
      );
      assert.deepEqual(
        snapshot.currentPosition,
        sample.shotPlanner.positionAtPredictionTime,
        `snapshot current position should match the logged shot-planner output at sample ${i}`
      );
      assert.deepEqual(
        snapshot.tracking?.tickInfo ?? null,
        sample.shotPlanner.trackedHistoryAtPredictionTime,
        `snapshot tracking history should match the logged shot-planner output at sample ${i}`
      );
      assert.ok(sample.shotPlanner.trackedHistoryAfterWait && sample.shotPlanner.trackedHistoryAfterWait.length > 0, `expected trackedHistoryAfterWait at sample ${i}`);
      assert.deepEqual(
        sample.shotPlanner.trackedHistoryAfterWait?.[sample.shotPlanner.trackedHistoryAfterWait.length - 1]?.position,
        sample.shotPlanner.positionAfterWait,
        `trackedHistoryAfterWait should end at positionAfterWait for sample ${i}`
      );
      if (sample.shotPlanner.actualVelocityPerTick && sample.shotPlanner.positionAfterWait && sample.shotPlanner.movementAnalysis) {
        const expectedAnalysis = computeMovementAnalysis(
          sample.shotPlanner.positionAfterWait,
          sample.shotPlanner.actualVelocityPerTick,
        );
        const roundedExpectedAnalysis = {
          move: expectedAnalysis.move,
          radial: roundTo(expectedAnalysis.radial, 3),
          tangential: roundTo(expectedAnalysis.tangential, 3),
          angleDeg: roundTo(expectedAnalysis.angleDeg, 1),
        };
        assert.deepEqual(
          sample.shotPlanner.movementAnalysis.move,
          roundedExpectedAnalysis.move,
          `movementAnalysis move should match at sample ${i}`
        );
        assert.ok(
          Math.abs(sample.shotPlanner.movementAnalysis.radial - roundedExpectedAnalysis.radial) < 1e-12,
          `movementAnalysis radial should match at sample ${i}`
        );
        assert.ok(
          Math.abs(sample.shotPlanner.movementAnalysis.tangential - roundedExpectedAnalysis.tangential) < 1e-12,
          `movementAnalysis tangential should match at sample ${i}`
        );
        assert.ok(
          Math.abs(sample.shotPlanner.movementAnalysis.angleDeg - roundedExpectedAnalysis.angleDeg) < 1e-12,
          `movementAnalysis angleDeg should match at sample ${i}`
        );
      }

      if (sample.shotPlanner.predictionError && sample.shotPlanner.predictedPosition && sample.shotPlanner.positionAfterWait) {
        const expectedError = [
          sample.shotPlanner.positionAfterWait[0] - sample.shotPlanner.predictedPosition[0],
          sample.shotPlanner.positionAfterWait[1] - sample.shotPlanner.predictedPosition[1],
          sample.shotPlanner.positionAfterWait[2] - sample.shotPlanner.predictedPosition[2],
        ] as Vec3Tuple;
        assert.ok(
          sameVec3(sample.shotPlanner.predictionError, expectedError),
          `prediction error should match actual minus predicted at sample ${i}`
        );
      }

      if (sample.derived.distanceError != null && sample.shotPlanner.predictedPosition && sample.shotPlanner.positionAfterWait) {
        const recordedDistance = distance3(sample.shotPlanner.predictedPosition, sample.shotPlanner.positionAfterWait);
        assert.ok(
          Math.abs(recordedDistance - sample.derived.distanceError) < 1e-12,
          `derived distanceError should match the predicted/actual gap at sample ${i}`
        );
      }
    } catch (error) {
      dumpReplayState(sample, tracker, bot, prediction, error);
      throw error;
    }
  }

  const stationaryPosition = log.timeline[0].position;
  const stationarySamples = log.samples.filter(sample => sameVec3(getSamplePosition(sample), stationaryPosition));
  const movingSamples = log.samples.filter(sample => !sameVec3(getSamplePosition(sample), stationaryPosition));
  const firstMovingIndex = log.samples.findIndex(sample => !sameVec3(getSamplePosition(sample), stationaryPosition));

  assert.ok(firstMovingIndex >= 0, "expected a movement transition in the replay log");

  assert.equal(stationarySamples.length + movingSamples.length, log.samples.length, "raw sample partition should cover the full log");
  assert.ok(replayedConfidence.every(confidence => confidence >= 0 && confidence <= 1), "replayed confidence should stay inside [0, 1]");
});
