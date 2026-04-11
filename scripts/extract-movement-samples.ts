import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Vec3Tuple = [number, number, number];

type TrackedInfoEntry = {
  age?: number;
  duration?: number;
  position: Vec3Tuple;
  velocity: Vec3Tuple;
};

type MovementAnalysis = {
  move: Vec3Tuple;
  radial: number;
  tangential: number;
  angleDeg: number;
};

type ShotPlannerReplaySnapshot = {
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
    movementAnalysis: MovementAnalysis | null;
    predictionError: Vec3Tuple | null;
    trackedHistoryAtPredictionTime: TrackedInfoEntry[] | null;
    trackedHistoryAfterWait: TrackedInfoEntry[] | null;
  };
  replaySnapshot: ShotPlannerReplaySnapshot | null;
  derived: {
    distanceError: number | null;
  };
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

const SHOT_LINE_RE = /^\[shot-planner:startTick=(\d+)]\s*(.*)$/;
const CHAT_LINE_RE = /^\[chat:tick=(\d+)]\s*(.*)$/;
const PERF_PHASE_RE = /^\[perf\] tick=\d+ stateMachine\.update source=tick phase=([^\s|]+)/;
const TRACKED_INFO_RE = /(?:age: (\d+), )?(?:dur: (\d+), )?pos: \(([^)]*)\), vel: \(([^)]*)\)/g;

function parseNumber(value: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(`Could not parse number from "${value}"`);
  }
  return parsed;
}

function parseMaybeNumber(value: string | undefined): number | null {
  if (value == null || value === "null") return null;
  return parseNumber(value);
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

function stripOuterParens(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseMaybeVec3(value: string | undefined): Vec3Tuple | null {
  if (value == null || value === "null") return null;
  return parseVec3(stripOuterParens(value));
}

function computeDistanceError(predicted: Vec3Tuple, actual: Vec3Tuple): number {
  const dx = predicted[0] - actual[0];
  const dy = predicted[1] - actual[1];
  const dz = predicted[2] - actual[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function parseTrackedInfo(value: string | undefined): TrackedInfoEntry[] | null {
  if (!value || value === "null") return null;

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

function parseMovementAnalysis(value: string | undefined): MovementAnalysis | null {
  if (!value || value === "null") return null;

  const match = value.match(
    /^move=\(([^)]*)\)\s+radial=([^\s]+)\s+tangential=([^\s]+)\s+angleDeg=([^\s]+)$/
  );
  if (!match) {
    throw new Error(`Could not parse movementAnalysis from "${value}"`);
  }

  return {
    move: parseVec3(match[1]),
    radial: parseNumber(match[2]),
    tangential: parseNumber(match[3]),
    angleDeg: parseNumber(match[4]),
  };
}

function parseKeyValuePairs(value: string): Map<string, string> {
  const pairs = new Map<string, string>();
  const normalized = value.replace(/^\|\s*/, "");
  for (const token of normalized.split(" | ")) {
    const separatorIndex = token.indexOf("=");
    if (separatorIndex === -1) {
      throw new Error(`Expected key=value token, got "${token}"`);
    }
    const key = token.slice(0, separatorIndex);
    const raw = token.slice(separatorIndex + 1);
    pairs.set(key, raw);
  }
  return pairs;
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
    const actualPosition = sample.shotPlanner.positionAfterWait;
    const entryRelativeDelta = sample.shotPlanner.movementAnalysis?.move ?? [0, 0, 0];

    if (!actualPosition) {
      continue;
    }

    if (!current || !sameVec3(current.position, actualPosition) || current.phase !== sample.phase) {
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
            actualPosition[0] - previousPosition[0],
            actualPosition[1] - previousPosition[1],
            actualPosition[2] - previousPosition[2],
          ]
        : [0, 0, 0];

      current = {
        phase: sample.phase,
        startLine: sample.line,
        endLine: sample.line,
        startTick: sample.shotPlanner.startTick,
        endTick: sample.shotPlanner.startTick,
        position: actualPosition,
        previousPosition,
        deltaFromPrevious,
        entryRelativeDelta,
        confidences: [sample.shotPlanner.confidence ?? 0],
        distances: [sample.derived.distanceError ?? 0],
        rawFirst: sample.raw,
        rawLast: sample.raw,
      };
      continue;
    }

    current.endLine = sample.line;
    current.endTick = sample.shotPlanner.startTick;
    current.confidences.push(sample.shotPlanner.confidence ?? 0);
    current.distances.push(sample.derived.distanceError ?? 0);
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

export async function extractMovementSamples(
  inputPath: string,
  outputPath: string,
  options: { phase?: string | null; pretty?: boolean; verbose?: boolean } = {}
) {
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

    const phaseMatch = line.match(PERF_PHASE_RE);
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

    const shotPlannerTokens = parseKeyValuePairs(shotMatch[2]);
    const positionAtPredictionTime = parseVec3(stripOuterParens(shotPlannerTokens.get("positionAtPredictionTime") ?? ""));
    const predictedPosition = parseMaybeVec3(shotPlannerTokens.get("predictedPosition"));
    const positionAfterWait = parseMaybeVec3(shotPlannerTokens.get("positionAfterWait"));
    const predictionError = parseMaybeVec3(shotPlannerTokens.get("predictionError"));
    const confidence = parseMaybeNumber(shotPlannerTokens.get("confidence"));
    const shotPlanner: MovementSample["shotPlanner"] = {
      startTick: Number(shotMatch[1]),
      tickDuration: Number(shotPlannerTokens.get("tickDuration") ?? "0"),
      confidence,
      positionAtPredictionTime,
      predictedPosition,
      positionAfterWait,
      entityYawDegrees: parseMaybeNumber(shotPlannerTokens.get("entityYawDegrees")),
      actualVelocityPerTick: parseMaybeVec3(shotPlannerTokens.get("actualVelocityPerTick")),
      movementAnalysis: parseMovementAnalysis(shotPlannerTokens.get("movementAnalysis")),
      predictionError,
      trackedHistoryAtPredictionTime: parseTrackedInfo(shotPlannerTokens.get("trackedHistoryAtPredictionTime")),
      trackedHistoryAfterWait: parseTrackedInfo(shotPlannerTokens.get("trackedHistoryAfterWait")),
    };

    const replaySnapshotRaw = shotPlannerTokens.get("replaySnapshot");
    const replaySnapshot = replaySnapshotRaw && replaySnapshotRaw !== "null"
      ? JSON.parse(replaySnapshotRaw) as ShotPlannerReplaySnapshot
      : null;

    const distanceError =
      predictedPosition && positionAfterWait
        ? computeDistanceError(predictedPosition, positionAfterWait)
        : null;

    const sample: MovementSample = {
      line: index + 1,
      phase: context.phase,
      chatTick: context.chatTick,
      shotPlanner,
      replaySnapshot,
      derived: {
        distanceError,
      },
      raw: line,
    };

    if (options.phase && sample.phase !== options.phase) continue;
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

  await fs.writeFile(outputPath, JSON.stringify(extracted, null, options.pretty === false ? 0 : 2));

  if (options.verbose !== false) {
    console.log(
      `parsed ${samples.length} shot-planner samples (${timeline.length} timeline segments) from ${path.basename(inputPath)} -> ${path.basename(outputPath)}`
    );
    console.log(`phases: ${extracted.source.phases.join(", ") || "none"}`);
    if (samples.length > 0) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      console.log(
        `first tick=${first.shotPlanner.startTick} confidence=${(first.shotPlanner.confidence ?? 0).toFixed(4)} actual=${(first.shotPlanner.positionAfterWait ?? first.shotPlanner.positionAtPredictionTime).join(", ")} predicted=${(first.shotPlanner.predictedPosition ?? first.shotPlanner.positionAtPredictionTime).join(", ")}`
      );
      console.log(
        `last tick=${last.shotPlanner.startTick} confidence=${(last.shotPlanner.confidence ?? 0).toFixed(4)} actual=${(last.shotPlanner.positionAfterWait ?? last.shotPlanner.positionAtPredictionTime).join(", ")} predicted=${(last.shotPlanner.predictedPosition ?? last.shotPlanner.positionAtPredictionTime).join(", ")}`
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

  return extracted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(process.cwd(), args.input);
  const outputPath = path.resolve(process.cwd(), args.output);
  await extractMovementSamples(inputPath, outputPath, {
    phase: args.phase,
    pretty: args.pretty,
    verbose: true,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
