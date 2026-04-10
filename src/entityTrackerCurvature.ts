import physicsUtilPlugin, { ControlStateHandler } from "@nxg-org/mineflayer-physics-util";
import { Bot } from "mineflayer";
import { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { dirToYawAndPitch } from "./mathUtils";

const emptyVec = new Vec3(0, 0, 0);
const DEFAULT_CONFIG = {
  maxHistory: 10,
  featureWindow: 5,
  directionBreakThreshold: Math.PI / 2,
  minPlanarSpeed: 1e-4,
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

  private logDebug(event: string, details: Record<string, unknown>) {
    if (!this.debugLogging) return;
    console.log(`[EntityTrackerCurvature:${event}]`, details);
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

    return Math.max(-this.config.maxTurnRate, Math.min(this.config.maxTurnRate, turnRate));
  }

  private deriveCurvatureFeatures(history: TrackingInfo[]): CurvatureFeatures | null {
    const samples = this.buildVelocitySamples(history);
    if (samples.length === 0) return null;

    const recent = samples.slice(-this.config.featureWindow);
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
    const verticalVelocity = this.estimateVerticalVelocity(history);

    let planarVelocity = new Vec3(latestVelocity.x, 0, latestVelocity.z);
    if (headingYaw !== null && planarSpeed > this.config.minPlanarSpeed) {
      planarVelocity = new Vec3(-Math.sin(headingYaw) * planarSpeed, 0, -Math.cos(headingYaw) * planarSpeed);
    }

    return {
      latestVelocity: new Vec3(latestVelocity.x, verticalVelocity, latestVelocity.z),
      planarVelocity,
      planarSpeed,
      headingYaw,
      turnRate,
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
        if (ageDelta > 1) {
          info.tickInfo = [currentSample];
        } else {
          previousSample.age = currentSample.age;
          previousSample.velocity = currentSample.velocity;
        }

        info.initialAge = this._tickAge;
        info.avgVel = emptyVec;
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
        .set("forward", this.config.assumeForwardInput)
        .set("sprint", this.config.assumeSprintInput);

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

    this.logDebug("predict:start", {
      entityId: entity.id,
      ticksAhead: sanitizedTicks,
      currentPosition: currentPosition.toString(),
      planarVelocity: features.planarVelocity.toString(),
      planarSpeed: features.planarSpeed,
      headingYaw: features.headingYaw,
      turnRate: features.turnRate,
      verticalVelocity: features.verticalVelocity,
    });

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

    for (let tick = 0; tick < sanitizedTicks; tick++) {
      if (tick < this.config.turnContinuationTicks) {
        yaw += features.turnRate;
      }

      predicted.x += -Math.sin(yaw) * features.planarSpeed;
      predicted.z += -Math.cos(yaw) * features.planarSpeed;
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
