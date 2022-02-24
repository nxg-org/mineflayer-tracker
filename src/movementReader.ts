import { Physics } from "./lib/physics/engines/physics";
import { MovementSimulations } from "./lib/physics/sims/nextSim";
import registry from "prismarine-registry"
import { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { Entity } from "prismarine-entity";
import { promisify } from "util";
import { dirToYawAndPitch } from "./mathUtils";
import { EntityState } from "./lib/physics/states/entityState";
import { StateStorage } from "./lib/storage/stateStorage";


const sleep = promisify(setTimeout);
const emptyVec = new Vec3(0, 0, 0);


// I am not sure whether or not to use states or just plain velocities. 
export type TrackingData = {
    [entityId: number]: { tracking: boolean; states: StateStorage};
};




/**
 * Plan:
 * 
 * Get entity position and velocity. Calculate velocity based off of rel_entity_move + simulation.
 * Scrap that part three. What I'm about to do is incredibly wasteful.
 * 
 */
export class MovementReader {
    public physics: Physics;
    public readonly moveSims: MovementSimulations;
    public trackingData: TrackingData = {};
    private currentTick: number;

    constructor(private bot: Bot) {
        this.physics = new Physics(registry(bot.version));
        this.moveSims = new MovementSimulations(this.bot, this.physics);
        this.currentTick = 0;
        this.bot.on("entityMoved", (entity) => console.log("entityMoved:", this.currentTick, entity.username))
        // this.bot._client.on("rel_entity_move", this.updateVelocity)
        // this.bot._client.on("entity_move_look", this.updateVelocity)
    }

    public async getCorrectMovement(target: Entity) {
        const targetState = this.getTestState(target);
        if (!targetState) return null
        // console.log(this.currentTick, targetState.yaw.toFixed(5), targetState.pitch.toFixed(5), targetState.velocity )
        return await this.moveSims.findCorrectMovements(targetState, this.bot.world, target.position);
    }


    private updateVelocityTwo = (entity: Entity) => {
        const entityId = entity.id
        if (!this.trackingData[entityId]?.tracking) return;
        if (!this.bot.entities[entityId]) return;

        const stateInfo = this.trackingData[entityId].states
        entity.velocity = entity.position.minus(stateInfo.get(this.currentTick - 2).position).scaled(1 / (this.currentTick - 2))
        const testPos = stateInfo.get(this.currentTick - 2).position.plus(entity.velocity)
        console.log(this.currentTick, stateInfo.oldestTick, '\n', entity.velocity, '\n', entity.position, '\n', testPos)
    }

    /**
     * This should hopefully update the state's velocity to be correct.
     * @param {any} packet rel_entity_move packet.
     */
    private updateVelocity = (packet: any) => {
        // console.log("rel_entity_move data:                       Vec3 { x:", packet.dX / 8000, " y:", packet.dY / 8000, " z:", packet.dZ / 8000, "}") //notchian velocity calculation
        // console.log("entity's current velocity:                 ", this.bot.entities[packet.entityId].velocity)
        // console.log("entity name:                               ", this.bot.entities[packet.entityId].username)

        const entityId = packet.entityId;
        if (!this.trackingData[entityId]?.tracking) return;
        if (!this.bot.entities[entityId]) return;

        // const testVel = new Vec3(packet.dX / 8000, packet.dY / 8000, packet.dZ / 8000)

        let testVel;
        if (this.bot.supportFeature('fixedPointDelta')) {
            testVel = new Vec3(packet.dX / 32, packet.dY /32, packet.dZ / 32);
        }
        else if (this.bot.supportFeature('fixedPointDelta128')) {
            testVel = new Vec3(packet.dX / 4096, packet.dY / 4096, packet.dZ / 4096);
        } else {
            testVel =  new Vec3(packet.dX / 32, packet.dY /32, packet.dZ / 32);
        }


        const stateInfo = this.trackingData[entityId].states
        const state = stateInfo.get(this.currentTick - 1)
        if (!state) return;
        state.velocity = state.position.minus(stateInfo.get(this.currentTick - 2).position).scaled( 1 / (this.currentTick - 2)) //  testVel.scaled(1 / this.currentTick - stateInfo.states.oldestTick)
        // state.position.add(state.velocity)
        console.log(this.currentTick, stateInfo.oldestTick, state.velocity, state.position)
        // console.log(this.currentTick,'\n',state.velocity, '\n',state.position,'\n',packet.dY, this.bot.entities[entityId].onGround)

        // this.physics.simulatePlayer(state, this.bot.world)



        // Should I simply update the current state? 
        // Do I simulate? Jesus. What to do...

    }

    /**
     * goal of this is to keep up-to-date on entity's state ONE TICK BEHIND CURRENT.
     * If prismarine-entity had a clean way to clone entities, that would be fantastic.
     * However, it does not. :wheeze:
     * 
     * 
     * can't since prismarine-entity keeps track of entity IDs and such. Adding a clone would mean a refactor
     * fucks with logic/doesn't fit with the rest of the library. :sadge:
     * it makes sense, but my method will be slower. Then again, this isn't particularly performance intensive.
     * (Yet.)
     * 
     * What's up?
     * 
     * 
     * Just add it to prismarine-entity ez
     * @returns 
     */
    private onPhysics = () => {

        this.currentTick++
        for (const entityId in this.trackingData) {
            if (!this.trackingData[entityId]?.tracking) return;
            if (!this.bot.entities[entityId]) return;
            const currentEntity = this.bot.entities[entityId] // wasteful index lookup. More performant than variable storage before return.
            const currentState = EntityState.CREATE_FROM_ENTITY(this.physics, currentEntity);
            const entityInfo = this.trackingData[entityId] // variable assignment by REFERENCE. Not a copy.

            // I don't want to do it this way since I'll know... oh, whatever. Better to be wasteful than non-functional.
            if (entityInfo.states.length > 2) {
                entityInfo.states.removeOldest();

            }
            // this will push the entity's info to storage. However, it is NOT updated to rel_entity_move.
            // I may have to do this w/ some scuffed internal logic. Let's find out?????
            entityInfo.states.pushRaw(this.currentTick, currentState)
            // const lastState = entityInfo.states.get(this.currentTick - 1)
            // if (lastState) this.physics.simulatePlayer(lastState, this.bot.world);
            
        }


    }






    public trackEntity(entity: Entity) {
        if (this.trackingData[entity.id]) this.trackingData[entity.id].tracking = true;
        this.trackingData[entity.id] ??= { tracking: true, states: new StateStorage() };
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

    public getTestState(entity: Entity): EntityState | null {
        return this.trackingData[entity.id] ? this.trackingData[entity.id].states.get(this.currentTick - 1) : null;
    }

    public getEntityVelocity(entity: Entity): Vec3 | null {
        return this.trackingData[entity.id] ? this.trackingData[entity.id].states.get(this.currentTick).velocity : null;
    }
}
