import { EventEmitter } from "node:events";
import type { Bot, ControlState } from "mineflayer";
import { Vec3 } from "vec3";

const minecraftData = require("minecraft-data");
const entityFactory = require("prismarine-entity");
const physicsUtilLoader = require("@nxg-org/mineflayer-physics-util").default;
const { ControlStateHandler } = require("@nxg-org/mineflayer-physics-util");

const TEST_VERSION = "1.20.4";
const TEST_REGISTRY = minecraftData(TEST_VERSION);
const Entity = entityFactory(TEST_VERSION);
const STONE_ID = TEST_REGISTRY.blocksByName.stone.id;

export type ReplayControlFrame = Partial<Record<ControlState, boolean>> & {
  yaw?: number;
  pitch?: number;
};

export type ReplayBotFields = {
  registry: typeof TEST_REGISTRY;
  entity: any;
  target: any;
  entities: Record<number, any>;
  inventory: { slots: any[] };
  game: { gameMode: "survival" | "creative" | "adventure" | "spectator" };
  food: number;
  usingHeldItem: boolean;
  fireworkRocketDuration: number;
  world: { getBlock(pos: Vec3): any };
  physicsUtil: any;
  controlState: Record<ControlState, boolean>;
  setControlState(state: ControlState, wanted: boolean): void;
  getControlState(state: ControlState): boolean;
  getEquipmentDestSlot(slot: string): number;
  loadPlugin(plugin: (bot: Bot) => void): void;
};

class ReplayBotImpl extends EventEmitter {
  public registry = TEST_REGISTRY;
  public entity!: any;
  public target!: any;
  public entities: Record<number, any> = {};
  public inventory = { slots: new Array(46).fill(null) };
  public game = { gameMode: "survival" as const };
  public food = 20;
  public usingHeldItem = false;
  public fireworkRocketDuration = 0;
  public world!: { getBlock(pos: Vec3): any };
  public physicsUtil!: any;
  public controlState: Record<ControlState, boolean> = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false,
  };

  constructor(world: { getBlock(pos: Vec3): any }) {
    super();
    this.world = world;
  }

  public setControlState(state: ControlState, wanted: boolean) {
    this.controlState[state] = wanted;
  }

  public getControlState(state: ControlState) {
    return this.controlState[state];
  }

  public getEquipmentDestSlot(_slot: string) {
    return 0;
  }

  public loadPlugin(plugin: (bot: Bot) => void) {
    plugin(this as unknown as Bot);
  }
}

function createSolidBlock(position: Vec3, type = STONE_ID, name = "stone") {
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

export function createFlatWorld(floorY = 0) {
  return {
    getBlock(pos: Vec3) {
      const floored = pos.floored();
      if (floored.y !== floorY) return null;
      return createSolidBlock(floored);
    },
  };
}

function makeControlFrame(frame: ReplayControlFrame) {
  const control = ControlStateHandler.DEFAULT();
  for (const state of ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const) {
    control.set(state, !!frame[state]);
  }
  return control;
}

function applyEntityDefaults(entity: any, position: Vec3) {
  entity.id = entity.id ?? 1;
  entity.type = "player";
  entity.name = "player";
  entity.displayName = "Player";
  entity.height = 1.8;
  entity.width = 0.6;
  entity.position = position.clone();
  entity.velocity = entity.velocity ?? new Vec3(0, 0, 0);
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

function seedPhysicsContextFromEntity(ctx: any, entity: any) {
  ctx.state.onGround = entity.onGround;
  ctx.state.lastOnGround = entity.lastOnGround ?? entity.onGround;
  ctx.state.supportingBlockPos = entity.supportingBlockPos ?? null;
  ctx.state.isInWater = entity.isInWater ?? false;
  ctx.state.isUnderWater = entity.isUnderWater ?? false;
  ctx.state.isInLava = entity.isInLava ?? false;
  ctx.state.isUnderLava = entity.isUnderLava ?? false;
  ctx.state.isInWeb = entity.isInWeb ?? false;
  ctx.state.isCollidedHorizontally = entity.isCollidedHorizontally ?? false;
  ctx.state.isCollidedHorizontallyMinor = entity.isCollidedHorizontallyMinor ?? false;
  ctx.state.isCollidedVertically = entity.isCollidedVertically ?? false;
  ctx.state.swimming = entity.swimming ?? false;
  ctx.state.sprinting = entity.sprinting ?? false;
  ctx.state.crouching = entity.crouching ?? false;
  ctx.state.fallFlying = entity.fallFlying ?? false;
  ctx.state.elytraFlying = entity.elytraFlying ?? false;
  ctx.state.canFly = entity.canFly ?? false;
  ctx.state.flying = entity.flying ?? false;
}

export function createReplayBot(options: {
  botPosition?: Vec3;
  targetPosition?: Vec3;
  targetVelocity?: Vec3;
  targetYaw?: number;
  targetPitch?: number;
  targetOnGround?: boolean;
  floorY?: number;
} = {}) {
  const world = createFlatWorld(options.floorY ?? 4);
  const bot = new ReplayBotImpl(world);

  const observer = new Entity(1);
  applyEntityDefaults(observer, options.botPosition ?? new Vec3(0, 1, 0));
  observer.velocity = new Vec3(0, 0, 0);

  const target = new Entity(2);
  applyEntityDefaults(target, options.targetPosition ?? new Vec3(20, 1, 20));
  if (options.targetVelocity) target.velocity = options.targetVelocity.clone();
  if (typeof options.targetYaw === "number") target.yaw = options.targetYaw;
  if (typeof options.targetPitch === "number") target.pitch = options.targetPitch;
  if (typeof options.targetOnGround === "boolean") target.onGround = options.targetOnGround;
  target.lastOnGround = target.onGround;

  bot.entity = observer;
  bot.target = target;
  bot.entities[observer.id] = observer;
  bot.entities[target.id] = target;

  physicsUtilLoader(bot as unknown as Bot);

  const originalGetPhysicsCtx = bot.physicsUtil.getPhysicsCtx.bind(bot.physicsUtil);
  bot.physicsUtil.getPhysicsCtx = (...args: any[]) => {
    const ctx = originalGetPhysicsCtx(...args);
    const entity = args[1] ?? bot.target;
    seedPhysicsContextFromEntity(ctx, entity);
    return ctx;
  };

  return bot as unknown as Bot & ReplayBotFields;
}

export function stepReplayTick(bot: Bot & ReplayBotFields, frame: ReplayControlFrame = {}) {
  const ctx = bot.physicsUtil.getPhysicsCtx(bot.physicsUtil.engine, bot.target);
  seedPhysicsContextFromEntity(ctx, bot.target);
  ctx.state.control = makeControlFrame(frame);

  if (typeof frame.yaw === "number") ctx.state.yaw = frame.yaw;
  if (typeof frame.pitch === "number") ctx.state.pitch = frame.pitch;

  bot.physicsUtil.engine.simulate(ctx, bot.world);
  if (typeof ctx.state.applyToEntity === "function") {
    ctx.state.applyToEntity(bot.target);
  } else {
    bot.target.position.set(ctx.state.pos.x, ctx.state.pos.y, ctx.state.pos.z);
    bot.target.velocity.set(ctx.state.vel.x, ctx.state.vel.y, ctx.state.vel.z);
    bot.target.onGround = ctx.state.onGround;
    bot.target.yaw = ctx.state.yaw;
    bot.target.pitch = ctx.state.pitch;
  }
  bot.entities[bot.target.id] = bot.target;
  bot.emit("physicsTick");

  return ctx;
}

export function simulateFuturePosition(bot: Bot & ReplayBotFields, frames: ReplayControlFrame[]) {
  const ctx = bot.physicsUtil.getPhysicsCtx(bot.physicsUtil.engine, bot.target);
  const simCtx = ctx.clone();

  for (const frame of frames) {
    simCtx.state.control = makeControlFrame(frame);

    if (typeof frame.yaw === "number") simCtx.state.yaw = frame.yaw;
    if (typeof frame.pitch === "number") simCtx.state.pitch = frame.pitch;

    bot.physicsUtil.engine.simulate(simCtx, bot.world);
  }

  return simCtx.state.pos.clone();
}

export function repeatFrame(frame: ReplayControlFrame, count: number): ReplayControlFrame[] {
  return Array.from({ length: count }, () => ({ ...frame }));
}
