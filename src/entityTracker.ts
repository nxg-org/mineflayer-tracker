import physicsUtilPlugin, { ControlStateHandler } from "@nxg-org/mineflayer-physics-util";
import { Bot } from "mineflayer";
import { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { dirToYawAndPitch } from "./mathUtils";

const emptyVec = new Vec3(0, 0, 0);
const DEFAULT_CONFIG = {
  maxHistory: 10,
  featureWindow: 4,
  directionBreakThreshold: Math.PI / 2,
  minPlanarSpeed: 1e-4,
  minSpeedTrend: 0.01,
  minTurnRate: Math.PI / 180,
  maxShortHorizonTurn: Math.PI / 8,
  shortHorizonTicks: 2,
  turnContinuationTicks: 1,
  usePhysicsRefinement: true,
};

type TrackingInfo = { position: Vec3; velocity: Vec3; age: number };
type VelocitySample = {
  velocity: Vec3;
  planarSpeed: number;
  yaw: number | null;
  dt: number;
};
type MotionFeatures = {
  stableVelocity: Vec3;
  baseVelocity: Vec3;
  basePlanarSpeed: number;
  baseDirection: Vec3;
  headingYaw: number | null;
  steeringYaw: number | null;
  planarVelocity: Vec3;
  planarAcceleration: Vec3;
  latestVelocity: Vec3;
  latestPlanarSpeed: number;
  turnRate: number;
  speedTrend: number;
  verticalVelocity: number;
  coherence: number;
};

export type EntityTrackerConfig = Partial<typeof DEFAULT_CONFIG>;

export type TrackingData = {
  [entityId: number]: { tracking: boolean; info: { initialAge: number; avgVel: Vec3; tickInfo: TrackingInfo[] } };
};

export class EntityTracker {
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

    if (value) this.bot.on("physicsTick", this.hawkeyeRewriteTracking);
    else this.bot.off("physicsTick", this.hawkeyeRewriteTracking);

    this._enabled = value;
  }

  constructor(private bot: Bot, config: EntityTrackerConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (!this.bot.physicsUtil) {
      // Linked local packages can end up with duplicate mineflayer type
      // identities, so we intentionally treat the physics plugin as a runtime
      // plugin here instead of requiring TypeScript to prove the Bot types are
      // identical across package boundaries.
      this.bot.loadPlugin(physicsUtilPlugin as any);
    }

    this.enabled = true;
  }

  private getRecentPlanarDelta(info: { tickInfo: TrackingInfo[] }): Vec3 {
    if (info.tickInfo.length < 2) return emptyVec;

    const previous = info.tickInfo[info.tickInfo.length - 2];
    const latest = info.tickInfo[info.tickInfo.length - 1];
    const dt = latest.age - previous.age;
    if (dt <= 0) return emptyVec;

    const delta = latest.position.minus(previous.position);
    return new Vec3(delta.x / dt, 0, delta.z / dt);
  }

  private hawkeyeRewriteTracking = () => {
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

      const recentPlanar = this.getRecentPlanarDelta(info);
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

      const features = this.deriveMotionFeatures(info.tickInfo);
      info.avgVel = features?.baseVelocity ?? emptyVec;
    }
  };

  private deriveMotionFeatures(history: TrackingInfo[]): MotionFeatures | null {
    const velocitySamples = this.buildVelocitySamples(history);
    if (velocitySamples.length === 0) return null;

    const recent = velocitySamples.slice(-this.config.featureWindow);
    const stableVelocity = this.getWeightedVelocity(recent);
    const latestVelocity = recent[recent.length - 1].velocity.clone();
    const latestPlanarSpeed = recent[recent.length - 1].planarSpeed;
    const rawTurnRate = this.getRecentTurnRate(recent);
    const rawSpeedTrend = this.getRecentSpeedTrend(recent);
    const verticalVelocity = this.estimateVerticalVelocity(history);
    const coherence = this.getMotionCoherence(recent, stableVelocity, rawTurnRate, rawSpeedTrend);
    const baseVelocity = this.getBaseVelocity(latestVelocity, stableVelocity, coherence, rawTurnRate, rawSpeedTrend);
    const planarVelocity = new Vec3(baseVelocity.x, 0, baseVelocity.z);
    const planarAcceleration = this.getPlanarAcceleration(recent, planarVelocity, rawTurnRate);
    const basePlanarSpeed = this.getPlanarMagnitude(baseVelocity);
    const baseDirection = this.normalizePlanar(baseVelocity);
    const headingYaw =
      basePlanarSpeed > this.config.minPlanarSpeed ? dirToYawAndPitch(new Vec3(baseVelocity.x, 0, baseVelocity.z)).yaw : null;
    const steeringYaw = this.getSteeringYaw(planarVelocity, planarAcceleration, headingYaw, rawTurnRate);

    return {
      stableVelocity: new Vec3(stableVelocity.x, verticalVelocity, stableVelocity.z),
      baseVelocity: new Vec3(baseVelocity.x, verticalVelocity, baseVelocity.z),
      basePlanarSpeed,
      baseDirection,
      headingYaw,
      steeringYaw,
      planarVelocity,
      planarAcceleration,
      latestVelocity,
      latestPlanarSpeed,
      turnRate: coherence < 0.35 ? 0 : rawTurnRate,
      speedTrend: coherence < 0.35 ? 0 : rawSpeedTrend,
      verticalVelocity,
      coherence,
    };
  }

  private getBaseVelocity(
    latestVelocity: Vec3,
    stableVelocity: Vec3,
    coherence: number,
    turnRate: number,
    speedTrend: number
  ): Vec3 {
    // The old tracker always averaged over history, which made it lag behind
    // turning and braking. The new rule is simpler: use the local mean only
    // when the recent window is genuinely steady, otherwise trust the newest
    // observed direction/speed and only project trends for a short horizon.
    const isTurning = Math.abs(turnRate) >= this.config.minTurnRate;
    const isChangingSpeed = Math.abs(speedTrend) >= this.config.minSpeedTrend;

    if (coherence >= 0.75 && !isTurning && !isChangingSpeed) {
      return stableVelocity.clone();
    }

    return latestVelocity.clone();
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

  private getWeightedVelocity(samples: VelocitySample[]): Vec3 {
    const velocity = new Vec3(0, 0, 0);
    if (samples.length === 0) return emptyVec;

    // This keeps smoothing local and explainable without hand-tuned weights.
    for (const sample of samples) {
      velocity.x += sample.velocity.x;
      velocity.y += sample.velocity.y;
      velocity.z += sample.velocity.z;
    }

    velocity.x /= samples.length;
    velocity.y /= samples.length;
    velocity.z /= samples.length;
    return velocity;
  }

  private getRecentTurnRate(samples: VelocitySample[]): number {
    if (samples.length < 2) return 0;

    const turnDiffs: number[] = [];
    let totalTurn = 0;
    let lastSign = 0;

    for (let i = 1; i < samples.length; i++) {
      const prevYaw = samples[i - 1].yaw;
      const currentYaw = samples[i].yaw;
      if (prevYaw === null || currentYaw === null) continue;

      const diff = this.getWrappedAngleDiff(prevYaw, currentYaw);
      if (Math.abs(diff) < this.config.minTurnRate) continue;

      const sign = Math.sign(diff);
      if (lastSign !== 0 && sign !== lastSign) {
        // Tiny heading noise should not be treated as real curvature. We only
        // continue a turn when the recent window agrees on a single turn
        // direction; otherwise straight-line motion is the safer default.
        return 0;
      }

      lastSign = sign;
      turnDiffs.push(diff);
      totalTurn += diff;
    }

    if (turnDiffs.length < 2) return 0;

    const averageTurn = totalTurn / turnDiffs.length;
    if (Math.abs(averageTurn) < this.config.minTurnRate * 2) return 0;

    return Math.max(-this.config.maxShortHorizonTurn, Math.min(this.config.maxShortHorizonTurn, averageTurn));
  }

  private getRecentSpeedTrend(samples: VelocitySample[]): number {
    if (samples.length < 2) return 0;

    let totalTrend = 0;
    let count = 0;

    for (let i = 1; i < samples.length; i++) {
      const diff = samples[i].planarSpeed - samples[i - 1].planarSpeed;
      totalTrend += diff;
      count++;
    }

    if (count === 0) return 0;

    const trend = totalTrend / count;
    return Math.abs(trend) < this.config.minSpeedTrend ? 0 : trend;
  }

  private getPlanarAcceleration(samples: VelocitySample[], basePlanarVelocity: Vec3, turnRate: number): Vec3 {
    if (samples.length < 2) return emptyVec;

    let totalX = 0;
    let totalZ = 0;
    let count = 0;

    for (let i = 1; i < samples.length; i++) {
      totalX += samples[i].velocity.x - samples[i - 1].velocity.x;
      totalZ += samples[i].velocity.z - samples[i - 1].velocity.z;
      count++;
    }

    if (count === 0) return emptyVec;

    const acceleration = new Vec3(totalX / count, 0, totalZ / count);
    const accelerationMagnitude = this.getPlanarMagnitude(acceleration);

    // Ignore tiny vector noise. For kinematic projection we want the recent
    // acceleration trend, not lateral jitter amplified over future ticks.
    if (accelerationMagnitude < this.config.minSpeedTrend) {
      return emptyVec;
    }

    // When motion is nearly straight, prefer acceleration along the current
    // travel axis. This preserves braking/reversal and avoids inventing curves
    // from tiny sideways deltas.
    //
    // During jump-turns or other fast heading changes, that projection becomes
    // too conservative because it throws away the very lateral component that
    // is causing the heading to rotate. In those cases we keep the full recent
    // acceleration vector so the predictor can pivot into the new direction
    // instead of continuing to lag along the old one.
    if (Math.abs(turnRate) >= this.config.minTurnRate) {
      return acceleration;
    }

    if (this.getPlanarMagnitude(basePlanarVelocity) > this.config.minPlanarSpeed) {
      const direction = this.normalizePlanar(basePlanarVelocity);
      const accelerationAlongDirection = direction.x * acceleration.x + direction.z * acceleration.z;
      return new Vec3(direction.x * accelerationAlongDirection, 0, direction.z * accelerationAlongDirection);
    }

    return acceleration;
  }

  private estimateVerticalVelocity(history: TrackingInfo[]): number {
    const latest = history[history.length - 1];
    const previous = history[history.length - 2];
    if (!latest || !previous) {
      return -0.078;
    }

    const dt = latest.age - previous.age;
    const latestSampleVerticalVelocity = dt > 0 ? (latest.position.y - previous.position.y) / dt : 0;

    // Keep the vertical seed intentionally simple and explicit: derive it from
    // the last tracked positional delta Y rather than trusting server-reported
    // entity velocity. When that observed delta is flat, bias it slightly
    // downward so the split physics Y simulation continues gravity instead of
    // hovering at the current height.
    if (Math.abs(latestSampleVerticalVelocity) <= 1e-9) {
      return -0.078;
    }

    return latestSampleVerticalVelocity;
  }

  private getMotionCoherence(samples: VelocitySample[], weightedVelocity: Vec3, turnRate: number, speedTrend: number): number {
    if (samples.length < 2) return 0.5;

    const weightedPlanarSpeed = this.getPlanarMagnitude(weightedVelocity);
    if (weightedPlanarSpeed <= this.config.minPlanarSpeed) return 1;

    let speedDeviation = 0;
    let turnDeviation = 0;
    let stopStartCount = 0;

    for (let i = 0; i < samples.length; i++) {
      speedDeviation += Math.abs(samples[i].planarSpeed - weightedPlanarSpeed);

      const previousYaw = i > 0 ? samples[i - 1].yaw : null;
      const currentYaw = samples[i].yaw;
      if (previousYaw !== null && currentYaw !== null) {
        turnDeviation += Math.abs(this.getWrappedAngleDiff(previousYaw, currentYaw));
      }

      if (
        (samples[i].planarSpeed <= this.config.minPlanarSpeed) !==
        (samples[Math.max(0, i - 1)].planarSpeed <= this.config.minPlanarSpeed)
      ) {
        stopStartCount++;
      }
    }

    speedDeviation /= samples.length;
    turnDeviation /= Math.max(1, samples.length - 1);

    const speedScore = 1 - Math.min(1, speedDeviation / Math.max(0.08, weightedPlanarSpeed * 0.75));
    const turnScore = 1 - Math.min(1, turnDeviation / (Math.PI / 6));
    const trendScore = speedTrend === 0 ? 1 : 1 - Math.min(1, Math.abs(speedTrend) / Math.max(0.08, weightedPlanarSpeed));
    const turnRateScore = turnRate === 0 ? 1 : 1 - Math.min(1, Math.abs(turnRate) / (Math.PI / 4));
    const stopStartPenalty = Math.min(1, stopStartCount * 0.4);

    const coherence = speedScore * 0.35 + turnScore * 0.3 + trendScore * 0.2 + turnRateScore * 0.15 - stopStartPenalty;
    return Math.max(0, Math.min(1, coherence));
  }

  private getSteeringYaw(
    planarVelocity: Vec3,
    planarAcceleration: Vec3,
    headingYaw: number | null,
    turnRate: number
  ): number | null {
    const planarSpeed = this.getPlanarMagnitude(planarVelocity);
    const accelerationMagnitude = this.getPlanarMagnitude(planarAcceleration);
    const accelerationYaw =
      accelerationMagnitude > this.config.minSpeedTrend ? dirToYawAndPitch(new Vec3(planarAcceleration.x, 0, planarAcceleration.z)).yaw : null;

    if (headingYaw === null) {
      return accelerationYaw;
    }

    if (accelerationYaw !== null && planarSpeed > this.config.minPlanarSpeed) {
      const velocityDirection = this.normalizePlanar(planarVelocity);
      const accelerationDirection = this.normalizePlanar(planarAcceleration);
      const alignment = velocityDirection.x * accelerationDirection.x + velocityDirection.z * accelerationDirection.z;

      // When the observed path is braking or reversing against the current
      // travel vector, the physics check should face where the path is being
      // steered, not where inertia is still carrying the entity.
      if (alignment <= -0.25) {
        return accelerationYaw;
      }
    }

    if (Math.abs(turnRate) >= this.config.minTurnRate) {
      return headingYaw + turnRate;
    }

    return accelerationYaw ?? headingYaw;
  }

  private logDebug(event: string, details: Record<string, unknown>) {
    if (!this.debugLogging) return;
    console.log(`[EntityTracker:${event}]`, details);
  }

  private normalizePlanar(vec: Vec3): Vec3 {
    const magnitude = this.getPlanarMagnitude(vec);
    if (magnitude <= this.config.minPlanarSpeed) return emptyVec;
    return new Vec3(vec.x / magnitude, 0, vec.z / magnitude);
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

  private projectPlanarVelocity(planarVelocity: Vec3, planarAcceleration: Vec3, coherence: number): Vec3 {
    // Kinematic mode intentionally allows the planar velocity vector to cross
    // through zero and reverse if the recent acceleration trend supports it.
    // That is the behavior the conservative model explicitly prevented.
    return new Vec3(
      planarVelocity.x + planarAcceleration.x * coherence,
      0,
      planarVelocity.z + planarAcceleration.z * coherence
    );
  }

  private getClosestPlanarVelocityOnSegment(proposed: Vec3, start: Vec3, end: Vec3): Vec3 {
    const segmentX = end.x - start.x;
    const segmentZ = end.z - start.z;
    const segmentLengthSquared = segmentX * segmentX + segmentZ * segmentZ;

    if (segmentLengthSquared <= 1e-9) {
      return start.clone();
    }

    const toProposedX = proposed.x - start.x;
    const toProposedZ = proposed.z - start.z;
    const projection = (toProposedX * segmentX + toProposedZ * segmentZ) / segmentLengthSquared;
    const t = Math.max(0, Math.min(1, projection));

    return new Vec3(
      start.x + segmentX * t,
      0,
      start.z + segmentZ * t
    );
  }

  private simulatePlanarProbe(
    entity: Entity,
    startPosition: Vec3,
    planarVelocity: Vec3,
    verticalVelocity: number,
    control: ControlStateHandler,
    yaw: number
  ): Vec3 | null {
    if (!this.config.usePhysicsRefinement || !this.bot.physicsUtil) {
      return null;
    }

    try {
      const simCtx = this.bot.physicsUtil.getPhysicsCtx(this.bot.physicsUtil.engine, entity);
      simCtx.state.pos = startPosition.clone();
      simCtx.state.vel = new Vec3(planarVelocity.x, verticalVelocity, planarVelocity.z);
      simCtx.state.control = control.clone();
      simCtx.state.yaw = yaw;

      this.bot.physicsUtil.engine.simulate(simCtx, this.bot.world);
      return new Vec3(simCtx.state.vel.x, 0, simCtx.state.vel.z);
    } catch (error) {
      this.logDebug("predict:planar-probe-fallback", {
        entityId: entity.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private constrainPlanarVelocityWithPhysics(
    entity: Entity,
    startPosition: Vec3,
    currentPlanarVelocity: Vec3,
    proposedPlanarVelocity: Vec3,
    verticalVelocity: number,
    steeringYaw: number | null
  ): Vec3 {
    const referenceDirection =
      this.getPlanarMagnitude(proposedPlanarVelocity) > this.config.minPlanarSpeed
        ? this.normalizePlanar(proposedPlanarVelocity)
        : this.normalizePlanar(currentPlanarVelocity);
    if (this.getPlanarMagnitude(referenceDirection) <= this.config.minPlanarSpeed) {
      return proposedPlanarVelocity;
    }

    const yaw = steeringYaw ?? dirToYawAndPitch(referenceDirection).yaw;
    const coastVelocity = this.simulatePlanarProbe(
      entity,
      startPosition,
      currentPlanarVelocity,
      verticalVelocity,
      ControlStateHandler.DEFAULT(),
      yaw
    );
    const driveVelocity = this.simulatePlanarProbe(
      entity,
      startPosition,
      currentPlanarVelocity,
      verticalVelocity,
      ControlStateHandler.DEFAULT().set("forward", true).set("sprint", true),
      yaw
    );

    if (!coastVelocity || !driveVelocity) {
      return proposedPlanarVelocity;
    }

    // Use physics as a full-vector plausibility bound, not just a scalar speed
    // check along one heading. During jump-turns the stale heading was causing
    // the old 1D clamp to pull the proposal back toward the previous direction.
    // Projecting onto the segment between "coast" and "drive" keeps the
    // proposal inside the physically plausible envelope while allowing the
    // heading itself to rotate.
    return this.getClosestPlanarVelocityOnSegment(proposedPlanarVelocity, coastVelocity, driveVelocity);
  }

  private simulateVerticalPath(
    entity: Entity,
    planarPositions: Vec3[],
    initialVerticalVelocity: number
  ): { finalY: number; finalVerticalVelocity: number } {
    return { finalY: 4, finalVerticalVelocity: -0.078 };

    // if (!this.config.usePhysicsRefinement || !this.bot.physicsUtil || planarPositions.length === 0) {
    //   const lastPosition = planarPositions[planarPositions.length - 1] ?? entity.position;
    //   return { finalY: lastPosition.y, finalVerticalVelocity: initialVerticalVelocity };
    // }

    // try {
    //   const simCtx = this.bot.physicsUtil.getPhysicsCtx(this.bot.physicsUtil.engine, entity);
    //   simCtx.state.pos = entity.position.clone();
    //   simCtx.state.vel = new Vec3(0, initialVerticalVelocity, 0);
    //   simCtx.state.control = ControlStateHandler.DEFAULT();
    //   simCtx.state.onGround = false;

    //   for (let tick = 0; tick < planarPositions.length; tick++) {
    //     const planarPosition = planarPositions[tick];

    //     // Temporary split model:
    //     // physics fully owns Y and landing timing, while X/Z come from the
    //     // kinematic predictor above. This is not a perfect physical model, but
    //     // it avoids obviously wrong "hovering" forecasts until we unify the
    //     // full collision-aware predictor later.
    //     simCtx.state.pos.x = planarPosition.x;
    //     simCtx.state.pos.z = planarPosition.z;
    //     simCtx.state.vel.x = 0;
    //     simCtx.state.vel.z = 0;
    //     simCtx.state.onGround = false;

    //     this.bot.physicsUtil.engine.simulate(simCtx, this.bot.world);

    //     if (simCtx.state.onGround && simCtx.state.vel.y === 0) {
    //       return { finalY: simCtx.state.pos.y, finalVerticalVelocity: simCtx.state.vel.y };
    //     }
    //   }

    //   return { finalY: simCtx.state.pos.y, finalVerticalVelocity: simCtx.state.vel.y };
    // } catch (error) {
    //   this.logDebug("predict:vertical-physics-fallback", {
    //     entityId: entity.id,
    //     error: error instanceof Error ? error.message : String(error),
    //   });

    //   const lastPosition = planarPositions[planarPositions.length - 1] ?? entity.position;
    //   return { finalY: lastPosition.y, finalVerticalVelocity: initialVerticalVelocity };
    // }
  }

  public predictEntityPosition(entity: Entity, ticksAhead: number): Vec3 | null {
    const entry = this.trackingData[entity.id];
    if (!entry) return null;

    const sanitizedTicks = Math.max(0, Math.floor(ticksAhead));
    const currentPosition = entity.position.clone();
    if (sanitizedTicks === 0) return currentPosition;

    const features = this.deriveMotionFeatures(entry.info.tickInfo);
    if (!features) return currentPosition;

    const predicted = currentPosition.clone();
    let planarVelocity = features.planarVelocity.clone();
    const planarPositions: Vec3[] = [];

    this.logDebug("predict:start", {
      entityId: entity.id,
      entityName: entity.name,
      ticksAhead: sanitizedTicks,
      currentPosition: currentPosition.toString(),
      baseVelocity: features.baseVelocity.toString(),
      stableVelocity: features.stableVelocity.toString(),
      latestVelocity: features.latestVelocity.toString(),
      coherence: features.coherence,
      planarAcceleration: features.planarAcceleration.toString(),
      headingYaw: features.headingYaw,
      steeringYaw: features.steeringYaw,
      verticalVelocity: features.verticalVelocity,
    });

    for (let tick = 0; tick < sanitizedTicks; tick++) {
      const coherenceFactor = features.coherence;
      const proposedPlanarVelocity = this.projectPlanarVelocity(planarVelocity, features.planarAcceleration, coherenceFactor);
      planarVelocity = this.constrainPlanarVelocityWithPhysics(
        entity,
        predicted,
        planarVelocity,
        proposedPlanarVelocity,
        features.verticalVelocity,
        features.steeringYaw
      );
      predicted.x += planarVelocity.x;
      predicted.z += planarVelocity.z;
      planarPositions.push(predicted.clone());

      this.logDebug("predict:tick", {
        entityId: entity.id,
        tick: tick + 1,
        coherence: coherenceFactor,
        proposedPlanarVelocity: proposedPlanarVelocity.toString(),
        planarVelocity: planarVelocity.toString(),
        predictedPosition: predicted.toString(),
      });
    }

    const verticalSimulation = this.simulateVerticalPath(entity, planarPositions, features.verticalVelocity);
    predicted.y = verticalSimulation.finalY;

    this.logDebug("predict:end", {
      entityId: entity.id,
      ticksAhead: sanitizedTicks,
      finalVerticalVelocity: verticalSimulation.finalVerticalVelocity,
      predictedPosition: predicted.toString(),
    });

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
    this.hawkeyeRewriteTracking();
  }

  public enable() {
    this.enabled = true;
  }

  public disable() {
    this.enabled = false;
  }
}
