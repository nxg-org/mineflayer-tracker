import { Entity } from "prismarine-entity";
import { Bot } from "mineflayer";
import { EPhysicsCtx, EntityPhysics } from "@nxg-org/mineflayer-physics-util";
import { Vec3 } from "vec3";
import { dirToYawAndPitch } from "./mathUtils";

const emptyVec = new Vec3(0, 0, 0);
const MAX_HISTORY = 10;
const RECENT_VELOCITY_WEIGHTS = [4, 3, 2, 1];
const DIRECTION_BREAK_THRESHOLD = Math.PI / 2;
const TURN_RATE_CLAMP = Math.PI / 8;
const MIN_PLANAR_SPEED = 1e-4;
const PLAYER_GROUNDED_SPEED_CAP = 0.2873;

type TrackingInfo = { position: Vec3; velocity: Vec3; age: number };
type VelocitySample = { velocity: Vec3; dt: number };
type MotionModel = {
  weightedPlanarVelocity: Vec3;
  weightedPlanarSpeed: number;
  planarDirection: Vec3;
  turnRate: number;
  speedTrend: number;
  verticalVelocity: number;
};

export type TrackingData = {
  [entityId: number]: { tracking: boolean; info: { initialAge: number; avgVel: Vec3; tickInfo: TrackingInfo[] } };
};

export class EntityTracker {
  public trackingData: TrackingData = {};

  private _enabled = false;
  private _tickAge = 0;
  private _physicsEngine: EntityPhysics | null = null;

  public get enabled() {
    return this._enabled;
  }

  public set enabled(value: boolean) {
    if (value === this._enabled) return;

    if (value) this.bot.on("physicsTick", this.hawkeyeRewriteTracking);
    else this.bot.off("physicsTick", this.hawkeyeRewriteTracking);

    this._enabled = value;
  }

  constructor(private bot: Bot) {
    this.enabled = true;
  }

  private get physicsEngine() {
    if (!this._physicsEngine) {
      const registry = this.bot.registry as any;
      EPhysicsCtx.loadData(registry);
      this._physicsEngine = new EntityPhysics(registry);
    }

    return this._physicsEngine;
  }

  private hawkeyeRewriteTracking = () => {
    this._tickAge++;

    for (const entityId in this.trackingData) {
      const entry = this.trackingData[entityId];
      if (!entry.tracking) continue;

      const entity = this.bot.entities[entityId];
      if (!entity) continue;

      const info = entry.info;
      const currentPos = entity.position.clone();
      const currentSample: TrackingInfo = {
        position: currentPos,
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

      const delta = currentPos.minus(previousSample.position);
      const ageDelta = this._tickAge - previousSample.age;

      if (delta.equals(emptyVec)) {
        if (ageDelta > 1) {
          info.tickInfo = [currentSample];
          info.initialAge = this._tickAge;
          info.avgVel = emptyVec;
        } else {
          info.initialAge = this._tickAge;
          previousSample.age = this._tickAge;
          previousSample.velocity = entity.velocity.clone();
          info.avgVel = emptyVec;
        }
        continue;
      }

      if (!info.avgVel.equals(emptyVec)) {
        const avgPlanar = new Vec3(info.avgVel.x, 0, info.avgVel.z);
        const deltaPlanar = new Vec3(delta.x, 0, delta.z);

        if (this.getPlanarMagnitude(avgPlanar) > MIN_PLANAR_SPEED && this.getPlanarMagnitude(deltaPlanar) > MIN_PLANAR_SPEED) {
          const oldYaw = dirToYawAndPitch(avgPlanar).yaw;
          const newYaw = dirToYawAndPitch(deltaPlanar).yaw;
          const diff = this.getWrappedAngleDiff(oldYaw, newYaw);

          if (Math.abs(diff) >= DIRECTION_BREAK_THRESHOLD) {
            info.tickInfo = [previousSample];
          }
        }
      }

      info.tickInfo.push(currentSample);
      while (info.tickInfo.length > MAX_HISTORY) {
        info.tickInfo.shift();
      }

      info.avgVel = this.estimateVelocity(info.tickInfo);
    }
  };

  private estimateVelocity(history: TrackingInfo[]): Vec3 {
    const motionModel = this.buildMotionModel(history);
    if (!motionModel) return emptyVec;

    const predictedPlanarVelocity = new Vec3(
      motionModel.planarDirection.x * motionModel.weightedPlanarSpeed,
      0,
      motionModel.planarDirection.z * motionModel.weightedPlanarSpeed
    );

    return new Vec3(predictedPlanarVelocity.x, motionModel.verticalVelocity, predictedPlanarVelocity.z);
  }

  private buildMotionModel(history: TrackingInfo[]): MotionModel | null {
    if (history.length < 2) return null;

    const velocitySamples = this.buildVelocitySamples(history);
    if (velocitySamples.length === 0) return null;

    const recentSamples = velocitySamples.slice(-RECENT_VELOCITY_WEIGHTS.length);
    const weightedPlanarVelocity = this.getWeightedPlanarVelocity(recentSamples);
    const weightedPlanarSpeed = this.getPlanarMagnitude(weightedPlanarVelocity);
    const latestSample = velocitySamples[velocitySamples.length - 1];
    const verticalVelocity = this.estimateVerticalVelocity(history, latestSample);

    if (weightedPlanarSpeed <= MIN_PLANAR_SPEED) {
      return {
        weightedPlanarVelocity,
        weightedPlanarSpeed: 0,
        planarDirection: emptyVec,
        turnRate: 0,
        speedTrend: this.getRecentSpeedTrend(recentSamples),
        verticalVelocity,
      };
    }

    const latestVelocity = recentSamples[recentSamples.length - 1].velocity;
    const latestPlanarDirection = this.normalizePlanar(latestVelocity);
    const baseDirection =
      this.getPlanarMagnitude(latestPlanarDirection) > MIN_PLANAR_SPEED
        ? latestPlanarDirection
        : this.normalizePlanar(weightedPlanarVelocity);

    const turnRate = this.getRecentTurnRate(recentSamples);
    const rotatedDirection =
      this.getPlanarMagnitude(baseDirection) > MIN_PLANAR_SPEED
        ? this.rotatePlanar(baseDirection, turnRate)
        : baseDirection;

    const speedTrend = this.getRecentSpeedTrend(recentSamples);
    const predictedSpeed = this.clampPredictedSpeed(weightedPlanarSpeed, speedTrend);

    return {
      weightedPlanarVelocity,
      weightedPlanarSpeed: predictedSpeed,
      planarDirection: rotatedDirection,
      turnRate,
      speedTrend,
      verticalVelocity,
    };
  }

  private buildVelocitySamples(history: TrackingInfo[]): VelocitySample[] {
    const samples: VelocitySample[] = [];

    for (let i = 1; i < history.length; i++) {
      const current = history[i];
      const previous = history[i - 1];
      const dt = current.age - previous.age;
      if (dt <= 0) continue;

      const delta = current.position.minus(previous.position);
      samples.push({
        velocity: new Vec3(delta.x / dt, delta.y / dt, delta.z / dt),
        dt,
      });
    }

    return samples;
  }

  private getWeightedPlanarVelocity(samples: VelocitySample[]): Vec3 {
    let totalWeight = 0;
    const velocity = new Vec3(0, 0, 0);

    for (let i = 0; i < samples.length; i++) {
      const weight = RECENT_VELOCITY_WEIGHTS[i] ?? 1;
      totalWeight += weight;
      velocity.x += samples[samples.length - 1 - i].velocity.x * weight;
      velocity.z += samples[samples.length - 1 - i].velocity.z * weight;
    }

    if (totalWeight === 0) return emptyVec;

    velocity.x /= totalWeight;
    velocity.z /= totalWeight;
    return velocity;
  }

  private getRecentTurnRate(samples: VelocitySample[]): number {
    if (samples.length < 2) return 0;

    let weightedTurn = 0;
    let totalWeight = 0;

    for (let i = 1; i < samples.length; i++) {
      const previous = samples[i - 1].velocity;
      const current = samples[i].velocity;

      if (this.getPlanarMagnitude(previous) <= MIN_PLANAR_SPEED || this.getPlanarMagnitude(current) <= MIN_PLANAR_SPEED) {
        continue;
      }

      const previousYaw = dirToYawAndPitch(new Vec3(previous.x, 0, previous.z)).yaw;
      const currentYaw = dirToYawAndPitch(new Vec3(current.x, 0, current.z)).yaw;
      const weight = i;

      weightedTurn += this.getWrappedAngleDiff(previousYaw, currentYaw) * weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) return 0;

    const averageTurn = weightedTurn / totalWeight;
    return Math.max(-TURN_RATE_CLAMP, Math.min(TURN_RATE_CLAMP, averageTurn));
  }

  private getRecentSpeedTrend(samples: VelocitySample[]): number {
    if (samples.length < 2) return 0;

    let weightedTrend = 0;
    let totalWeight = 0;

    for (let i = 1; i < samples.length; i++) {
      const previousSpeed = this.getPlanarMagnitude(samples[i - 1].velocity);
      const currentSpeed = this.getPlanarMagnitude(samples[i].velocity);
      const weight = i;

      weightedTrend += (currentSpeed - previousSpeed) * weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) return 0;
    return weightedTrend / totalWeight;
  }

  private clampPredictedSpeed(weightedSpeed: number, speedTrend: number): number {
    if (speedTrend < 0) {
      return Math.max(0, weightedSpeed + speedTrend);
    }

    return weightedSpeed + Math.min(speedTrend, weightedSpeed * 0.35);
  }

  private estimateVerticalVelocity(history: TrackingInfo[], latestSample: VelocitySample): number {
    const latestInfo = history[history.length - 1];
    if (!latestInfo) return 0;

    if (Math.floor(latestInfo.position.y) === latestInfo.position.y) {
      return 0;
    }

    const verticalSamples = this.buildVelocitySamples(history).slice(-3);
    if (verticalSamples.length === 0) {
      return latestSample.velocity.y;
    }

    let totalWeight = 0;
    let weightedY = 0;

    for (let i = 0; i < verticalSamples.length; i++) {
      const weight = RECENT_VELOCITY_WEIGHTS[i] ?? 1;
      weightedY += verticalSamples[verticalSamples.length - 1 - i].velocity.y * weight;
      totalWeight += weight;
    }

    return totalWeight === 0 ? latestSample.velocity.y : weightedY / totalWeight;
  }

  private normalizePlanar(vec: Vec3): Vec3 {
    const magnitude = this.getPlanarMagnitude(vec);
    if (magnitude <= MIN_PLANAR_SPEED) return emptyVec;
    return new Vec3(vec.x / magnitude, 0, vec.z / magnitude);
  }

  private rotatePlanar(direction: Vec3, angle: number): Vec3 {
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);

    return new Vec3(
      direction.x * cos - direction.z * sin,
      0,
      direction.x * sin + direction.z * cos
    );
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

  private getGroundingInfo(entity: Entity, initialVelocity: Vec3, ticksAhead: number) {
    if (ticksAhead <= 0) {
      return { startsGrounded: entity.onGround, landingTick: entity.onGround ? 0 : null };
    }

    try {
      const ctx = EPhysicsCtx.FROM_ENTITY(this.physicsEngine, entity);
      ctx.state.vel = initialVelocity.clone();
      ctx.state.onGround = entity.onGround;
      ctx.position.x = entity.position.x;
      ctx.position.y = entity.position.y;
      ctx.position.z = entity.position.z;

      if (ctx.state.onGround) {
        return { startsGrounded: true, landingTick: 0 };
      }

      for (let tick = 0; tick < ticksAhead; tick++) {
        this.physicsEngine.simulate(ctx, this.bot.world);
        if (ctx.state.onGround) {
          return { startsGrounded: false, landingTick: tick + 1 };
        }
      }
    } catch {
      return { startsGrounded: entity.onGround, landingTick: entity.onGround ? 0 : null };
    }

    return { startsGrounded: false, landingTick: null };
  }

  private getGroundedSpeedCap(entity: Entity): number | null {
    if (entity.name !== "player") return null;
    return PLAYER_GROUNDED_SPEED_CAP;
  }

  public predictEntityPosition(entity: Entity, ticksAhead: number): Vec3 | null {
    const entry = this.trackingData[entity.id];
    if (!entry) return null;

    const sanitizedTicks = Math.max(0, Math.floor(ticksAhead));
    const currentPosition = entity.position.clone();
    if (sanitizedTicks === 0) return currentPosition;

    const motionModel = this.buildMotionModel(entry.info.tickInfo);
    if (!motionModel) return currentPosition;

    const predictedPosition = currentPosition.clone();
    let direction = motionModel.planarDirection.clone();
    let planarSpeed = motionModel.weightedPlanarSpeed;
    let verticalVelocity = motionModel.verticalVelocity;
    const initialVelocity = new Vec3(
      motionModel.planarDirection.x * motionModel.weightedPlanarSpeed,
      motionModel.verticalVelocity,
      motionModel.planarDirection.z * motionModel.weightedPlanarSpeed
    );
    const groundingInfo = this.getGroundingInfo(entity, initialVelocity, sanitizedTicks);
    const groundedSpeedCap = this.getGroundedSpeedCap(entity);

    for (let tick = 0; tick < sanitizedTicks; tick++) {
      const turnInfluence = Math.max(0, 1 - tick * 0.35);
      const brakingInfluence = Math.max(0, 1 - tick * 0.3);
      const verticalInfluence = Math.max(0, 1 - tick * 0.5);
      const grounded =
        groundingInfo.startsGrounded ||
        (groundingInfo.landingTick !== null && tick + 1 >= groundingInfo.landingTick);

      if (this.getPlanarMagnitude(direction) > MIN_PLANAR_SPEED && turnInfluence > 0) {
        direction = this.rotatePlanar(direction, motionModel.turnRate * turnInfluence);
      }

      const perTickTrend = motionModel.speedTrend * brakingInfluence;
      planarSpeed = this.clampPredictedSpeed(planarSpeed, perTickTrend);

      if (grounded) {
        verticalVelocity = 0;
        if (groundedSpeedCap !== null) {
          planarSpeed = Math.min(planarSpeed, groundedSpeedCap);
        }
      }

      predictedPosition.x += direction.x * planarSpeed;
      predictedPosition.z += direction.z * planarSpeed;
      predictedPosition.y += verticalVelocity;

      if (!grounded) {
        verticalVelocity *= verticalInfluence;
        if (Math.abs(verticalVelocity) < MIN_PLANAR_SPEED) {
          verticalVelocity = 0;
        }
      }
    }

    return predictedPosition;
  }

  public trackEntity(entity: Entity) {
    if (this.trackingData[entity.id]) this.trackingData[entity.id].tracking = true;
    this.trackingData[entity.id] ??= { tracking: true, info: { avgVel: emptyVec, tickInfo: [], initialAge: 0 } };
  }

  public stopTrackingEntity(entity: Entity, clear: boolean = false) {
    if (!this.trackingData[entity.id]) return;
    this.trackingData[entity.id].tracking = false;
    if (clear) {
      delete this.trackingData[entity.id];
    }
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
    this.hawkeyeRewriteTracking();
  }

  public enable() {
    this.enabled = true;
  }

  public disable() {
    this.enabled = false;
  }
}
