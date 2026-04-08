import { Bot } from "mineflayer";
import { BasicShotInfo, projectileGravity, ShotFactory, trajectoryInfo, InterceptFunctions } from "@nxg-org/mineflayer-trajectories";
import type { Entity } from "prismarine-entity";
import type { Block } from "prismarine-block";
import type { Vec3 } from "vec3";

type InfoBoundToEntity = { entity: Entity; shotInfo: BasicShotInfo };
const normalizeName = (name: string | null | undefined) => name?.toLowerCase();
const knownProjectiles = new Set(Object.keys(projectileGravity).map((name) => name.toLowerCase()));
const knownWeapons = new Set(Object.keys(trajectoryInfo).map((name) => name.toLowerCase()));
const damagingProjectiles = new Set(["arrow", "firework_rocket", "trident", "fireball"]);

const hasKnownProjectileName = (name: string | null | undefined) => knownProjectiles.has(normalizeName(name) ?? "");
const hasKnownWeaponName = (name: string | null | undefined) => knownWeapons.has(normalizeName(name) ?? "");
const isDamagingProjectileName = (name: string | null | undefined) => damagingProjectiles.has(normalizeName(name) ?? "");
const isAimingMobName = (name: string | null | undefined) => {
    const normalizedName = normalizeName(name);
    return normalizedName === "skeleton" || normalizedName === "piglin";
};
const isBowName = (name: string | null | undefined) => normalizeName(name)?.includes("bow") ?? false;

export class ProjectileTracker {
    private intercepter: InterceptFunctions;
    private projectilesChecked: boolean = false;
    private entitiesChecked: boolean = false;
    private $isAimedAt: InfoBoundToEntity | null = null;
    private $projectileAtMe: InfoBoundToEntity | null = null;
    public detectIncomingProjectiles: boolean = false;
    public detectAimingEntities: boolean = false;

    constructor(private bot: Bot) {
        this.intercepter = new InterceptFunctions(bot);
        this.bot.on("physicsTick", this.perTickHandler);
    }

    public get isAimedAt(): InfoBoundToEntity | null {
        if (this.entitiesChecked) return this.$isAimedAt;
        else {
            this.$isAimedAt = this.getHighestPriorityEntity();
            this.entitiesChecked = true;
            return this.$isAimedAt;
        }
    }

    public get projectileAtMe(): InfoBoundToEntity | null {
        if (this.projectilesChecked) return this.$projectileAtMe;
        else {
            this.$projectileAtMe = this.getHighestPriorityProjectile();
            this.projectilesChecked = true;
            return this.$projectileAtMe;
        }
    }

    perTickHandler = async () => {
        this.projectilesChecked = false;
        this.entitiesChecked = false;
    };

    getIncomingArrow(): InfoBoundToEntity | null {
        const arrowInfos = this.getIncomingArrows();
        return (
            arrowInfos.sort(
                (a, b) => a.entity.position.distanceTo(this.bot.entity.position) - b.entity.position.distanceTo(this.bot.entity.position)
            )[0] ?? null
        );
    }

    getIncomingArrows(): InfoBoundToEntity[] {
        const hittingArrows = [];
        const aabbComponents = { position: this.bot.entity.position, height: this.bot.entity.height + 0.18, width: 0.6 };
        for (const entity of Object.values(this.bot.entities).filter((e) => normalizeName(e.name)?.includes("arrow"))) {
            // assuming stopped.
            const init = ShotFactory.fromEntity(entity, this.intercepter);
            const info = init.hitsEntity(aabbComponents);
            if (!!info) hittingArrows.push({ entity, shotInfo: info.shotInfo });
        }
        return hittingArrows;
    }

    getIncomingProjectiles(): InfoBoundToEntity[] {
        const hittingArrows = [];
        const aabbComponents = { position: this.bot.entity.position, height: this.bot.entity.height + 0.18, width: 0.6 };
        for (const entity of Object.values(this.bot.entities).filter((e) => hasKnownProjectileName(e.name))) {
            // assuming stopped.
            const init = ShotFactory.fromEntity(entity, this.intercepter);
            const info = init.hitsEntity(aabbComponents);
            if (!!info && info.shotInfo.nearestDistance === 0) hittingArrows.push({ entity, shotInfo: info.shotInfo });
        }
        return hittingArrows;
    }

    getHighestPriorityProjectile(doesDamage: boolean = true): InfoBoundToEntity | null {
        const projs = this.getIncomingProjectiles();
        if (doesDamage) {
            return (
                projs
                    .filter((p) => isDamagingProjectileName(p.entity.name))
                    .sort(
                        (a, b) =>
                            a.entity.position.distanceTo(this.bot.entity.position) - b.entity.position.distanceTo(this.bot.entity.position)
                    )[0] ?? null
            );
        } else {
            return (
                projs.sort(
                    (a, b) =>
                        a.entity.position.distanceTo(this.bot.entity.position) - b.entity.position.distanceTo(this.bot.entity.position)
                )[0] ?? null
            );
        }
    }

    allProjectileInfo(): { entity: Entity; info: { block: Block | null; hitPos: Vec3 | null; totalTicks: number } }[] {
        const hittingArrows = [];
        const entities = Object.values(this.bot.entities);
        for (const entity of Object.values(this.bot.entities).filter((e) => hasKnownProjectileName(e.name))) {
            // assuming stopped.
            const init = ShotFactory.fromEntity(entity, this.intercepter);
            const info = init.calcToIntercept(true, entities);
            hittingArrows.push({ entity, info });
        }
        return hittingArrows;
    }

    getMobsAimingAtBot(): InfoBoundToEntity[] {
        const hittingArrows = [];
        const aabbComponents = { position: this.bot.entity.position, height: this.bot.entity.height + 0.18, width: 0.6 };
        for (const entity of Object.values(this.bot.entities).filter(
            (e) => isAimingMobName(e.name) && isBowName(e.heldItem?.name)
        )) {
            const init = ShotFactory.fromMob(entity, this.intercepter);
            const info = init.hitsEntity(aabbComponents);
            if (!!info) hittingArrows.push({ entity, shotInfo: info.shotInfo });
        }
        return hittingArrows;
    }

    //TODO: Make aim dynamic by reading heldItem metadata.
    getPlayersAimingAtBot(): InfoBoundToEntity[] {
        const hittingArrows = [];
        const aabbComponents = { position: this.bot.entity.position, height: this.bot.entity.height + 0.18, width: 0.6 };
        for (const entity of Object.values(this.bot.entities).filter((e) => e.type === "player" && e !== this.bot.entity)) {
            if (hasKnownWeaponName(entity.heldItem?.name)) {
                const init = ShotFactory.fromPlayer(entity, this.intercepter);
                const info = init.hitsEntity(aabbComponents);
                if (!!info) hittingArrows.push({ entity, shotInfo: info.shotInfo });
            }
        }
        return hittingArrows;
    }

    getAimingEntities(): InfoBoundToEntity[] {
        return this.getMobsAimingAtBot().concat(this.getPlayersAimingAtBot());
    }

    getHighestPriorityEntity(): InfoBoundToEntity | null {
        return this.getAimingEntities().sort((a, b) => a.shotInfo.totalTicks - b.shotInfo.totalTicks)[0] ?? null;
    }

    getShotDestination(entity: Entity): InfoBoundToEntity[] | null {
        if (hasKnownWeaponName(entity.heldItem?.name ?? entity.equipment[1]?.name)) {
            let shot;
            switch (entity.type) {
                case "player":
                    shot = ShotFactory.fromPlayer(entity, this.intercepter);
                    break;
                case "mob":
                    shot = ShotFactory.fromMob(entity, this.intercepter);
                    break;
                default:
                    throw `Invalid entity type: ${entity.type}`;
            }
            const info = shot.hitsEntities(
                true,
                ...Object.values(this.bot.entities).filter((e) => (e.type === "player" || e.type === "mob") && entity !== e)
            );
            return info as { entity: Entity; shotInfo: BasicShotInfo }[];
        }
        return null;
    }

    getProjectileDestination(entity: Entity): InfoBoundToEntity[] | null {
        if (hasKnownProjectileName(entity.name)) {
            let shot = ShotFactory.fromEntity(entity, this.intercepter);
            const info = shot.hitsEntities(
                true,
                ...Object.values(this.bot.entities).filter((e) => e.type === "player" || e.type === "mob")
            );
            return info as { entity: Entity; shotInfo: BasicShotInfo }[];
        }
        return null;
    }
}
