import utilPlugin from "@nxg-org/mineflayer-util-plugin";
import { PhysicsUtilWrapper } from "@nxg-org/mineflayer-physics-util";
import { EntityTracker } from "./entityTracker";
import { EntityTrackerCurvature } from "./entityTrackerCurvature";
import { ProjectileTracker } from "./projectileTracker";
import { Bot } from "mineflayer";
// import { MovementReader } from "./movementReader";
import { MovementSimulations } from "./dist/sims/nextSim";
import { EntityTrackerOld } from "./entityTrackerOld";

declare module "mineflayer" {
    interface Bot {
        // inputReader: MovementReader;
        physicsUtil?: PhysicsUtilWrapper;
        tracker: EntityTracker;
        trackerOld: EntityTrackerOld;
        projectiles: ProjectileTracker;
    }
}

export default function plugin(bot: Bot) {
    if (!bot.util) bot.loadPlugin(utilPlugin);
    bot.tracker = new EntityTracker(bot);
    bot.trackerOld = new EntityTrackerOld(bot);
    bot.projectiles = new ProjectileTracker(bot);
    // bot.inputReader = new MovementReader(bot);
}

export { EntityTracker };
export { EntityTrackerCurvature };
export { ProjectileTracker };
export { MovementSimulations };

// export { MovementReader };
