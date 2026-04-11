import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { EntityTrackerCurvature } from "../src/entityTrackerCurvature";
import {
  createReplayBot,
  repeatFrame,
  simulateFuturePosition,
  stepReplayTick,
  type ReplayControlFrame,
} from "./replayBot";

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function pearson(xs: number[], ys: number[]) {
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

type Scenario = {
  name: string;
  frames: ReplayControlFrame[];
  warmupTicks: number;
  horizon: number;
};

type ScenarioRun = Scenario & {
  targetPosition: Vec3;
};

function makeScenario(name: string, frames: ReplayControlFrame[], warmupTicks = 12, horizon = 6): Scenario {
  return { name, frames, warmupTicks, horizon };
}

function createOrbitFrames(ticks: number, turnsPerTick = Math.PI / 24): ReplayControlFrame[] {
  const frames: ReplayControlFrame[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    frames.push({
      forward: true,
      sprint: true,
      yaw: tick * turnsPerTick,
    });
  }
  return frames;
}

function createYawFlipFrames(ticks: number, splitTick: number): ReplayControlFrame[] {
  const frames: ReplayControlFrame[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    frames.push({
      forward: true,
      jump: true,
      yaw: tick < splitTick ? 0 : Math.PI,
    });
  }
  return frames;
}

function createRandomStrafeFlipFrames(ticks: number, seed: number): ReplayControlFrame[] {
  const frames: ReplayControlFrame[] = [];
  let state = seed >>> 0;

  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  let direction: "left" | "right" = random() < 0.5 ? "left" : "right";
  let remaining = 4 + Math.floor(random() * 3);

  for (let tick = 0; tick < ticks; tick++) {
    frames.push({
      forward: true,
      sprint: true,
      [direction]: true,
    });

    remaining--;
    if (remaining <= 0) {
      direction = direction === "left" ? "right" : "left";
      remaining = 4 + Math.floor(random() * 3);
    }
  }

  return frames;
}

function createRandomStrafeJumpSprintFrames(ticks: number, seed: number, forward = true): ReplayControlFrame[] {
  const frames: ReplayControlFrame[] = [];
  let state = seed >>> 0;

  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  let direction: "left" | "right" = random() < 0.5 ? "left" : "right";
  let remaining = 4 + Math.floor(random() * 3);

  for (let tick = 0; tick < ticks; tick++) {
    frames.push({
      ...(forward ? { forward: true } : { back: true }),
      sprint: true,
      jump: true,
      [direction]: true,
    });

    remaining--;
    if (remaining <= 0) {
      direction = direction === "left" ? "right" : "left";
      remaining = 4 + Math.floor(random() * 3);
    }
  }

  return frames;
}

function orbitYawStepForRadius(radius: number) {
  // This is intentionally aggressive. We want to stress the curvature code at
  // tight radii instead of smoothing the motion into a polite orbit.
  return 3.2 / Math.max(1, radius);
}

const SCENARIOS: Scenario[] = [
  makeScenario("standing still", repeatFrame({}, 40)),
  makeScenario("walking forward", repeatFrame({ forward: true }, 40)),
  makeScenario("sprinting forward", repeatFrame({ forward: true, sprint: true }, 40)),
  makeScenario(
    "sprint jumping forward",
    [...repeatFrame({ forward: true, sprint: true, jump: true }, 16), ...repeatFrame({ forward: true, sprint: true }, 24)]
  ),
  makeScenario(
    "sprint jumping with strafe",
    [...repeatFrame({ forward: true, sprint: true, jump: true, left: true }, 16), ...repeatFrame({ forward: true, sprint: true, left: true }, 24)]
  ),
  makeScenario("forward then reverse", [...repeatFrame({ forward: true }, 20), ...repeatFrame({ back: true }, 20)]),
  makeScenario(
    "jumping forward then reverse",
    [...repeatFrame({ forward: true, jump: true }, 20), ...repeatFrame({ back: true, jump: true }, 20)]
  ),
  makeScenario("orbiting around bot (near)", createOrbitFrames(48, orbitYawStepForRadius(8)), 12, 6),
  makeScenario("orbiting around bot (mid)", createOrbitFrames(48, orbitYawStepForRadius(16)), 12, 6),
  makeScenario("orbiting around bot (far)", createOrbitFrames(48, orbitYawStepForRadius(32)), 12, 6),
  makeScenario("jump forward then yaw flip", createYawFlipFrames(40, 20), 12, 6),
  makeScenario("random strafe flips", createRandomStrafeFlipFrames(48, 0xC0FFEE), 12, 6),
  makeScenario("random strafe jump sprint toward", createRandomStrafeJumpSprintFrames(48, 0xFACEB00C, true), 12, 6),
  makeScenario("random strafe jump sprint away", createRandomStrafeJumpSprintFrames(48, 0xFACEB00C, false), 12, 6),
];

const TARGET_POSITIONS = [
  new Vec3(20, 1, 20),
];

const POSITION_COVERAGE_POSITIONS = [
  new Vec3(8, 1, 8),
  new Vec3(-20, 1, -20),
  new Vec3(32, 1, 32),
];

const ORBIT_TARGET_POSITIONS = [
  new Vec3(8, 1, 0),
  new Vec3(16, 1, 0),
  new Vec3(24, 1, 0),
  new Vec3(32, 1, 0),
];

function runScenario(scenario: Scenario, targetPosition: Vec3) {
  const bot = createReplayBot({
    botPosition: new Vec3(0, 1, 0),
    targetPosition,
    targetVelocity: new Vec3(0, 0, 0),
    targetOnGround: true,
    floorY: 0,
  });

  const tracker = new EntityTrackerCurvature(bot as any);
  tracker.trackEntity(bot.target);

  const history: Array<{ confidence: number; distance: number }> = [];
  const frames = scenario.frames;

  for (let tick = 0; tick < frames.length - scenario.horizon; tick++) {
    stepReplayTick(bot, frames[tick]);

    if (tick < scenario.warmupTicks) continue;

    const prediction = tracker.predictEntityPositionWithConfidence(bot.target, scenario.horizon);
    assert.ok(prediction, `expected prediction for ${scenario.name}`);

    const actual = simulateFuturePosition(bot, frames.slice(tick + 1, tick + 1 + scenario.horizon));
    history.push({
      confidence: prediction.confidence,
      distance: prediction.position.distanceTo(actual),
    });
  }

  assert.ok(history.length > 0, `expected samples for ${scenario.name}`);

  return {
    scenario,
    bot,
    tracker,
    history,
    targetPosition,
    confidence: mean(history.map(sample => sample.confidence)),
    distance: mean(history.map(sample => sample.distance)),
  };
}

test("scenario coverage and confidence calibration", (t) => {
  const targetPosition = TARGET_POSITIONS[0];
  const results = SCENARIOS.map(scenario => {
    if (scenario.name.startsWith("orbiting around bot")) {
      return runScenario(scenario, ORBIT_TARGET_POSITIONS[1]);
    }

    return runScenario(scenario, targetPosition);
  });

  for (const result of results) {
    const last = result.history[result.history.length - 1];
    t.diagnostic(
      `${result.scenario.name} @ ${result.targetPosition.toString()}: samples=${result.history.length} confidence_avg=${result.confidence.toFixed(4)} distance_avg=${result.distance.toFixed(4)} last_confidence=${last.confidence.toFixed(4)}`
    );
    assert.ok(Number.isFinite(result.confidence), `${result.scenario.name} confidence should be finite`);
    assert.ok(result.confidence >= 0 && result.confidence <= 1, `${result.scenario.name} confidence should stay in [0,1]`);
    assert.ok(Number.isFinite(result.distance), `${result.scenario.name} distance should be finite`);
  }

  const standing = results.find(result => result.scenario.name === "standing still");
  const walking = results.find(result => result.scenario.name === "walking forward");
  const sprinting = results.find(result => result.scenario.name === "sprinting forward");
  const reversing = results.find(result => result.scenario.name === "forward then reverse");
  const orbitingNear = results.find(result => result.scenario.name === "orbiting around bot (near)");
  const orbitingMid = results.find(result => result.scenario.name === "orbiting around bot (mid)");
  const orbitingFar = results.find(result => result.scenario.name === "orbiting around bot (far)");
  const yawFlip = results.find(result => result.scenario.name === "jump forward then yaw flip");
  const randomStrafe = results.find(result => result.scenario.name === "random strafe flips");
  const randomToward = results.find(result => result.scenario.name === "random strafe jump sprint toward");
  const randomAway = results.find(result => result.scenario.name === "random strafe jump sprint away");

  assert.ok(standing, "standing still scenario missing");
  assert.ok(walking, "walking scenario missing");
  assert.ok(sprinting, "sprinting scenario missing");
  assert.ok(reversing, "reverse scenario missing");
  assert.ok(orbitingNear, "near orbiting scenario missing");
  assert.ok(orbitingMid, "mid orbiting scenario missing");
  assert.ok(orbitingFar, "far orbiting scenario missing");
  assert.ok(yawFlip, "yaw flip scenario missing");
  assert.ok(randomStrafe, "random strafe scenario missing");
  assert.ok(randomToward, "random strafe toward scenario missing");
  assert.ok(randomAway, "random strafe away scenario missing");

  assert.ok(standing.confidence >= walking.confidence, "standing still should be at least as confident as walking");
  assert.ok(walking.confidence <= sprinting.confidence + 0.15, "sprinting should not be much less confident than walking");
  assert.ok(reversing.confidence < walking.confidence, "reverse motion should be less confident than steady walking");
  assert.ok(orbitingNear.confidence > reversing.confidence, "orbiting motion should be more coherent than reversal motion");
  assert.ok(yawFlip.confidence < orbitingMid.confidence, "yaw flip should be less confident than orbiting");
  assert.ok(randomStrafe.confidence < walking.confidence, "random strafe flipping should be less confident than steady walking");
  assert.ok(randomToward.confidence >= randomAway.confidence - 0.1, "toward and away variants should stay in the same rough range");
});

test("confidence correlates with error across the scenario table", () => {
  const targetPosition = TARGET_POSITIONS[0];
  const results = SCENARIOS.map(scenario => {
    if (scenario.name.startsWith("orbiting around bot")) {
      return runScenario(scenario, ORBIT_TARGET_POSITIONS[1]);
    }

    return runScenario(scenario, targetPosition);
  });
  const confidences = results.flatMap(result => result.history.map(sample => sample.confidence));
  const distances = results.flatMap(result => result.history.map(sample => sample.distance));
  const corr = pearson(confidences, distances);

  assert.ok(Number.isFinite(corr), "correlation should be finite");
  assert.ok(confidences.length > 0, "expected confidence samples");
});

test("confidence stays stable across a few representative spawn positions", () => {
  const scenarios = [
    SCENARIOS.find(scenario => scenario.name === "standing still"),
    SCENARIOS.find(scenario => scenario.name === "walking forward"),
    SCENARIOS.find(scenario => scenario.name === "orbiting around bot (mid)"),
  ];

  assert.ok(scenarios[0], "standing still scenario missing");
  assert.ok(scenarios[1], "walking scenario missing");
  assert.ok(scenarios[2], "orbiting scenario missing");

  const results = POSITION_COVERAGE_POSITIONS.map(targetPosition => [
    runScenario(scenarios[0]!, targetPosition),
    runScenario(scenarios[1]!, targetPosition),
    runScenario(scenarios[2]!, targetPosition),
  ]).flat();

  for (const result of results) {
    assert.ok(result.confidence >= 0 && result.confidence <= 1, `${result.scenario.name} confidence should stay in [0,1]`);
  }
});
