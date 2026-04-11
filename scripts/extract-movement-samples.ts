import fs from "node:fs/promises";
import path from "node:path";

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
  startTick: number;
  tickDuration: number;
  confidence: number;
  start: Vec3Tuple;
  predicted: Vec3Tuple;
  actual: Vec3Tuple;
  yawDeg: number;
  actualLastV: Vec3Tuple;
  actualRelativeDelta: Vec3Tuple;
  radial: number;
  tangential: number;
  angleDeg: number;
  predDelta: Vec3Tuple;
  trackedInfoStart: TrackedInfoEntry[];
  trackedInfoEnd: TrackedInfoEntry[];
  trackedInfo: TrackedInfoEntry[];
  distanceError: number;
  errorDelta: Vec3Tuple;
  raw: string;
};

type MovementTimelineSegment = {
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
};

type ExtractedMovementLog = {
  source: {
    input: string;
    generatedAt: string;
    totalSamples: number;
    phases: string[];
  };
  samples: MovementSample[];
  timeline: MovementTimelineSegment[];
};

type LogContext = {
  phase: string | null;
  chatTick: number | null;
};

const SHOT_LINE_RE =
  /^\[shot-planner:startTick=(\d+)] tickDuration=(\d+) start=\(([^)]*)\) predicted=\(([^)]*)\) confidence=([^\s]+) actual=\(([^)]*)\) yawDeg=([^\s]+) actualLastV=\(([^)]*)\) actualRelativeDelta=move=\(([^)]*)\) radial=([^\s]+) tangential=([^\s]+) angleDeg=([^\s]+) predDelta=\(([^)]*)\)(?: trackedInfoStart=(.*?)(?: trackedInfoEnd=(.*))?| trackedInfo=(.*))?$/;
const CHAT_LINE_RE = /^\[chat:tick=(\d+)]\s*(.*)$/;
const PHASE_RE = /\bphase=([^\s|]+)/;
const TRACKED_INFO_RE = /(?:age: (\d+), )?(?:dur: (\d+), )?pos: \(([^)]*)\), vel: \(([^)]*)\)/g;

function parseNumber(value: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(`Could not parse number from "${value}"`);
  }
  return parsed;
}

function parseTuple(value: string, expectedLength: number): number[] {
  const parts = value.split(",").map(part => parseNumber(part));
  if (parts.length !== expectedLength) {
    throw new Error(`Expected ${expectedLength} values, got ${parts.length} from "${value}"`);
  }
  return parts;
}

function parseVec3(value: string): Vec3Tuple {
  const parts = parseTuple(value, 3);
  return [parts[0], parts[1], parts[2]];
}

function parseVec3Tuple(value: string): Vec3Tuple {
  const parts = parseTuple(value, 3);
  return [parts[0], parts[1], parts[2]];
}

function computeDistanceError(predicted: Vec3Tuple, actual: Vec3Tuple): number {
  const dx = predicted[0] - actual[0];
  const dy = predicted[1] - actual[1];
  const dz = predicted[2] - actual[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function parseTrackedInfo(value: string | undefined): TrackedInfoEntry[] {
  if (!value) return [];

  const entries: TrackedInfoEntry[] = [];
  TRACKED_INFO_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
    while ((match = TRACKED_INFO_RE.exec(value)) !== null) {
      entries.push({
        age: match[1] ? Number(match[1]) : undefined,
        duration: match[2] ? Number(match[2]) : undefined,
        position: parseVec3(match[3]),
        velocity: parseVec3(match[4]),
      });
    }

  return entries;
}

function vec3Key(vec: Vec3Tuple): string {
  return `${vec[0]}|${vec[1]}|${vec[2]}`;
}

function sameVec3(a: Vec3Tuple, b: Vec3Tuple): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function buildTimeline(samples: MovementSample[]): MovementTimelineSegment[] {
  const segments: MovementTimelineSegment[] = [];
  let current: {
    phase: string | null;
    startLine: number;
    endLine: number;
    startTick: number;
    endTick: number;
    position: Vec3Tuple;
    previousPosition: Vec3Tuple | null;
    deltaFromPrevious: Vec3Tuple;
    entryRelativeDelta: Vec3Tuple;
    confidences: number[];
    distances: number[];
    rawFirst: string;
    rawLast: string;
  } | null = null;

  for (const sample of samples) {
    if (!current || !sameVec3(current.position, sample.actual) || current.phase !== sample.phase) {
      if (current) {
        segments.push({
          phase: current.phase,
          startLine: current.startLine,
          endLine: current.endLine,
          startTick: current.startTick,
          endTick: current.endTick,
          ageTicks: current.endTick - current.startTick + 1,
          sampleCount: current.confidences.length,
          position: current.position,
          previousPosition: current.previousPosition,
          deltaFromPrevious: current.deltaFromPrevious,
          entryRelativeDelta: current.entryRelativeDelta,
          confidenceAtEntry: current.confidences[0] ?? 0,
          confidenceAvg: current.confidences.reduce((sum, value) => sum + value, 0) / Math.max(1, current.confidences.length),
          confidenceMin: Math.min(...current.confidences),
          confidenceMax: Math.max(...current.confidences),
          distanceErrorAvg: current.distances.reduce((sum, value) => sum + value, 0) / Math.max(1, current.distances.length),
          distanceErrorMax: Math.max(...current.distances),
          rawFirst: current.rawFirst,
          rawLast: current.rawLast,
        });
      }

      const previousSegment = segments[segments.length - 1] ?? null;
      const previousPosition = previousSegment ? previousSegment.position : null;
      const deltaFromPrevious: Vec3Tuple = previousPosition
        ? [
            sample.actual[0] - previousPosition[0],
            sample.actual[1] - previousPosition[1],
            sample.actual[2] - previousPosition[2],
          ]
        : [0, 0, 0];

      current = {
        phase: sample.phase,
        startLine: sample.line,
        endLine: sample.line,
        startTick: sample.startTick,
        endTick: sample.startTick,
        position: sample.actual,
        previousPosition,
        deltaFromPrevious,
        entryRelativeDelta: sample.actualRelativeDelta,
        confidences: [sample.confidence],
        distances: [sample.distanceError],
        rawFirst: sample.raw,
        rawLast: sample.raw,
      };
      continue;
    }

    current.endLine = sample.line;
    current.endTick = sample.startTick;
    current.confidences.push(sample.confidence);
    current.distances.push(sample.distanceError);
    current.rawLast = sample.raw;
  }

  if (current) {
    segments.push({
      phase: current.phase,
      startLine: current.startLine,
      endLine: current.endLine,
      startTick: current.startTick,
      endTick: current.endTick,
      ageTicks: current.endTick - current.startTick + 1,
      sampleCount: current.confidences.length,
      position: current.position,
      previousPosition: current.previousPosition,
      deltaFromPrevious: current.deltaFromPrevious,
      entryRelativeDelta: current.entryRelativeDelta,
      confidenceAtEntry: current.confidences[0] ?? 0,
      confidenceAvg: current.confidences.reduce((sum, value) => sum + value, 0) / Math.max(1, current.confidences.length),
      confidenceMin: Math.min(...current.confidences),
      confidenceMax: Math.max(...current.confidences),
      distanceErrorAvg: current.distances.reduce((sum, value) => sum + value, 0) / Math.max(1, current.distances.length),
      distanceErrorMax: Math.max(...current.distances),
      rawFirst: current.rawFirst,
      rawLast: current.rawLast,
    });
  }

  return segments;
}

function parseArgs(argv: string[]) {
  const args = {
    input: "output.log",
    output: "movement-samples.json",
    phase: null as string | null,
    pretty: true,
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (current === "--input" || current === "-i") {
      args.input = argv[++i] ?? args.input;
      continue;
    }
    if (current === "--output" || current === "-o") {
      args.output = argv[++i] ?? args.output;
      continue;
    }
    if (current === "--phase") {
      args.phase = argv[++i] ?? null;
      continue;
    }
    if (current === "--compact") {
      args.pretty = false;
      continue;
    }
    positional.push(current);
  }

  if (positional[0]) args.input = positional[0];
  if (positional[1]) args.output = positional[1];

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(process.cwd(), args.input);
  const outputPath = path.resolve(process.cwd(), args.output);

  const raw = await fs.readFile(inputPath, "utf8");
  const lines = raw.split(/\r?\n/);

  const context: LogContext = {
    phase: null,
    chatTick: null,
  };

  const samples: MovementSample[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;

    const phaseMatch = line.match(PHASE_RE);
    if (phaseMatch) {
      context.phase = phaseMatch[1];
    }

    const chatMatch = line.match(CHAT_LINE_RE);
    if (chatMatch) {
      context.chatTick = Number(chatMatch[1]);
      continue;
    }

    const shotMatch = line.match(SHOT_LINE_RE);
    if (!shotMatch) continue;

    const sample: MovementSample = {
      line: index + 1,
      phase: context.phase,
      chatTick: context.chatTick,
      startTick: Number(shotMatch[1]),
      tickDuration: Number(shotMatch[2]),
      start: parseVec3(shotMatch[3]),
      predicted: parseVec3(shotMatch[4]),
      confidence: parseNumber(shotMatch[5]),
      actual: parseVec3(shotMatch[6]),
      yawDeg: parseNumber(shotMatch[7]),
      actualLastV: parseVec3(shotMatch[8]),
      actualRelativeDelta: parseVec3Tuple(shotMatch[9]),
      radial: parseNumber(shotMatch[10]),
      tangential: parseNumber(shotMatch[11]),
      angleDeg: parseNumber(shotMatch[12]),
      predDelta: parseVec3(shotMatch[13]),
      trackedInfoStart: parseTrackedInfo(shotMatch[14] ?? shotMatch[16]),
      trackedInfoEnd: parseTrackedInfo(shotMatch[15]),
      trackedInfo: parseTrackedInfo(shotMatch[14] ?? shotMatch[16]),
      distanceError: 0,
      errorDelta: [0, 0, 0],
      raw: line,
    };

    sample.errorDelta = [
      sample.predicted[0] - sample.actual[0],
      sample.predicted[1] - sample.actual[1],
      sample.predicted[2] - sample.actual[2],
    ];
    sample.distanceError = computeDistanceError(sample.predicted, sample.actual);

    if (args.phase && sample.phase !== args.phase) continue;
    samples.push(sample);
  }

  const timeline = buildTimeline(samples);
  const extracted: ExtractedMovementLog = {
    source: {
      input: path.basename(inputPath),
      generatedAt: new Date().toISOString(),
      totalSamples: samples.length,
      phases: [...new Set(samples.map(sample => sample.phase ?? "none"))],
    },
    samples,
    timeline,
  };

  await fs.writeFile(outputPath, JSON.stringify(extracted, null, args.pretty ? 2 : 0));

  console.log(
    `parsed ${samples.length} shot-planner samples (${timeline.length} timeline segments) from ${path.basename(inputPath)} -> ${path.basename(outputPath)}`
  );
  console.log(`phases: ${extracted.source.phases.join(", ") || "none"}`);
  if (samples.length > 0) {
    const first = samples[0];
    const last = samples[samples.length - 1];
    console.log(
      `first tick=${first.startTick} confidence=${first.confidence.toFixed(4)} actual=${first.actual.join(", ")} predicted=${first.predicted.join(", ")}`
    );
    console.log(
      `last tick=${last.startTick} confidence=${last.confidence.toFixed(4)} actual=${last.actual.join(", ")} predicted=${last.predicted.join(", ")}`
    );
  }
  if (timeline.length > 0) {
    const firstSegment = timeline[0];
    const lastSegment = timeline[timeline.length - 1];
    console.log(
      `first segment tick=${firstSegment.startTick}-${firstSegment.endTick} age=${firstSegment.ageTicks} pos=${firstSegment.position.join(", ")} delta=${firstSegment.deltaFromPrevious.join(", ")}`
    );
    console.log(
      `last segment tick=${lastSegment.startTick}-${lastSegment.endTick} age=${lastSegment.ageTicks} pos=${lastSegment.position.join(", ")} delta=${lastSegment.deltaFromPrevious.join(", ")}`
    );
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
