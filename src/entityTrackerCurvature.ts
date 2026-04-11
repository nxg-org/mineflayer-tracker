import physicsUtilPlugin, { ControlStateHandler } from "@nxg-org/mineflayer-physics-util";
import { Bot } from "mineflayer";
import { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { dirToYawAndPitch } from "./mathUtils";
import { getMovementWindowConfidence, type WindowConfidenceSample } from "./windowConfidence";

const emptyVec = new Vec3(0, 0, 0);
const DEFAULT_CONFIG = {
  maxHistory: 20,
  featureWindow: 10,
  directionBreakThreshold: Math.PI / 2,
  minPlanarSpeed: 1e-4,
  minSpeedTrend: 0.01,
  minTurnRate: Math.PI / 180,
  maxTurnRate: Math.PI / 6,
  turnContinuationTicks: 3,
  usePhysicsRefinement: true,
  assumeForwardInput: true,
  assumeSprintInput: true,
};

type TrackingInfo = { position: Vec3; velocity: Vec3; age: number; duration: number };
type VelocitySample = {
  velocity: Vec3;
  planarSpeed: number;
  yaw: number | null;
  dt: number;
};
type CurvatureFeatures = {
  latestVelocity: Vec3;
  planarVelocity: Vec3;
  planarSpeed: number;
  headingYaw: number | null;
  turnRate: number;
  planarAcceleration: Vec3;
  accelerationChanged: boolean;
  verticalVelocity: number;
};

export type CurvaturePrediction = {
  position: Vec3;
  confidence: number;
};

export type EntityTrackerCurvatureConfig = Partial<typeof DEFAULT_CONFIG>;

export type TrackingData = {
  [entityId: number]: { tracking: boolean; info: { initialAge: number; avgVel: Vec3; tickInfo: TrackingInfo[] } };
};

export class EntityTrackerCurvature {
  public trackingData: TrackingData = {};
  public debugLogging = false;

  private _enabled = false;
  private _tickAge = 0;
  private readonly config: typeof DEFAULT_CONFIG;
  private readonly lastLoggedPredictionTick = new Map<number, number>();
  private readonly recentMovement = new Map<number, { previous: Vec3 | null; current: Vec3 }>();

  public get enabled() {
    return this._enabled;
  }

  public set enabled(value: boolean) {
    if (value === this._enabled) return;

    if (value) this.bot.on("physicsTick", this.trackMotionHistory);
    else this.bot.off("physicsTick", this.trackMotionHistory);

    this._enabled = value;
  }

  constructor(private bot: Bot, config: EntityTrackerCurvatureConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (!this.bot.physicsUtil) {
      this.bot.loadPlugin(physicsUtilPlugin as any);
    }

    this.enabled = true;
  }

  private logDebug(event: string, details: Record<string, unknown>, override = false) {
    if (!this.debugLogging && !override) return;
    console.log(`[EntityTrackerCurvature:${event}]`, details);
  }

  private formatVec3(vec: Vec3): string {
    return `(${vec.x}, ${vec.y}, ${vec.z})`;
  }

  private formatMaybeVec3(vec: Vec3 | null | undefined): string {
    return vec ? this.formatVec3(vec) : "null";
  }

  private formatTrackedInfo(entries: Array<{ position: Vec3; velocity: Vec3; age?: number; duration?: number }>): string {
    if (entries.length === 0) return "null";

    return entries
      .map(entry => {
        return `{age: ${entry.age ?? "null"}, dur: ${entry.duration ?? "null"}, pos: ${this.formatVec3(entry.position)}, vel: ${this.formatVec3(entry.velocity)}}`;
      })
      .join(", ");
  }

  private cloneTrackedInfo(entityId: number): TrackingInfo[] {
    const tickInfo = this.trackingData[entityId]?.info.tickInfo ?? [];
    return tickInfo.map(entry => ({
      position: entry.position.clone(),
      velocity: entry.velocity.clone(),
      age: entry.age,
      duration: entry.duration,
    }));
  }

  private getYawDegrees(yaw: number): string {
    if (!Number.isFinite(yaw)) return "null";
    return ((yaw * 180) / Math.PI).toFixed(1);
  }

  private clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
  }

  private average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  private getPlanarMagnitude(vec: Vec3): number {
    return Math.sqrt(vec.x * vec.x + vec.z * vec.z);
  }

  private getWrappedAngleDiff(from: number, to: number): number {
    let diff = to - from;

    while (diff <= -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;

    return diff;
  }

  private buildVelocitySamples(history: TrackingInfo[]): VelocitySample[] {
    const samples: VelocitySample[] = [];

    for (let i = 1; i < history.length; i++) {
      const previous = history[i - 1];
      const current = history[i];

      const delta = current.position.minus(previous.position);
      // Normalize velocity to per-tick (positions are sent every 2 ticks in Minecraft)
      const velocity = new Vec3(delta.x / 2, delta.y / 2, delta.z / 2);
      const planarSpeed = this.getPlanarMagnitude(velocity);
      const yaw =
        planarSpeed > this.config.minPlanarSpeed ? dirToYawAndPitch(new Vec3(velocity.x, 0, velocity.z)).yaw : null;

      samples.push({ velocity, planarSpeed, yaw, dt: 1 });
    }

    return samples;
  }

  private estimateVerticalVelocity(history: TrackingInfo[]): number {
    const latest = history[history.length - 1];
    const previous = history[history.length - 2];
    if (!latest || !previous) return -0.078;

    // Normalize to per-tick (positions are sent every 2 ticks)
    const deltaY = (latest.position.y - previous.position.y) / 2;
    return Math.abs(deltaY) <= 1e-9 ? -0.078 : deltaY;
  }

  private getPlanarAcceleration(samples: VelocitySample[]): Vec3 | null {
    if (samples.length < 2) return null;

    let totalAccelX = 0;
    let totalAccelZ = 0;
    let count = 0;

    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1];
      const curr = samples[i];

      const accelX = curr.velocity.x - prev.velocity.x;
      const accelZ = curr.velocity.z - prev.velocity.z;

      totalAccelX += accelX;
      totalAccelZ += accelZ;
      count++;
    }

    if (count === 0) return null;
    return new Vec3(totalAccelX / count, 0, totalAccelZ / count);
  }

  private getAccelerationAwareWindow(samples: VelocitySample[], entityId?: number): { samples: VelocitySample[]; accelerationChanged: boolean } {
    const recent = samples.slice(-this.config.featureWindow);
    if (recent.length < 3) {
      return { samples: recent, accelerationChanged: false };
    }

    const latestVelocity = recent[recent.length - 1].velocity;
    const latestVelocityMag = this.getPlanarMagnitude(latestVelocity);
    const latestAccel = this.getPlanarAcceleration(recent.slice(-Math.min(4, recent.length)));
    if (!latestAccel) {
      return { samples: recent, accelerationChanged: false };
    }

    const latestAccelMag = this.getPlanarMagnitude(latestAccel);
    if (latestVelocityMag <= this.config.minPlanarSpeed || latestAccelMag < this.config.minSpeedTrend) {
      return { samples: recent, accelerationChanged: false };
    }

    const velocityDot = latestVelocity.x * latestAccel.x + latestVelocity.z * latestAccel.z;
    const braking = velocityDot < -latestVelocityMag * latestAccelMag * 0.15;

    let changed = braking;
    if (!changed) {
      for (let i = recent.length - 2; i >= 1; i--) {
        const segmentAccel = this.getPlanarAcceleration(recent.slice(Math.max(0, i - 1), i + 1));
        if (!segmentAccel) continue;

        const segmentMag = this.getPlanarMagnitude(segmentAccel);
        if (segmentMag < this.config.minSpeedTrend) continue;

        const dotProduct = segmentAccel.x * latestAccel.x + segmentAccel.z * latestAccel.z;
        if (dotProduct < 0) {
          changed = true;
          break;
        }
      }
    }

    if (!changed) {
      return { samples: recent, accelerationChanged: false };
    }

    // Once the acceleration regime changes, the older velocity samples are
    // mostly inertia from the previous motion phase. Keep only the freshest
    // tail so the predictor can react to the new push instead of averaging the
    // stale segment back into the next prediction.
    const trimmedWindow = recent.slice(-Math.min(4, recent.length));
    return { samples: trimmedWindow, accelerationChanged: true };
  }

  private isAccelerationReversing(recentAccel: Vec3 | null, olderAccel: Vec3 | null): boolean {
    if (!recentAccel || !olderAccel) return false;

    const recentMag = this.getPlanarMagnitude(recentAccel);
    const olderMag = this.getPlanarMagnitude(olderAccel);

    // Only consider reversals if both accelerations are significant
    if (recentMag < this.config.minPlanarSpeed * 0.5 || olderMag < this.config.minPlanarSpeed * 0.5) {
      return false;
    }

    // Dot product < 0 means opposing directions (reversal)
    const dotProduct = recentAccel.x * olderAccel.x + recentAccel.z * olderAccel.z;
    return dotProduct < 0;
  }

  private getSignedTurnRate(samples: VelocitySample[]): number {
    const recent = samples.slice(-this.config.featureWindow);
    if (recent.length < 2) return 0;

    let totalTurn = 0;
    let count = 0;

    for (let i = 1; i < recent.length; i++) {
      const previousYaw = recent[i - 1].yaw;
      const currentYaw = recent[i].yaw;
      if (previousYaw === null || currentYaw === null) continue;

      totalTurn += this.getWrappedAngleDiff(previousYaw, currentYaw);
      count++;
    }

    if (count === 0) return 0;

    const turnRate = totalTurn / count;
    if (Math.abs(turnRate) < this.config.minTurnRate) {
      return 0;
    }

    // Check for acceleration reversals which indicate input changes.
    const midpoint = Math.floor(recent.length / 2);
    const recentSamples = recent.slice(midpoint);
    const olderSamples = recent.slice(0, midpoint);

    const recentAccel = this.getPlanarAcceleration(recentSamples);
    const olderAccel = this.getPlanarAcceleration(olderSamples);

    // If acceleration is reversing (e.g., quickly switching from left to right input),
    // keep the direction of the turn but dampen it so we do not over-shoot the
    // reversal with a fully confident curvature continuation.
    if (this.isAccelerationReversing(recentAccel, olderAccel)) {
      return 0;
    }

    return Math.max(-this.config.maxTurnRate, Math.min(this.config.maxTurnRate, turnRate));
  }

  private isInLongStaticPeriod(history: TrackingInfo[]): boolean {
    if (history.length === 0) return false;

    const latest = history[history.length - 1];
    const latestPlanarSpeed = this.getPlanarMagnitude(new Vec3(latest.velocity.x, 0, latest.velocity.z));
    const isDurationLong = latest.duration > 3; // Standing still for >3 ticks is inconsistent, treat as static
    const isVelocityNearZero = latestPlanarSpeed < this.config.minPlanarSpeed * 2;

    return isDurationLong && isVelocityNearZero;
  }

  private deriveCurvatureFeatures(history: TrackingInfo[], entityId?: number): CurvatureFeatures | null {
    const samples = this.buildVelocitySamples(history);
    if (samples.length === 0) {
      const latest = history[history.length - 1];
      if (!latest) return null;

      const planarVelocity = new Vec3(latest.velocity.x, 0, latest.velocity.z);
      const planarSpeed = this.getPlanarMagnitude(planarVelocity);
      const headingYaw =
        planarSpeed > this.config.minPlanarSpeed ? dirToYawAndPitch(new Vec3(planarVelocity.x, 0, planarVelocity.z)).yaw : null;
      const verticalVelocity = this.estimateVerticalVelocity(history);

      return {
        latestVelocity: new Vec3(latest.velocity.x, verticalVelocity, latest.velocity.z),
        planarVelocity,
        planarSpeed,
        headingYaw,
        turnRate: 0,
        planarAcceleration: emptyVec,
        accelerationChanged: false,
        verticalVelocity,
      };
    }

    const { samples: recent, accelerationChanged } = this.getAccelerationAwareWindow(samples, entityId);
    const moving = recent.filter(sample => sample.planarSpeed > this.config.minPlanarSpeed);
    const latest = moving[moving.length - 1] ?? recent[recent.length - 1];
    const latestVelocity = latest.velocity.clone();

    // We separate speed from curvature here. The current path-shape problem is
    // mostly about not continuing steering strongly enough, so we keep speed as
    // a simple local average and let heading change come from signed turn rate.
    const speedSource = moving.length > 0 ? moving : recent;
    const planarSpeed =
      speedSource.reduce((total, sample) => total + sample.planarSpeed, 0) / Math.max(1, speedSource.length);
    const headingYaw = latest.yaw;
    
    // If in a long static period, suppress turn extrapolation entirely
    const inStaticPeriod = this.isInLongStaticPeriod(history);
    const turnRate = inStaticPeriod ? 0 : this.getSignedTurnRate(recent);
    
    const planarAcceleration = this.getPlanarAcceleration(recent) ?? emptyVec;
    const verticalVelocity = this.estimateVerticalVelocity(history);

    let planarVelocity = new Vec3(latestVelocity.x, 0, latestVelocity.z);
    const accelerationMagnitude = this.getPlanarMagnitude(planarAcceleration);
    const accelerationOpposesMotion =
      accelerationMagnitude > this.config.minSpeedTrend &&
      this.getPlanarMagnitude(planarVelocity) > this.config.minPlanarSpeed &&
      planarVelocity.x * planarAcceleration.x + planarVelocity.z * planarAcceleration.z < 0;

    if (accelerationChanged && accelerationOpposesMotion) {
      planarVelocity = new Vec3(
        latestVelocity.x + planarAcceleration.x,
        0,
        latestVelocity.z + planarAcceleration.z
      );
    } else if (headingYaw !== null && planarSpeed > this.config.minPlanarSpeed) {
      planarVelocity = new Vec3(-Math.sin(headingYaw) * planarSpeed, 0, -Math.cos(headingYaw) * planarSpeed);
    }

    return {
      latestVelocity: new Vec3(latestVelocity.x, verticalVelocity, latestVelocity.z),
      planarVelocity,
      planarSpeed,
      headingYaw,
      turnRate,
      planarAcceleration,
      accelerationChanged,
      verticalVelocity,
    };
  }

  private getCurrentPlanarDelta(info: { tickInfo: TrackingInfo[] }): Vec3 {
    if (info.tickInfo.length < 2) return emptyVec;

    const previous = info.tickInfo[info.tickInfo.length - 2];
    const latest = info.tickInfo[info.tickInfo.length - 1];

    const delta = latest.position.minus(previous.position);
    return new Vec3(delta.x, 0, delta.z);
  }

  private getRelativeMovementSummary(actual: Vec3, deltaVelocity: Vec3 | null): string {
    if (!deltaVelocity) return "null";

    const move = new Vec3(deltaVelocity.x, 0, deltaVelocity.z);
    const moveMagnitude = this.getPlanarMagnitude(move);
    if (moveMagnitude <= this.config.minPlanarSpeed) {
      return `move=${this.formatVec3(move)} radial=0.000 tangential=0.000 angleDeg=0.0`;
    }

    const actualFlat = new Vec3(actual.x, 0, actual.z);
    const actualMagnitude = this.getPlanarMagnitude(actualFlat);
    if (actualMagnitude <= this.config.minPlanarSpeed) {
      return `move=${this.formatVec3(move)} radial=0.000 tangential=0.000 angleDeg=0.0`;
    }

    const dot = actualFlat.x * move.x + actualFlat.z * move.z;
    const cross = actualFlat.x * move.z - actualFlat.z * move.x;
    const cosine = Math.max(-1, Math.min(1, dot / (actualMagnitude * moveMagnitude)));
    const angleDeg = (Math.acos(cosine) * 180) / Math.PI;
    const radial = dot / actualMagnitude;
    const tangential = Math.abs(cross) / actualMagnitude;

    return `move=${this.formatVec3(move)} radial=${radial.toFixed(3)} tangential=${tangential.toFixed(3)} angleDeg=${angleDeg.toFixed(1)}`;
  }

  public logActualTargetPositionAfterTicks(target: Entity, ticks: number, predicted: CurvaturePrediction | null, startTick: number): void {
    const targetId = target.id;
    const lastLoggedTick = this.lastLoggedPredictionTick.get(targetId);
    if (lastLoggedTick === startTick) return;

    this.lastLoggedPredictionTick.set(targetId, startTick);
    const startPos = target.position.clone();
    const trackedInfoAtPredictionStart = this.cloneTrackedInfo(targetId);

    void this.bot.waitForTicks(Math.max(0, ticks)).then(() => {
      const currentTarget = this.bot.entities[targetId];
      if (!currentTarget) {
        const trackedHistoryAtPredictionTime = this.formatTrackedInfo(trackedInfoAtPredictionStart);
        console.log(
          `[shot-planner:startTick=${startTick}] | confidence=${predicted?.confidence ?? "null"} | tickDuration=${ticks} | ` +
          `positionAtPredictionTime=${this.formatVec3(startPos)} | predictedPosition=${this.formatMaybeVec3(predicted?.position)} | ` +
          `positionAfterWait=null | entityYawDegrees=null | actualVelocityPerTick=null | movementAnalysis=null | predictionError=null | ` +
          `trackedHistoryAtPredictionTime=${trackedHistoryAtPredictionTime} | trackedHistoryAfterWait=null`,
        );
        return;
      }

      const positionAfterWait = currentTarget.position.clone();
      const lastMovementData = this.recentMovement.get(targetId);
      const rawPositionDelta = lastMovementData?.previous && lastMovementData.current.equals(positionAfterWait) ? lastMovementData.current.minus(lastMovementData.previous) : null;
      // Normalize to per-tick (positions are sent every 2 ticks)
      const actualVelocityPerTick = rawPositionDelta ? new Vec3(rawPositionDelta.x / 2, rawPositionDelta.y / 2, rawPositionDelta.z / 2) : null;
      const predictionError = predicted ? positionAfterWait.minus(predicted.position) : null;
      const movementAnalysis = this.getRelativeMovementSummary(positionAfterWait, actualVelocityPerTick);
      const entityYawDegrees = this.getYawDegrees(currentTarget.yaw);
      const trackedHistoryAtPredictionTime = this.formatTrackedInfo(trackedInfoAtPredictionStart);
      const trackedHistoryAfterWait = this.formatTrackedInfo(this.trackingData[targetId]?.info.tickInfo ?? []);

      console.log(
        `[shot-planner:startTick=${startTick}] | confidence=${predicted?.confidence ?? "null"} | tickDuration=${ticks} | ` +
          `positionAtPredictionTime=${this.formatVec3(startPos)} | predictedPosition=${this.formatMaybeVec3(predicted?.position)} | ` +
          `positionAfterWait=${this.formatVec3(positionAfterWait)} | entityYawDegrees=${entityYawDegrees} | ` +
          `actualVelocityPerTick=${this.formatMaybeVec3(actualVelocityPerTick)} | movementAnalysis=${movementAnalysis} | ` +
          `predictionError=${this.formatMaybeVec3(predictionError)} | ` +
          `trackedHistoryAtPredictionTime=${trackedHistoryAtPredictionTime} | trackedHistoryAfterWait=${trackedHistoryAfterWait}`,
      );
    });
  }

  private trackMotionHistory = () => {
    this._tickAge++;

    for (const entityId in this.trackingData) {
      const entry = this.trackingData[entityId];
      if (!entry.tracking) continue;

      const entity = this.bot.entities[entityId];
      if (!entity) continue;

      const info = entry.info;
      const currentSample: TrackingInfo = {
        position: entity.position.clone(),
        velocity: entity.velocity.clone(),
        age: this._tickAge,
        duration: 1,
      };

      const previousSample = info.tickInfo[info.tickInfo.length - 1];
      if (!previousSample) {
        info.initialAge = this._tickAge;
        info.tickInfo.push(currentSample);
        info.avgVel = emptyVec;
        continue;
      }

      const delta = currentSample.position.minus(previousSample.position);
      const ageDelta = currentSample.age - previousSample.age;

      if (delta.equals(emptyVec)) {
        if (ageDelta > 1) {
          currentSample.duration = ageDelta;
          // When standing still, zero out horizontal velocity
          currentSample.velocity = new Vec3(0, currentSample.velocity.y, 0);
          // Clear all history when standing still for >3 ticks
          info.tickInfo = [currentSample];
        } else {
          previousSample.duration += 1;
          previousSample.age = currentSample.age;
          // When standing still, zero out horizontal velocity
        
          // If previous sample has now accumulated >3 ticks of standstill, collapse history
          if (previousSample.duration > 3) {
            previousSample.velocity = new Vec3(0, currentSample.velocity.y, 0);
            info.tickInfo = [previousSample];
          }
        }

        info.initialAge = this._tickAge;
        info.avgVel = emptyVec;
        continue;
      }

      this.recentMovement.set(Number(entityId), {
        previous: previousSample.position.clone(),
        current: currentSample.position.clone(),
      });

      // When resuming movement after a long static period, discard the stale static history
      if (previousSample.duration > 3 && this.getPlanarMagnitude(new Vec3(previousSample.velocity.x, 0, previousSample.velocity.z)) < this.config.minPlanarSpeed * 2) {
        info.tickInfo = [currentSample];
      } else {
        const recentPlanar = this.getCurrentPlanarDelta(info);
        if (!recentPlanar.equals(emptyVec)) {
          const deltaPlanar = new Vec3(delta.x, 0, delta.z);
          if (
            this.getPlanarMagnitude(recentPlanar) > this.config.minPlanarSpeed &&
            this.getPlanarMagnitude(deltaPlanar) > this.config.minPlanarSpeed
          ) {
            const oldYaw = dirToYawAndPitch(recentPlanar).yaw;
            const newYaw = dirToYawAndPitch(deltaPlanar).yaw;
            if (Math.abs(this.getWrappedAngleDiff(oldYaw, newYaw)) >= this.config.directionBreakThreshold) {
              info.tickInfo = [previousSample];
            }
          }
        }

        info.tickInfo.push(currentSample);
      }

      while (info.tickInfo.length > this.config.maxHistory) {
        info.tickInfo.shift();
      }

      const features = this.deriveCurvatureFeatures(info.tickInfo, +entityId);
      info.avgVel = features?.latestVelocity ?? emptyVec;
    }
  };

  private predictWithCurvaturePhysics(entity: Entity, ticksAhead: number, features: CurvatureFeatures): Vec3 | null {
    if (!this.config.usePhysicsRefinement || !this.bot.physicsUtil || features.headingYaw === null) {
      return null;
    }

    try {
      const simCtx = this.bot.physicsUtil.getPhysicsCtx(this.bot.physicsUtil.engine, entity);
      simCtx.state.pos = entity.position.clone();
      simCtx.state.vel = new Vec3(features.planarVelocity.x, features.verticalVelocity, features.planarVelocity.z);
      simCtx.state.yaw = features.headingYaw;
      simCtx.state.control = ControlStateHandler.DEFAULT()
        .set("forward", this.config.assumeForwardInput)
        .set("sprint", this.config.assumeSprintInput)

        // Jump state is a bit tricky since we do not directly observe it.
        // but it has a big impact on vertical motion and thus trajectory.
        // Use a simple heuristic based on whether the entity is currently ascending or descending
        // to set the initial jump state, which lets physics produce a more accurate arc 
        // instead of trying to guess the jump from vertical velocity alone.
        
        // the heuristic is checking if the vertical position is not close to a flat plane (to 3 decimal places)
        // if equal to floored (0 dec.), then we're on a solid block.
        // if equal to anything with < 3 decimal places, then its probably intentional.
        // if we're just moving through midair, typically the position will be something like 10.123456, which floors to 10.123
        .set("jump", simCtx.state.pos.y != Number(simCtx.state.pos.y.toFixed(3))); 


      // The main idea of this tracker is to treat recent path curvature as a
      // short-horizon proxy for continued steering. If the target has been
      // holding forward while turning their head, rotating yaw each simulated
      // tick lets physics produce a curved path from controls directly instead
      // of trying to infer that curve from world-space acceleration alone.
      for (let tick = 0; tick < ticksAhead; tick++) {
        if (tick < this.config.turnContinuationTicks) {
          simCtx.state.yaw += features.turnRate;
        }

        this.bot.physicsUtil.engine.simulate(simCtx, this.bot.world);
      }

      return simCtx.state.pos.clone();
    } catch (error) {
      this.logDebug("predict:curvature-physics-fallback", {
        entityId: entity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  public predictEntityPositionWithConfidence(entity: Entity, ticksAhead: number): CurvaturePrediction | null {
    const entry = this.trackingData[entity.id];
    if (!entry) return null;

    const sanitizedTicks = Math.max(0, Math.floor(ticksAhead));
    const currentPosition = entity.position.clone();
    if (sanitizedTicks === 0) {
      return { position: currentPosition, confidence: 1 };
    }

    // If entity is in a long static period, just predict it stays in place
    if (this.isInLongStaticPeriod(entry.info.tickInfo)) {
      return { position: currentPosition, confidence: 0.95 };
    }

    const features = this.deriveCurvatureFeatures(entry.info.tickInfo, entity.id);
    if (!features) return { position: currentPosition, confidence: 0 };
    const observedSamples = this.buildVelocitySamples(entry.info.tickInfo);
    const { accelerationChanged } = this.getAccelerationAwareWindow(observedSamples, entity.id);
    const windowAge = entry.info.tickInfo.reduce((sum, sample) => sum + Math.max(1, sample.duration), 0);
    const confidence = getMovementWindowConfidence({
      samples: (
        observedSamples.length > 0
          ? observedSamples
          : [
              {
                velocity: new Vec3(features.latestVelocity.x, 0, features.latestVelocity.z),
                planarSpeed: features.planarSpeed,
                dt: 1,
                duration: windowAge,
              },
            ]
      ) as WindowConfidenceSample[],
      ticksAhead: sanitizedTicks,
      featureWindow: this.config.featureWindow,
      windowAge,
      minPlanarSpeed: this.config.minPlanarSpeed,
      minSpeedTrend: this.config.minSpeedTrend,
      accelerationChanged,
    });

    this.logDebug("predict:start", {
      entityId: entity.id,
      ticksAhead: sanitizedTicks,
      currentPosition: currentPosition.toString(),
      planarVelocity: features.planarVelocity.toString(),
      planarSpeed: features.planarSpeed,
      headingYaw: features.headingYaw,
      turnRate: features.turnRate,
      planarAcceleration: features.planarAcceleration.toString(),
      accelerationChanged: features.accelerationChanged,
      verticalVelocity: features.verticalVelocity,
      confidence,
    });

    const predictedFromPhysics = this.predictWithCurvaturePhysics(entity, sanitizedTicks, features);
    if (predictedFromPhysics) {
      this.logDebug("predict:end", {
        entityId: entity.id,
        predictedPosition: predictedFromPhysics.toString(),
        confidence,
      });
      return { position: predictedFromPhysics, confidence };
    }

    // Fallback: continue the local heading and rotate it by recent curvature
    // over a short horizon. This keeps the same path-shape logic even without
    // physics refinement available.
    const predicted = currentPosition.clone();
    let yaw = features.headingYaw ?? 0;

    for (let tick = 0; tick < sanitizedTicks; tick++) {
      if (tick < this.config.turnContinuationTicks) {
        yaw += features.turnRate;
      }

      predicted.x += -Math.sin(yaw) * features.planarSpeed;
      predicted.z += -Math.cos(yaw) * features.planarSpeed;
    }

    return { position: predicted, confidence };
  }

  public predictEntityPosition(entity: Entity, ticksAhead: number): Vec3 | null {
    return this.predictEntityPositionWithConfidence(entity, ticksAhead)?.position ?? null;
  }

  public trackEntity(entity: Entity) {
    if (this.trackingData[entity.id]) this.trackingData[entity.id].tracking = true;
    this.trackingData[entity.id] ??= { tracking: true, info: { avgVel: emptyVec, tickInfo: [], initialAge: 0 } };
  }

  public stopTrackingEntity(entity: Entity, clear: boolean = false) {
    if (!this.trackingData[entity.id]) return;
    this.trackingData[entity.id].tracking = false;
    if (clear) delete this.trackingData[entity.id];
  }

  public getEntitySpeed(entity: Entity): Vec3 | null {
    return this.trackingData[entity.id] ? this.trackingData[entity.id].info.avgVel : null;
  }

  public getEntityPositionInfo(entity: Entity): { position: Vec3; velocity: Vec3 }[] {
    return this.trackingData[entity.id] ? this.trackingData[entity.id].info.tickInfo : [];
  }

  public clearTrackingData() {
    this.trackingData = {};
  }

  public update() {
    this.trackMotionHistory();
  }

  public enable() {
    this.enabled = true;
  }

  public disable() {
    this.enabled = false;
  }
}
