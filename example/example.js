"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mineflayer_1 = require("mineflayer");
const mineflayer_util_plugin_1 = __importDefault(require("@nxg-org/mineflayer-util-plugin"));
const index_1 = __importDefault(require("../src/index"));
const vec3_1 = require("vec3");
const bot = (0, mineflayer_1.createBot)({
    username: "tracker-test",
    host: "localhost",
    port: 25565,
});
bot.on("spawn", () => {
    bot.physics.yawSpeed = 50;
});
bot.loadPlugin(mineflayer_util_plugin_1.default);
bot.loadPlugin(index_1.default);
function fetchEntity(bot, wanted, author) {
    var _a;
    return ((_a = bot.nearestEntity((e) => (!!e.username && e.username === wanted) || e.name === wanted)) !== null && _a !== void 0 ? _a : bot.nearestEntity((e) => e.username === author));
}
bot.on("chat", (u, m) => __awaiter(void 0, void 0, void 0, function* () {
    console.log(m);
    if (u === bot.entity.username)
        return;
    const msg = m.split(" ");
    let target = fetchEntity(bot, msg[1], u);
    switch (msg[0]) {
        case "jump":
            for (let i = 0; i < 12; i++) {
                bot.setControlState("jump", true);
                yield bot.waitForTicks(1);
                console.log(bot.entity.position, bot.entity.velocity);
            }
            break;
        case "selftrack": {
            bot.on('physicsTick', () => {
                console.log("tick", bot.entity.position, bot.entity.velocity);
            });
            bot.setControlState('forward', true);
            bot.setControlState('sprint', true);
            break;
        }
        case "track":
            if (!target)
                return bot.chat("No target found.");
            bot.tracker.trackEntity(target);
            let lastPos = new vec3_1.Vec3(0, 0, 0);
            while (true) {
                // bot.tracker.getEntitySpeed(target)
                console.log(target.position, bot.tracker.getEntitySpeed(target), target.position.minus(lastPos));
                yield bot.waitForTicks(1);
                lastPos = target.position.clone();
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
}));
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
