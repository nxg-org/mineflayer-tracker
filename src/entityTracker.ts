import { Entity } from "prismarine-entity";
import { Bot } from "mineflayer";
import { promisify } from "util";
import { Vec3 } from "vec3";
import { dirToYawAndPitch, pointToYawAndPitch } from "./mathUtils";

const sleep = promisify(setTimeout);
const emptyVec = new Vec3(0, 0, 0);

type TrackingInfo =  { position: Vec3; velocity: Vec3; age: number }
export type TrackingData = {
  [entityId: number]: { tracking: boolean; info: { initialAge: number, avgVel: Vec3; tickInfo:TrackingInfo[],  } };
};

export class EntityTracker {
  public trackingData: TrackingData = {};

  private _enabled = false;
  private _tickAge = 0;

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
    this.enabled = true; // turns on the tracking
  }

  // private test = (packet: Entity) => {
  //   const entityId = packet.id;
  //   const entry = this.trackingData[entityId];
  //   if (!entry?.tracking) return;

  //   const entity = this.bot.entities[entityId];
  //   if (!entity) return;

  //   const currentPos = entity.position.clone();
  //   const info = entry.info;

  //   // If we have at least one prior tick, compute the shift
  //   if (info.tickInfo.length > 0) {
  //     const lastPos = info.tickInfo[info.tickInfo.length - 1].position;
  //     const shiftPos = currentPos.minus(lastPos);

  //     // If there's no movement, reset history and avgSpeed, then bail out
  //     if (shiftPos.equals(emptyVec)) {
  //       info.tickInfo = [{ position: currentPos, velocity: entity.velocity.clone(), age: this._tickAge }];
  //       info.avgSpeed = emptyVec;
  //       return;
  //     }

  //     // If the direction changed sharply, prune the history to just the last point
  //     if (!info.avgSpeed.equals(emptyVec)) {
  //       const oldYaw = dirToYawAndPitch(info.avgSpeed).yaw;
  //       const newYaw = dirToYawAndPitch(shiftPos).yaw;
  //       const dif = Math.abs(oldYaw - newYaw);
  //       if (dif > Math.PI / 4 && dif < (11 * Math.PI) / 4) {
  //         // keep only the very last tick before current
  //         const last = info.tickInfo.pop()!;
  //         info.tickInfo = [last];
  //       }
  //     }
  //   }

  //   // Cap history length at 10
  //   if (info.tickInfo.length > 10) {
  //     info.tickInfo.shift();
  //   }

  //   // Record the new sample
  //   info.tickInfo.push({ position: currentPos, velocity: entity.velocity.clone(), age: this._tickAge });

  //   // Recompute average speed over history
  //   const speed = new Vec3(0, 0, 0);
  //   const len = info.tickInfo.length;
  //   for (let i = 1; i < len; i++) {
  //     const curr = info.tickInfo[i].position;
  //     const prev = info.tickInfo[i - 1].position;
  //     speed.x += curr.x - prev.x;
  //     speed.y += curr.y - prev.y;
  //     speed.z += curr.z - prev.z;
  //   }
  //   speed.x /= len;
  //   speed.y /= len;
  //   speed.z /= len;

  //   // Update avgSpeed if it has changed
  //   if (!speed.equals(info.avgSpeed)) {
  //     info.avgSpeed = speed;
  //   }
  // };

  private hawkeyeRewriteTracking = () => {
    this._tickAge++;
    for (const entityId in this.trackingData) {
      if (!this.trackingData[entityId].tracking) continue;
      const entity = this.bot.entities[entityId]; //bot.entities[entityId]

      // if (!e) return;
      if (!entity) continue;
      const info = this.trackingData[entityId].info;

      const currentPos = entity.position.clone();

      
      if (info.tickInfo.length > 0) {
        // console.log(info.tickInfo.length, this._tickAge, info.tickInfo[info.tickInfo.length - 1]?.age, currentPos.toString(), entity.velocity.toString())

        const prevInfo = info.tickInfo[info.tickInfo.length - 1];
        const prevPos = currentPos.minus(prevInfo.position);

        // console.log(info.tickInfo.length, shiftInfo.age, this._tickAge, shiftPos.toString(), shiftInfo.position.toString(), currentPos.toString())
        if (prevPos.equals(emptyVec) &&  info.initialAge - prevInfo.age > 1) {
          // console.log('equal pos and we have not received info, clearing cache.')
          info.tickInfo = [{ position: currentPos, velocity: entity.velocity.clone(), age: this._tickAge }];
          info.initialAge = this._tickAge
          info.avgVel = emptyVec;
          continue;
        } else if (prevPos.equals(emptyVec)) {
          info.initialAge = this._tickAge
          // console.log('equal pos but maybe not received info')
          continue;
        }

        if (!prevPos.equals(emptyVec) && !info.avgVel.equals(emptyVec)) {
          const oldYaw = dirToYawAndPitch(info.avgVel).yaw;
          const newYaw = dirToYawAndPitch(prevPos).yaw;
          const dif = Math.abs(oldYaw - newYaw);
          if (dif > Math.PI / 4 && dif < (11 * Math.PI) / 4) {
            info.tickInfo = [info.tickInfo.pop()!];
          }
        }
      }

      if (info.tickInfo.length > 10) {
        info.tickInfo.shift();
      }


      const curInfo = { position: currentPos, velocity: entity.velocity.clone(), age: this._tickAge };
      const prevInfo = info.tickInfo[info.tickInfo.length - 1];
      const vel = new Vec3(0, 0, 0);

      const length = info.tickInfo.length;
      const divLength = length;

      if (length === 0)  info.initialAge = this._tickAge;
      info.tickInfo.push(curInfo);

      const handleTimeDifferential = (selector: 'x' | 'y' | 'z', curPos:TrackingInfo, prevPos: TrackingInfo ) => {
        const first = curPos.position[selector];
        const second = prevPos.position[selector];

        const firstAge = curPos.age;
        const secondAge = prevPos.age;

        if (length === 1) {
          return first - second;
        }
        return (first - second) / (firstAge - secondAge);
      }

      // average X and Z over found differential.
      for (let i = 1; i < length + 1; i++) {
        vel.x += handleTimeDifferential('x', info.tickInfo[i], info.tickInfo[i - 1]);
        vel.z += handleTimeDifferential('z', info.tickInfo[i], info.tickInfo[i - 1]);
        // vel.y += pos.y - prevPos.y;
      }

      vel.x = vel.x / divLength;
      vel.z = vel.z / divLength;
      // vel.y = speed.y / divLength;


      // now, since calculating the impulse of Y is hard, we just take the difffence between the last tick and the current one.

      if (!prevInfo) vel.y = 0;
      else {
        // if the current measurement is at a whole integer, set vel.y to 0. this is because we're collided with a block.
        const currentY = Math.floor(currentPos.y);
        if (currentY === currentPos.y) vel.y = 0;
        else {
          vel.y = handleTimeDifferential('y', curInfo, prevInfo);
        }
       
      }

      if (!vel.equals(info.avgVel)) info.avgVel = vel;
    }
  };

  public trackEntity(entity: Entity) {
    if (this.trackingData[entity.id]) this.trackingData[entity.id].tracking = true;
    this.trackingData[entity.id] ??= { tracking: true, info: { avgVel: emptyVec, tickInfo: [], initialAge: 0 } };
  }

  public stopTrackingEntity(entity: Entity, clear: boolean = false) {
    if (!this.trackingData[entity.id]) return;
    this.trackingData[entity.id].tracking = false;
    if (clear) {
      delete this.trackingData[entity.id];
      // this.trackingData[entity.id].info.avgSpeed = emptyVec;
      // this.trackingData[entity.id].info.tickInfo = [];
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
