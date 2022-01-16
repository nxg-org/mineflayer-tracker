import utilPlugin from "@nxg-org/mineflayer-util-plugin";
import { EntityTracker } from "./entityTracker";
import { ProjectileTracker } from "./projectileTracker";
import { Bot } from "mineflayer";
import { Entity } from "prismarine-entity";

declare module "mineflayer" {
    interface Bot {
        tracker: EntityTracker
        projectiles: ProjectileTracker;

    }
    interface BotEvents {
        attackedTarget: (target: Entity) => void;
        stoppedAttacking: () => void;
        startedAttacking: (target: Entity) => void;
        targetBlockingUpdate: (target: Entity, blocking: boolean) => void;
    }
}

export default function plugin(bot: Bot) {
    if (!bot.util) bot.loadPlugin(utilPlugin);
    bot.tracker = new EntityTracker(bot);
    bot.projectiles = new ProjectileTracker(bot);
}

export { EntityTracker };
