"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const vec3_1 = require("vec3");
const index_js_1 = require("../lib/index.js");
const replayBot_1 = require("./replayBot");
function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}
function pearson(xs, ys) {
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
function bucketize(points) {
    const sorted = [...points].sort((a, b) => a.confidence - b.confidence);
    const bucketSize = Math.max(1, Math.ceil(sorted.length / 4));
    const buckets = [];
    for (let i = 0; i < sorted.length; i += bucketSize) {
        buckets.push(sorted.slice(i, i + bucketSize));
    }
    return buckets;
}
function runFrames(bot, frames) {
    for (const frame of frames) {
        (0, replayBot_1.stepReplayTick)(bot, frame);
    }
}
function comparePrediction(bot, tracker, horizon) {
    const prediction = tracker.predictEntityPositionWithConfidence(bot.entity, horizon);
    strict_1.default.ok(prediction, "tracker should return a prediction");
    const future = (0, replayBot_1.simulateFuturePosition)(bot, (0, replayBot_1.repeatFrame)({}, horizon));
    return {
        prediction,
        future,
        distance: prediction.position.distanceTo(future),
    };
}
(0, node_test_1.default)("stable standstill should be near-certain", () => {
    const bot = (0, replayBot_1.createReplayBot)({
        position: new vec3_1.Vec3(0, 1, 0),
        velocity: new vec3_1.Vec3(0, 0, 0),
        onGround: true,
    });
    const tracker = new index_js_1.EntityTrackerCurvature(bot);
    tracker.trackEntity(bot.entity);
    runFrames(bot, (0, replayBot_1.repeatFrame)({}, 12));
    const { prediction, future, distance } = comparePrediction(bot, tracker, 10);
    strict_1.default.ok(distance < 1e-6, `expected standstill prediction to match actual position, got distance ${distance}`);
    strict_1.default.ok(prediction.confidence >= 0.95, `expected standstill confidence near 1, got ${prediction.confidence.toFixed(4)}`);
    strict_1.default.equal(prediction.position.distanceTo(future) < 1e-6, true);
});
(0, node_test_1.default)("steady motion should outrank braking motion", () => {
    const bot = (0, replayBot_1.createReplayBot)({
        position: new vec3_1.Vec3(0, 1, 0),
        velocity: new vec3_1.Vec3(0, 0, 0),
        onGround: true,
    });
    const tracker = new index_js_1.EntityTrackerCurvature(bot);
    tracker.trackEntity(bot.entity);
    runFrames(bot, (0, replayBot_1.repeatFrame)({ forward: true, sprint: true }, 12));
    const steady = tracker.predictEntityPositionWithConfidence(bot.entity, 8);
    strict_1.default.ok(steady, "expected steady prediction");
    runFrames(bot, (0, replayBot_1.repeatFrame)({}, 3));
    const braking = tracker.predictEntityPositionWithConfidence(bot.entity, 8);
    strict_1.default.ok(braking, "expected braking prediction");
    strict_1.default.ok(steady.confidence > braking.confidence, `expected steady confidence (${steady.confidence.toFixed(4)}) to exceed braking confidence (${braking.confidence.toFixed(4)})`);
});
(0, node_test_1.default)("mixed scripted motion produces measurable confidence/error statistics", (t) => {
    const bot = (0, replayBot_1.createReplayBot)({
        position: new vec3_1.Vec3(0, 1, 0),
        velocity: new vec3_1.Vec3(0, 0, 0),
        onGround: true,
    });
    const tracker = new index_js_1.EntityTrackerCurvature(bot);
    tracker.trackEntity(bot.entity);
    const script = [
        ...(0, replayBot_1.repeatFrame)({}, 10),
        ...(0, replayBot_1.repeatFrame)({ forward: true, sprint: true }, 12),
        ...(0, replayBot_1.repeatFrame)({}, 6),
        ...(0, replayBot_1.repeatFrame)({ forward: true, sprint: true }, 8),
        ...(0, replayBot_1.repeatFrame)({ back: true, sprint: true }, 8),
    ];
    const horizon = 6;
    const samples = [];
    for (let tick = 0; tick < script.length - horizon; tick++) {
        (0, replayBot_1.stepReplayTick)(bot, script[tick]);
        if (tick < 12)
            continue;
        const prediction = tracker.predictEntityPositionWithConfidence(bot.entity, horizon);
        strict_1.default.ok(prediction, "expected prediction");
        const actual = (0, replayBot_1.simulateFuturePosition)(bot, script.slice(tick + 1, tick + 1 + horizon));
        samples.push({
            confidence: prediction.confidence,
            distance: prediction.position.distanceTo(actual),
        });
    }
    strict_1.default.ok(samples.length > 10, "expected enough samples for statistics");
    const confidences = samples.map(sample => sample.confidence);
    const distances = samples.map(sample => sample.distance);
    const corr = pearson(confidences, distances);
    t.diagnostic(`samples=${samples.length}`);
    t.diagnostic(`confidence_vs_distance_pearson=${corr.toFixed(4)}`);
    const buckets = bucketize(samples);
    buckets.forEach((bucket, index) => {
        const bucketConf = bucket.map(sample => sample.confidence);
        const bucketDist = bucket.map(sample => sample.distance);
        t.diagnostic(`bucket_${index + 1}: count=${bucket.length} confidence_avg=${mean(bucketConf).toFixed(4)} distance_avg=${mean(bucketDist).toFixed(4)}`);
    });
    strict_1.default.ok(Number.isFinite(corr), "correlation should be finite");
});
