
import { Entity } from "prismarine-entity";
import { Bot } from "mineflayer";
import { ControlStateHandler, EPhysicsCtx, EntityState } from "@nxg-org/mineflayer-physics-util"
import { Vec3 } from "vec3";
import { IPhysics } from "@nxg-org/mineflayer-physics-util/dist/physics/engines";

const BasicMoves = [
    ControlStateHandler.DEFAULT(),
    ControlStateHandler.DEFAULT().set("forward", true),
    ControlStateHandler.DEFAULT().set("forward", true).set("right", true),
    ControlStateHandler.DEFAULT().set("forward", true).set("left", true),
    ControlStateHandler.DEFAULT().set("back", true),
    ControlStateHandler.DEFAULT().set("back", true).set("left", true),
    ControlStateHandler.DEFAULT().set("back", true).set("right", true),
    ControlStateHandler.DEFAULT().set("left", true),
    ControlStateHandler.DEFAULT().set("right", true),
]


export interface MovementSimOptions {
    sprintFirst: boolean;
    jumpFirst: boolean;
}

/**
 * To be used once per movement.
 *
 * Provide state that will serve as a base. The state itself will not be modified/consumed unless called for.
 */
export class MovementSimulations {
   
    constructor(public bot: Bot, public readonly ctx: IPhysics) {}

    *predictGenerator(ctx: EPhysicsCtx, world: any, ticks: number = 1, controls?: ControlStateHandler) {
        ctx.state.control = controls ?? ControlStateHandler.DEFAULT();
        for (let current = 0; current < ticks; current++) {
            yield this.ctx.simulate(ctx, world) as EntityState
        }
        return ctx;
    }
  
    predictForward(target: Entity, world: any, ticks: number = 1, controls?: ControlStateHandler) {
        const ctx = EPhysicsCtx.FROM_ENTITY(this.ctx,target);
        ctx.state.control = controls ?? ControlStateHandler.DEFAULT();
        for (let current = 0; current < ticks; current++) {
            this.ctx.simulate(ctx, world)
        }
        return ctx;
    }



    findCorrectMovements(lastState: EPhysicsCtx, world: any, wantedPos: Vec3) {
      
        // console.log("TEST\n===========================\ndelta pos:",wantedPos.minus(lastState.position), '\nstate\'s vel:', lastState.velocity, '\nstate\'s position:', lastState.position, '\nwanted position:', wantedPos)
        const defaultCtx = lastState.clone();
        const destinations: [Vec3, ControlStateHandler][] = [];
        for (const move of BasicMoves) {
            const testCtx = defaultCtx.clone();
            testCtx.state.control = move.clone();
            
            this.ctx.simulate(testCtx, world)
            destinations.push([testCtx.position, testCtx.state.control])
        }

        const flag = !defaultCtx.state.isUsingItem
        const flag2 = defaultCtx.state.onGround || defaultCtx.state.isInWater || defaultCtx.state.isInLava
        const flag3 = flag && flag2

      
        // Apply sprint tests.
        // Only apply if moving forward AND not sneaking AND state not using item.
        if (flag) {
            for (const move of BasicMoves.filter(ctrl => ctrl.forward === true && ctrl.sneak === false && ctrl.back === false)) {
                const testCtx = defaultCtx.clone();
                testCtx.state.control = move.clone().set("sprint", true);
                this.ctx.simulate(testCtx, world)
                destinations.push([testCtx.position, testCtx.state.control])
            }
        }
       

        // Apply jump, sneak, and jump-sneak tests.
        // Only test this if jump is relevant. Otherwise, ignore.
        if (flag2) { 
            for (const move of BasicMoves) {
                const testCtx = defaultCtx.clone();
                testCtx.state.control = move.clone().set("jump", true);
                this.ctx.simulate(testCtx, world)
                destinations.push([testCtx.position, testCtx.state.control])
            }
            for (const move of BasicMoves) {
                const testState1 = defaultCtx.clone();
                testState1.state.control = move.clone().set("sneak", true);
                this.ctx.simulate(testState1, world)
                destinations.push([testState1.position, testState1.state.control])
            }
            for (const move of BasicMoves) {
                const testState2 = defaultCtx.clone();
                testState2.state.control = move.clone().set("jump", true).set("sneak", true);
                this.ctx.simulate(testState2, world)
                destinations.push([testState2.position, testState2.state.control])
            }
        }

    


        // Apply sprint-jump tests.
        // Only apply if entity is on the ground, NOT shifting, and NOT holding backward.
        if (flag3) {
            for (const move of BasicMoves.filter(ctrl => ctrl.forward === true && ctrl.sneak === false && ctrl.back === false)) {
                const testState = defaultCtx.clone();
                testState.state.control = move.clone().set("sprint", true).set("jump", true);
                this.ctx.simulate(testState, world)
                destinations.push([testState.position, testState.state.control])
            }
        }
        const closestControls = destinations.sort((a, b) => a[0].distanceTo(wantedPos) - b[0].distanceTo(wantedPos))
    
        return closestControls[0][1];
    }
}
