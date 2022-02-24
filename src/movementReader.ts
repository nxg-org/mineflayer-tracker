import { Physics } from "./dist/physics/engines/physics";
import { MovementSimulations } from "./dist/physics/sims/nextSim";
import registry from "prismarine-registry";
import { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { Entity } from "prismarine-entity";
import { promisify } from "util";
import { dirToYawAndPitch } from "./mathUtils";
import { EntityState } from "./dist/physics/states/entityState";
import { StateStorage } from "./dist/storage/stateStorage";
import { MathUtils } from "@nxg-org/mineflayer-util-plugin";

const sleep = promisify(setTimeout);
const emptyVec = new Vec3(0, 0, 0);

// I am not sure whether or not to use states or just plain velocities.
export type TrackingData = {
    [entityId: number]: { tracking: boolean; states: EntityState[] };
};

/**
 * Plan:
 *
 * Get entity position and velocity. Calculate velocity based off of rel_entity_move + simulation.
 * Scrap that part three. What I'm about to do is incredibly wasteful.
 *
 */
type VelocityPacket = { entityId: number; velocityX: number; velocityY: number; velocityZ: number };
export class MovementReader {
    public physics: Physics;
    public readonly moveSims: MovementSimulations;
    public trackingData: TrackingData = {};
    private simStates: { [entityId: number]: { mu: boolean; vu: boolean; state: EntityState } } = {};

    private tick = 0;
    constructor(private bot: Bot) {
        this.physics = new Physics(registry(bot.version));
        this.moveSims = new MovementSimulations(this.bot, this.physics);
        // this.bot.on("physicsTick", () =>{
        //     this.tick++
        //     console.log("ticked", this.tick, this.bot.nearestEntity(e => e.username === "Generel_Schwerz")?.position, "Generel_Schwerz")

        // })

        // this.bot.on("entityMoved", (entity) => {
        //     console.log("moved.", this.tick, entity.position, entity.username)
        // })
        this.bot.on("entityMoved", this.updateStateInfo);
        this.bot._client.on("entity_velocity", this.perVelocityUpdateState);
    }

    public getCorrectMovement(entity: Entity) {
        const simState = this.simStates[entity.id];
        if (!simState || !simState.mu || !simState.vu) {
            // console.log(!!simState, simState.mu, simState.vu)
            return null;
        }
        // console.log(simState.state.velocity)
        return simState.state.controlState;
    }

    private perVelocityUpdateState = async (packet: VelocityPacket) => {
        if (!this.simStates[packet.entityId]) return;
        const simInfo = this.simStates[packet.entityId];
        // simInfo.state.velocity = MathUtils.fromNotchVelocity(new Vec3(packet.velocityX, packet.velocityY, packet.velocityZ));
        simInfo.vu = true;
        await this.bot.waitForTicks(1)
        simInfo.vu = false
    };

    private updateStateInfo = async (entity: Entity) => {
        const entityId = entity.id;
        if (!this.trackingData[entityId]?.tracking) return;
        if (!this.bot.entities[entityId]) return;

        const currentEntity = this.bot.entities[entityId]; // wasteful index lookup. More performant than variable storage before return.
        const currentState = EntityState.CREATE_FROM_ENTITY(this.physics, currentEntity);
        const stateInfo = this.trackingData[entityId].states;
        const simState = this.simStates[entity.id].state;

        //update states that have changes unrelated to position changes. Yaw, pitch, etc.
        const previousState = stateInfo[1];
        let simulate = previousState && !previousState.position.equals(entity.position)
       
        stateInfo.push(currentState);

        //this is so it only stores current movement pos, and last movement pos.
        if (stateInfo.length > 2) {
            stateInfo.shift();
            // const simVel = simState.velocity.clone();
          
            simState.merge(stateInfo[0]);
            const simVel = entity.position.minus(simState.position)
            simState.velocity = simVel
            // simState.velocity = simVel;
          

            if (simulate) {
                console.log(
                    "TEST\n===========================",
                    "\ndelta pos:",entity.position.minus(simState.position), 
                    '\nstate\'s vel:', simState.velocity, 
                    '\nstate\'s position:', simState.position, 
                    '\nwanted position:', entity.position)
        
                const moves = await this.moveSims.findCorrectMovements(simState, this.bot.world, entity.position);
                simState.controlState = moves;
                this.physics.simulatePlayer(simState, this.bot.world);
                this.simStates[entity.id].mu = true;
            }
            // const moves = await this.moveSims.findCorrectMovements(simState, this.bot.world, entity.position);
            // simState.controlState = moves;
            // this.simStates[entityId].vu = false;
        }

       
       
    };

    public trackEntity(entity: Entity) {
        if (this.trackingData[entity.id]) this.trackingData[entity.id].tracking = true;
        this.trackingData[entity.id] ??= { tracking: true, states: [] };
        this.simStates[entity.id] ??= { mu: false, vu: false, state: EntityState.CREATE_FROM_ENTITY(this.physics, entity) };
    }

    public stopTrackingEntity(entity: Entity, clear: boolean = false) {
        if (!this.trackingData[entity.id]) return;
        this.trackingData[entity.id].tracking = false;
        if (clear) {
            delete this.trackingData[entity.id];
            delete this.simStates[entity.id];
        }
    }

    public getTestState(entity: Entity): EntityState | null {
        return this.trackingData[entity.id] ? this.trackingData[entity.id].states[1] : null;
    }

    public getEntityVelocity(entity: Entity): Vec3 | null {
        return this.trackingData[entity.id] ? this.trackingData[entity.id].states[1].velocity : null;
    }
}
