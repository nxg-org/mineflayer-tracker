import physicsUtilPlugin, { ControlStateHandler } from "@nxg-org/mineflayer-physics-util";
import { Bot } from "mineflayer";
import { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { dirToYawAndPitch } from "./mathUtils";

const emptyVec = new Vec3(0, 0, 0);
const DEFAULT_CONFIG = {
  maxHistory: 40,
  featureWindow: 20,
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

type TrackingInfo = { position: Vec3; velocity: Vec3; age: number };
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
  speedTrend: number;
  planarAcceleration: Vec3;
  accelerationChanged: boolean;
  forwardIntent: boolean;
  verticalVelocity: number;
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
    console.log(`[EntityTrackerCurvature:${event}:startTick:${(this.bot as any).currentTick}]`, details);
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
      const dt = current.age - previous.age;
      if (dt <= 0) continue;

      const delta = current.position.minus(previous.position);
      const velocity = new Vec3(delta.x / dt, delta.y / dt, delta.z / dt);
      const planarSpeed = this.getPlanarMagnitude(velocity);
      const yaw =
        planarSpeed > this.config.minPlanarSpeed ? dirToYawAndPitch(new Vec3(velocity.x, 0, velocity.z)).yaw : null;

      samples.push({ velocity, planarSpeed, yaw, dt });
    }

    return samples;
  }

  private estimateVerticalVelocity(history: TrackingInfo[]): number {
    const latest = history[history.length - 1];
    const previous = history[history.length - 2];
    if (!latest || !previous) return -0.078;

    const dt = latest.age - previous.age;
    const deltaY = dt > 0 ? (latest.position.y - previous.position.y) / dt : 0;
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
      const dt = curr.dt > 0 ? curr.dt : 1;

      const accelX = (curr.velocity.x - prev.velocity.x) / dt;
      const accelZ = (curr.velocity.z - prev.velocity.z) / dt;

      totalAccelX += accelX;
      totalAccelZ += accelZ;
      count++;
    }

    if (count === 0) return null;
    return new Vec3(totalAccelX / count, 0, totalAccelZ / count);
  }

  private getPlanarSpeedTrend(samples: VelocitySample[]): number {
    if (samples.length < 2) return 0;

    let totalTrend = 0;
    let count = 0;

    for (let i = 1; i < samples.length; i++) {
      totalTrend += samples[i].planarSpeed - samples[i - 1].planarSpeed;
      count++;
    }

    if (count === 0) return 0;

    const trend = totalTrend / count;
    return Math.abs(trend) < this.config.minSpeedTrend ? 0 : trend;
  }

  private getAccelerationAwareWindow(samples: VelocitySample[]): { samples: VelocitySample[]; accelerationChanged: boolean } {
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

  private getPredictionBranch(features: CurvatureFeatures): string {
    if (!features.forwardIntent) {
      return features.planarSpeed <= this.config.minPlanarSpeed ? "stopped" : "braking";
    }

    if (features.accelerationChanged) {
      return "accel_adjusted";
    }

    if (Math.abs(features.turnRate) >= this.config.minTurnRate) {
      return "turn_continuation";
    }

    return "steady_heading";
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

  private deriveCurvatureFeatures(history: TrackingInfo[]): CurvatureFeatures | null {
    const samples = this.buildVelocitySamples(history);
    if (samples.length === 0) return null;

    const { samples: recent, accelerationChanged } = this.getAccelerationAwareWindow(samples);
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
    const turnRate = this.getSignedTurnRate(recent);
    const speedTrend = this.getPlanarSpeedTrend(recent);
    const planarAcceleration = this.getPlanarAcceleration(recent) ?? emptyVec;
    const verticalVelocity = this.estimateVerticalVelocity(history);

    let planarVelocity = new Vec3(latestVelocity.x, 0, latestVelocity.z);
    const accelerationMagnitude = this.getPlanarMagnitude(planarAcceleration);
    const accelerationOpposesMotion =
      accelerationMagnitude > this.config.minSpeedTrend &&
      this.getPlanarMagnitude(planarVelocity) > this.config.minPlanarSpeed &&
      planarVelocity.x * planarAcceleration.x + planarVelocity.z * planarAcceleration.z < 0;

    const forwardTrendThreshold = this.config.minSpeedTrend * 2;
    const forwardIntent = speedTrend > forwardTrendThreshold && !(accelerationChanged && accelerationOpposesMotion);

    if (accelerationChanged && accelerationOpposesMotion) {
      planarVelocity = new Vec3(
        latestVelocity.x + planarAcceleration.x,
        0,
        latestVelocity.z + planarAcceleration.z
      );
    } else if (forwardIntent && headingYaw !== null && planarSpeed > this.config.minPlanarSpeed) {
      planarVelocity = new Vec3(-Math.sin(headingYaw) * planarSpeed, 0, -Math.cos(headingYaw) * planarSpeed);
    }

    return {
      latestVelocity: new Vec3(latestVelocity.x, verticalVelocity, latestVelocity.z),
      planarVelocity,
      planarSpeed,
      headingYaw,
      turnRate,
      speedTrend,
      planarAcceleration,
      accelerationChanged,
      forwardIntent,
      verticalVelocity,
    };
  }

  private getCurrentPlanarDelta(info: { tickInfo: TrackingInfo[] }): Vec3 {
    if (info.tickInfo.length < 2) return emptyVec;

    const previous = info.tickInfo[info.tickInfo.length - 2];
    const latest = info.tickInfo[info.tickInfo.length - 1];
    const dt = latest.age - previous.age;
    if (dt <= 0) return emptyVec;

    const delta = latest.position.minus(previous.position);
    return new Vec3(delta.x / dt, 0, delta.z / dt);
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
        const stoppedSample: TrackingInfo = {
          position: currentSample.position.clone(),
          velocity: emptyVec.clone(),
          age: currentSample.age,
        };

        if (ageDelta > 1) {
          info.tickInfo = [stoppedSample];
        } else {
          info.tickInfo.push(stoppedSample);
        }

        info.initialAge = this._tickAge;
        info.avgVel = emptyVec;
        while (info.tickInfo.length > this.config.maxHistory) {
          info.tickInfo.shift();
        }
        continue;
      }

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
      while (info.tickInfo.length > this.config.maxHistory) {
        info.tickInfo.shift();
      }

      const features = this.deriveCurvatureFeatures(info.tickInfo);
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
        .set("forward", this.config.assumeForwardInput && features.forwardIntent)
        .set("sprint", this.config.assumeSprintInput && features.forwardIntent);

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

  public predictEntityPosition(entity: Entity, ticksAhead: number): Vec3 | null {
    const entry = this.trackingData[entity.id];
    if (!entry) return null;

    const sanitizedTicks = Math.max(0, Math.floor(ticksAhead));
    const currentPosition = entity.position.clone();
    if (sanitizedTicks === 0) return currentPosition;

    const features = this.deriveCurvatureFeatures(entry.info.tickInfo);
    if (!features) return currentPosition;

    const branch = this.getPredictionBranch(features);
    this.logDebug("predict:start", {
      entityId: entity.id,
      ticksAhead: sanitizedTicks,
      currentPosition: currentPosition.toString(),
      branch,
      planarVelocity: features.planarVelocity.toString(),
      planarSpeed: features.planarSpeed,
      headingYaw: features.headingYaw,
      turnRate: features.turnRate,
      speedTrend: features.speedTrend,
      planarAcceleration: features.planarAcceleration.toString(),
      accelerationChanged: features.accelerationChanged,
      forwardIntent: features.forwardIntent,
      verticalVelocity: features.verticalVelocity,
    }, true);

    const predictedFromPhysics = this.predictWithCurvaturePhysics(entity, sanitizedTicks, features);
    if (predictedFromPhysics) {
      this.logDebug("predict:end", {
        entityId: entity.id,
        predictedPosition: predictedFromPhysics.toString(),
      });
      return predictedFromPhysics;
    }

    // Fallback: continue the local heading and rotate it by recent curvature
    // over a short horizon. This keeps the same path-shape logic even without
    // physics refinement available.
    const predicted = currentPosition.clone();
    let yaw = features.headingYaw ?? 0;
    let planarSpeed = features.planarSpeed;

    for (let tick = 0; tick < sanitizedTicks; tick++) {
      if (features.forwardIntent && tick < this.config.turnContinuationTicks) {
        yaw += features.turnRate;
      }

      const speedDelta = features.forwardIntent ? features.speedTrend : Math.min(0, features.speedTrend);
      planarSpeed = Math.max(0, planarSpeed + speedDelta);
      predicted.x += -Math.sin(yaw) * planarSpeed;
      predicted.z += -Math.cos(yaw) * planarSpeed;
    }

    return predicted;
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
