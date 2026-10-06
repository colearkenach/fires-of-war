/** Pure Fires of War rules shared by Foundry and tests. */

export const WEAPON_RANK_ORDER = Object.freeze(["", "E", "D", "C", "B", "A", "S"]);

/** An explicit 0/0 use pool is unlimited; 0 with a positive maximum is depleted. */
export function hasInfiniteUses(uses) {
    // Remove Durability marks prepared weapon uses as infinite without changing the stored values.
    if (uses?.infinite === true) return true;
    return uses?.value != null && uses?.max != null && Number(uses.value) === 0 && Number(uses.max) === 0;
}

export function formatUses(uses) {
    return hasInfiniteUses(uses) ? "∞" : uses ? `${uses.value ?? 0}/${uses.max ?? 0}` : "";
}

/** Normalize actor/weapon rank data without allowing malformed legacy values through. */
export function normalizeWeaponRank(value, { allowPrf = false } = {}) {
    if (typeof value !== "string") return "";
    const rank = value.trim();
    if (allowPrf && rank.toLowerCase() === "prf") return "Prf";
    const normalized = rank.toUpperCase();
    return WEAPON_RANK_ORDER.includes(normalized) ? normalized : "";
}

export function weaponRankIndex(value) {
    return WEAPON_RANK_ORDER.indexOf(normalizeWeaponRank(value));
}

/** Class-granted proficiency caps from Fires of War. */
export function classWeaponRankCap(classType) {
    if (classType === "Recruit") return "C";
    if (classType === "Standard") return "A";
    if (["Promoted", "Advanced", "Enemy Only", "Monster"].includes(classType)) return "S";
    return "A";
}

export function canBuyOffClassWeaponRank(classType) {
    return classType === "Promoted" || classType === "Advanced";
}

/** Resolve the attainable rank for one weapon group in the active class. */
export function weaponRankLimit({ classType, isClassProficient, hasOtherS = false }) {
    if (!isClassProficient) return "C";
    const cap = classWeaponRankCap(classType);
    if (cap === "S" && canBuyOffClassWeaponRank(classType) && hasOtherS) return "A";
    return cap;
}

export function clampPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.min(Math.max(Math.floor(number), 0), 100);
}

/** Resolve a configured activated-skill TN safely. */
export function computeSkillActivationTarget({ type, statValue, multiplier, fixed }) {
    if (type === "fixed") return clampPercent(fixed);
    const stat = Number.isFinite(Number(statValue)) ? Number(statValue) : 0;
    if (type === "stat") return clampPercent(stat);
    const mult = Number.isFinite(Number(multiplier)) ? Number(multiplier) : 1;
    return clampPercent(stat * mult);
}

const SKILL_STAT_MAP = Object.freeze({
    hp: "hp", "hit points": "hp",
    str: "strength", strength: "strength",
    mag: "magic", magic: "magic",
    skl: "skill", skill: "skill",
    spd: "speed", speed: "speed",
    def: "defense", defense: "defense",
    res: "resistance", resistance: "resistance",
    lck: "luck", luck: "luck",
    cha: "charm", charm: "charm",
    bld: "build", build: "build",
    move: "move", movement: "move"
});

const SKILL_COMBAT_MAP = Object.freeze({
    hit: "hitRate", "hit rate": "hitRate",
    crit: "critRate", "crit rate": "critRate", critical: "critRate",
    avo: "avoid", avoid: "avoid",
    dodge: "dodge", dge: "dodge",
    as: "attackSpeed", "attack speed": "attackSpeed"
});

/**
 * Parse explicitly signed skill bonuses. Requiring + or - prevents ordinary
 * rules text such as Canto's "8 Move" example from becoming a stat bonus.
 */
export function parseSignedSkillBonuses(text) {
    const result = {
        attributes: { hp: 0, strength: 0, magic: 0, skill: 0, speed: 0, defense: 0, resistance: 0, luck: 0, charm: 0, build: 0, move: 0 },
        maximums: { hp: 0, strength: 0, magic: 0, skill: 0, speed: 0, defense: 0, resistance: 0, luck: 0, charm: 0, build: 0, move: 0 },
        growthRates: { hp: 0, strength: 0, magic: 0, skill: 0, speed: 0, defense: 0, resistance: 0, luck: 0, charm: 0, build: 0 },
        combat: { hitRate: 0, critRate: 0, avoid: 0, dodge: 0, attackSpeed: 0 }
    };
    if (typeof text !== "string" || !text.trim()) return result;

    const clauses = text.split(/[,;]|\band\b/i).map(clause => clause.trim()).filter(Boolean);
    for (const clause of clauses) {
        const growthMatch = clause.match(/([+-]\d+)%?\s*growth\s+(.+)/i);
        if (growthMatch) {
            const key = SKILL_STAT_MAP[growthMatch[2].trim().toLowerCase()];
            if (key && key in result.growthRates) result.growthRates[key] += Number(growthMatch[1]);
            continue;
        }

        const maxMatch = clause.match(/([+-]\d+)\s*max\s+(.+)/i);
        if (maxMatch) {
            const key = SKILL_STAT_MAP[maxMatch[2].trim().toLowerCase()];
            if (key && key in result.maximums) result.maximums[key] += Number(maxMatch[1]);
            continue;
        }

        const statMatch = clause.match(/([+-]\d+)\s+(.+)/i);
        if (!statMatch) continue;
        const value = Number(statMatch[1]);
        const name = statMatch[2].trim().toLowerCase();
        if (SKILL_COMBAT_MAP[name]) result.combat[SKILL_COMBAT_MAP[name]] += value;
        else if (SKILL_STAT_MAP[name] && SKILL_STAT_MAP[name] in result.attributes) result.attributes[SKILL_STAT_MAP[name]] += value;
    }
    return result;
}

/** Whether a Combat Art can be used with a given equipped weapon group. */
export function combatArtAllowsWeaponType(restriction, weaponType) {
    const required = typeof restriction === "string" ? restriction.trim().toLowerCase() : "";
    const equipped = typeof weaponType === "string" ? weaponType.trim().toLowerCase() : "";
    if (!equipped) return false;
    if (!required || ["—", "-", "any", "none", "â€”"].includes(required)) return true;
    if (required === "fists") return equipped === "unarmed";
    return required === equipped;
}

const ART_STATS = {hp: "hp", str: "strength", strength: "strength", mag: "magic", magic: "magic", skl: "skill", dex: "skill", skill: "skill", spd: "speed", speed: "speed", lck: "luck", luck: "luck", def: "defense", defense: "defense", res: "resistance", resistance: "resistance", cha: "charm", charm: "charm", bld: "build", build: "build"};
const artWeaponKey = name => ({fists: "unarmed", brawling: "unarmed", swords: "sword", lances: "lance", axes: "axe", bows: "bow", knives: "knife", guns: "firearm"}[name] ?? name);
const artWeaponGroups = new Set(["any", "sword", "lance", "axe", "bow", "knife", "unarmed", "firearm", "anima", "light", "dark", "staff", "stone", "monster"]);

/** Shared by the sheet, HUD and execution so hidden arts cannot bypass prerequisites. */
export function combatArtReason(actor, art, weapon = actor?.items?.find(i => i.type === "weapon" && i.system?.equipped)) {
    if (!weapon || ["staff", "anima", "light", "dark", "spell"].includes(String(weapon.system?.weaponType).toLowerCase()) || !combatArtAllowsWeaponType(art.system?.weaponRestriction, weapon.system?.weaponType)) return "Equip a compatible physical weapon.";
    if (actor.canUseWeapon && !actor.canUseWeapon(weapon)) return "Weapon proficiency required.";
    const uses = weapon.system?.uses;
    if (uses && !hasInfiniteUses(uses) && Number(uses.value) < Math.max(1, Number(art.system?.durabilityCost) || 0)) return "Not enough weapon durability.";
    const ranks = actor.system?.weaponRanks ?? {};
    const meetsRank = (type, rank) => (type === "any" ? Object.values(ranks) : [ranks[artWeaponKey(type)]]).some(value => weaponRankIndex(value) >= weaponRankIndex(rank));
    const required = normalizeWeaponRank(art.system?.requiredRank);
    if (required && !meetsRank(String(weapon.system.weaponType).toLowerCase(), required)) return `Requires ${required} weapon rank.`;
    const meets = clause => {
        const text = clause.trim().toLowerCase();
        if (!text || ["none", "any", "—", "-"].includes(text)) return true;
        const stat = text.match(/^([a-z]+)\s*(?:>=|≥|:)?\s*(\d+)\+?$/);
        if (stat && ART_STATS[stat[1]]) return Number(actor.system?.attributes?.[ART_STATS[stat[1]]]?.value || 0) >= Number(stat[2]);
        // "Level 5" is the current class level; "TL 20+" / "Total Level 5+" is Total Level.
        const level = text.match(/^(?:(tl|total\s*level)|level|lvl)\s*(?:>=|≥|:)?\s*(\d+)\+?$/);
        if (level) return Number((level[1] ? actor.system?.totalLevel || actor.system?.level : actor.system?.level) || 0) >= Number(level[2]);
        // "Lance E", "Lance Rank E", "Lance E Rank", "Any C Rank", "any weapon at D Rank".
        const rank = text.match(/^(any|[a-z]+)(?:\s+weapons?)?(?:\s+at)?\s*(?:rank\s*)?([edcbas])\+?(?:\s+rank)?$/);
        if (rank && artWeaponGroups.has(artWeaponKey(rank[1]))) return meetsRank(rank[1], rank[2].toUpperCase());
        const reversedRank = text.match(/^([edcbas])\s+(any|[a-z]+)$/);
        if (reversedRank && artWeaponGroups.has(artWeaponKey(reversedRank[2]))) return meetsRank(reversedRank[2], reversedRank[1].toUpperCase());
        const named = text.replace(/^(?:skill|class)\s*:\s*/, "");
        return Array.from(actor.items ?? []).some(i => ["skill", "class"].includes(i.type) && String(i.name).trim().toLowerCase() === named && (i.type !== "class" || i.system?.equipped) && i.system?.automation?.mode !== "off");
    };
    for (const clause of String(art.system?.prerequisites ?? "").split(/[,;]|\s+and\s+/i)) {
        if (!clause.split(/\s+or\s+/i).some(meets)) return `Requires ${clause.trim()}.`;
    }
    return "";
}

/** Skills that have an explicit player-facing action in the Token HUD. */
export function isTokenActionSkillType(skillType) {
    return skillType === "Active" || skillType === "Passive (Activated)";
}

const STAT_WORDS = Object.freeze({hp: "hp", "max hp": "hp", str: "strength", strength: "strength", mag: "magic", magic: "magic",
    skl: "skill", skill: "skill", spd: "speed", speed: "speed", def: "defense", defense: "defense", res: "resistance", resistance: "resistance",
    lck: "luck", luk: "luck", luck: "luck", cha: "charm", charm: "charm", bld: "build", build: "build", con: "build", constitution: "build",
    mov: "move", move: "move", movement: "move"});
export const STAT_SHORT = Object.freeze({hp: "Max HP", strength: "STR", magic: "MAG", skill: "SKL", speed: "SPD", defense: "DEF",
    resistance: "RES", luck: "LUK", charm: "CHA", build: "BLD", move: "MOV"});

/** Stat effects in an item's text: "Permanently increase STR by 2" (stat boosters) and
 * "Grants +7 RES when used, decreases by 1 each turn" or "+2 DEF for 3 turns" (temporary). */
export function parseItemStatEffects(text) {
    const effect = String(text ?? "").toLowerCase().replace(/\s+/g, " ");
    const permanent = [], temporary = [];
    for (const match of effect.matchAll(/permanently (?:increases?|raises?|boosts?) (?:the user'?s |your )?(max hp|[a-z]+) by (\d+)/g)) {
        const stat = STAT_WORDS[match[1]];
        if (stat) permanent.push({stat, amount: Number(match[2])});
    }
    for (const match of effect.matchAll(/(?:grants?|gives?|gain) \+(\d+) (max hp|[a-z]+)\b([^.]*)/g)) {
        const stat = STAT_WORDS[match[2]], rest = match[3];
        if (!stat || stat === "hp") continue;
        const decay = Number(rest.match(/decreas\w* by (\d+) each (?:turn|phase)/)?.[1] ?? 0);
        const turns = Number(rest.match(/for (\d+) (?:turns?|phases?)/)?.[1] ?? 0);
        const amount = Number(match[1]);
        temporary.push({stat, amount, decay, duration: decay ? Math.ceil(amount / decay) : turns || 1});
    }
    return {permanent, temporary};
}
