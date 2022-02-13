import { createBot, EquipmentDestination } from "mineflayer";
import utilPlugin from "@nxg-org/mineflayer-util-plugin";
import tracker from "./index";
import { Vec3 } from "vec3";

const bot = createBot({
    username: "tracker-test",
    host: "minecraft.next-gen.dev",
    port: 25565,
    version: "1.17.1",
});

bot.physics.yawSpeed = 50;

bot.loadPlugin(utilPlugin);
bot.loadPlugin(tracker);

bot.prependListener("physicsTick", async () => {
    let target = bot.nearestEntity((e) => e.username === "Generel_Schwerz");
    if (!target) return;
    bot.tracker.trackEntity(target);
    console.log(bot.tracker.getEntitySpeed(target))
    const { x, y, z } = target.position.plus(bot.tracker.getEntitySpeed(target));
    bot.chat(`/summon zombie ${x} ${y} ${z}`);
    await bot.util.sleep(200);
    bot.chat("/kill @e[type=!player]");
});

bot.util.sleep(5000);
