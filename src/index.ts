import utilPlugin from "@nxg-org/mineflayer-util-plugin";
import { EntityTracker } from "./entityTracker";
import { ProjectileTracker } from "./projectileTracker";
import { Bot } from "mineflayer";
import { Entity } from "prismarine-entity";
import { MovementReader } from "./movementReader";
import { MovementSimulations } from "./dist/physics/sims/nextSim";
import { EntityState } from "./dist/physics/states/entityState";
import { PlayerState } from "./dist/physics/states/playerState";
import { Physics } from "./dist/physics/engines/physics";
import { PlayerControls } from "./dist/physics/player/playerControls";

declare module "mineflayer" {
    interface Bot {
        // inputReader: MovementReader;
        tracker: EntityTracker;
        projectiles: ProjectileTracker;
    }
}

export default function plugin(bot: Bot) {
    if (!bot.util) bot.loadPlugin(utilPlugin);
    bot.tracker = new EntityTracker(bot);
    bot.projectiles = new ProjectileTracker(bot);
    // bot.inputReader = new MovementReader(bot);
}

export { EntityTracker };
export { ProjectileTracker };
export { MovementSimulations };

//temporary.
export { EntityState, PlayerState, Physics, PlayerControls };

// export { MovementReader };
