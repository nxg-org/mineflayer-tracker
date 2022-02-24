import { Bot, createBot, EquipmentDestination } from "mineflayer";
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

function fetchEntity(bot: Bot, wanted: string, author: string) {
    return (
        bot.nearestEntity((e) => (!!e.username && e.username === wanted) || e.name === wanted) ??
        bot.nearestEntity((e) => e.username === author)
    );
}

bot.on("chat", async (u, m) => {
    console.log(m)
    if (u === bot.entity.username) return;
    const msg = m.split(" ");
    let target = fetchEntity(bot, msg[1], u);
    switch (msg[0]) {
        case "jump": 
            for (let i = 0; i < 12; i++) {
                bot.setControlState("jump", true);
                await bot.waitForTicks(1)
                console.log(bot.entity.position, bot.entity.velocity)
            }
            break;
        case "track":
            if (!target) return bot.chat("No target found.");
            bot.tracker.trackEntity(target)

            while (true) {
                
            }
            // bot.inputReader.trackEntity(target)
            // while (true) {
            //     console.log(await bot.inputReader.getCorrectMovement(target))
            //     // await bot.inputReader.getCorrectMovement(target)
            //     await bot.waitForTicks(1);
            // }
            break;
        case "stop":
            break;
    }
});

// bot.prependListener("physicsTick", async () => {
//     let target = bot.nearestEntity((e) => e.username === "Generel_Schwerz");
//     if (!target) return;
//     bot.tracker.trackEntity(target);
//     console.log(bot.tracker.getEntitySpeed(target))
//     const { x, y, z } = target.position.plus(bot.tracker.getEntitySpeed(target)!);
//     bot.chat(`/summon zombie ${x} ${y} ${z}`);
//     await bot.util.sleep(200);
//     bot.chat("/kill @e[type=!player]");
// });
