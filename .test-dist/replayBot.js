"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFlatWorld = createFlatWorld;
exports.createReplayBot = createReplayBot;
exports.stepReplayTick = stepReplayTick;
exports.simulateFuturePosition = simulateFuturePosition;
exports.repeatFrame = repeatFrame;
const node_events_1 = require("node:events");
const vec3_1 = require("vec3");
const minecraftData = require("minecraft-data");
const entityFactory = require("prismarine-entity");
const physicsUtilLoader = require("@nxg-org/mineflayer-physics-util").default;
const { ControlStateHandler } = require("@nxg-org/mineflayer-physics-util");
const TEST_VERSION = "1.20.4";
const TEST_REGISTRY = minecraftData(TEST_VERSION);
const Entity = entityFactory(TEST_VERSION);
const STONE_ID = TEST_REGISTRY.blocksByName.stone.id;
class ReplayBotImpl extends node_events_1.EventEmitter {
    constructor(world) {
        super();
        this.registry = TEST_REGISTRY;
        this.entities = {};
        this.inventory = { slots: new Array(46).fill(null) };
        this.game = { gameMode: "survival" };
        this.food = 20;
        this.usingHeldItem = false;
        this.fireworkRocketDuration = 0;
        this.controlState = {
            forward: false,
            back: false,
            left: false,
            right: false,
            jump: false,
            sprint: false,
            sneak: false,
        };
        this.world = world;
    }
    setControlState(state, wanted) {
        this.controlState[state] = wanted;
    }
    getControlState(state) {
        return this.controlState[state];
    }
    getEquipmentDestSlot(_slot) {
        return 0;
    }
    loadPlugin(plugin) {
        plugin(this);
    }
}
function createSolidBlock(position, type = STONE_ID, name = "stone") {
    return {
        name,
        type,
        metadata: 0,
        boundingBox: "block",
        shapes: [[0, 0, 0, 1, 1, 1]],
        position: position.clone(),
        getProperties: () => ({ waterlogged: false }),
    };
}
function createFlatWorld(floorY = 0) {
    return {
        getBlock(pos) {
            const floored = pos.floored();
            if (floored.y !== floorY)
                return null;
            return createSolidBlock(floored);
        },
    };
}
function makeControlFrame(frame) {
    const control = ControlStateHandler.DEFAULT();
    for (const state of ["forward", "back", "left", "right", "jump", "sprint", "sneak"]) {
        control.set(state, !!frame[state]);
    }
    return control;
}
function applyEntityDefaults(entity) {
    entity.id = entity.id ?? 1;
    entity.type = "player";
    entity.name = "player";
    entity.displayName = "Player";
    entity.height = 1.8;
    entity.width = 0.6;
    entity.position = entity.position ?? new vec3_1.Vec3(0, 1, 0);
    entity.velocity = entity.velocity ?? new vec3_1.Vec3(0, 0, 0);
    entity.onGround = entity.onGround ?? true;
    entity.yaw = entity.yaw ?? 0;
    entity.pitch = entity.pitch ?? 0;
    entity.attributes = entity.attributes ?? {};
    entity.effects = entity.effects ?? [];
    entity.equipment = entity.equipment ?? new Array(6).fill(null);
    entity.metadata = entity.metadata ?? [];
    entity.metadata[8] = entity.metadata[8] ?? 0;
    entity.metadata.push({ type: 18, value: 0 });
    entity.lastOnGround = entity.lastOnGround ?? entity.onGround;
    entity.isInWater = entity.isInWater ?? false;
    entity.isUnderWater = entity.isUnderWater ?? false;
    entity.isInLava = entity.isInLava ?? false;
    entity.isUnderLava = entity.isUnderLava ?? false;
    entity.isInWeb = entity.isInWeb ?? false;
    entity.isCollidedHorizontally = entity.isCollidedHorizontally ?? false;
    entity.isCollidedHorizontallyMinor = entity.isCollidedHorizontallyMinor ?? false;
    entity.isCollidedVertically = entity.isCollidedVertically ?? false;
    entity.supportingBlockPos = entity.supportingBlockPos ?? null;
    entity.swimming = entity.swimming ?? false;
    entity.sprinting = entity.sprinting ?? false;
    entity.crouching = entity.crouching ?? false;
    entity.fallFlying = entity.fallFlying ?? false;
    entity.elytraFlying = entity.elytraFlying ?? false;
    entity.canFly = entity.canFly ?? false;
    entity.flying = entity.flying ?? false;
}
function createReplayBot(options = {}) {
    const world = createFlatWorld(options.floorY ?? 0);
    const bot = new ReplayBotImpl(world);
    const entity = new Entity(1);
    applyEntityDefaults(entity);
    if (options.position)
        entity.position = options.position.clone();
    if (options.velocity)
        entity.velocity = options.velocity.clone();
    if (typeof options.yaw === "number")
        entity.yaw = options.yaw;
    if (typeof options.pitch === "number")
        entity.pitch = options.pitch;
    if (typeof options.onGround === "boolean")
        entity.onGround = options.onGround;
    entity.lastOnGround = entity.onGround;
    bot.entity = entity;
    bot.entities[entity.id] = entity;
    physicsUtilLoader(bot);
    return bot;
}
function stepReplayTick(bot, frame = {}) {
    const ctx = bot.physicsUtil.ePhysicsCtx.FROM_BOT(bot.physicsUtil.engine, bot);
    ctx.state.control = makeControlFrame(frame);
    if (typeof frame.yaw === "number")
        ctx.state.yaw = frame.yaw;
    if (typeof frame.pitch === "number")
        ctx.state.pitch = frame.pitch;
    bot.physicsUtil.engine.simulate(ctx, bot.world);
    ctx.state.apply(bot);
    bot.entities[bot.entity.id] = bot.entity;
    bot.emit("physicsTick");
    return ctx;
}
function simulateFuturePosition(bot, frames) {
    const ctx = bot.physicsUtil.ePhysicsCtx.FROM_BOT(bot.physicsUtil.engine, bot);
    for (const frame of frames) {
        ctx.state.control = makeControlFrame(frame);
        if (typeof frame.yaw === "number")
            ctx.state.yaw = frame.yaw;
        if (typeof frame.pitch === "number")
            ctx.state.pitch = frame.pitch;
        bot.physicsUtil.engine.simulate(ctx, bot.world);
    }
    return ctx.state.pos.clone();
}
function repeatFrame(frame, count) {
    return Array.from({ length: count }, () => ({ ...frame }));
}
