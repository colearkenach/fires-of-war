const fields = foundry.data.fields;
const STATS = ["hp", "strength", "magic", "skill", "speed", "defense", "resistance", "luck", "charm", "build"];
const WEAPONS = ["sword", "lance", "axe", "bow", "firearm", "unarmed", "knife", "anima", "light", "dark", "staff", "monster", "stone"];
const number = (initial = 0) => new fields.NumberField({required: true, nullable: true, initial});
const string = (initial = "") => new fields.StringField({required: true, blank: true, trim: false, initial});
const boolean = (initial = false) => new fields.BooleanField({initial});
const object = (initial = {}) => new fields.ObjectField({initial: () => foundry.utils.deepClone(initial)});
const resource = (value = 0, max = 0) => new fields.SchemaField({value: number(value), max: number(max)});
const uses = (value, max) => new fields.SchemaField({value: number(value), max: number(max), infinite: new fields.BooleanField({persisted: false})});
const stats = (move = false) => new fields.SchemaField(Object.fromEntries([...STATS, ...(move ? ["move"] : [])].map(key => [key, number()])));

class SystemValueField extends fields.AnyField {
    initialize(value) { return foundry.utils.deepClone(value); }
}

const array = (initial = []) => new fields.ArrayField(new SystemValueField(), {initial: () => foundry.utils.deepClone(initial)});

class CharacterData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            attributes: new fields.SchemaField(Object.fromEntries(STATS.map(key => [key, resource()]))),
            growthRates: stats(),
            accumulatedGrowthRates: stats(),
            level: number(1),
            totalLevel: number(1),
            experience: number(),
            biography: string(),
            appearance: string(),
            combat: object({hitRate: 0, critRate: 0, avoid: 0, dodge: 0, damage: 0}),
            weaponRanks: object(Object.fromEntries(WEAPONS.map(key => [key, ""]))),
            battalionRank: string("E"),
            weaponMasteryBonuses: object(),
            movement: new fields.SchemaField({base: number(), current: number()}),
            unitTypes: new SystemValueField({required: true, initial: () => []}),
            rescue: object({active: false}),
            convoyUnit: boolean(),
            mount: object({dismounted: false, lost: false, forced: false}),
            revivalStones: new fields.SchemaField({value: number(), max: number(), enraged: boolean(), bonuses: array()}),
            supportRanks: object(),
            activeSupport: string(),
            affinity: string(),
            weaponExp: number(),
            fatePoints: resource(),
            statusEffects: array(),
            holyBlood: array(),
            crests: array(),
            alternateClasses: array(),
            personalTrait: string(),
            roleplayTraitChoices: object(),
            fatigue: resource(),
            personalDetails: new fields.SchemaField({
                age: number(), sex: string(), height: string(), weight: string(),
                hairColor: string("#000000"), eyeColor: string("#000000"), birthplace: string(), background: string()
            }),
            activeClassName: new fields.StringField({initial: "", persisted: false}),
            activeClassType: new fields.StringField({initial: "", persisted: false}),
            activeSupportBonus: new fields.ObjectField({nullable: true, initial: null, persisted: false}),
            breakdown: new fields.ObjectField({persisted: false})
        };
    }
}

class PartyData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {gold: number(), memberIds: array(), notes: string()};
    }
}

class ShopData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {isOpen: boolean(), buyMultiplier: number(1), sellMultiplier: number(0.5), partyId: string(), notes: string()};
    }
}

class ItemData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            description: string(),
            source: string(),
            bonuses: new fields.SchemaField({
                attributes: stats(true), maximums: stats(true), growthRates: stats(),
                combat: new fields.SchemaField({hitRate: number(), critRate: number(), avoid: number(), dodge: number(), attackSpeed: number()})
            })
        };
    }
}

class PhysicalItemData extends ItemData {
    static defineSchema() {
        return {...super.defineSchema(), price: number(), weight: number(), quantity: number(1)};
    }
}

class InventoryItemData extends PhysicalItemData {
    static defineSchema() {
        return {
            ...super.defineSchema(),
            itemType: string("consumable"), equipped: boolean(), mountSlot: boolean(), mountType: string("Horse"),
            mountRestriction: string(), mountActor: string(), classChange: object({mode: "", classes: []}),
            uses: uses(3, 3), effect: string()
        };
    }
}

class WeaponData extends PhysicalItemData {
    static defineSchema() {
        return {
            ...super.defineSchema(),
            equipped: boolean(), weaponType: string("sword"), might: number(5), hit: number(90), crit: number(),
            range: string("1"), rank: string("E"), prfProficient: boolean(), uses: uses(45, 45),
            properties: new SystemValueField({required: true, initial: () => ({
                illegal: false, legendary: false, slayer: {enabled: false, all: false, types: {}},
                cursed: false, shade: false, deadly: false, magical: false, unwieldy: false, slow: false, mechanical: false,
                abuse: false, absorb: false, puncture: false, piercing: false, brave: false, poison: false, reverse: false,
                superior: false, smash: false, crippling: false, vehicle: false, petrify: false
            })}),
            propertiesNotes: string(), weaponTriangle: object({advantage: "\u2014", disadvantage: "\u2014"})
        };
    }
}

class SpellData extends ItemData {
    static defineSchema() {
        return {
            ...super.defineSchema(),
            school: string("Black Magic"), hpCost: number(1), might: number(3), hit: number(80), crit: number(),
            range: string("1-2"), rank: string("E"), special: string(), admixWeapon: string()
        };
    }
}

class CombatArtData extends ItemData {
    static defineSchema() {
        return {
            ...super.defineSchema(),
            prerequisites: string(), weaponRestriction: string("\u2014"), requiredRank: string(), durabilityCost: number(1),
            might: number(), hit: number(), crit: number(), avoid: number(), dodge: number(), effect: string()
        };
    }
}

class SkillData extends ItemData {
    static defineSchema() {
        return {
            ...super.defineSchema(),
            skillType: string("Passive"), prerequisites: string(), level: string("Innate"), activation: string(),
            grantedByClass: string(), activationTrigger: string("Manual"), activationTargetType: string("stat_mult"),
            activationStat: string("skill"), activationMult: number(1), activationFixed: number(),
            revivalGate: object({mode: "", stones: 0}),
            automation: object({mode: "auto", trigger: "Passive", hp: 0, phase: "any", weapons: "", auraTarget: "enemies", auraRadius: 1,
                attributes: {}, hit: 0, crit: 0, avoid: 0, dodge: 0, damage: 0, damageReduction: 0, defenseMultiplier: 1,
                damageMultiplier: 1, healingFraction: 0, useMultiplier: 1, strikes: 1, brave: false})
        };
    }
}

class ClassData extends ItemData {
    static defineSchema() {
        return {
            ...super.defineSchema(),
            classType: string("Standard"), maxLevel: number(20), movement: number(5), equipped: boolean(),
            unitTypes: object(), weaponProficiencies: object(), baseStats: object(), growthRates: object(), statCaps: object(),
            classSkills: array(), roleplayTraits: array([{base: "", alternative: ""}, {base: "", alternative: ""}, {base: "", alternative: ""}]),
            promotions: array(), currentPath: array()
        };
    }
}

class BattalionData extends ItemData {
    static defineSchema() {
        return {
            ...super.defineSchema(),
            endurance: resource(), movePenalty: number(), might: number(8), hit: number(10), crit: number(),
            range: string("3x1"), rank: string("E"), properties: string(), area: object({cells: [], origin: "5,9", reach: 0}),
            battalionType: string(),
            price: new fields.NumberField({required: false, nullable: true}),
            weight: new fields.NumberField({required: false, nullable: true}),
            quantity: new fields.NumberField({required: false, nullable: true})
        };
    }
}

class MiscBonusData extends ItemData {
    static defineSchema() {
        return {...super.defineSchema(), enabled: boolean(true)};
    }
}

export function registerDataModels() {
    Object.assign(CONFIG.Actor.dataModels, {character: CharacterData, party: PartyData, shop: ShopData});
    Object.assign(CONFIG.Item.dataModels, {weapon: WeaponData, item: InventoryItemData, skill: SkillData, spell: SpellData,
        class: ClassData, battalion: BattalionData, combatArt: CombatArtData, miscBonus: MiscBonusData});
}
