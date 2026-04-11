const fs = require("fs");

const logPath = process.argv[2] || "output.log";
const text = fs.readFileSync(logPath, "utf8");
const lines = text.split(/\r?\n/);

const shotPattern =
  /\[shot-planner:startTick=(\d+)\].*?predicted=\(([-0-9.]+),\s*([-0-9.]+),\s*([-0-9.]+)\).*?confidence=([0-9.]+).*?actual=\(([-0-9.]+),\s*([-0-9.]+),\s*([-0-9.]+)\)/;

const points = [];

for (const line of lines) {
  const match = line.match(shotPattern);
  if (!match) continue;

  const predicted = {
    x: Number(match[2]),
    y: Number(match[3]),
    z: Number(match[4]),
  };
  const confidence = Number(match[5]);
  const actual = {
    x: Number(match[6]),
    y: Number(match[7]),
    z: Number(match[8]),
  };

  const dx = predicted.x - actual.x;
  const dy = predicted.y - actual.y;
  const dz = predicted.z - actual.z;
  const distance = Math.hypot(dx, dy, dz);

  points.push({
    tick: Number(match[1]),
    confidence,
    distance,
  });
}

if (points.length === 0) {
  console.error(`No shot-planner lines matched in ${logPath}`);
  process.exit(1);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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

function quartileBuckets(items) {
  const sorted = [...items].sort((a, b) => a.confidence - b.confidence);
  const bucketSize = Math.ceil(sorted.length / 4);
  const buckets = [];

  for (let i = 0; i < sorted.length; i += bucketSize) {
    buckets.push(sorted.slice(i, i + bucketSize));
  }

  return buckets;
}

const confidences = points.map(p => p.confidence);
const distances = points.map(p => p.distance);
const corr = pearson(confidences, distances);
const corrInv = pearson(confidences, distances.map(d => 1 / (1 + d)));

console.log(`log=${logPath}`);
console.log(`samples=${points.length}`);
console.log(`confidence_vs_distance_pearson=${corr.toFixed(4)}`);
console.log(`confidence_vs_inverse_distance_pearson=${corrInv.toFixed(4)}`);
console.log("");

const buckets = quartileBuckets(points);
for (let i = 0; i < buckets.length; i++) {
  const bucket = buckets[i];
  const confs = bucket.map(p => p.confidence);
  const dists = bucket.map(p => p.distance);
  console.log(
    `bucket_${i + 1}: count=${bucket.length} confidence_avg=${mean(confs).toFixed(4)} distance_avg=${mean(dists).toFixed(4)} confidence_min=${Math.min(...confs).toFixed(4)} confidence_max=${Math.max(...confs).toFixed(4)}`
  );
}

console.log("");
console.log("sample_points:");
for (const point of points.slice(0, 10)) {
  console.log(`tick=${point.tick} confidence=${point.confidence.toFixed(4)} distance=${point.distance.toFixed(4)}`);
}
