// Fires of War system for Foundry VTT
// Clean rewrite without sanitizers

import {
    WEAPON_RANK_ORDER,
    canBuyOffClassWeaponRank,
    clampPercent,
    combatArtAllowsWeaponType,
    combatArtReason,
    computeSkillActivationTarget,
    hasInfiniteUses,
    formatUses,
    isTokenActionSkillType,
    normalizeWeaponRank,
    parseSignedSkillBonuses,
    weaponRankIndex,
    weaponRankLimit,
    parseItemStatEffects,
    STAT_SHORT
} from "./module/rules/feue.mjs";
import {
    clampTraitTarget,
    getClassRoleplayTraits,
    isSuccessfulTraitRoll,
    roleplayTraitFormula
} from "./module/rules/roleplay-traits.mjs";
import {registerTacticalForecast} from "./module/map/tactical-forecast.mjs";
import {createBattleForecast, renderBattleForecast, requestBattleAttack, registerBattleForecast, reverseTriangle, forecastTriangle, presentCombatText, defeatEnemyTokens, battleDeclarations} from "./module/combat/battle-forecast.mjs";
import {tokenInItemRange} from "./module/ui/character-action-hud.mjs";
import {registerCharacterActionHud} from "./module/ui/character-action-hud.mjs";
import {registerTacticalEncounter} from "./module/encounter/tactical-encounter.mjs";
import {applyTerrainStats, getAppliedTerrain, terrainCombatStats, tokenTerrain} from "./module/map/terrain.mjs";
import {applyRescueStats, getRescueBase, rescueMovementHalved} from "./module/encounter/event-rules.mjs";
import {registerEventInteractions} from "./module/encounter/event-interactions.mjs";
import {registerConvoy, requestConvoy, inventoryUsage} from "./module/units/convoy.mjs";
import {convoySheetData, convoyUnits, bindConvoySheet, dropConvoyItem} from "./module/units/convoy-ui.mjs";
import {hasSkill, skillRule, skillAutomationConfig, skillAutomationInfo, passiveTextBonuses, passiveSkillBonuses, skillModifiers, triggerSkills, TOME_TYPES} from "./module/skills/skill-automation.mjs";
import {registerUnitActions, assertUnitAction, actorActionToken, completeMajorAction, applyMountProfile, toggleMount, unitCombatant, relaySheetAction, validateUnitTarget, withUnitActionLock} from "./module/units/unit-actions.mjs";
import {resolveWeaponEffects, timedEffectTerms, healActor, finishCombatEffects, displaceTokens, addTimedEffect} from "./module/combat/combat-effects.mjs";
import {useActiveSkill, activeSkillRule, activeSkillUsable} from "./module/skills/active-skills.mjs";
import {StatLedger, term, sumTerms, breakdownHtml, tooltipAttributes} from "./module/ui/stat-breakdown.mjs";
import {combatStatDisplay, attributeDisplay, movementDisplay, COMBAT_STATS} from "./module/ui/stat-display.mjs";
import {AREA_PRESETS, DEFAULT_ORIGIN, EDITOR_SIZE, battalionArea, battalionOperational, battalionStats, battalionTooltip, battalionUseReason, editorArea, normalizeShape, resolveBattalion} from "./module/combat/battalions.mjs";
import {statusStatModifiers, isIncapacitated, isSilenced, activeStatuses, statusImmune, STATUS_RULES, CONDITION_ICONS, DEAD_STATUS, conditionForStatus} from "./module/rules/status-rules.mjs";
import {registerConditions, toggleCondition, setCondition} from "./module/rules/conditions.mjs";
import {registerAltRuleSettings, weaponTriangle, triangleOverride, durabilityExempt, perMapTracked, perMapArtCost, artCostMode, effectivePrice, revivalEnabled, revivalAllowed,
    revivalState, revivalHpMultiplier, revivalBonusTerms, revivalSkillOpen, REVIVAL_STAT_KEYS, fateEnabled, fateMax, fatePoints, replaceableMounts, isMountItem, mountLost, sameEquipSlot} from "./module/rules/alt-rules.mjs";
import {registerPhaseBanner} from "./module/encounter/phase-banner.mjs";
import {registerCombatAI} from "./module/ai/combat-ai.mjs";
import {registerAllegianceUI, actorAllegiance, allegianceOptions, setActorAllegiance} from "./module/units/allegiance-ui.mjs";
import {openClassPicker, classChipsHtml, classStatTableHtml, baseStatLabel, registerClassUI} from "./module/ui/class-ui.mjs";
import {openItemPicker, hasItemPicker} from "./module/ui/item-pickers.mjs";
import {openSupportPicker} from "./module/units/support-picker.mjs";
import {seedMonsterContent} from "./module/rules/monster-classes.mjs";
import {registerTokenIndicators} from "./module/map/token-indicators.mjs";
import {registerFallRules, spendFatePoint, fateSkillReroll, recordMapUse, perMapArtReason, resolveExchangeFalls, refreshFatePoints} from "./module/rules/fall-rules.mjs";
import {activeClassChange, classChangeConfig, classChangeItemsEnabled, consumeClassChangeItem, hasUsesLeft, knownClassNames, promotesClass, promotionItemsFor, secondSealRequired, secondSealsOf} from "./module/rules/class-change.mjs";
import {esc} from "./module/map/terrain-ui.mjs";

registerTacticalForecast();
registerBattleForecast();
registerTacticalEncounter();
registerConvoy();
registerEventInteractions();
registerUnitActions();
registerFallRules();
registerConditions();
registerPhaseBanner();
registerCombatAI();
registerAllegianceUI();
registerClassUI();
registerTokenIndicators();
registerCharacterActionHud((actor, action, item, options) => {
    const sheet = actor.sheet;
    switch (action) {
        case "attack": return sheet._promptWeaponAttack(item, options);
        case "staff": return sheet._useStaff(item, options);
        case "item": return sheet._useItem(item, {...options, consume: item.system.itemType !== "equippable"});
        case "art": return sheet._executeCombatArt(item, options.weapon, options);
        case "spell":
        case "heal": return sheet._castSpell(item, options);
        case "activation": return sheet._rollSkillActivation(item);
        case "battalion": return sheet._beginBattalion(item, options);
        case "skill": return sheet._useSkill(item, options);
        case "details": return item.sheet.render(true);
    }
});

// ====================================================================
// 1. CONSTANTS
// ====================================================================
const FEUE = {
    WEAPON_RANKS: {
        "": { order: -1, label: "—" },
        "E": { order: 0, label: "E" },
        "D": { order: 1, label: "D" },
        "C": { order: 2, label: "C" },
        "B": { order: 3, label: "B" },
        "A": { order: 4, label: "A" },
        "S": { order: 5, label: "S" }
    },
    AFFINITIES: ["Fire", "Thunder", "Wind", "Ice", "Earth", "Dark", "Light", "Anima"],
    UNIT_TYPES: ["Infantry", "Mounted", "Flying", "Dragon", "Armored", "Magician", "Beast", "Mechanical", "Monster"],
    CLASS_TYPES: ["Recruit", "Standard", "Promoted", "Advanced", "Enemy Only", "Monster"],
    MAG_WEAPON_TYPES: ["anima", "light", "dark", "staff", "stone"],
    STAT_KEYS: ["hp", "strength", "magic", "skill", "speed", "defense", "resistance", "luck", "charm", "build"],
    STAT_LABELS: { hp: "HP", strength: "Str", magic: "Mag", skill: "Skl", speed: "Spd", defense: "Def", resistance: "Res", luck: "Lck", charm: "Cha", build: "Bld" },
    WeaponTypes: {
        "sword": "Sword", "lance": "Lance", "axe": "Axe", "bow": "Bow",
        "firearm": "Firearm", "unarmed": "Unarmed", "knife": "Knife",
        "anima": "Anima", "light": "Light", "dark": "Dark",
        "staff": "Staff", "monster": "Monster", "stone": "Stone"
    },
    MASTERY_BONUSES: {
        hitRate: { label: "Hit Rate", step: 5, suffix: "%" },
        critRate: { label: "Crit Rate", step: 5, suffix: "%" },
        avoid: { label: "Avoid", step: 5, suffix: "%" },
        dodge: { label: "Dodge", step: 5, suffix: "%" },
        attackSpeed: { label: "Attack Speed", step: 2, suffix: "" }
    },
    STATUS_EFFECTS: [
        "Berserk", "Silence", "Sleep", "Poison", "Petrification",
        "Paralysis", "Shock", "Rattled", "Confusion", "Blood Sacrifice",
        "Burning", "Buffeted", "Frozen", "Guard Break", "Knocked Out"
    ],
    SUPPORT_RANKS: ["C", "B", "A", "S"],
    SUPPORT_RANK_MULTIPLIER: { C: 1, B: 2, A: 3, S: 4 },
    AFFINITY_BONUSES: {
        Fire: { primary: "Atk", secondary: "Hit", pVal: 1, sVal: 1 },
        Thunder: { primary: "Def", secondary: "Avo", pVal: 1, sVal: 1 },
        Wind: { primary: "AS", secondary: "Avo", pVal: 1, sVal: 1 },
        Ice: { primary: "Res", secondary: "Dodge", pVal: 1, sVal: 1 },
        Earth: { primary: "Avo", secondary: "Dodge", pVal: 1, sVal: 1 },
        Dark: { primary: "Crit", secondary: "Atk", pVal: 1, sVal: 1 },
        Light: { primary: "Hit", secondary: "Crit", pVal: 1, sVal: 1 },
        Anima: { primary: "Dodge", secondary: "Res", pVal: 1, sVal: 1 }
    }
};

// Common crest names. The list is display-only; users can type any value.
FEUE.CREST_SUGGESTIONS = [
    "Crest of Dawn", "Crest of Dusk", "Crest of Storms", "Crest of Embers",
    "Crest of Rivers", "Crest of Stone", "Crest of Iron", "Crest of Glass",
    "Crest of Stars", "Crest of Ash", "Crest of Thorns", "Crest of Bells",
    "Crest of Ravens", "Crest of Roses", "Crest of Keys", "Crest of Crowns",
    "Crest of Lanterns", "Crest of Blades", "Crest of the Wild"
];

FEUE.HOLY_BLOOD = {
    "Dawn":    { weapon: "Sunblade",      growths: { hp: 2, strength: 1, skill: 1, luck: 1 } },
    "Dusk":    { weapon: "Moonbrand",     growths: { hp: 2, skill: 3 } },
    "Storm":   { weapon: "Stormlance",    growths: { hp: 2, speed: 3 } },
    "Gale":    { weapon: "Skystring",     growths: { hp: 2, luck: 3 } },
    "Mercy":   { weapon: "Mercy Bell",    growths: { magic: 1, resistance: 2, luck: 1, charm: 1 } },
    "Thunder": { weapon: "Stormcaller",   growths: { hp: 2, skill: 3 } },
    "Ember":   { weapon: "Cinderheart",   growths: { hp: 2, magic: 3 } },
    "Night":   { weapon: "Gravebrand",    growths: { hp: 2, strength: 3 } },
    "Tide":    { weapon: "Tidebreaker",   growths: { hp: 2, strength: 1, speed: 1, defense: 1 } },
    "Iron":    { weapon: "Ironroot",      growths: { strength: 2, defense: 3 } },
    "Star":    { weapon: "Starfire",      growths: { hp: 1, magic: 2, resistance: 2 } },
    "Wind":    { weapon: "Windwake",      growths: { hp: 2, speed: 3 } },
    "Shadow":  { weapon: "Shadowfall",    growths: { hp: 1, magic: 2, resistance: 2 } }
};

FEUE.WEAPON_RANK_ARTS = {
    sword: {
        D: [{ name: "Wrath Strike", might: 5, hit: 10, crit: 0, durabilityCost: 3, effect: "No additional effect." }],
        C: [{ name: "Grounder", might: 3, hit: 10, crit: 0, durabilityCost: 3, effect: "Effective against flying." }],
        B: [{ name: "Soulblade", might: 0, hit: 10, crit: 10, durabilityCost: 3, effect: "Adds RES to damage." }],
        A: [{ name: "Hexblade", might: 8, hit: 0, crit: 0, durabilityCost: 4, effect: "Targets enemy RES." }],
        S: [{ name: "Sublime Heaven", might: 10, hit: 10, crit: 20, durabilityCost: 5, effect: "Effective against dragons." }]
    },
    lance: {
        D: [{ name: "Tempest Lance", might: 8, hit: 0, crit: 0, durabilityCost: 4, effect: "No additional effect." }],
        C: [{ name: "Knightkneeler", might: 6, hit: 10, crit: 0, durabilityCost: 3, effect: "Effective against cavalry." }],
        B: [{ name: "Lance Jab", might: 3, hit: 0, crit: 0, durabilityCost: 3, effect: "Follow-up attack." }],
        A: [{ name: "Glowing Ember", might: 0, hit: 0, crit: 0, durabilityCost: 4, effect: "Adds DEF to damage." }],
        S: [{ name: "Paraselene", might: 10, hit: 5, crit: 10, durabilityCost: 5, effect: "Grants +5 DEF for 1 turn." }]
    },
    axe: {
        D: [{ name: "Smash", might: 3, hit: 20, crit: 0, durabilityCost: 3, effect: "No additional effect." }],
        C: [{ name: "Helm Splitter", might: 7, hit: 0, crit: 0, durabilityCost: 4, effect: "Effective against armored." }],
        B: [{ name: "Focused Strike", might: 3, hit: 30, crit: 0, durabilityCost: 3, effect: "No additional effect." }],
        A: [{ name: "Lightning Axe", might: 0, hit: 0, crit: 0, durabilityCost: 4, effect: "Adds RES to damage. Targets enemy RES." }],
        S: [{ name: "Apocalyptic Flame", might: 12, hit: 0, crit: 10, durabilityCost: 5, effect: "Effective against dragons." }]
    },
    bow: {
        D: [{ name: "Curved Shot", might: 1, hit: 30, crit: 0, durabilityCost: 3, effect: "+1 Range." }],
        C: [{ name: "Break Shot", might: 1, hit: 0, crit: 0, durabilityCost: 3, effect: "Inflicts -5 DEF on target." }],
        B: [{ name: "Heavy Draw", might: 8, hit: 0, crit: 0, durabilityCost: 3, effect: "Effective against armored." }],
        A: [{ name: "Ward Arrow", might: 0, hit: 0, crit: 0, durabilityCost: 4, effect: "Inflicts Silence." }],
        S: [{ name: "Hunter's Volley", might: 3, hit: 0, crit: 0, durabilityCost: 5, effect: "Attacks twice." }]
    },
    knife: {
        D: [{ name: "Shiv", might: 3, hit: 10, crit: 10, durabilityCost: 3, effect: "No additional effect." }],
        C: [{ name: "Assassinate", might: 5, hit: 0, crit: 30, durabilityCost: 4, effect: "No additional effect." }],
        B: [{ name: "Windsweep", might: 0, hit: 20, crit: 0, durabilityCost: 3, effect: "Target cannot counterattack." }],
        A: [{ name: "Lethality", might: 0, hit: -10, crit: 50, durabilityCost: 5, effect: "No additional effect." }],
        S: [{ name: "Foul Play", might: 0, hit: 0, crit: 0, durabilityCost: 3, effect: "Swap positions with an ally." }]
    },
    unarmed: {
        D: [{ name: "Fading Blow", might: 3, hit: 10, crit: 0, durabilityCost: 3, effect: "Grants +5 AVO for 1 turn." }],
        C: [{ name: "Rushing Blow", might: 5, hit: 0, crit: 0, durabilityCost: 3, effect: "Move +1 after attacking." }],
        B: [{ name: "Mystic Blow", might: 6, hit: 0, crit: 0, durabilityCost: 4, effect: "Targets enemy RES." }],
        A: [{ name: "Nimble Combo", might: 3, hit: 20, crit: 10, durabilityCost: 4, effect: "Attacks twice." }],
        S: [{ name: "Astra", might: 0, hit: 0, crit: 0, durabilityCost: 5, effect: "Attacks five times at half damage." }]
    },
    firearm: {
        D: [{ name: "Steady Shot", might: 0, hit: 20, crit: 0, durabilityCost: 3, effect: "No additional effect." }],
        C: [{ name: "Piercing Shot", might: 5, hit: 0, crit: 0, durabilityCost: 3, effect: "Ignores half of target DEF." }],
        B: [{ name: "Scatter Shot", might: -2, hit: -10, crit: 0, durabilityCost: 4, effect: "Hits all adjacent enemies." }],
        A: [{ name: "Deadeye", might: 3, hit: 0, crit: 30, durabilityCost: 4, effect: "+2 Range." }],
        S: [{ name: "Annihilation Round", might: 15, hit: -20, crit: 20, durabilityCost: 5, effect: "Effective against armored." }]
    }
};

const DEFAULT_WEAPON_RANKS = Object.fromEntries(
    Object.keys(FEUE.WeaponTypes).map(type => [type, ""])
);
const RANK_ORDER = WEAPON_RANK_ORDER;
function rankIdx(r) { return weaponRankIndex(r); }
function rankLabel(r) { return normalizeWeaponRank(r) || "—"; }
/** Nobility allows a second Battalion. */
const battalionLimit = actor => hasSkill(actor, "nobility") ? 2 : 1;
/** Spell HP cost after Admix (−2, minimum 1) and Spell Mastery (halved, rounded down). */
function spellHpCost(actor, spell, admix) {
    const base = Math.max(0, Number(spell.system.hpCost || 0));
    const cost = admix ? Math.max(Math.min(base, 1), base - 2) : base;
    return hasSkill(actor, "spell mastery") ? Math.floor(cost / 2) : cost;
}
/** Admix (p. 145): the equipped weapon is the spell's tagged Admix weapon, or a tome of the spell's own name.
 * Weapons named "Spell Admix" still grant it to every spell. Returns that weapon, or null. */
function spellAdmixWeapon(actor, spell) {
    const weapon = actor?.items?.find(i => i.type === "weapon" && i.system?.equipped);
    if (!weapon || !spell) return null;
    const key = value => String(value ?? "").trim().toLowerCase();
    const wanted = key(spell.system?.admixWeapon) || key(spell.name);
    return key(weapon.name) === wanted || key(weapon.name).includes("spell admix") ? weapon : null;
}
let admixWeaponNames = null;
/** Weapon names offered in a spell's Admix field: world weapons and every weapon compendium (loaded once). */
async function admixWeaponOptions() {
    if (admixWeaponNames) return admixWeaponNames;
    const names = new Set(Array.from(game.items ?? []).filter(i => i.type === "weapon").map(i => i.name));
    for (const pack of game.packs.filter(p => p.metadata.type === "Item")) {
        try { for (const entry of await pack.getIndex()) if (entry.type === "weapon") names.add(entry.name); } catch { /* unavailable pack */ }
    }
    return admixWeaponNames = [...names].sort((a, b) => a.localeCompare(b));
}
function weaponTypeKey(value) {
    const key = typeof value === "string" ? value.trim().toLowerCase() : "";
    return Object.hasOwn(FEUE.WeaponTypes, key) ? key : "";
}

// Static Growth Bonus pattern: for a growth rate R (1-10), the list of levels at which +1 is gained.
// For R > 10: floor(R/10) gains every level + one extra gain at pattern[R%10] levels.
FEUE.STATIC_GROWTH_LEVELS = {
    1: [5, 15],
    2: [5, 10, 15, 20],
    3: [4, 7, 10, 14, 17, 20],
    4: [3, 5, 8, 10, 13, 15, 18, 20],
    5: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
    6: [2, 4, 5, 7, 9, 10, 12, 14, 15, 17, 19, 20],
    7: [2, 3, 5, 6, 8, 9, 10, 12, 13, 15, 16, 18, 19, 20],
    8: [2, 3, 4, 5, 7, 8, 9, 10, 12, 13, 14, 15, 17, 18, 19, 20],
    9: [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    10: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
};

/** Return static gain at the given level for a growth rate (effective GR after all bonuses). */
function feueStaticGain(gr, level) {
    const g = Math.max(0, Math.floor(Number(gr) || 0));
    if (g <= 0) return 0;
    const whole = Math.floor(g / 10);
    const rem = g % 10;
    const extra = rem > 0 && FEUE.STATIC_GROWTH_LEVELS[rem]?.includes(level) ? 1 : 0;
    return whole + extra;
}

// ====================================================================
// 2. ACTOR CLASS
// ====================================================================
class FiresOfWarActor extends Actor {

    async _onCreate(data, options, userId) {
        super._onCreate(data, options, userId);
        if (game.user.id !== userId) return;
        if (this.type !== "character") return;
        await this._getOrCreateLevelUpBonus();
    }

    /** Token HUD and macros: a rulebook condition's icon adds or removes the condition (with its duration) on the sheet. */
    async toggleStatusEffect(statusId, options = {}) {
        const condition = this.type === "character" && conditionForStatus(statusId);
        return condition ? toggleCondition(this, condition, options) : super.toggleStatusEffect(statusId, options);
    }

    _blankBonuses() {
        return {
            attributes: { hp: 0, strength: 0, magic: 0, skill: 0, speed: 0, defense: 0, resistance: 0, luck: 0, charm: 0, build: 0, move: 0 },
            maximums: { hp: 0, strength: 0, magic: 0, skill: 0, speed: 0, defense: 0, resistance: 0, luck: 0, charm: 0, build: 0, move: 0 },
            growthRates: { hp: 0, strength: 0, magic: 0, skill: 0, speed: 0, defense: 0, resistance: 0, luck: 0, charm: 0, build: 0 },
            combat: { hitRate: 0, critRate: 0, avoid: 0, dodge: 0, attackSpeed: 0 }
        };
    }

    /** Parse skill activation text for bonus patterns like "+2 Strength", "+10 Hit", "+5% Growth HP", "+3 Max Def" */
    _parseSkillBonuses(text) {
        return parseSignedSkillBonuses(text);
    }

    /** Sum item bonuses. `sources` keeps one tooltip term per item and stat. */
    _collectBonuses() {
        const totals = this._blankBonuses();
        totals.sources = [];
        const bonusItems = this.items.filter(i => {
            if (i.type === "skill") return i.system?.skillType === "Passive" && !skillRule(i) && !activeSkillRule(i) && i.system?.automation?.mode !== "off" && revivalSkillOpen(i);
            if (i.type === "item") {
                if (i.system.itemType === "miscellaneous") return false;
                // Equippable items only grant bonuses when equipped; a mount's benefits need a rider on it.
                if (i.system.itemType === "equippable") return i.system.equipped === true && !(isMountItem(i) && (this.system.mount?.dismounted || mountLost(i)));
                return true; // Consumables always apply their bonuses (if any)
            }
            if (i.type === "miscBonus" && i.system?.enabled !== false) return true;
            return false;
        });
        const equippedWeapon = this.items.find(i => i.type === "weapon" && i.system?.equipped);
        if (equippedWeapon) bonusItems.push(equippedWeapon);
        // Battalion bonuses (Great Protectors, Archsage School) apply while the Battalion has Endurance.
        bonusItems.push(...this.items.filter(i => i.type === "battalion" && battalionOperational(i)));
        const add = (item, field, key, raw) => {
            const value = Number(raw || 0);
            if (!value) return;
            totals[field][key] += value;
            const label = item.getFlag?.("fires-of-war", "isLevelUpBonus") || item.name === "Bonuses from Level Up" ? "Level-up gains" : item === equippedWeapon ? `${item.name} (equipped)` : item.name;
            totals.sources.push({path: `${field}.${key}`, label, value});
        };
        for (const item of bonusItems) {
            const b = item.system?.bonuses || {};
            for (const field of ["attributes", "maximums", "growthRates", "combat"]) for (const k of Object.keys(totals[field])) add(item, field, k, b[field]?.[k]);

            // Parse skill activation text for additional bonuses
            if (item.type === "skill" && item.system?.activation) {
                const parsed = passiveTextBonuses(item);
                if (!parsed) continue;
                for (const field of ["attributes", "maximums", "growthRates", "combat"]) for (const k of Object.keys(totals[field])) add(item, field, k, parsed[field][k]);
            }
        }
        const passives = passiveSkillBonuses(this);
        for (const field of ["maximums", "growthRates"]) for (const [key, value] of Object.entries(passives[field])) totals[field][key] = (totals[field][key] ?? 0) + value;
        totals.sources.push(...passives.terms.filter(t => /^(maximums|growthRates)\./.test(t.path)));
        return totals;
    }

    /** Collapse duplicate Level-Up Bonus items. Keeps the one with the flag (or first match) and deletes others. */
    async _dedupeLevelUpBonus() {
        const matches = this.items.filter(i =>
            i.type === "miscBonus" && (i.getFlag("fires-of-war", "isLevelUpBonus") || i.name === "Bonuses from Level Up")
        );
        if (matches.length <= 1) {
            if (matches.length === 1 && !matches[0].getFlag("fires-of-war", "isLevelUpBonus")) {
                await matches[0].setFlag("fires-of-war", "isLevelUpBonus", true);
            }
            return matches[0] || null;
        }
        const keeper = matches.find(i => i.getFlag("fires-of-war", "isLevelUpBonus")) || matches[0];
        const extras = matches.filter(i => i.id !== keeper.id);
        if (!keeper.getFlag("fires-of-war", "isLevelUpBonus")) await keeper.setFlag("fires-of-war", "isLevelUpBonus", true);
        await this.deleteEmbeddedDocuments("Item", extras.map(i => i.id));
        return keeper;
    }

    /** Find or create the permanent "Bonuses from Level Up" miscBonus item. */
    /** Stat boosters (Energy Ring, Secret Book...) add permanent bonuses to a "Stat Boosters" item, up to the stat's cap.
     * Returns the amount gained (0 when the stat is already at its maximum). */
    async _applyStatBooster(stat, amount) {
        const sys = this.system;
        let room = Infinity;
        if (stat === "hp") {
            const ec = this.items.find(i => i.type === "class" && i.system?.equipped);
            const cap = Number(ec ? this._getCurrentClassNode(ec).statCaps?.hp : 0) || 0;
            if (cap > 0) room = cap - Number(sys.attributes?.hp?.max || 0);
        } else if (stat !== "move") {
            const attribute = stat === "speed" ? getRescueBase(this)?.speed ?? sys.attributes?.speed : sys.attributes?.[stat];
            const cap = Number(attribute?.max || 0);
            const current = Number(attribute?.value || 0) - (stat === "defense" ? getAppliedTerrain(this).defense : 0);
            if (cap > 0) room = cap - current;
        }
        const gained = Math.max(0, Math.min(Number(amount) || 0, room));
        if (!gained) return 0;
        let bonus = this.items.find(i => i.type === "miscBonus" && i.getFlag("fires-of-war", "isStatBooster"));
        if (!bonus) {
            [bonus] = await this.createEmbeddedDocuments("Item", [{name: "Stat Boosters", type: "miscBonus", img: "icons/svg/upgrade.svg",
                system: {enabled: true}, flags: {"fires-of-war": {isStatBooster: true}}}]);
        }
        await bonus.update({[`system.bonuses.attributes.${stat}`]: Number(bonus.system.bonuses?.attributes?.[stat] || 0) + gained});
        if (stat === "hp") await this.update({"system.attributes.hp.value": Number(sys.attributes?.hp?.value || 0) + gained});
        return gained;
    }

    async _getOrCreateLevelUpBonus() {
        await this._dedupeLevelUpBonus();
        let bonus = this.items.find(i =>
            i.type === "miscBonus" && i.getFlag("fires-of-war", "isLevelUpBonus")
        );
        if (!bonus) {
            const [created] = await this.createEmbeddedDocuments("Item", [{
                name: "Bonuses from Level Up",
                type: "miscBonus",
                img: "icons/svg/upgrade.svg",
                system: {
                    enabled: true,
                    bonuses: {
                        attributes: { hp: 0, strength: 0, magic: 0, skill: 0, speed: 0, defense: 0, resistance: 0, luck: 0, charm: 0, build: 0, move: 0 },
                        maximums: { hp: 0, strength: 0, magic: 0, skill: 0, speed: 0, defense: 0, resistance: 0, luck: 0, charm: 0, build: 0, move: 0 },
                        growthRates: { hp: 0, strength: 0, magic: 0, skill: 0, speed: 0, defense: 0, resistance: 0, luck: 0, charm: 0, build: 0 },
                        combat: { hitRate: 0, critRate: 0, avoid: 0, dodge: 0, attackSpeed: 0 }
                    }
                },
                flags: { "fires-of-war": { isLevelUpBonus: true } }
            }]);
            bonus = created;
        }
        return bonus;
    }

    _getClassRootNode(classItem) {
        const sys = classItem.system;
        return {
            id: "root",
            name: classItem.name, classType: sys.classType, movement: sys.movement,
            maxLevel: sys.maxLevel, baseStats: sys.baseStats || {},
            growthRates: sys.growthRates || {}, statCaps: sys.statCaps || {},
            unitTypes: sys.unitTypes || {}, weaponProficiencies: sys.weaponProficiencies || {},
            classSkills: Array.isArray(sys.classSkills) ? sys.classSkills : [],
            roleplayTraits: Array.isArray(sys.roleplayTraits) ? sys.roleplayTraits : [],
            promotions: sys.promotions || []
        };
    }

    /** Return the root class and every valid node traversed by currentPath. */
    _getCurrentClassPath(classItem) {
        const path = [this._getClassRootNode(classItem)];
        let node = path[0];
        const currentPath = Array.isArray(classItem.system.currentPath) ? classItem.system.currentPath : [];
        for (const id of currentPath) {
            const next = (node.promotions || []).find(p => p.id === id);
            if (!next) break;
            node = next;
            path.push(node);
        }
        return path;
    }

    /** Walk the promotion tree via currentPath to find the active class node. */
    _getCurrentClassNode(classItem) {
        const path = this._getCurrentClassPath(classItem);
        return path[path.length - 1];
    }

    /** Roleplay Trait sources from the equipped class and its active promotion path. */
    _getRoleplayTraitSources() {
        const classItem = this.items.find(item => item.type === "class" && item.system.equipped);
        if (!classItem) return [];
        return this._getCurrentClassPath(classItem).map((node, index) => ({
            key: `${classItem.id}:${index === 0 ? "root" : (node.id || index)}`,
            className: node.name || classItem.name,
            traits: getClassRoleplayTraits(node.name || classItem.name, node.roleplayTraits)
        })).filter(source => source.traits.length);
    }

    /** Apply the class-facing profile and grant E Rank to newly gained proficiencies. */
    async _syncClassProfile(node) {
        if (!node) return;
        const updates = {
            "system.unitTypes": Object.entries(node.unitTypes || {})
                .filter(([, enabled]) => Boolean(enabled))
                .map(([name]) => name),
            "system.battalionRank": normalizeWeaponRank(this.system.battalionRank) || "E"
        };
        for (const weaponType of Object.keys(FEUE.WeaponTypes)) {
            if (node.weaponProficiencies?.[weaponType] && !normalizeWeaponRank(this.system.weaponRanks?.[weaponType])) {
                updates[`system.weaponRanks.${weaponType}`] = "E";
            }
        }
        await this.update(updates);
    }

    prepareDerivedData() {
        if (this.type !== "character") return;
        const system = this.system;

        // Weapon ranks. Normalize legacy casing/shapes before any comparison so
        // malformed actor data cannot crash an attack or skip rank steps.
        const rawRanks = system.weaponRanks && typeof system.weaponRanks === "object" && !Array.isArray(system.weaponRanks)
            ? system.weaponRanks
            : {};
        const normalizedRanks = foundry.utils.deepClone(DEFAULT_WEAPON_RANKS);
        for (const key of Object.keys(normalizedRanks)) {
            const legacyKey = Object.keys(rawRanks).find(candidate => candidate.toLowerCase() === key);
            normalizedRanks[key] = normalizeWeaponRank(legacyKey ? rawRanks[legacyKey] : rawRanks[key]);
        }
        system.weaponRanks = normalizedRanks;

        // Fires of War gives every unit at least E Battalion Rank.
        system.battalionRank = normalizeWeaponRank(system.battalionRank) || "E";
        if (!system.weaponMasteryBonuses || typeof system.weaponMasteryBonuses !== "object" || Array.isArray(system.weaponMasteryBonuses)) {
            system.weaponMasteryBonuses = {};
        }

        // Resolve equipped class node
        const equippedClass = this.items.find(i => i.type === "class" && i.system?.equipped);
        let baseStats = {}, growths = {}, caps = {}, classMovement = 0;

        if (equippedClass) {
            const node = this._getCurrentClassNode(equippedClass);
            system.activeClassName = node.name;
            system.activeClassType = node.classType;
            // Promoted/Advanced classes have no inherent base stats — all stat
            // value comes from the level-up bonus item.  Their "baseStats" field
            // stores promotion bonuses (applied once at promotion time).
            const isPromoted = ["Promoted", "Advanced"].includes(node.classType);
            baseStats = isPromoted ? {} : foundry.utils.deepClone(node.baseStats || {});
            growths = foundry.utils.deepClone(node.growthRates || {});
            caps = foundry.utils.deepClone(node.statCaps || {});
            classMovement = Number(node.movement || 0);
        }

        system.attributes ??= {};
        const className = equippedClass ? system.activeClassName || equippedClass.name : "";
        const bonus = this._collectBonuses();
        // Every prepared number is also recorded as tooltip terms (system.breakdown).
        const ledger = new StatLedger();
        const pathOf = path => path === "attributes.move" ? "movement" : path;
        for (const source of bonus.sources) ledger.add(pathOf(source.path), source.label, source.value);
        const statMaxBonus = Number(game.settings?.get("fires-of-war", "statMaxBonus") || 0);
        const useFatigue = !!game.settings?.get("fires-of-war", "useFatigue");

        for (const k of FEUE.STAT_KEYS) {
            system.attributes[k] ??= { value: 0, max: 0 };
            const base = Number(baseStats[k] || 0);
            const cap = Number(caps[k] || 0);
            if (equippedClass) ledger.add(`attributes.${k}`, `${className} base`, base, "base");

            if (k === "hp") {
                // HP special: max = HP stat, value = current HP (user-managed)
                let hpMax = base + (bonus.attributes.hp || 0);
                // Fatigue: when fatigue >= BLD, max HP is halved.
                if (useFatigue) {
                    const bld = Number(system.attributes?.build?.value || 0);
                    const fat = Number(system.fatigue?.value || 0);
                    if (bld > 0 && fat >= bld) {
                        ledger.add("attributes.hp", "Fatigued (halved)", Math.floor(hpMax / 2) - hpMax);
                        hpMax = Math.floor(hpMax / 2);
                    }
                }
                system.attributes.hp.max = hpMax;
                if (system.attributes.hp.value > system.attributes.hp.max && system.attributes.hp.max > 0) {
                    system.attributes.hp.value = system.attributes.hp.max;
                }
            } else {
                system.attributes[k].value = base + (bonus.attributes[k] || 0);
                const rawCap = cap + (bonus.maximums[k] || 0);
                if (equippedClass) ledger.add(`maximums.${k}`, `${className} cap`, cap, "base");
                // Higher Stat Maximums alt rule: flat +10/+20 to non-HP caps when a cap is set.
                system.attributes[k].max = rawCap > 0 ? rawCap + statMaxBonus : rawCap;
                if (rawCap > 0) ledger.add(`maximums.${k}`, "Higher Stat Maximums", statMaxBonus);
            }
        }

        system.growthRates ??= {};
        const holyGrowths = this._getHolyBloodGrowths();
        const crestReductions = this._getCrestGrowthReductions();
        const crestHpPenalty = this._getCrestHpGrowthPenalty();
        for (const k of FEUE.STAT_KEYS) {
            let v = (growths[k] || 0) + (bonus.growthRates[k] || 0) + (holyGrowths[k] || 0) - (crestReductions[k] || 0);
            if (k === "hp") v -= crestHpPenalty;
            system.growthRates[k] = v;
            if (equippedClass) ledger.add(`growthRates.${k}`, `${className} growth`, growths[k] || 0, "base");
            ledger.add(`growthRates.${k}`, "Holy Blood", holyGrowths[k] || 0);
            ledger.add(`growthRates.${k}`, "Crest", -(crestReductions[k] || 0));
            if (k === "hp") ledger.add("growthRates.hp", "Major + Minor Crests", -crestHpPenalty);
        }

        // Multiple Crests penalty: -10 max HP
        if (game.settings?.get("fires-of-war", "useCrests")) {
            const crests = Array.isArray(system.crests) ? system.crests : [];
            const hasMajor = crests.some(c => c?.strength === "Major");
            const hasMinor = crests.some(c => c?.strength === "Minor");
            if (hasMajor && hasMinor) {
                ledger.add("attributes.hp", "Major + Minor Crests", -Math.min(10, system.attributes.hp.max || 0));
                system.attributes.hp.max = Math.max(0, (system.attributes.hp.max || 0) - 10);
                if (system.attributes.hp.value > system.attributes.hp.max) {
                    system.attributes.hp.value = system.attributes.hp.max;
                }
            }
        }

        // Replaceable Mounts: a forcibly dismounted unit has half its max HP for the rest of the map.
        if (system.mount?.forced && replaceableMounts()) {
            const half = Math.floor((system.attributes.hp.max || 0) / 2);
            ledger.add("attributes.hp", "Forcibly dismounted (halved)", half - (system.attributes.hp.max || 0));
            system.attributes.hp.max = half;
        }
        // Enraged Revival raises max HP as Revival Stones are lost; baseMax is the HP a stone restores without it.
        system.attributes.hp.baseMax = system.attributes.hp.max;
        const enraged = revivalHpMultiplier(this);
        if (enraged !== 1) {
            const raised = Math.floor((system.attributes.hp.max || 0) * enraged);
            ledger.add("attributes.hp", `Enraged Revival (×${enraged})`, raised - (system.attributes.hp.max || 0));
            system.attributes.hp.max = raised;
        }
        if (system.attributes.hp.value > system.attributes.hp.max && system.attributes.hp.max > 0) system.attributes.hp.value = system.attributes.hp.max;

        // Skills, timed effects (Rally, Seal, Crippling...) and rulebook statuses.
        const skillBonuses = passiveSkillBonuses(this);
        const statuses = statusStatModifiers(this);
        const temporary = timedEffectTerms(this);
        const modifierTerms = [...skillBonuses.terms.filter(t => /^(attributes|combat)\./.test(t.path)), ...statuses.terms,
            ...temporary.map(t => ({...t, path: t.path.startsWith("effects.") ? `combat.${t.key}` : t.path})), ...revivalBonusTerms(this)];
        for (const t of modifierTerms) {
            const [field, key] = t.path.split(".");
            if (t.path === "movement" || field === "attributes" && key === "move") bonus.attributes.move += t.value;
            else if (field === "attributes" && key !== "hp" && system.attributes[key]) system.attributes[key].value += t.value;
            else if (field === "combat" && key in bonus.combat) bonus.combat[key] += t.value;
            else continue;
            ledger.add(pathOf(t.path), t.label, t.value);
        }
        applyMountProfile(this);
        // Fate Points: LUK ÷ 5, refreshed each session.
        if (fateEnabled()) system.fatePoints = {...(system.fatePoints ?? {}), value: Math.max(0, Number(system.fatePoints?.value) || 0), max: fateMax(this)};
        // Magical Flight counts as Flying (Slayer immunity is handled in attack calculations).
        if (hasSkill(this, "magical flight")) {
            const types = Array.isArray(system.unitTypes) ? system.unitTypes : Object.keys(system.unitTypes ?? {}).filter(t => system.unitTypes[t]);
            if (!types.includes("Flying")) system.unitTypes = [...types, "Flying"];
        }
        const battalions = this.items.filter(i => i.type === "battalion");
        const batPenalty = battalions.reduce((total, b) => total + Number(b.system?.movePenalty || 0), 0);
        system.movement ??= { base: 0, current: 0 };
        system.movement.base = classMovement + (bonus.attributes.move || 0) + batPenalty;
        if (equippedClass) ledger.add("movement", `${className} Move`, classMovement, "base");
        for (const b of battalions) ledger.add("movement", b.name, Number(b.system?.movePenalty || 0));
        const before = {speed: system.attributes.speed.value, speedMax: system.attributes.speed.max, move: system.movement.base};
        applyRescueStats(this);
        ledger.add("attributes.speed", "Rescuing (halved)", system.attributes.speed.value - before.speed);
        ledger.add("maximums.speed", "Rescuing (halved)", system.attributes.speed.max - before.speedMax);
        ledger.add("movement", "Rescuing (halved)", system.movement.base - before.move);
        if (statuses.move) {
            const status = activeStatuses(this).find(s => s.rule?.move === statuses.move)?.name ?? "Status";
            const reduced = statuses.move === "zero" ? 0 : Math.floor(system.movement.base / 2);
            ledger.add("movement", `${status}${statuses.move === "half" ? " (halved)" : ""}`, reduced - system.movement.base);
            system.movement.base = reduced;
        }

        // Combat stats
        const ew = this.items.find(i => i.type === "weapon" && i.system?.equipped);
        const greatHaul = hasSkill(this, "great haul") ? 4 : 0;
        const rawWeight = Number(ew?.system?.weight || 0), wWeight = Math.max(0, rawWeight - greatHaul);
        const bld = Number(system.attributes.build?.value || 0);
        const spd = Number(system.attributes.speed?.value || 0);
        const skl = Number(system.attributes.skill?.value || 0);
        const lck = Number(system.attributes.luck?.value || 0);
        // Weapon mastery bonuses apply only when the equipped weapon matches
        const equippedWeaponType = weaponTypeKey(ew?.system?.weaponType);
        const mastery = (equippedWeaponType && system.weaponMasteryBonuses?.[equippedWeaponType]) || {};
        const masteryLabel = `${FEUE.WeaponTypes[equippedWeaponType] ?? "Weapon"} mastery`;
        const combatSources = key => ledger.get(`combat.${key}`);

        const burden = Math.max(wWeight - bld, 0);
        const asTerms = [term("SPD", spd, "base"), ...combatSources("attackSpeed"), term(masteryLabel, mastery.attackSpeed),
            term(ew ? `${ew.name} weight (Wt ${rawWeight}${greatHaul ? " − 4 Great Haul" : ""} vs BLD ${bld})` : "Weapon weight", -burden)];
        // Keep weapon-independent bases separate. Individual roll actions may
        // use a weapon other than the currently equipped one.
        const baseHitTerms = [term("SKL", skl, "base"), term("LUK ÷ 4", Math.floor(lck / 4)), ...combatSources("hitRate")];
        const baseCritTerms = [term("SKL ÷ 2", Math.floor(skl / 2), "base"), ...combatSources("critRate")];
        const hitTerms = [...baseHitTerms, term(ew ? `${ew.name} Hit` : "Weapon Hit", ew?.system?.hit), term(masteryLabel, mastery.hitRate)];
        const critTerms = [...baseCritTerms, term(ew ? `${ew.name} Crit` : "Weapon Crit", ew?.system?.crit), term(masteryLabel, mastery.critRate)];
        const avoidTerms = [term("SPD", spd, "base"), term("LUK ÷ 4", Math.floor(lck / 4)), ...combatSources("avoid"), term(masteryLabel, mastery.avoid)];
        const dodgeTerms = [term("LUK", lck, "base"), ...combatSources("dodge"), term(masteryLabel, mastery.dodge)];

        // Damage: weapon Might + damage stat. Non-proficiency halves the final value after skill bonuses.
        const damageTerms = [];
        let damageMultiplier = 1;
        if (ew) {
            const props = normalizeWeaponProperties(ew.system.properties);
            const broken = !hasInfiniteUses(ew.system.uses) && Number(ew.system.uses?.max) > 0 && Number(ew.system.uses?.value) <= 0;
            const di = props.magical ? {stat: "MAG", value: system.attributes.magic.value} : props.mechanical ? {stat: "SPD", value: system.attributes.speed.value}
                : equippedWeaponType === "sword" && hasSkill(this, "performance artist") ? {stat: "CHA", value: system.attributes.charm.value} : this.getDamageStat(equippedWeaponType);
            damageTerms.push(term(`${ew.name} Mt${broken ? " (broken)" : ""}`, broken ? 0 : Number(ew.system.might || 0), "base"));
            damageTerms.push(props.puncture ? term("Puncture: no damage stat", 0, "info") : term(di.stat, di.value));
            if (hasSkill(this, "dark pact") && [...TOME_TYPES, "spell"].includes(equippedWeaponType) && props.absorb) damageTerms.push(term("Dark Pact", 5));
            if (!broken && !this.canUseWeapon(ew)) { damageMultiplier = 0.5; damageTerms.push(term("Non-proficient", 0.5, "mult")); }
        }
        // Sleep, Petrification and Knocked Out set Avoid, Dodge and AS to 0.
        const zeroStatus = activeStatuses(this).find(s => s.rule?.zero)?.name;
        for (const [key, list] of [["avoid", avoidTerms], ["dodge", dodgeTerms], ["attackSpeed", asTerms]]) if (statuses.zero.has(key)) list.push(term(zeroStatus, 0, "set"));
        const derived = terms => terms.some(t => t.kind === "set") ? terms.filter(t => t.kind === "set").at(-1).value : sumTerms(terms);

        // Aid: depends on unit type and sex
        const unitTypes = Array.isArray(system.unitTypes) ? system.unitTypes : [];
        const sex = (system.personalDetails?.sex || "").toLowerCase();
        const isMountedOrFlying = unitTypes.some(t => ["Mounted", "Flying"].includes(t));
        let aid = Math.max(bld - 1, 0); // Infantry default
        let aidLabel = `Infantry: BLD ${bld} − 1`;
        if (isMountedOrFlying) {
            const female = sex === "female" || sex === "f";
            aid = (female ? 20 : 25) - bld;
            aidLabel = `Mounted/Flying: ${female ? 20 : 25} − BLD ${bld}`;
        }

        system.combat = {
            attackSpeed: derived(asTerms),
            baseHitRate: sumTerms(baseHitTerms),
            baseCritRate: sumTerms(baseCritTerms),
            hitRate: sumTerms(hitTerms),
            critRate: sumTerms(critTerms),
            avoid: derived(avoidTerms),
            dodge: derived(dodgeTerms),
            damage: sumTerms(damageTerms),
            damageMultiplier,
            aid,
            zeroed: [...statuses.zero],
            critTaken: statuses.critTaken
        };
        Object.assign(ledger.entries, {"combat.attackSpeed": asTerms, "combat.hitRate": hitTerms, "combat.critRate": critTerms, "combat.avoid": avoidTerms,
            "combat.dodge": dodgeTerms, "combat.damage": damageTerms, "combat.baseHitRate": baseHitTerms, "combat.baseCritRate": baseCritTerms,
            "combat.aid": [term(aidLabel, aid, "base")]});
        system.breakdown = ledger.toObject();
        applyTerrainStats(this, {fresh: true});
    }

    async levelUp() {
        const system = this.system;
        const currentLevel = system.level || 1;

        // ── Check if at max level → promotion instead of normal level up ──
        const ec = this.items.find(i => i.type === "class" && i.system?.equipped);
        if (ec) {
            const node = this._getCurrentClassNode(ec);
            const maxLevel = Number(node.maxLevel || 20);
            const promos = node.promotions || [];

            if (currentLevel >= maxLevel) {
                if (promos.length) {
                    // Proper Promotion, Full Classic: a Standard class needs a class change item even at max level.
                    // Partial Classic promotes naturally here and keeps the item; Recruits always promote on their own.
                    const mode = game.settings.get("fires-of-war", "properPromotion") || "off";
                    if (mode === "full" && node.classType !== "Recruit") {
                        const items = promotionItemsFor(this, node);
                        if (!items.length) {
                            ui.notifications.warn(`${this.name} needs a class change item that can promote ${node.name} (Proper Promotion: Full Classic).`);
                            return;
                        }
                        await this._showPromotionDialog(ec, promos, { items });
                    } else await this._showPromotionDialog(ec, promos);
                } else {
                    ui.notifications.warn(`${this.name} is at max level (${maxLevel}) with no promotions available.`);
                }
                return;
            }
        }

        // ── Normal level up ──
        const gr = system.growthRates || {};
        const accumulated = foundry.utils.deepClone(system.accumulatedGrowthRates || {});
        const gains = {};
        const newAccumulated = {};
        const rollDetails = [];
        const useStatic = !!game.settings.get("fires-of-war", "useStaticGrowths");
        const newLevelForStatic = currentLevel + 1;

        for (const stat of FEUE.STAT_KEYS) {
            const baseGR = Number(gr[stat] || 0);
            const accum = Number(accumulated[stat] || 0);
            const effectiveGR = baseGR + accum;

            // Check stat cap first
            let atCap = false;
            if (stat === "hp") {
                if (ec) {
                    const nodeHp = this._getCurrentClassNode(ec);
                    const hpCap = Number(nodeHp.statCaps?.hp || 0);
                    if (hpCap > 0 && Number(system.attributes?.hp?.max || 0) >= hpCap) atCap = true;
                }
            } else {
                const attribute = stat === "speed" ? getRescueBase(this)?.speed ?? system.attributes[stat] : system.attributes[stat];
                const currentVal = Number(attribute?.value || 0) - (stat === "defense" ? getAppliedTerrain(this).defense : 0);
                const cap = Number(attribute?.max || 0);
                if (cap > 0 && currentVal >= cap) atCap = true;
            }

            if (atCap) {
                gains[stat] = 0;
                newAccumulated[stat] = 0;
                rollDetails.push({ stat, roll: "—", effectiveGR, gained: 0, atCap: true });
                continue;
            }

            if (useStatic) {
                const gained = feueStaticGain(baseGR, newLevelForStatic);
                gains[stat] = gained;
                newAccumulated[stat] = 0;
                rollDetails.push({ stat, roll: "static", effectiveGR: baseGR, gained, atCap: false });
            } else if (effectiveGR >= 10) {
                // Guaranteed +1, plus +1 per additional 10 above threshold
                const gained = 1 + Math.floor((effectiveGR - 10) / 10);
                gains[stat] = gained;
                newAccumulated[stat] = effectiveGR % 10;
                rollDetails.push({ stat, roll: "auto", effectiveGR, gained, atCap: false });
            } else {
                const roll = await new Roll("1d10").evaluate();
                const sum = roll.total + effectiveGR;
                if (sum >= 10) {
                    gains[stat] = 1;
                    newAccumulated[stat] = 0;
                    rollDetails.push({ stat, roll: roll.total, effectiveGR, gained: 1, atCap: false });
                } else {
                    gains[stat] = 0;
                    newAccumulated[stat] = sum;
                    rollDetails.push({ stat, roll: roll.total, effectiveGR, gained: 0, atCap: false, carried: sum });
                }
            }
        }

        // Persist accumulated growth rates (reset when static)
        await this.update({ "system.accumulatedGrowthRates": newAccumulated });

        const gainedStats = Object.entries(gains).filter(([, v]) => v > 0);

        if (gainedStats.length) {
            const bonusItem = await this._getOrCreateLevelUpBonus();
            const updates = {};
            for (const [stat, amount] of gainedStats) {
                const current = Number(bonusItem.system.bonuses?.attributes?.[stat] || 0);
                updates[`system.bonuses.attributes.${stat}`] = current + amount;
            }
            await bonusItem.update(updates);

            if (gains.hp) {
                await this.update({
                    "system.attributes.hp.value": (system.attributes?.hp?.value || 0) + gains.hp
                });
            }
        }

        const newLevel = currentLevel + 1;
        await this.update({ "system.level": newLevel, "system.totalLevel": (system.totalLevel || 1) + 1 });

        // Build detailed chat message
        const detailRows = rollDetails.map(d => {
            const label = FEUE.STAT_LABELS[d.stat] || d.stat;
            if (d.atCap) return `<tr><td>${label}</td><td colspan="3" style="color:#888;">At cap</td></tr>`;
            const rollStr = d.roll === "auto" ? "Auto" : (d.roll === "static" ? "Static" : String(d.roll));
            const resultStr = d.gained > 0
                ? `<span class="gain">+${d.gained}</span>`
                : (d.carried ? `<span style="color:#b8860b;">Carry ${d.carried}</span>` : `<span style="color:#888;">—</span>`);
            return `<tr><td>${label}</td><td>${rollStr}</td><td>GR ${d.effectiveGR}</td><td>${resultStr}</td></tr>`;
        }).join("");

        const gainList = gainedStats.map(([k, v]) => `<span class="gain">+${v} ${FEUE.STAT_LABELS[k] || k}</span>`);
        ChatMessage.create({
            user: game.user.id, speaker: ChatMessage.getSpeaker({ actor: this }),
            content: `<div class="feue-levelup"><h3>${this.name} reached level ${newLevel}!</h3>${gainList.length ? `<div class="stat-gains">${gainList.join("")}</div>` : "<p>No stats increased.</p>"}<details><summary>Roll Details</summary><table class="feue-gr-table"><tr><th>Stat</th><th>Roll</th><th>GR</th><th>Result</th></tr>${detailRows}</table></details></div>`
        });

        // Grant class skills for new level
        if (ec) {
            const currentNode = this._getCurrentClassNode(ec);
            await this._grantClassSkills(currentNode, { exactLevel: newLevel });
        }

        // Award WEXP at level 4 and every 4 levels. Battalion Rank is not a
        // weapon proficiency and does not increase this award.
        if (newLevel >= 4 && newLevel % 4 === 0 && ec) {
            const node = this._getCurrentClassNode(ec);
            const wProfs = Object.entries(node.weaponProficiencies || {}).filter(([, v]) => v);
            const wexpGain = wProfs.length;
            if (wexpGain > 0) {
                await this.update({ "system.weaponExp": Number(system.weaponExp || 0) + wexpGain });
                ui.notifications.info(`${this.name} gained ${wexpGain} Weapon EXP!`);
            }
        }
    }

    /** Promotion offered by a level-up at max level. `items` are the class change items it may spend (Full Classic). */
    async _showPromotionDialog(classItem, promotions, { items = [] } = {}) {
        const opts = promotions.map(p => `<option value="${p.id}">${p.name} (${p.classType})</option>`).join("");
        const itemField = items.length ? `<p>Proper Promotion (Full Classic) spends a class change item:</p>
                <div class="form-group"><select id="feue-promo-item" style="width:100%;">${items.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join("")}</select></div>` : "";
        new Dialog({
            title: "Promotion Available!",
            content: `<div style="padding:10px;">
                <p>Choose your promotion path:</p>
                <div class="form-group">
                    <select id="feue-promo-choice" style="width:100%;">${opts}</select>
                </div>${itemField}
            </div>`,
            buttons: {
                promote: {
                    icon: '<i class="fas fa-arrow-up"></i>',
                    label: "Promote",
                    callback: async (html) => {
                        const item = items.length ? this.items.get(html.find("#feue-promo-item").val()) : null;
                        if (items.length && !item) return ui.notifications.warn("That class change item is no longer available.");
                        await this.promoteTo(classItem, html.find("#feue-promo-choice").val(), { item, levelUp: true });
                    }
                },
                cancel: {
                    icon: '<i class="fas fa-times"></i>',
                    label: "Decide Later"
                }
            },
            default: "promote"
        }).render(true);
    }

    /**
     * Promote the equipped class along one of its promotions.
     * levelUp: the promotion is this level-up (max level), so Total Level rises; a class change item used
     * from Level 10 promotes without gaining a level. `item` is spent once the promotion is applied.
     */
    async promoteTo(classItem, promotionId, { item = null, levelUp = false } = {}) {
        const previousNode = this._getCurrentClassNode(classItem);
        const chosen = (previousNode.promotions || []).find(p => p.id === promotionId);
        if (!chosen) throw Error("That promotion is no longer available.");
        const prevType = previousNode?.classType || "";
        await classItem.update({ "system.currentPath": [...(classItem.system.currentPath || []), chosen.id] });
        await this._applyPromotionBenefits(previousNode, chosen);
        if (item) await consumeClassChangeItem(item);
        const using = item ? ` using ${esc(item.name)}` : "";

        if (prevType === "Recruit") {
            // Recruit→Standard: increment level (e.g. 10→11), keep going
            const currentLevel = this.system.level || 10;
            const newLevel = currentLevel + 1;
            await this.update({
                "system.level": newLevel,
                "system.totalLevel": (this.system.totalLevel || currentLevel) + 1
            });
            ChatMessage.create({
                user: game.user.id,
                speaker: ChatMessage.getSpeaker({ actor: this }),
                content: `<div class="feue-levelup"><h3>${this.name} promoted to ${chosen.name} at level ${newLevel}${using}!</h3></div>`
            });
        } else {
            // Standard→Promoted/Advanced: reset to level 1
            const prevLevel = this.system.level || 20;
            await this.update({
                "system.level": 1,
                "system.totalLevel": (this.system.totalLevel || prevLevel) + (levelUp ? 1 : 0)
            });
            ChatMessage.create({
                user: game.user.id,
                speaker: ChatMessage.getSpeaker({ actor: this }),
                content: `<div class="feue-levelup"><h3>${this.name} promoted to ${chosen.name}${using}!</h3><p>Level reset to 1.</p></div>`
            });
        }

        ui.notifications.info(`${this.name} promoted to ${chosen.name}!`);
        return chosen;
    }

    /** Classes a reclass can switch to. Once the unit is in an alternate class, its starting class is a target again. */
    reclassTargets() {
        const classes = this.items.filter(i => i.type === "class"), equipped = classes.find(c => c.system.equipped);
        const alternates = new Set(Array.isArray(this.system.alternateClasses) ? this.system.alternateClasses : []);
        return classes.filter(c => c !== equipped && (alternates.has(c.id) || alternates.has(equipped?.id)));
    }

    /** Why this unit cannot use a class change item right now, or "". */
    classChangeReason(item, mode = activeClassChange(item)) {
        if (!mode) return `${item?.name ?? "This item"} is not a class change item under the current settings.`;
        if (!hasUsesLeft(item)) return `${item.name} has no uses remaining.`;
        if (mode === "reclass") {
            if ((this.system.level || 0) < 10 && (this.system.totalLevel || 0) < 10) return `${this.name} must be at least Level 10 to reclass.`;
            return this.reclassTargets().length ? "" : `${this.name} has no alternate class to change to.`;
        }
        const classItem = this.items.find(i => i.type === "class" && i.system.equipped);
        if (!classItem) return `${this.name} has no equipped class.`;
        const node = this._getCurrentClassNode(classItem);
        if (node.classType === "Recruit") return `${node.name} is a Recruit class: it promotes on its own at its maximum level.`;
        if (!(node.promotions || []).length) return `${node.name} has no promotions.`;
        if ((this.system.level || 1) < 10) return `${this.name} must reach Level 10 as ${node.name} to promote.`;
        return promotesClass(item, node.name) ? "" : `${item.name} cannot promote ${node.name}.`;
    }

    /** Options for a class change item: promotions of the current class, or reclass targets. */
    classChangeChoices(mode) {
        if (mode === "reclass") return this.reclassTargets().map(c => ({ id: c.id, label: `${c.name} (${c.system.classType})` }));
        const classItem = this.items.find(i => i.type === "class" && i.system.equipped);
        const node = classItem ? this._getCurrentClassNode(classItem) : null;
        return (node?.promotions || []).map(p => ({ id: p.id, label: `${p.name} (${p.classType})` }));
    }

    async _applyPromotionBenefits(previousNode, chosenNode) {
        const prevType = previousNode?.classType || "";
        const nextType = chosenNode?.classType || "";
        const promoteToAdvanced = ["Promoted", "Advanced"].includes(nextType);
        const fromBaseClass = ["Recruit", "Standard"].includes(prevType);

        // ── Adjust Level Up Bonus to account for promotion ──
        const bonusItem = await this._getOrCreateLevelUpBonus();
        const bonusUpdates = {};

        // Track whether the previous class was Promoted/Advanced (base=0 in derivation)
        const prevIsPromoted = ["Promoted", "Advanced"].includes(prevType);
        const prevEffectiveBase = (key) => prevIsPromoted ? 0 : Number(previousNode?.baseStats?.[key] || 0);

        for (const key of FEUE.STAT_KEYS) {
            const currentBonus = Number(bonusItem.system.bonuses?.attributes?.[key] || 0);
            const currentTotal = prevEffectiveBase(key) + currentBonus;

            let newBonus = currentBonus;

            if (fromBaseClass && !promoteToAdvanced) {
                // Recruit→Standard: floor to new base, then store remainder as bonus
                const nextBase = Number(chosenNode?.baseStats?.[key] || 0);
                const targetTotal = Math.max(currentTotal, nextBase);
                newBonus = Math.max(targetTotal - nextBase, 0);
            } else if (promoteToAdvanced) {
                // Standard→Promoted/Advanced: add promotion bonuses, capped by new stat caps.
                // Promoted classes have effective base 0, so all value lives in the bonus.
                const promoBonus = Number(chosenNode?.baseStats?.[key] || 0);
                const cap = Number(chosenNode?.statCaps?.[key] || 0);
                const uncapped = currentTotal + promoBonus;
                newBonus = cap > 0 ? Math.min(uncapped, cap) : uncapped;
            }

            bonusUpdates[`system.bonuses.attributes.${key}`] = newBonus;
        }

        await bonusItem.update(bonusUpdates);

        // ── Bump current HP to match new max ──
        const oldHpBonus = Number(bonusItem.system.bonuses?.attributes?.hp || 0);
        const oldHpTotal = prevEffectiveBase("hp") + oldHpBonus;
        let newHpTotal = oldHpTotal;
        if (fromBaseClass && !promoteToAdvanced) {
            const nextHpBase = Number(chosenNode?.baseStats?.hp || 0);
            newHpTotal = Math.max(oldHpTotal, nextHpBase);
        } else if (promoteToAdvanced) {
            const promoHpBonus = Number(chosenNode?.baseStats?.hp || 0);
            const hpCap = Number(chosenNode?.statCaps?.hp || 0);
            const uncapped = oldHpTotal + promoHpBonus;
            newHpTotal = hpCap > 0 ? Math.min(uncapped, hpCap) : uncapped;
        }
        const hpDiff = newHpTotal - oldHpTotal;
        if (hpDiff > 0) {
            await this.update({
                "system.attributes.hp.value": (this.system.attributes?.hp?.value || 0) + hpDiff
            });
        }

        // ── Unit types & weapon proficiencies ──
        await this._syncClassProfile(chosenNode);

        // ── Grant skills from new class node ──
        const fromRecruit = prevType === "Recruit";
        if (fromRecruit) {
            await this._grantClassSkills(chosenNode, { all: true });
        } else {
            await this._grantClassSkills(chosenNode, { upToLevel: 1 });
        }
        await this._removeInnateSkills(previousNode);
    }

    /**
 * Grant class skills from a node to this actor.
 * @param {Object} node - The class/promotion node with classSkills[]
 * @param {Object} options
 * @param {number}  [options.exactLevel]  - Grant skills at exactly this level
 * @param {number}  [options.upToLevel]   - Grant skills at or below this level
 * @param {boolean} [options.all]         - Grant ALL skills regardless of level
 */
    async _grantClassSkills(node, { exactLevel, upToLevel, all } = {}) {
        const classSkills = Array.isArray(node.classSkills) ? node.classSkills : [];

        if (!classSkills.length) return;

        const toGrant = classSkills.filter(cs => {
            if (cs.level === "Innate") return true;
            if (all) return true;
            const lv = Number(cs.level);
            if (exactLevel !== undefined) return lv === exactLevel;
            if (upToLevel !== undefined) return lv <= upToLevel;
            return false;
        });

        if (!toGrant.length) return;

        // Avoid duplicates — check by name
        const existingNames = new Set(
            this.items.filter(i => i.type === "skill").map(i => i.name)
        );

        const newSkills = toGrant
            .filter(cs => !existingNames.has(cs.skillData.name))
            .map(cs => {
                const sys = foundry.utils.deepClone(cs.skillData.system || {});
                sys.grantedByClass = node.name || "";
                return {
                    name: cs.skillData.name,
                    type: "skill",
                    img: cs.skillData.img || "icons/svg/book.svg",
                    system: sys
                };
            });

        if (newSkills.length) {
            await this.createEmbeddedDocuments("Item", newSkills);
            for (const s of newSkills) {
                ui.notifications.info(`${this.name} learned ${s.name}!`);
            }
        }
    }

    /**
     * Remove innate skills that came from a specific class node.
     * @param {Object} node - The class/promotion node
     */
    async _removeInnateSkills(node) {
        const classSkills = Array.isArray(node.classSkills) ? node.classSkills : [];
        const innateNames = new Set(
            classSkills.filter(cs => cs.level === "Innate").map(cs => cs.skillData.name)
        );
        if (!innateNames.size) return;

        const toRemove = this.items
            .filter(i => i.type === "skill" && innateNames.has(i.name) && (!i.system.grantedByClass || i.system.grantedByClass === node.name))
            .map(i => i.id);

        if (toRemove.length) {
            await this.deleteEmbeddedDocuments("Item", toRemove);
            ui.notifications.info(`${this.name} lost innate skills from previous class.`);
        }
    }

    async _grantWeaponArts(weaponType, newRank) {
        const artsForRank = FEUE.WEAPON_RANK_ARTS?.[weaponType]?.[newRank];
        if (!artsForRank || !artsForRank.length) return;

        const existingNames = new Set(this.items.filter(i => i.type === "combatArt").map(i => i.name));
        const newArts = artsForRank
            .filter(art => !existingNames.has(art.name))
            .map(art => ({
                name: art.name,
                type: "combatArt",
                img: "icons/svg/sword.svg",
                system: {
                    might: art.might || 0,
                    hit: art.hit || 0,
                    crit: art.crit || 0,
                    durabilityCost: art.durabilityCost || 0,
                    effect: art.effect || "",
                    weaponRestriction: weaponType,
                    requiredRank: newRank
                }
            }));

        if (newArts.length) {
            await this.createEmbeddedDocuments("Item", newArts);
            for (const a of newArts) {
                ui.notifications.info(`${this.name} learned combat art: ${a.name}!`);
            }
        }
    }

    _onUpdate(changed, options, userId) {
        super._onUpdate(changed, options, userId);
        if (game.user.id !== userId) return;
        if (this.type !== "character") return;

        // Auto-level when EXP reaches 10+
        const newExp = foundry.utils.getProperty(changed, "system.experience");
        if (newExp !== undefined && newExp >= 10) {
            // Count how many level-ups are earned (every 10 EXP = 1 level)
            const levelUps = Math.floor(newExp / 10);
            // EXP always resets to 0 per rulebook (no carrying remainder)
            this.update({ "system.experience": 0 }).then(async () => {
                for (let i = 0; i < levelUps; i++) {
                    await this.levelUp();
                }
            });
        }
    }

    /** Switch to an alternate class. With class change items in use, `item` must be a Second Seal, spent on success. */
    async reclassTo(targetClassId, { item = null } = {}) {
        if (!game.settings.get("fires-of-war", "useReclassing")) {
            ui.notifications.warn("Reclassing alt rule is not enabled.");
            return false;
        }
        const lv = this.system.level || 0;
        const tlv = this.system.totalLevel || 0;
        if (lv < 10 && tlv < 10) {
            ui.notifications.warn(`${this.name} must be at least Level 10 to reclass.`);
            return false;
        }
        if (secondSealRequired() && activeClassChange(item) !== "reclass") {
            ui.notifications.warn(`${this.name} needs a Second Seal to reclass.`);
            return false;
        }
        const target = this.items.get(targetClassId);
        if (!target || target.type !== "class") {
            ui.notifications.error("Target class not found.");
            return false;
        }
        const current = this.items.find(i => i.type === "class" && i.system.equipped);
        if (current?.id === target.id) {
            ui.notifications.info(`${this.name} is already ${target.name}.`);
            return false;
        }
        if (!this.reclassTargets().includes(target)) {
            ui.notifications.warn(`${target.name} is not one of ${this.name}'s alternate classes.`);
            return false;
        }

        // Remove Innate skills granted by previous class
        const prevSkills = this.items.filter(i =>
            i.type === "skill" && i.system?.level === "Innate" && i.system?.grantedByClass
        );
        if (prevSkills.length) {
            await this.deleteEmbeddedDocuments("Item", prevSkills.map(s => s.id));
        }

        // Swap equipped class
        const updates = [];
        if (current) updates.push({ _id: current.id, "system.equipped": false });
        updates.push({ _id: target.id, "system.equipped": true });
        await this.updateEmbeddedDocuments("Item", updates);

        // Grant innate skills of new class
        const node = this._getCurrentClassNode(target);
        await this._syncClassProfile(node);
        await this._grantClassSkills(node, {});
        if (item) await consumeClassChangeItem(item);

        ChatMessage.create({
            user: game.user.id, speaker: ChatMessage.getSpeaker({ actor: this }),
            content: `<div class="feue-levelup"><h3>${this.name} reclassed to ${target.name}${item ? ` using ${esc(item.name)}` : ""}!</h3><p>Stats and weapon ranks preserved.</p></div>`
        });
        return true;
    }

    async levelReset() {
        const bonusItem = this.items.find(i => i.type === "miscBonus" && i.getFlag("fires-of-war", "isLevelUpBonus"));
        if (bonusItem) {
            const resetBonuses = {};
            for (const k of FEUE.STAT_KEYS) resetBonuses[`system.bonuses.attributes.${k}`] = 0;
            resetBonuses["system.bonuses.attributes.move"] = 0;
            await bonusItem.update(resetBonuses);
        }

        const resetAccumulated = {};
        for (const k of FEUE.STAT_KEYS) resetAccumulated[k] = 0;
        await this.update({
            "system.level": 1,
            "system.totalLevel": 1,
            "system.experience": 0,
            "system.accumulatedGrowthRates": resetAccumulated
        });

        ChatMessage.create({
            user: game.user.id, speaker: ChatMessage.getSpeaker({ actor: this }),
            content: `<div class="feue-level-reset"><h3>${this.name} — Level Reset!</h3><p>Level, Total Level, EXP, and all level-up stat bonuses have been reset.</p></div>`
        });
        ui.notifications.info(`${this.name} has been reset to Level 1.`);
    }

    canUseWeapon(weapon) {
        if (normalizeWeaponProperties(weapon?.system?.properties).cursed && hasSkill(this, "curse proficiency")) return true;
        const weaponType = weaponTypeKey(weapon?.system?.weaponType);
        const rawRequiredRank = weapon?.system?.rank;
        if (!weaponType || rawRequiredRank == null || rawRequiredRank === "") return true;
        if (weaponType === "unarmed" && String(weapon?.name || "").trim().toLowerCase() === "fists") return true;
        if (this._hasHolyBloodForWeapon(weapon?.name)) return true;
        if (this._hasCrestForRelic(weapon?.name)) return true;
        const requiredRank = normalizeWeaponRank(rawRequiredRank, { allowPrf: true });
        if (!requiredRank) return false;
        if (weaponType === "dark" && requiredRank !== "Prf" && rankIdx(requiredRank) <= rankIdx("C") && hasSkill(this, "shadowgift")) return true;
        if (requiredRank === "Prf") return !!weapon.system.prfProficient;
        const actorRank = normalizeWeaponRank(this.system.weaponRanks?.[weaponType]);
        return this.hasWeaponProficiency(weaponType)
            && !!actorRank
            && rankIdx(actorRank) >= rankIdx(requiredRank);
    }

    /** Whether the active class can use a weapon group without penalties. */
    hasWeaponProficiency(weaponType) {
        if (!Object.hasOwn(FEUE.WeaponTypes, weaponType)) return false;
        const equippedClass = this.items.find(item => item.type === "class" && item.system?.equipped);
        if (!equippedClass) return false;
        const node = this._getCurrentClassNode(equippedClass);
        if (node.weaponProficiencies?.[weaponType]) return true;

        // Existing saves predate explicit purchased-proficiency tracking. A
        // rank of C or lower on a Promoted/Advanced class is the only legal
        // off-class state, so it is safe to recognize it as purchased.
        const rank = normalizeWeaponRank(this.system.weaponRanks?.[weaponType]);
        return canBuyOffClassWeaponRank(node.classType)
            && !!rank
            && rankIdx(rank) <= rankIdx("C");
    }

    _getHolyBloodGrowths() {
        const out = {};
        if (!game.settings?.get("fires-of-war", "useHolyBlood")) return out;
        const lines = Array.isArray(this.system.holyBlood) ? this.system.holyBlood : [];
        for (const entry of lines) {
            const data = FEUE.HOLY_BLOOD[entry?.bloodline];
            if (!data) continue;
            const half = entry.strength === "Minor";
            for (const [k, v] of Object.entries(data.growths)) {
                const val = half ? Math.floor(v / 2) : v;
                out[k] = (out[k] || 0) + val;
            }
        }
        return out;
    }

    _getCrestGrowthReductions() {
        const out = {};
        if (!game.settings?.get("fires-of-war", "useCrests")) return out;
        const crests = Array.isArray(this.system.crests) ? this.system.crests : [];
        for (const c of crests) {
            const red = c?.reductions || {};
            for (const [k, v] of Object.entries(red)) {
                out[k] = (out[k] || 0) + Number(v || 0);
            }
        }
        return out;
    }

    _getCrestHpGrowthPenalty() {
        if (!game.settings?.get("fires-of-war", "useCrests")) return 0;
        const crests = Array.isArray(this.system.crests) ? this.system.crests : [];
        const hasMajor = crests.some(c => c?.strength === "Major");
        const hasMinor = crests.some(c => c?.strength === "Minor");
        return (hasMajor && hasMinor) ? 1 : 0;
    }

    _hasCrestForRelic(weaponName) {
        if (!weaponName) return false;
        if (!game.settings?.get("fires-of-war", "useCrests")) return false;
        if (!game.settings?.get("fires-of-war", "useHeroRelics")) return false;
        const crests = Array.isArray(this.system.crests) ? this.system.crests : [];
        return crests.some(c => c?.relic && c.relic === weaponName);
    }

    _hasHolyBloodForWeapon(weaponName) {
        if (!weaponName) return false;
        if (!game.settings?.get("fires-of-war", "useHolyBlood")) return false;
        const lines = Array.isArray(this.system.holyBlood) ? this.system.holyBlood : [];
        for (const entry of lines) {
            const data = FEUE.HOLY_BLOOD[entry?.bloodline];
            if (data && data.weapon === weaponName) return true;
        }
        return false;
    }

    getDamageStat(weaponType) {
        weaponType = weaponTypeKey(weaponType);
        const a = this.system.attributes || {};
        if (weaponType === "firearm") return { stat: "SPD", value: a.speed?.value || 0 };
        if (FEUE.MAG_WEAPON_TYPES.includes(weaponType)) return { stat: "MAG", value: a.magic?.value || 0 };
        return { stat: "STR", value: a.strength?.value || 0 };
    }
}

// ====================================================================
// 3. ACTOR SHEET
// ====================================================================
class FiresOfWarCharacterSheet extends ActorSheet {
    async _updateObject(event, formData) {
        // Current Movement is displayed after Rescue. Preserve the raw value when
        // submitting another field, and convert intentional edits back to base units.
        const key = "system.movement.current";
        if (rescueMovementHalved(this.actor) && key in formData) {
            formData[key] = Number(formData[key]) === this.actor.system.movement.current
                ? this.actor._source.system.movement.current : Math.max(0, Number(formData[key]) * 2);
        }
        // Revival Stones: a unit given more stones starts with all of them; remaining never exceeds the total.
        const stonesMax = "system.revivalStones.max", stonesValue = "system.revivalStones.value";
        if (stonesMax in formData) {
            const max = Math.min(5, Math.max(0, Math.trunc(Number(formData[stonesMax]) || 0))), before = revivalState(this.actor);
            formData[stonesMax] = max;
            if (max !== before.max && Number(formData[stonesValue] ?? before.value) === before.value && before.value === before.max) formData[stonesValue] = max;
            if (stonesValue in formData) formData[stonesValue] = Math.min(max, Math.max(0, Math.trunc(Number(formData[stonesValue]) || 0)));
        }
        return super._updateObject(event, formData);
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            classes: ["feue", "sheet", "actor", "character"],
            template: "systems/fires-of-war/templates/actor/character-sheet.html",
            width: 980, height: 750,
            // Keep the page where it was when an edit re-renders the sheet.
            scrollY: [".sheet-body", ".unit-sidebar"],
            tabs: [{ navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "main" }]
        });
    }

    getData() {
        const data = super.getData();
        data.terrain = getAppliedTerrain(this.actor);
        data.hasTerrainStats = !!(data.terrain.avoid || data.terrain.defense);
        data.appId = this.appId;
        data.FEUE = FEUE;
        data.weaponRankOptions = Object.entries(FEUE.WEAPON_RANKS).map(([key, value]) => ({ key, label: value.label }));
        data.battalionRankOptions = data.weaponRankOptions.filter(option => option.key);
        data.isGM = !!game.user.isGM;
        data.classes = this.actor.items.filter(i => i.type === "class");
        data.skills = this.actor.items.filter(i => i.type === "skill").map(skill => {
            const info = skillAutomationInfo(skill, activeSkillRule(skill));
            const badge = {auto: "Auto", partial: "Partial", manual: "GM", none: "Manual", off: "Off"}[info.status] ?? "Manual";
            return {_id: skill._id, id: skill.id, name: skill.name, img: skill.img, system: skill.system, automation: {...info, badge,
                tooltip: tooltipAttributes(breakdownHtml({title: `${skill.name} — ${badge}`, total: "", terms: [], notes: [info.summary]}))}};
        });
        data.spells = this.actor.items.filter(i => i.type === "spell");
        data.combatArts = this.actor.items.filter(i => i.type === "combatArt" && !combatArtReason(this.actor, i));
        data.miscBonus = this.actor.items.filter(i => i.type === "miscBonus");
        data.weapons = this.actor.items.filter(i => i.type === "weapon");
        data.battalion = this.actor.items.find(i => i.type === "battalion") || null;
        data.battalions = this.actor.items.filter(i => i.type === "battalion").map(bn => {
            const stats = battalionStats(this.actor, bn), area = battalionArea(bn);
            return {_id: bn._id, id: bn.id, name: bn.name, img: bn.img, system: bn.system, tooltip: tooltipAttributes(battalionTooltip(this.actor, bn)),
                summary: [stats.attacks ? `${stats.damage} Dmg · ${stats.hit}% Hit` : "Support", area?.key === "custom" ? "Custom area" : area?.key ?? "Self",
                    `END ${bn.system.endurance?.value ?? 0}/${bn.system.endurance?.max ?? 0}`].join(" · "), unusable: battalionUseReason(this.actor, bn)};
        });
        data.battalionLimit = battalionLimit(this.actor);
        data.battalionFull = data.battalions.length >= data.battalionLimit;
        data.items = this.actor.items.filter(i => i.type === "item").map(item => ({
            _id: item._id, id: item.id, name: item.name, img: item.img, system: item.system, usesLabel: formatUses(item.system.uses)
        }));
        data.inventory = this._getInventoryUsage();

        // Class info from tree
        data.equippedClass = data.classes.find(c => c.system.equipped);
        if (data.equippedClass) {
            const node = this.actor._getCurrentClassNode(data.equippedClass);
            data.currentClassName = node.name;
            data.currentClassType = node.classType;
        }

        // Roleplay Traits are collected from the equipped class's active
        // promotion path. Each base/optional choice is stored on the actor so
        // the class item remains reusable by different characters.
        const roleplayChoices = this.actor.system.roleplayTraitChoices;
        const choiceMap = roleplayChoices && typeof roleplayChoices === "object" && !Array.isArray(roleplayChoices)
            ? roleplayChoices
            : {};
        data.roleplayTraitSources = this.actor._getRoleplayTraitSources().map(source => {
            const sourceChoices = choiceMap[source.key] && typeof choiceMap[source.key] === "object"
                ? choiceMap[source.key]
                : {};
            const traits = source.traits.map((pair, index) => {
                const useAlternative = sourceChoices[index] === "alternative" && !!pair.alternative;
                return {
                    index,
                    base: pair.base,
                    alternative: pair.alternative,
                    hasAlternative: !!pair.alternative,
                    selected: useAlternative ? "alternative" : "base",
                    name: useAlternative ? pair.alternative : pair.base
                };
            }).filter(trait => trait.name);
            return {
                ...source,
                traits,
                canSwap: traits.some(trait => trait.hasAlternative)
            };
        });
        data.hasRoleplayTraitSources = data.roleplayTraitSources.length > 0;
        data.personalTrait = typeof this.actor.system.personalTrait === "string"
            ? this.actor.system.personalTrait.trim()
            : "";

        // Split weapon ranks into class-granted vs off-class groups, with all
        // rank costs/caps exposed directly in the UI.
        const classNode = data.equippedClass
            ? this.actor._getCurrentClassNode(data.equippedClass)
            : null;
        const classProficiencies = classNode?.weaponProficiencies || {};
        const classType = classNode?.classType || "";
        const classProfCount = Object.values(classProficiencies).filter(Boolean).length;
        data.proficientWeapons = [];
        data.otherWeapons = [];
        for (const [weapon, label] of Object.entries(FEUE.WeaponTypes)) {
            const rank = normalizeWeaponRank(this.actor.system.weaponRanks?.[weapon]);
            const currentIdx = rankIdx(rank);
            const maxIdx = this._weaponMaxRankIdx(weapon);
            const isClassProficient = !!classProficiencies[weapon];
            const offClassAllowed = canBuyOffClassWeaponRank(classType);
            const canBuyMastery = isClassProficient && rank === "S" && classProfCount === 1;
            let canSpend = false;
            let actionTitle;
            if (!classNode) {
                actionTitle = "Equip a class before spending WEXP";
            } else if (canBuyMastery) {
                canSpend = true;
                actionTitle = "Spend 1 WEXP on a weapon mastery bonus";
            } else if (!isClassProficient && !offClassAllowed) {
                actionTitle = "Only Promoted or Advanced classes can buy off-class ranks";
            } else if (currentIdx >= maxIdx) {
                actionTitle = `Maximum rank: ${rankLabel(RANK_ORDER[maxIdx])}`;
            } else {
                const cost = isClassProficient ? 1 : 2;
                const nextRank = RANK_ORDER[currentIdx + 1];
                canSpend = true;
                actionTitle = `Spend ${cost} WEXP to advance to ${nextRank}`;
            }
            const entry = {
                key: weapon,
                label,
                rank,
                maxRank: rankLabel(RANK_ORDER[maxIdx]),
                cost: isClassProficient ? 1 : 2,
                canSpend,
                actionTitle
            };
            (isClassProficient ? data.proficientWeapons : data.otherWeapons).push(entry);
        }
        data.hasClassProficiencies = data.proficientWeapons.length > 0;
        data.hasOtherWeapons = data.otherWeapons.length > 0;

        data.battalionRank = normalizeWeaponRank(this.actor.system.battalionRank) || "E";

        // Mastery bonuses (for display)
        data.weaponMasteryDisplay = [];
        for (const [wt, bonuses] of Object.entries(this.actor.system.weaponMasteryBonuses || {})) {
            const parts = [];
            for (const [k, v] of Object.entries(bonuses || {})) {
                if (!v) continue;
                const spec = FEUE.MASTERY_BONUSES[k];
                if (!spec) continue;
                parts.push(`+${v}${spec.suffix} ${spec.label}`);
            }
            if (parts.length) data.weaponMasteryDisplay.push({ type: FEUE.WeaponTypes[wt] || wt, text: parts.join(", ") });
        }

        // Weapons - include rank context so failures are understandable before
        // the player rolls.
        data.weapons = data.weapons.map(w => {
            const properties = normalizeWeaponProperties(w.system.properties);
            const typeKey = weaponTypeKey(w.system.weaponType);
            return {
                _id: w._id, id: w.id, name: w.name, img: w.img, system: w.system,
                broken: Number(w.system.uses?.max || 0) > 0 && Number(w.system.uses?.value || 0) <= 0,
                repairable: Number(w.system.uses?.max || 0) > 0 && !properties.legendary,
                usesLabel: hasInfiniteUses(w.system.uses) || Number(w.system.uses?.max) > 0 ? formatUses(w.system.uses) : "",
                usable: this.actor.canUseWeapon(w),
                typeLabel: FEUE.WeaponTypes[typeKey] || w.system.weaponType || "Weapon",
                requiredRank: normalizeWeaponRank(w.system.rank, { allowPrf: true }) || "Invalid",
                currentRank: normalizeWeaponRank(this.actor.system.weaponRanks?.[typeKey]) || "—"
            };
        });

        // Hover breakdowns use the single selected (or only) token for terrain, auras and positions.
        const statToken = actorActionToken(this.actor);
        const attributeTips = attributeDisplay(this.actor, statToken);
        const combatDisplay = combatStatDisplay(this.actor, statToken);
        data.combatStats = COMBAT_STATS.map(({key, label, suffix}) => ({key, label: key === "critRate" ? "Critical Rate" : label, suffix,
            value: combatDisplay[key].value, tooltip: tooltipAttributes(combatDisplay[key].html)}));
        data.hpTooltip = tooltipAttributes(attributeTips.hp.html);
        data.movementTooltip = tooltipAttributes(movementDisplay(this.actor, statToken).html);
        data.statusEntries = (this.actor.system.statusEffects ?? []).map((effect, idx) => {
            const key = String(effect?.name ?? effect).trim().toLowerCase(), rule = STATUS_RULES[key];
            const parts = [rule?.summary, ...Object.entries(effect?.attributes ?? {}).filter(([, v]) => Number(v)).map(([k, v]) => `${v > 0 ? "+" : ""}${v} ${FEUE.STAT_LABELS[k] ?? (k === "move" ? "Move" : k)}`),
                ...Object.entries(effect?.combat ?? {}).filter(([, v]) => Number(v)).map(([k, v]) => `${v > 0 ? "+" : ""}${v} ${({hitRate: "Hit", critRate: "Crit", avoid: "Avoid", dodge: "Dodge", damage: "damage", damageReduction: "damage reduction"})[k] ?? k}`)].filter(Boolean);
            return {idx, name: effect?.name ?? effect, img: rule ? CONDITION_ICONS[key] : "", duration: effect?.duration, tooltip: parts.length ? tooltipAttributes(breakdownHtml({title: effect?.name ?? effect, total: "", notes: parts})) : ""};
        });
        // Dead is Foundry's own token status; it is listed here too and lasts until removed.
        if (this.actor.statuses?.has(DEAD_STATUS)) data.statusEntries.unshift({dead: true, name: "Dead", img: CONFIG.statusEffects.find(s => s.id === DEAD_STATUS)?.img ?? "icons/svg/skull.svg",
            tooltip: tooltipAttributes(breakdownHtml({title: "Dead", total: "", notes: ["Slain: defeated in the encounter. Lasts until removed."]}))});

        // Stable rules-order stat rows with readable labels.
        data.nonHpAttributes = FEUE.STAT_KEYS
            .filter(key => key !== "hp")
            .map(key => {
                const attribute = this.actor.system.attributes?.[key] || { value: 0, max: 0 };
                const permanentValue = Number(attribute.value || 0) - (key === "defense" ? data.terrain.defense : 0);
                return {
                    key,
                    label: FEUE.STAT_LABELS[key] || key,
                    value: Number(attribute.value || 0),
                    max: Number(attribute.max || 0),
                    percent: Number(attribute.max || 0) > 0
                        ? clampPercent(permanentValue / Number(attribute.max) * 100)
                        : 0,
                    atCap: Number(attribute.max || 0) > 0 && permanentValue >= Number(attribute.max || 0),
                    tooltip: tooltipAttributes(attributeTips[key].html)
                };
            });
        data.growthRateEntries = FEUE.STAT_KEYS.map(key => ({
            key,
            label: FEUE.STAT_LABELS[key] || key,
            value: Number(this.actor.system.growthRates?.[key] || 0),
            tooltip: tooltipAttributes(attributeTips[key].growthHtml)
        }));
        const hp = this.actor.system.attributes?.hp;
        data.hpPercent = Number(hp?.max || 0) > 0
            ? clampPercent(Number(hp?.value || 0) / Number(hp.max) * 100)
            : 0;
        data.experiencePercent = clampPercent(Number(this.actor.system.experience || 0) / 10 * 100);

        // Support ranks
        const cha = this.actor.system.attributes?.charm?.value || 0;
        data.supportLimit = Math.min(1 + Math.floor(cha / 4), 8);
        const supports = this.actor.system.supportRanks || {};
        data.supportEntries = Object.entries(supports).map(([key, val]) => {
            const aff = FEUE.AFFINITY_BONUSES[val.affinity] || null;
            const mult = FEUE.SUPPORT_RANK_MULTIPLIER[val.rank] || 0;
            let bonusText = "—";
            if (aff && mult) {
                bonusText = `+${aff.pVal * mult} ${aff.primary}, +${aff.sVal * mult} ${aff.secondary}`;
            }
            return { key, name: val.name, rank: val.rank, affinity: val.affinity, bonusText };
        });
        data.supportCount = data.supportEntries.length;

        // Alt rule flags (read once for template)
        data.useFatigue = !!game.settings.get("fires-of-war", "useFatigue");
        data.useCrests = !!game.settings.get("fires-of-war", "useCrests");
        data.useReclassing = !!game.settings.get("fires-of-war", "useReclassing");
        data.properPromotion = game.settings.get("fires-of-war", "properPromotion") || "off";
        data.statMaxBonus = Number(game.settings.get("fires-of-war", "statMaxBonus") || 0);

        // Allegiance (phase) chosen for this character's tokens
        data.allegianceOptions = allegianceOptions(actorAllegiance(this.actor));
        // Fate Points, Revival Stones and Replaceable Mounts
        data.isGM = game.user.isGM;
        data.useFatePoints = fateEnabled();
        if (data.useFatePoints) {
            const fp = this.actor.system.fatePoints ?? {};
            data.fate = {value: fatePoints(this.actor), max: fateMax(this.actor), autoNegate: fp.autoNegate ?? !!this.actor.hasPlayerOwner, rerollSkills: !!fp.rerollSkills};
        }
        data.useRevivalStones = revivalEnabled() && revivalAllowed(this.actor);
        if (data.useRevivalStones) {
            const state = revivalState(this.actor), multiplier = revivalHpMultiplier(this.actor);
            data.revival = {...state, pips: Array.from({length: state.max}, (_, n) => n < state.value), multiplier: multiplier !== 1 ? multiplier : 0,
                bonuses: state.bonuses.map((row, index) => ({index, when: row.when === "above" ? "above" : "atOrBelow", stones: Number(row.stones) || 0, stat: row.stat, value: Number(row.value) || 0,
                    active: state.max > 0 && (row.when === "above" ? state.value > Number(row.stones) : state.value <= Number(row.stones))}))};
            data.revivalStats = Object.entries(REVIVAL_STAT_KEYS).map(([key, label]) => ({key, label}));
        }
        data.replaceableMounts = replaceableMounts();
        if (data.replaceableMounts) {
            const mount = this.actor.items.find(i => isMountItem(i) && i.system.equipped);
            const mounted = this.actor.system.mount ?? {};
            data.mountStatus = mounted.dismounted ? (mounted.lost ? "Dismounted · mount lost" : "Dismounted") : mount ? `Riding ${mount.name}` : "No mount equipped";
            data.mountForced = !!mounted.forced;
        }

        // Fatigue display
        if (data.useFatigue) {
            const bld = Number(this.actor.system.attributes?.build?.value || 0);
            const fat = Number(this.actor.system.fatigue?.value || 0);
            data.fatigueValue = fat;
            data.fatigueMax = bld;
            data.fatigued = bld > 0 && fat >= bld;
        }

        // Crests
        data.crestEntries = (this.actor.system.crests || []).map((c, idx) => ({
            idx,
            name: c.name || "",
            strength: c.strength || "Minor",
            relic: c.relic || "",
            reductions: c.reductions || {}
        }));

        // Reclassing: list alternate classes stored by id
        const allClasses = this.actor.items.filter(i => i.type === "class");
        const altIds = Array.isArray(this.actor.system.alternateClasses) ? this.actor.system.alternateClasses : [];
        data.alternateClassEntries = altIds.map(id => {
            const c = this.actor.items.get(id);
            return c ? { id, name: c.name, classType: c.system.classType } : null;
        }).filter(Boolean);
        data.reclassAvailable = data.useReclassing
            && ((this.actor.system.totalLevel || 0) >= 10 || (this.actor.system.level || 0) >= 10)
            && this.actor.reclassTargets().length > 0;
        data.reclassNeedsSeal = secondSealRequired();
        data.classChoices = allClasses.map(c => ({ id: c.id, name: c.name, classType: c.system.classType }));

        // Holy Blood (alt rule)
        data.useHolyBlood = !!game.settings.get("fires-of-war", "useHolyBlood");
        data.holyBloodOptions = Object.keys(FEUE.HOLY_BLOOD);
        data.holyBloodEntries = (this.actor.system.holyBlood || []).map((e, idx) => {
            const info = FEUE.HOLY_BLOOD[e.bloodline];
            return {
                idx,
                bloodline: e.bloodline || "",
                strength: e.strength || "Major",
                weapon: info?.weapon || "—"
            };
        });

        // Dedupe any legacy duplicate Level Up Bonus items (do not auto-create new ones)
        const lubMatches = this.actor.items.filter(i =>
            i.type === "miscBonus" && (i.getFlag("fires-of-war", "isLevelUpBonus") || i.name === "Bonuses from Level Up")
        );
        if (lubMatches.length > 1) this.actor._dedupeLevelUpBonus();

        return data;
    }

    _getInventoryUsage() {
        return inventoryUsage(this.actor);
    }

    async _onDropItem(event, data) {
        const item = await Item.implementation.fromDropData(data);
        if (item?.parent?.type === "party") {
            try { return await requestConvoy({action: "withdraw", partyId: item.parent.id, unitUuid: this.actor.uuid, itemId: item.id}); }
            catch (error) { ui.notifications.warn(error.message); return false; }
        }
        return super._onDropItem(event, data);
    }

    _disableFields(form) {
        super._disableFields(form);
        // Foundry disables all buttons for observers, including navigation.
        for (const button of form.querySelectorAll(".sheet-page-step")) button.disabled = false;
    }

    activateListeners(html) {
        super.activateListeners(html);
        // Page browsing must also work on observer sheets.
        html.find(".sheet-page-step").click(event => {
            event.preventDefault();
            const tabs = this._tabs[0];
            if (!tabs) return;
            const pages = html.find(".sheet-tabs [data-tab]").toArray().map(el => el.dataset.tab);
            const index = Math.max(0, pages.indexOf(tabs.active));
            const step = Number(event.currentTarget.dataset.pageStep);
            tabs.activate(pages[(index + step + pages.length) % pages.length], { triggerCallback: true });
            html.find(".sheet-body").scrollTop(0);
            html.find(".tab.active .sheet-page-step").filter(`[data-page-step="${step}"]`).trigger("focus");
        });
        html.find(".sheet-tabs [data-tab]").on("keydown", event => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.currentTarget.click();
        });
        if (!this.options.editable) return;

        html.find(".level-up").click(async () => this.actor.levelUp());
        html.find(".award-xp").click(() => this._onAwardXp());

        // Fatigue
        html.find(".feue-allegiance-select").change(async ev => {
            try { await setActorAllegiance(this.actor, ev.currentTarget.value); }
            catch (error) { ui.notifications.error(`Could not change allegiance: ${error.message}`); }
        });
        // Fate Points
        html.find(".fate-adjust").click(async ev => {
            const value = Math.max(0, fatePoints(this.actor) + Number(ev.currentTarget.dataset.delta));
            await this.actor.update({"system.fatePoints.value": value});
        });
        html.find(".fate-refresh").click(async () => {
            await refreshFatePoints([this.actor]);
            ChatMessage.create({speaker: ChatMessage.getSpeaker({actor: this.actor}), content: `<p><b>${_escapeTokenActionHtml(this.actor.name)}</b> refreshes to ${fateMax(this.actor)} Fate Points.</p>`});
        });
        // Revival Stones: Empowering Revival stat rows are edited as a whole array.
        const revivalRows = () => foundry.utils.deepClone(revivalState(this.actor).bonuses);
        html.find(".revival-bonus-add").click(async () => {
            await this.actor.update({"system.revivalStones.bonuses": [...revivalRows(), {when: "atOrBelow", stones: 1, stat: "strength", value: 2}]});
        });
        html.find(".revival-bonus-remove").click(async ev => {
            const index = Number(ev.currentTarget.closest("[data-index]").dataset.index);
            await this.actor.update({"system.revivalStones.bonuses": revivalRows().filter((row, n) => n !== index)});
        });
        html.find(".feue-revival-bonus [data-field]").change(async ev => {
            const index = Number(ev.currentTarget.closest("[data-index]").dataset.index), field = ev.currentTarget.dataset.field;
            const rows = revivalRows();
            if (!rows[index]) return;
            rows[index][field] = ["stones", "value"].includes(field) ? Math.trunc(Number(ev.currentTarget.value) || 0) : ev.currentTarget.value;
            await this.actor.update({"system.revivalStones.bonuses": rows});
        });

        html.find(".fatigue-inc").click(async () => {
            const cur = Number(this.actor.system.fatigue?.value || 0);
            await this.actor.update({ "system.fatigue.value": cur + 1 });
        });
        html.find(".fatigue-rest").click(async () => {
            const cur = Number(this.actor.system.fatigue?.value || 0);
            const roll = await new Roll("1d10").evaluate();
            const reduced = Math.max(0, cur - roll.total);
            await this.actor.update({ "system.fatigue.value": reduced });
            ChatMessage.create({
                user: game.user.id, speaker: ChatMessage.getSpeaker({ actor: this.actor }),
                content: `<div class="feue-levelup"><h3>${this.actor.name} rested!</h3><p>Fatigue reduced by ${roll.total} (${cur} → ${reduced}).</p></div>`
            });
        });

        // Crests
        html.find(".crest-add").click(async () => {
            const list = foundry.utils.deepClone(this.actor.system.crests || []);
            list.push({ name: "", strength: "Minor", relic: "", reductions: {} });
            await this.actor.update({ "system.crests": list });
        });
        html.find(".crest-remove").click(async ev => {
            const idx = Number($(ev.currentTarget).data("idx"));
            const list = foundry.utils.deepClone(this.actor.system.crests || []);
            list.splice(idx, 1);
            await this.actor.update({ "system.crests": list });
        });
        html.find(".crest-name, .crest-strength, .crest-relic").change(async ev => {
            const idx = Number($(ev.currentTarget).data("idx"));
            const el = ev.currentTarget;
            const field = el.classList.contains("crest-name") ? "name"
                : el.classList.contains("crest-strength") ? "strength"
                : "relic";
            const list = foundry.utils.deepClone(this.actor.system.crests || []);
            if (!list[idx]) return;
            list[idx][field] = el.value;
            await this.actor.update({ "system.crests": list });
        });
        html.find(".crest-edit-reductions").click(async ev => {
            const idx = Number($(ev.currentTarget).data("idx"));
            const list = foundry.utils.deepClone(this.actor.system.crests || []);
            const crest = list[idx];
            if (!crest) return;
            const rows = FEUE.STAT_KEYS.map(k => {
                const v = Number(crest.reductions?.[k] || 0);
                return `<div class="form-group"><label style="flex:1">${FEUE.STAT_LABELS[k] || k}</label><input type="number" data-stat="${k}" value="${v}" style="width:60px" min="0"/></div>`;
            }).join("");
            new Dialog({
                title: `Edit Growth Reductions — ${crest.name || "Crest"}`,
                content: `<div><p>Major Crest: reduce one GR by 2 <i>or</i> two by 1. Minor Crest: reduce one GR by 1.</p>${rows}</div>`,
                buttons: {
                    save: {
                        label: "Save",
                        callback: (dlg) => {
                            const reductions = {};
                            dlg.find("input[data-stat]").each((_, inp) => {
                                const k = inp.dataset.stat;
                                const v = Number(inp.value || 0);
                                if (v) reductions[k] = v;
                            });
                            const list2 = foundry.utils.deepClone(this.actor.system.crests || []);
                            if (list2[idx]) {
                                list2[idx].reductions = reductions;
                                this.actor.update({ "system.crests": list2 });
                            }
                        }
                    },
                    cancel: { label: "Cancel" }
                },
                default: "save"
            }).render(true);
        });

        // Reclassing
        html.find(".alt-class-add").click(async () => {
            const choices = this.actor.items.filter(i => i.type === "class").map(c => ({ id: c.id, name: c.name, type: c.system.classType }));
            const current = Array.isArray(this.actor.system.alternateClasses) ? this.actor.system.alternateClasses : [];
            if (current.length >= 2) {
                ui.notifications.warn("Maximum 2 alternate classes.");
                return;
            }
            const available = choices.filter(c => !current.includes(c.id));
            if (!available.length) {
                ui.notifications.warn("No additional classes on this character to add. Drag a class item in first.");
                return;
            }
            const opts = available.map(c => `<option value="${c.id}">${c.name} (${c.type})</option>`).join("");
            new Dialog({
                title: "Add Alternate Class",
                content: `<div><p>Choose a Standard class to add as an alternate.</p><select id="feue-alt-class" style="width:100%">${opts}</select></div>`,
                buttons: {
                    add: {
                        label: "Add",
                        callback: async (dlg) => {
                            const id = dlg.find("#feue-alt-class").val();
                            if (!id) return;
                            const list = [...current, id];
                            await this.actor.update({ "system.alternateClasses": list });
                        }
                    },
                    cancel: { label: "Cancel" }
                },
                default: "add"
            }).render(true);
        });
        html.find(".alt-class-remove").click(async ev => {
            const id = $(ev.currentTarget).data("id");
            const list = (this.actor.system.alternateClasses || []).filter(x => x !== id);
            await this.actor.update({ "system.alternateClasses": list });
        });
        html.find(".reclass-btn").click(async () => {
            // With class change items in use, reclassing is a Second Seal's item use (a Major Action in encounters).
            if (secondSealRequired()) {
                const seal = secondSealsOf(this.actor)[0];
                if (!seal) return ui.notifications.warn(`${this.actor.name} needs a Second Seal to reclass.`);
                try { return await this._useItem(seal); }
                catch (error) { return ui.notifications.warn(error.message); }
            }
            const choices = this.actor.reclassTargets();
            if (!choices.length) { ui.notifications.warn("No classes available to reclass into."); return; }
            const opts = choices.map(c => `<option value="${c.id}">${esc(c.name)} (${c.system.classType})</option>`).join("");
            new Dialog({
                title: "Reclass",
                content: `<div><p>Choose a class to switch to. Stats and weapon ranks are preserved.</p><select id="feue-reclass-choice" style="width:100%">${opts}</select></div>`,
                buttons: {
                    reclass: {
                        label: "Reclass",
                        callback: async (dlg) => {
                            const id = dlg.find("#feue-reclass-choice").val();
                            if (!id) return;
                            await this.actor.reclassTo(id);
                        }
                    },
                    cancel: { label: "Cancel" }
                },
                default: "reclass"
            }).render(true);
        });

        html.find(".holy-blood-add").click(async () => {
            const lines = foundry.utils.deepClone(this.actor.system.holyBlood || []);
            lines.push({ bloodline: Object.keys(FEUE.HOLY_BLOOD)[0], strength: "Major" });
            await this.actor.update({ "system.holyBlood": lines });
        });
        html.find(".holy-blood-remove").click(async ev => {
            const idx = Number($(ev.currentTarget).data("idx"));
            const lines = foundry.utils.deepClone(this.actor.system.holyBlood || []);
            lines.splice(idx, 1);
            await this.actor.update({ "system.holyBlood": lines });
        });
        html.find(".holy-blood-bloodline, .holy-blood-strength").change(async ev => {
            const idx = Number($(ev.currentTarget).data("idx"));
            const field = ev.currentTarget.classList.contains("holy-blood-bloodline") ? "bloodline" : "strength";
            const lines = foundry.utils.deepClone(this.actor.system.holyBlood || []);
            if (!lines[idx]) return;
            lines[idx][field] = ev.currentTarget.value;
            await this.actor.update({ "system.holyBlood": lines });
        });
        html.find(".level-reset").click(async () => {
            new Dialog({
                title: "Reset Level",
                content: `<p><b>Warning:</b> This will remove ALL stat gains from leveling up and reset ${this.actor.name} to Level 1.</p><p>Are you sure?</p>`,
                buttons: {
                    yes: { icon: '<i class="fas fa-exclamation-triangle"></i>', label: "Reset", callback: () => this.actor.levelReset() },
                    no: { label: "Cancel" }
                },
                default: "no"
            }).render(true);
        });
        html.find(".item-control.item-create").click(async (ev) => this._onItemCreate(ev));
        html.find(".item-control.item-edit").click(ev => {
            const id = $(ev.currentTarget).closest(".item").data("item-id");
            const item = this.actor.items.get(id);
            if (item) item.sheet.render(true);
        });

        html.find(".item-control.item-delete").click(async ev => {
            const id = $(ev.currentTarget).closest(".item").data("item-id");
            const item = this.actor.items.get(id);
            if (!item) return;
            if (item.getFlag("fires-of-war", "isLevelUpBonus")) {
                ui.notifications.warn("The Level Up Bonus cannot be deleted.");
                return;
            }
            await item.delete();
        });

        html.find(".item-control.class-equip").click(async ev => {
            const id = $(ev.currentTarget).closest(".item").data("item-id");
            const item = this.actor.items.get(id);
            if (!item) return;

            if (item.system.equipped) {
                // ── Unequip: remove innate skills ──
                const node = this.actor._getCurrentClassNode(item);
                await this.actor._removeInnateSkills(node);
                await item.update({ "system.equipped": false });
                await this.actor.update({ "system.unitTypes": [] });
                return;
            }

            // Unequip all other classes first
            for (const c of this.actor.items.filter(i => i.type === "class" && i.system.equipped)) {
                const oldNode = this.actor._getCurrentClassNode(c);
                await this.actor._removeInnateSkills(oldNode);
                await c.update({ "system.equipped": false });
            }

            // Equip the new class
            await item.update({ "system.equipped": true });

            // ── Grant skills up to current level ──
            const node = this.actor._getCurrentClassNode(item);
            await this.actor._syncClassProfile(node);
            const currentLevel = this.actor.system.level || 1;
            await this.actor._grantClassSkills(node, { upToLevel: currentLevel });
        });

        html.find(".item-control.weapon-equip").click(async ev => {
            const id = $(ev.currentTarget).closest(".item").data("item-id");
            const item = this.actor.items.get(id);
            if (!item) return;
            if (item.system.equipped) { await item.update({ "system.equipped": false }); return; }
            const others = this.actor.items.filter(i => i.type === "weapon" && i.system.equipped && i.id !== item.id);
            if (others.length) await this.actor.updateEmbeddedDocuments("Item", others.map(w => ({ _id: w.id, "system.equipped": false })));
            await item.update({ "system.equipped": true });
        });

        html.find(".item-control.item-equip").click(async ev => {
            const id = $(ev.currentTarget).closest(".item").data("item-id");
            const item = this.actor.items.get(id);
            if (!item) return;
            if (item.system.equipped) { await item.update({ "system.equipped": false }); return; }
            if (isMountItem(item) && mountLost(item)) return ui.notifications.warn(`${item.name} was lost. Equip a new mount.`);
            // Unequip the other item in the same slot (accessory or, with Replaceable Mounts, mount)
            const others = this.actor.items.filter(i => sameEquipSlot(i, item) && i.system.equipped && i.id !== item.id);
            if (others.length) await this.actor.updateEmbeddedDocuments("Item", others.map(i => ({ _id: i.id, "system.equipped": false })));
            await item.update({ "system.equipped": true });
        });

        html.find(".roll-attack").click(async (ev) => this._onRollAttack(ev));
        html.find(".roll-battalion").click(async (ev) => this._onRollBattalion(ev));
        html.find(".roll-spell").click(async (ev) => this._onRollSpell(ev));
        html.find(".roll-combat-art").click(async (ev) => this._onRollCombatArt(ev));
        html.find(".configure-roleplay-traits").click(ev => this._openRoleplayTraitSwapDialog(ev.currentTarget.dataset.sourceKey));
        html.find(".roll-roleplay-trait").click(ev => this._promptRoleplayTraitRoll(ev.currentTarget.dataset.trait || ""));
        html.find(".roll-roleplay-no-trait").click(() => this._promptRoleplayTraitRoll(""));
        html.find(".item-control.use-item").click(async (ev) => this._onUseItem(ev));
        html.find(".item-control.use-skill").click(async (ev) => this._onUseSkill(ev));
        html.find(".item-control.trigger-skill").click(async (ev) => this._onTriggerSkill(ev));

        // Status effects
        html.find(".status-effect-add").click(() => this._onAddStatusEffect());
        html.find(".status-effect-remove").click(ev => ev.currentTarget.dataset.status === DEAD_STATUS
            ? this.actor.toggleStatusEffect(DEAD_STATUS, {active: false})
            : this._onRemoveStatusEffect(Number($(ev.currentTarget).data("effect-index"))));
        html.find(".effect-duration-input").change(ev => {
            const idx = Number($(ev.currentTarget).data("effect-index"));
            const val = Number(ev.currentTarget.value);
            const statuses = foundry.utils.deepClone(this.actor.system.statusEffects || []);
            if (statuses[idx]) {
                statuses[idx].duration = val;
                this.actor.update({ "system.statusEffects": statuses });
            }
        });

        // Weapon EXP spending
        html.find(".wexp-spend").click(async (ev) => this._onSpendWexp(ev));
        html.find(".weapon-repair").click(async (ev) => this._onRepairWeapon(ev));
        html.find(".battalion-ranks-toggle").click(ev => {
            const toggle = $(ev.currentTarget);
            toggle.next(".battalion-ranks-content").slideToggle(200);
            toggle.find("i.fas").toggleClass("fa-caret-right fa-caret-down");
        });

        // Supports
        html.find(".support-add").click(() => this._onAddSupport());
        html.find(".support-remove").click(ev => this._onRemoveSupport($(ev.currentTarget).data("support-key")));
        html.find(".support-rank-select").change(ev => {
            const key = $(ev.currentTarget).data("support-key");
            const rank = ev.currentTarget.value;
            this.actor.update({ [`system.supportRanks.${key}.rank`]: rank });
        });

        html.find(".other-weapons-toggle").click(ev => {
            const toggle = $(ev.currentTarget);
            const content = toggle.next(".other-weapons-content");
            content.slideToggle(200);
            toggle.find("i.fas").toggleClass("fa-caret-right fa-caret-down");
        });

        // Mark the Level Up Bonus item as non-deletable and visually distinct
        const lubId = this.actor.items.find(i =>
            i.type === "miscBonus" && i.getFlag("fires-of-war", "isLevelUpBonus")
        )?._id;
        if (lubId) {
            const lubEl = html.find(`.item[data-item-id="${lubId}"]`);
            lubEl.addClass("level-up-bonus-item");
            lubEl.find(".item-delete").remove();
        }
    }

    _openRoleplayTraitSwapDialog(sourceKey) {
        const source = this.actor._getRoleplayTraitSources().find(entry => entry.key === sourceKey);
        if (!source) return ui.notifications.warn("That class no longer contributes Roleplay Traits.");
        const allChoices = this.actor.system.roleplayTraitChoices;
        const choiceMap = allChoices && typeof allChoices === "object" && !Array.isArray(allChoices)
            ? allChoices
            : {};
        const selected = choiceMap[source.key] && typeof choiceMap[source.key] === "object"
            ? choiceMap[source.key]
            : {};
        const rows = source.traits.map((pair, index) => {
            const base = _escapeTokenActionHtml(pair.base || "Unnamed Trait");
            const alternative = _escapeTokenActionHtml(pair.alternative);
            const useAlternative = selected[index] === "alternative" && !!pair.alternative;
            return `<div class="feue-trait-swap-row">
                <label for="feue-trait-choice-${index}">Trait ${index + 1}</label>
                <select id="feue-trait-choice-${index}" data-trait-index="${index}">
                    <option value="base"${useAlternative ? "" : " selected"}>${base}</option>
                    ${pair.alternative ? `<option value="alternative"${useAlternative ? " selected" : ""}>${alternative} (replaces ${base})</option>` : ""}
                </select>
            </div>`;
        }).join("");

        const dialog = new Dialog({
            title: `${source.className}: Roleplay Traits`,
            content: `<form class="feue-trait-swap-dialog">
                <p>Choose the base trait or its specific optional replacement for each slot.</p>
                ${rows || "<p>No traits are configured for this class.</p>"}
            </form>`,
            buttons: {
                save: {
                    icon: '<i class="fas fa-save"></i>',
                    label: "Save Choices",
                    callback: async html => {
                        const nextChoices = foundry.utils.deepClone(choiceMap);
                        nextChoices[source.key] = {};
                        html.find("select[data-trait-index]").each((_, element) => {
                            nextChoices[source.key][element.dataset.traitIndex] = element.value === "alternative"
                                ? "alternative"
                                : "base";
                        });
                        await this.actor.update({ "system.roleplayTraitChoices": nextChoices });
                    }
                },
                cancel: { label: "Cancel" }
            },
            default: "save"
        }, { width: 520 });
        dialog.render(true);
    }

    _promptRoleplayTraitRoll(traitName) {
        const hasRelevantTrait = typeof traitName === "string" && !!traitName.trim();
        const safeTrait = _escapeTokenActionHtml(hasRelevantTrait ? traitName.trim() : "No Relevant Trait");
        const options = Array.from({ length: 9 }, (_, index) => index + 2).map(target => {
            const labels = { 2: "Trivial", 4: "Simple", 6: "Standard", 8: "Hard", 10: "Impossible" };
            return `<option value="${target}"${target === 6 ? " selected" : ""}>TN ${target}${labels[target] ? ` — ${labels[target]}` : ""}</option>`;
        }).join("");
        const dialog = new Dialog({
            title: `Roleplay Trait Check: ${safeTrait}`,
            content: `<form class="feue-trait-roll-dialog">
                <p><b>${safeTrait}</b> rolls <b>${roleplayTraitFormula(hasRelevantTrait)}</b>${hasRelevantTrait ? " (keep highest)" : ""}.</p>
                <div class="form-group"><label for="feue-trait-tn">Target Number</label><select id="feue-trait-tn">${options}</select></div>
            </form>`,
            buttons: {
                roll: {
                    icon: '<i class="fas fa-dice-d10"></i>',
                    label: "Roll Check",
                    callback: html => this._rollRoleplayTrait(traitName, Number(html.find("#feue-trait-tn").val()))
                },
                cancel: { label: "Cancel" }
            },
            default: "roll"
        }, { width: 430 });
        dialog.render(true);
    }

    async _rollRoleplayTrait(traitName, target) {
        const hasRelevantTrait = typeof traitName === "string" && !!traitName.trim();
        const formula = roleplayTraitFormula(hasRelevantTrait);
        const tn = clampTraitTarget(target);
        const roll = await new Roll(formula).evaluate();
        const success = isSuccessfulTraitRoll(roll.total, tn);
        const traitLabel = hasRelevantTrait ? traitName.trim() : "No Relevant Trait";
        await ChatMessage.create({
            user: game.user.id,
            speaker: ChatMessage.getSpeaker({ actor: this.actor }),
            rolls: [roll],
            content: `<div class="feue-trait-check ${success ? "success" : "failure"}">
                <h3>${_escapeTokenActionHtml(this.actor.name)} — Roleplay Check</h3>
                <p><b>Trait:</b> ${_escapeTokenActionHtml(traitLabel)}</p>
                <p><b>Result:</b> ${roll.total} vs TN ${tn} — <b>${success ? "SUCCESS" : "FAILURE"}</b></p>
            </div>`
        });
    }

    async _onRollAttack(event) {
        event.preventDefault();
        const weapon = this.actor.items.get(event.currentTarget.dataset.weaponId);
        if (!weapon) return;

        return this._promptWeaponAttack(weapon);
    }

    async _promptWeaponAttack(weapon, {validateTarget, sourceToken} = {}) {
        if (weaponTypeKey(weapon.system.weaponType) === "staff" && !weapon.makeshift) return this._useStaff(weapon);
        const targetToken = Array.from(game.user.targets)[0] ?? null;
        const target = targetToken?.actor ?? null;
        sourceToken ??= this.actor.token?.object ?? canvas.tokens?.controlled.find(t => t.actor === this.actor);
        if (!sourceToken) {
            const copies = canvas.tokens?.placeables.filter(t => t.actor === this.actor) ?? [];
            if (copies.length === 1) sourceToken = copies[0];
        }
        const grid = canvas.grid?.getOffset ? canvas.grid : canvas.grid?.grid;
        const options = battleDeclarations(this.actor, weapon, {sourceToken, targetToken, grid});
        const buildForecast = (triangle, declared) => createBattleForecast({actor: this.actor, weapon, target, sourceToken, targetToken, grid, triangle: forecastTriangle(triangle), declared});
        const chosenTriangle = h => h.find("#wt-triangle").val() ?? "auto";
        const declaredFrom = h => Object.fromEntries(options.map(o => [o.key, o.forced || !!h.find(`[data-declare="${o.key}"]`).prop("checked")]));
        const declareHtml = options.length ? `<fieldset class="feue-battle-declare"><legend>Declare skills</legend>${options.map(o => `<label title="${_escapeTokenActionHtml(o.summary)}"><input type="checkbox" data-declare="${o.key}" ${o.forced ? "checked disabled" : ""}/> ${_escapeTokenActionHtml(o.label)}${o.forced ? " <small>(required for this range)</small>" : ""}</label>`).join("")}</fieldset>` : "";
        const sourceItem = weapon.sourceItem ?? weapon;
        const dialog = new Dialog({
            title: "Battle Forecast",
            content: `<form class="feue-battle-form">
                <div class="feue-battle-heading"><span>Battle forecast</span><small>Damage per strike · before critical hits · hover a value for its breakdown</small></div>
                <div id="attack-preview">${renderBattleForecast(buildForecast("auto", Object.fromEntries(options.map(o => [o.key, o.forced]))))}</div>
                ${triangleOverride() ? `<div class="feue-battle-triangle"><label for="wt-triangle">Weapon Triangle override</label>
                    <select id="wt-triangle">
                        <option value="auto">Automatic</option>
                        <option value="none">None</option>
                        <option value="advantage">Advantage (+15 Hit, +3 Mt)</option>
                        <option value="disadvantage">Disadvantage (-15 Hit, -3 Mt)</option>
                    </select>
                </div>` : ""}
                ${declareHtml}
            </form>`,
            buttons: {
                roll: {
                    icon: '<i class="fas fa-crosshairs"></i>', label: "Attack",
                    callback: async (h) => {
                        if (validateTarget && !validateTarget()) return;
                        if (this.actor.items.get(sourceItem.id) !== sourceItem || targetToken &&
                            (targetToken.destroyed || !targetToken.visible || targetToken.document.hidden && !game.user.isGM ||
                            targetToken.actor !== target || Array.from(game.user.targets).length !== 1 || !game.user.targets.has(targetToken))) {
                            return ui.notifications.warn("The battle target or weapon changed. Open the forecast again.");
                        }
                        if (sourceToken && targetToken && !tokenInItemRange(sourceToken, targetToken, weapon, grid)) {
                            return ui.notifications.warn("The target is outside this weapon's range.");
                        }
                        try { await requestBattleAttack(buildForecast(chosenTriangle(h), declaredFrom(h))); }
                        catch (error) { console.error("FEUE | Battle failed", error); ui.notifications.error(error.message); }
                    }
                },
                cancel: { label: "Cancel" }
            },
            default: "roll",
            render: (h) => {
                const refresh = () => h.find("#attack-preview").html(renderBattleForecast(buildForecast(chosenTriangle(h), declaredFrom(h))));
                h.find("#wt-triangle").change(refresh);
                h.find("[data-declare]").change(refresh);
            }
        }, {classes: ["dialog", "feue-battle-dialog"], width: Math.min(680, window.innerWidth - 32)});
        dialog.render(true);
    }

    /** Get targeted token's actor, if any. */
    _getTarget() {
        const t = Array.from(game.user.targets)[0];
        return t?.actor || null;
    }

    /**
     * Compute attack stats without rolling. Used for preview and execution.
     * modifiers: initiating, sourceToken, targetToken, targetWeapon, targetCanCounter, brave, declared {cleave, overdraw},
     * might/hit/crit (+ source label), extraTerms {damage, hit, crit} and defenseMultiplier from rolled skills.
     */
    _computeAttackStats(weapon, triangle = "none", target = null, modifiers = {}) {
        const a = this.actor;
        const weaponType = weaponTypeKey(weapon.system.weaponType);
        const isBroken = !hasInfiniteUses(weapon.system.uses) && (weapon.system.uses?.value ?? 1) <= 0;
        const isNonProf = !a.canUseWeapon(weapon);
        const penalties = [];
        const specialsDisabled = isBroken || isNonProf;
        // Broken/non-proficient weapons cannot use special abilities.
        const props = specialsDisabled
            ? normalizeWeaponProperties(null)
            : normalizeWeaponProperties(weapon.system.properties);
        const propNotes = [];
        const initiating = modifiers.initiating !== false;
        const sourceDoc = actorActionToken(a, modifiers.sourceToken);
        const targetDoc = actorActionToken(target, modifiers.targetToken);
        const tokens = sourceDoc?.parent?.tokens ?? targetDoc?.parent?.tokens ?? (globalThis.canvas?.scene?.id === sourceDoc?.parent?.id ? globalThis.canvas?.tokens?.placeables : null) ?? [sourceDoc, targetDoc].filter(Boolean);
        const targetWeapon = modifiers.targetWeapon !== undefined ? modifiers.targetWeapon : target?.items?.find(i => i.type === "weapon" && i.system?.equipped) ?? null;
        const round = game.combat?.round || 1;
        const magicWeapon = FEUE.MAG_WEAPON_TYPES.includes(weaponType) || props.magical || weapon.system?.weaponType === "spell";
        // Skill-granted weapon qualities.
        let darkPact = 0;
        if (!specialsDisabled) {
            if (hasSkill(a, "monster hunter")) { props.slayer.enabled = true; props.slayer.types.Monster = true; }
            if (hasSkill(a, "golembane")) { props.slayer.enabled = true; props.slayer.types.Mechanical = true; props.slayer.types.Puppet = true; }
            if (hasSkill(a, "dark pact") && ([...TOME_TYPES, "spell"].includes(weaponType) || weapon.system?.weaponType === "spell")) {
                if (props.absorb) darkPact = 5; else { props.absorb = true; propNotes.push("Dark Pact: Absorb"); }
            }
            if (hasSkill(a, "ballistician") && weaponType === "bow") props.vehicle = false;
        }
        const mine = skillModifiers(a, {token: sourceDoc, weapon, foe: target ?? null, foeToken: targetDoc, foeWeapon: targetWeapon, incomingWeapon: targetWeapon,
            initiating, round, tokens}, {own: !specialsDisabled});
        const theirs = target ? skillModifiers(target, {token: targetDoc, weapon: targetWeapon, foe: a, foeToken: sourceDoc, foeWeapon: weapon, incomingWeapon: weapon,
            initiating: !initiating, canCounter: modifiers.targetCanCounter, round, tokens}) : skillModifiers(null);
        if (!specialsDisabled && (mine.brave || modifiers.brave)) props.brave = true;
        if (triangle === "auto") {
            // Broken and non-proficient weapons keep the triangle but lose Reverse/Superior, on either side.
            const foeBroken = !hasInfiniteUses(targetWeapon?.system?.uses) && (targetWeapon?.system?.uses?.value ?? 1) <= 0;
            const foeProps = targetWeapon && !foeBroken && target?.canUseWeapon?.(targetWeapon) !== false ? normalizeWeaponProperties(targetWeapon.system?.properties) : {};
            triangle = target && targetWeapon ? weaponTriangle(weaponType, weaponTypeKey(targetWeapon.system?.weaponType),
                {reverse: props.reverse, superior: props.superior, foeReverse: foeProps.reverse, foeSuperior: foeProps.superior}) : "none";
        } else {
            if (props.reverse) triangle = reverseTriangle(triangle);
            if (props.superior) triangle = weaponTypeKey(targetWeapon?.system?.weaponType) === weaponType ? "advantage" : "none";
        }
        if (hasSkill(a, "beyond morality") || hasSkill(target, "beyond morality")) triangle = "none";

        let mightMult = 1, hitMult = 1, critOverride = null;
        // A broken weapon loses only its base Might. The wielder's damage stat
        // still contributes, unlike a non-proficient weapon whose final Might
        // is halved after bonuses.
        if (isBroken) { hitMult = 0.5; critOverride = 0; penalties.push("BROKEN"); }
        else if (isNonProf) { mightMult = 0.5; hitMult = 0.5; critOverride = 0; penalties.push("NON-PROFICIENT"); }

        const abuseMult = props.abuse ? 2 : 1;
        let triHit = 0, triMt = 0, triNote = "";
        if (triangle === "advantage") { triHit = 15 * abuseMult; triMt = 3 * abuseMult; triNote = `WTA +${triHit} Hit, +${triMt} Mt${props.abuse ? " (Abuse)" : ""}`; }
        else if (triangle === "disadvantage") { triHit = -15 * abuseMult; triMt = -3 * abuseMult; triNote = `WTD ${triHit} Hit, ${triMt} Mt${props.abuse ? " (Abuse)" : ""}`; }

        let di;
        if (props.magical) { di = { stat: "MAG", value: a.system.attributes?.magic?.value || 0 }; propNotes.push("Magical"); }
        else if (props.mechanical) { di = { stat: "SPD", value: a.system.attributes?.speed?.value || 0 }; propNotes.push("Mechanical"); }
        else di = a.getDamageStat(weaponType);
        if (!specialsDisabled && weaponType === "sword" && hasSkill(a, "performance artist")) di = {stat: "CHA", value: Number(a.system.attributes?.charm?.value || 0)};

        const statContribution = props.puncture ? 0 : di.value;
        if (props.puncture) propNotes.push("Puncture");

        const baseMight = isBroken ? 0 : Number(weapon.system.might || 0);

        let slayerMult = 1;
        if (props.slayer?.enabled && target) {
            const rawTargetTypes = target.system?.unitTypes || [];
            const targetTypes = new Set(Array.isArray(rawTargetTypes)
                ? rawTargetTypes
                : Object.entries(rawTargetTypes).filter(([, enabled]) => enabled).map(([type]) => type));
            // Magical Flight and Ultra Heavyweight ignore Slayer (Flying) and Slayer (Armored).
            if (hasSkill(target, "magical flight")) targetTypes.delete("Flying");
            if (hasSkill(target, "ultra heavyweight")) targetTypes.delete("Armored");
            const matched = props.slayer.all || Object.entries(props.slayer.types || {}).some(([type, enabled]) => enabled && targetTypes.has(type));
            if (matched) { slayerMult = 2; propNotes.push(props.slayer.all ? "Slayer (All) × 2" : "Slayer × 2"); }
        }

        // Labelled modifiers from Combat Arts, spells, rolled skills and declared skills.
        const extra = {damage: [...(modifiers.extraTerms?.damage ?? [])], hit: [...(modifiers.extraTerms?.hit ?? [])], crit: [...(modifiers.extraTerms?.crit ?? [])]};
        const source = modifiers.source ?? "Attack bonus";
        if (Number(modifiers.might)) extra.damage.push(term(source, modifiers.might));
        if (Number(modifiers.hit)) extra.hit.push(term(source, modifiers.hit));
        if (Number(modifiers.crit)) extra.crit.push(term(source, modifiers.crit));
        if (modifiers.declared?.overdraw && weaponType === "bow" && hasSkill(a, "overdraw")) {
            extra.damage.push(term("Overdraw", 4)); extra.hit.push(term("Overdraw", -10)); extra.crit.push(term("Overdraw", -10));
        }
        if (modifiers.declared?.cleave && hasSkill(a, "cleave")) extra.hit.push(term("Cleave", -20));
        if (darkPact) extra.damage.push(term("Dark Pact", darkPact));
        const timedDamage = timedEffectTerms(a).filter(t => t.path === "effects.damage").map(t => term(t.label, t.value));

        const damageTerms = [term(`${weapon.name} Mt${isBroken ? " (broken)" : ""}`, baseMight, "base"),
            props.puncture ? term("Puncture: no damage stat", 0, "info") : term(di.stat, statContribution),
            ...extra.damage, ...mine.terms.damage, ...timedDamage, term("Weapon Triangle", triMt)];
        if (mightMult !== 1) damageTerms.push(term("Non-proficient", mightMult, "mult"));
        // Fires of War applies non-proficiency halving after all modifiers.
        const rawDmg = Math.max(Math.floor(sumTerms(damageTerms) * mightMult), 0);

        const mastery = a.system.weaponMasteryBonuses?.[weaponType] || {};
        const masteryLabel = `${FEUE.WeaponTypes[weaponType] ?? "Weapon"} mastery`;
        const prepared = (key, fallbackLabel, fallback) => a.system.breakdown?.[key]?.length ? a.system.breakdown[key] : [term(fallbackLabel, fallback, "base")];
        const hitTerms = [...prepared("combat.baseHitRate", "Base Hit", Number(a.system.combat?.baseHitRate || 0)), term(`${weapon.name} Hit`, Number(weapon.system.hit || 0)),
            term(masteryLabel, mastery.hitRate), ...extra.hit, ...mine.terms.hit, term("Weapon Triangle", triHit)];
        if (hitMult !== 1) hitTerms.push(term(isBroken ? "Broken" : "Non-proficient", hitMult, "mult"));
        const critTerms = [...prepared("combat.baseCritRate", "Base Crit", Number(a.system.combat?.baseCritRate || 0)), term(`${weapon.name} Crit`, Number(weapon.system.crit || 0)),
            term(masteryLabel, mastery.critRate), ...extra.crit, ...mine.terms.crit];
        if (critOverride !== null) critTerms.push(term(isBroken ? "Broken" : "Non-proficient", critOverride, "set"));
        const rawHit = Math.max(Math.floor(sumTerms(hitTerms) * hitMult), 0);
        const rawCrit = critOverride !== null ? critOverride : Math.max(sumTerms(critTerms), 0);

        // Target defenses
        const isMagic = magicWeapon;
        const zeroed = new Set(target?.system?.combat?.zeroed ?? []);
        const terrain = target ? terrainCombatStats(target, modifiers.targetToken) : {avoid: 0, defense: 0};
        const targetTerrain = target && targetDoc?.parent ? tokenTerrain(targetDoc) : null;
        const withoutTerrain = (key, total) => {
            const terms = target?.system?.breakdown?.[key];
            if (!terms?.length) return [term(`${target?.name ?? "Target"} ${key.endsWith("avoid") ? "Avoid" : key.endsWith("dodge") ? "Dodge" : "DEF"}`, total, "base")];
            const own = terms.filter(t => t.key !== "terrain");
            const terrainValue = total - sumTerms(own);
            return [...own, term(`Terrain${targetTerrain ? ` (${targetTerrain.name})` : ""}`, terrainValue, "add", {key: "terrain"})];
        };
        const avoidTerms = zeroed.has("avoid") ? [term("Avoid locked by status", 0, "set")] : [...withoutTerrain("combat.avoid", terrain.avoid), ...theirs.terms.avoid];
        const tAvo = zeroed.has("avoid") ? 0 : sumTerms(avoidTerms);
        const dodgeTerms = zeroed.has("dodge") ? [term("Dodge locked by status", 0, "set")] : [...(target?.system?.breakdown?.["combat.dodge"] ?? [term(`${target?.name ?? "Target"} Dodge`, Number(target?.system?.combat?.dodge || 0), "base")]), ...theirs.terms.dodge];
        const tDodge = zeroed.has("dodge") ? 0 : sumTerms(dodgeTerms);
        const critTaken = target ? statusStatModifiers(target).critTaken : 0;
        const defenseKey = isMagic ? "resistance" : "defense";
        const defTerms = !target ? [] : isMagic
            ? [...(target.system.breakdown?.["attributes.resistance"] ?? [term(`${target.name} RES`, Number(target.system.attributes?.resistance?.value || 0), "base")]), ...theirs.terms.resistance]
            : [...withoutTerrain("attributes.defense", terrain.defense), ...theirs.terms.defense];
        const defenseMultiplier = (modifiers.defenseMultiplier ?? 1) * mine.defenseMultiplier;
        if (defenseMultiplier !== 1) defTerms.push(term(defenseMultiplier ? `${isMagic ? "RES" : "DEF"} reduced` : `${isMagic ? "RES" : "DEF"} ignored`, defenseMultiplier, "mult"));
        const tDef = target ? Math.max(0, Math.floor(sumTerms(defTerms) * defenseMultiplier)) : 0;
        const defLabel = isMagic ? "Res" : "Def";

        let netDmg;
        if (props.piercing) { netDmg = rawDmg; if (target) propNotes.push("Piercing"); }
        else netDmg = Math.max(rawDmg - tDef, 0);
        netDmg *= slayerMult;

        // Flat changes to damage taken (Life and Death, Dark Poise, Inspiration...) apply after critical multiplication.
        const timedReduction = target ? timedEffectTerms(target).filter(t => t.path === "effects.damageReduction").map(t => term(t.label, -t.value)) : [];
        const adjustTerms = [...theirs.terms.damageTaken, ...theirs.terms.damageReduction, ...timedReduction];
        const damageAdjust = sumTerms(adjustTerms);
        const damageMultiplier = mine.damageMultiplier, takenMultiplier = theirs.takenMultiplier;
        const strikeDamage = Math.floor(Math.max(0, Math.floor(Math.max(props.deadly ? 1 : 0, netDmg) * damageMultiplier) + damageAdjust) * takenMultiplier);
        const netHit = Math.max(rawHit - tAvo, 0);
        const netCrit = Math.max(rawCrit - tDodge + critTaken, 0);
        const multTerms = (list, key) => list.multiplierTerms.filter(m => m.key === key).map(m => term(m.label, m.value, "mult"));

        return {
            rawDmg, rawHit, rawCrit,
            netDmg, netHit, netCrit, strikeDamage, damageAdjust, damageMultiplier, takenMultiplier,
            tAvo, tDodge, tDef, defLabel, critTaken,
            baseMight, di, triHit, triMt, triNote, mightMult, penalties,
            disablesSkills: specialsDisabled,
            targetName: target?.name || null,
            props, propNotes,
            doubleSpeed: mine.totals.doubleSpeed,
            passiveEffects: {useMultiplier: mine.useMultiplier, healingFraction: mine.healingFraction, strikes: mine.strikes},
            skillNotes: mine.notes, targetSkillNotes: theirs.notes,
            situational: {mine: mine.situational, theirs: theirs.situational},
            breakdown: {
                damage: {terms: damageTerms, total: rawDmg},
                defense: {terms: defTerms, total: tDef, label: isMagic ? "RES" : "DEF"},
                adjust: {terms: [...adjustTerms, ...multTerms(mine, "damageMultiplier"), ...multTerms(theirs, "takenMultiplier"), ...(slayerMult !== 1 ? [term("Slayer", slayerMult, "mult")] : [])]},
                hit: {terms: hitTerms, total: rawHit},
                avoid: {terms: avoidTerms, total: tAvo},
                crit: {terms: critTerms, total: rawCrit},
                dodge: {terms: dodgeTerms, total: tDodge}
            }
        };
    }

    /** Apply weapon qualities that resolve after a successful attack roll. */
    async _applyWeaponHitEffects(stats, hit, crit, target, options = {}) {
        return resolveWeaponEffects(this, stats, hit, crit, target, options);
    }

    async _executeAttack(weapon, triangle = "auto", {forecast, userId = game.user.id} = {}) {
        forecast ??= createBattleForecast({actor: this.actor, weapon, target: this._getTarget(), triangle});
        assertUnitAction(this.actor, {sourceToken: forecast.sourceToken});
        validateUnitTarget(this.actor, weapon, forecast);
        const declared = forecast.declared ?? {};
        const startEffects = forecast.attacker.stats.disablesSkills ? {notes: []} : await triggerSkills(this.actor, "CombatStart", {weapon, target: forecast.target, initiating: true, token: forecast.sourceToken}, (item, tn) => this._rollSkillActivation(item, {targetOverride: tn, silent: true}));
        if (startEffects.brave || startEffects.noCounter) forecast = createBattleForecast({actor: this.actor, weapon, target: forecast.target, sourceToken: forecast.sourceToken, targetToken: forecast.targetToken,
            grid: forecast.grid ?? (globalThis.canvas?.grid?.getOffset ? canvas.grid : globalThis.canvas?.grid?.grid), triangle, brave: !!startEffects.brave, noCounter: !!startEffects.noCounter, declared});
        // Sword & Pistol: the defender switches to the weapon that can counter.
        if (forecast.defender.swapped && forecast.target) {
            await forecast.target.updateEmbeddedDocuments?.("Item", [...(forecast.defender.swapFrom ? [{_id: forecast.defender.swapFrom.id, "system.equipped": false}] : []), {_id: forecast.defender.weapon.id, "system.equipped": true}]);
        }
        const results = [];
        let openingSkills = startEffects.notes ?? [];
        for (const [index, side] of forecast.order.entries()) {
            const unit = forecast[side], other = forecast[side === "attacker" ? "defender" : "attacker"];
            // Special qualities can change HP during the exchange; a fallen unit cannot continue.
            if (Number(unit.actor.system.attributes?.hp?.value) <= 0 || other.actor && Number(other.actor.system.attributes?.hp?.value) <= 0) break;
            if (isIncapacitated(unit.actor)) continue;
            if (unit.token && other.token && forecast.grid && !tokenInItemRange(unit.token, other.token, unit.weapon, forecast.grid, {retaliation: side === "defender", overdraw: side === "attacker" && declared.overdraw})) continue;
            const attacker = side === "attacker";
            const result = await unit.actor.sheet._executeAttackStrike(unit.weapon,
                attacker ? triangle : reverseTriangle(triangle), other.actor,
                {sourceToken: unit.token, targetToken: other.token, initiating: attacker, userId, strikeLabel: `${index + 1}. ${attacker ? "Attack" : "Retaliation"}`, openingSkills: attacker ? openingSkills : [],
                    combatEffects: attacker ? startEffects : null, declared: attacker ? declared : {}, targetWeapon: other.weapon ?? null, targetCanCounter: attacker ? forecast.canRetaliate : undefined});
            if (attacker) openingSkills = [];
            results.push(...(Array.isArray(result) ? result : [result]));
        }
        if (results.length) await completeMajorAction(this.actor, {sourceToken: forecast.sourceToken, attacked: true});
        await finishCombatEffects(this.actor, forecast.target, results, {sourceToken: forecast.sourceToken, targetToken: forecast.targetToken});
        if (forecast.target) await finishCombatEffects(forecast.target, this.actor, results, {sourceToken: forecast.targetToken, targetToken: forecast.sourceToken, initiating: false});
        // Revival Stones are spent when combat ends; then a declared Capture/Subdue takes the fallen target.
        await resolveExchangeFalls([[this.actor, forecast.sourceToken], [forecast.target, forecast.targetToken]],
            {capture: declared.capture && forecast.target && forecast.targetToken ? {source: forecast.sourceToken, target: forecast.targetToken} : null});
        if (declared.lunge && hasSkill(this.actor, "lunge")) await this._lungeSwap(forecast, results);
        return results;
    }

    /** Lunge: after dealing damage, swap places with the target (both must still be standing). */
    async _lungeSwap(forecast, results) {
        const source = forecast.sourceToken?.document ?? forecast.sourceToken, target = forecast.targetToken?.document ?? forecast.targetToken;
        if (!source || !target || !results.some(r => r.actor === this.actor && r.hit && r.damage > 0)) return;
        if (Number(this.actor.system.attributes?.hp?.value) <= 0 || Number(forecast.target?.system.attributes?.hp?.value) <= 0) return;
        if (hasSkill(forecast.target, "ultra heavyweight")) return ChatMessage.create({speaker: ChatMessage.getSpeaker({actor: this.actor}), content: `<p><b>Lunge:</b> ${_escapeTokenActionHtml(target.name)} cannot be moved (Ultra Heavyweight).</p>`});
        try {
            await displaceTokens([{token: source, x: target.x, y: target.y}, {token: target, x: source.x, y: source.y}]);
            await ChatMessage.create({speaker: ChatMessage.getSpeaker({actor: this.actor}), content: `<p><b>Lunge:</b> ${_escapeTokenActionHtml(source.name)} swaps places with ${_escapeTokenActionHtml(target.name)}.</p>`});
        } catch (error) {
            console.error("FEUE | Lunge swap failed", error);
            ui.notifications.warn("Lunge could not move the tokens; an active GM is required to swap positions.");
        }
    }

    async _executeAttackStrike(weapon, triangle = "none", target = null, {sourceToken, targetToken, initiating = true, userId = game.user.id, strikeLabel = "Attack", attackEffects, durabilityCost = 1, modifiers = {}, expanded = false, openingSkills = [], combatEffects = null, declared = {}, targetWeapon, targetCanCounter} = {}) {
        const a = this.actor;
        sourceToken ??= actorActionToken(a);
        targetToken ??= target ? Array.from(game.user.targets ?? []).find(token => token.actor === target) : null;
        if (normalizeWeaponProperties(weapon.system.properties).vehicle && !(String(weapon.system.weaponType).toLowerCase() === "bow" && hasSkill(a, "ballistician")) && !hasSkill(a, String(weapon.system.weaponType).toLowerCase() === "bow" ? "ballista use" : "cannon use")) throw Error("This vehicle requires Ballista Use or Cannon Use to operate.");
        const context = {sourceToken, targetToken, initiating, declared, ...(targetWeapon !== undefined ? {targetWeapon} : {}), ...(targetCanCounter !== undefined ? {targetCanCounter} : {}), ...modifiers};
        const baseStats = this._computeAttackStats(weapon, triangle, target, context);
        if (!attackEffects) {
            attackEffects = !baseStats.disablesSkills ? await triggerSkills(a, "Attack", {weapon, target, initiating, token: sourceToken}, (item, tn) => this._rollSkillActivation(item, {targetOverride: tn, silent: true})) : {notes: []};
            // Non-rolled Custom effects, combat-start activations (Crest of Flames) and declared Cleave join the per-strike effects.
            const passive = baseStats.passiveEffects ?? {};
            attackEffects = {...attackEffects,
                useMultiplier: (attackEffects.useMultiplier ?? 1) * (passive.useMultiplier ?? 1),
                healingFraction: Math.max(attackEffects.healingFraction ?? 0, passive.healingFraction ?? 0, combatEffects?.healingFraction ?? 0),
                strikes: Math.max(attackEffects.strikes ?? 1, passive.strikes ?? 1),
                absorb: !!(attackEffects.absorb || combatEffects?.absorb),
                startDamage: Number(combatEffects?.damage || 0), startNotes: combatEffects?.damage ? combatEffects.notes : [],
                cleave: !!declared.cleave && hasSkill(a, "cleave")};
        }
        if (!expanded && attackEffects.strikes > 1) {
            const results = [];
            for (let i = 0; i < attackEffects.strikes; i++) {
                if (Number(a.system.attributes?.hp?.value) <= 0 || target && Number(target.system.attributes?.hp?.value) <= 0) break;
                results.push(await this._executeAttackStrike(weapon, triangle, target, {sourceToken, targetToken, initiating, userId, strikeLabel: `${strikeLabel} · Astra ${i + 1}`, attackEffects, durabilityCost, modifiers, expanded: true, openingSkills: i === 0 ? openingSkills : [], declared, targetWeapon, targetCanCounter}));
            }
            return results;
        }
        const skillLabel = (attackEffects.notes ?? []).join(" + ") || "Skill";
        const extraTerms = {damage: [], hit: [], crit: []};
        if (attackEffects.damage) extraTerms.damage.push(term(skillLabel, attackEffects.damage));
        if (attackEffects.hit) extraTerms.hit.push(term(skillLabel, attackEffects.hit));
        if (attackEffects.crit) extraTerms.crit.push(term(skillLabel, attackEffects.crit));
        if (attackEffects.startDamage) extraTerms.damage.push(term(attackEffects.startNotes?.join(" + ") || "Combat start", attackEffects.startDamage));
        const s = this._computeAttackStats(weapon, triangle, target, {...context, extraTerms, defenseMultiplier: attackEffects.defenseMultiplier ?? 1});
        const props = s.props;
        if (attackEffects.absorb) props.absorb = true;

        let hR = await new Roll("1d100").evaluate(); let hit = hR.total <= s.netHit;
        let fateNote = "";
        // Fate Points: the attacker declared a reroll of its first missed attack in this combat.
        if (!hit && initiating && declared.fate && !declared.fateUsed && await spendFatePoint(a)) {
            declared.fateUsed = true;
            const first = hR.total;
            hR = await new Roll("1d100").evaluate(); hit = hR.total <= s.netHit;
            fateNote = `<p class="feue-fate"><b>Fate Point:</b> rerolled ${first} → ${hR.total} (${fatePoints(a)} left)</p>`;
        }
        let crit = false;
        if (hit && s.netCrit > 0 && !props.shade) { const cR = await new Roll("1d100").evaluate(); crit = cR.total <= s.netCrit; }
        // Loptous Blood: the Loptous tome never loses durability.
        const freeUse = hasSkill(a, "loptous blood") && /loptous/i.test(String(weapon.name ?? ""));
        // Per-Map Durability: an encounter participant's weapon is charged at the end of the map instead.
        const mapCombat = perMapTracked(weapon) ? unitCombatant(sourceToken)?.parent ?? null : null;
        if (mapCombat && !freeUse) await recordMapUse(weapon, {combat: mapCombat});
        else if (weapon.system.uses && !hasInfiniteUses(weapon.system.uses) && !freeUse) {
            const spent = Math.max(0, Math.floor(durabilityCost * (attackEffects.useMultiplier ?? 1)));
            const newUses = Math.max(weapon.system.uses.value - spent, 0);
            await weapon.update({ "system.uses.value": newUses });
            if (newUses > 0 && newUses <= 2) ui.notifications.warn(`${weapon.name} has only ${newUses} use(s) remaining!`);
        }

        const skillNotes = hit ? [...openingSkills, ...(attackEffects.notes ?? [])] : [];
        const showOutcome = async defensiveSkills => {
            if (hit) {
                for (const name of skillNotes) await presentCombatText(sourceToken, "skill", name);
                for (const activation of defensiveSkills ?? []) await presentCombatText(activation.actor === a ? sourceToken : targetToken, "skill", activation.name);
            }
            await presentCombatText(targetToken ?? sourceToken, hit ? crit ? "crit" : "hit" : "miss", hit ? crit ? "CRIT" : "HIT" : "MISS");
        };
        const effects = await this._applyWeaponHitEffects(s, hit, crit, target, {weapon, sourceToken, targetToken, initiating, attackEffects, beforeDamage: showOutcome});
        if (!hit) await showOutcome();
        const fd = effects.finalDamage;
        if (hit) {
            await presentCombatText(effects.backfire ? sourceToken : targetToken ?? sourceToken, "damage", `${effects.damageTaken ?? fd} DAMAGE`);
            if (effects.reflectedDamage) await presentCombatText(sourceToken, "damage", `${effects.reflectedDamage} DAMAGE`);
        }
        await defeatEnemyTokens(a);
        // A declared Capture/Subdue decides the target's fate once the exchange ends.
        if (target && !(initiating && declared.capture)) await defeatEnemyTokens(target);

        const penaltyNote = s.penalties.length ? `<p class="feue-penalty"><b>${s.penalties.join(", ")}</b> — penalties applied</p>` : "";
        const triNoteHtml = s.triNote ? `<p class="feue-triangle"><b>${s.triNote}</b></p>` : "";
        const propNoteHtml = s.propNotes.length ? `<p class="feue-props"><b>${s.propNotes.join(", ")}</b></p>` : "";
        const passiveNotes = [...new Set([...(s.skillNotes ?? []), ...(s.targetSkillNotes ?? []).map(name => `${target?.name ?? "Target"}: ${name}`)])];
        const targetNote = target ? `<p class="feue-target"><b>Target:</b> ${target.name} (${s.tAvo} Avo, ${s.tDodge} Dodge, ${s.tDef} ${s.defLabel})</p>` : "";
        const damageCalculation = target
            ? `${crit ? "(" : ""}${s.rawDmg}${props.piercing ? " (Piercing)" : ` - ${s.tDef} ${s.defLabel}`}${crit ? ") × 3" : ""}${s.damageAdjust ? ` ${s.damageAdjust > 0 ? "+" : "−"} ${Math.abs(s.damageAdjust)} skills` : ""}${props.deadly && fd === 1 ? ", Deadly minimum 1" : ""}`
            : `${crit ? "(" : ""}${s.baseMight} Mt + ${s.di.value} ${s.di.stat}${crit ? ") × 3" : ""}`;
        const dmgLine = hit && !props.shade
            ? `<div class="feue-battle-damage"><span>Damage</span><strong tabindex="0" data-tooltip="${_escapeTokenActionHtml(damageCalculation)}" aria-label="${_escapeTokenActionHtml(`${fd} damage: ${damageCalculation}`)}">${fd}</strong></div>`
            : "";
        const hitTip = breakdownHtml({title: "Hit chance", total: Math.min(100, s.netHit), suffix: "%", terms: [...s.breakdown.hit.terms, term(`${target?.name ?? "Target"} Avoid`, -s.tAvo)]});
        await ChatMessage.create({
            user: userId, speaker: ChatMessage.getSpeaker({ actor: a }),
            content: `<div class="feue-attack-roll feue-battle-roll"><div class="feue-battle-roll-heading">${_escapeTokenActionHtml(strikeLabel)}</div><h3>${_escapeTokenActionHtml(a.name)} → ${_escapeTokenActionHtml(target?.name || "No target")}</h3><div class="feue-battle-roll-weapon">${_escapeTokenActionHtml(weapon.name)}</div>${penaltyNote}${triNoteHtml}${propNoteHtml}${targetNote}${fateNote}${skillNotes.length ? `<p><b>Skills:</b> ${skillNotes.map(_escapeTokenActionHtml).join(" · ")}</p>` : ""}${passiveNotes.length ? `<p class="feue-passive-skills"><b>Passive:</b> ${passiveNotes.map(_escapeTokenActionHtml).join(" · ")}</p>` : ""}<div class="feue-battle-result ${hit ? crit ? "critical" : "hit" : "miss"}">${hit ? crit ? "CRITICAL HIT" : "HIT" : "MISS"}<span ${tooltipAttributes(hitTip)}>${hR.total} / ${Math.min(100, s.netHit)}%</span></div>${dmgLine}${effects.shadeNote}${effects.absorbNote}${effects.cursedNote}${effects.effectNote || ""}<p><b>Range:</b> ${_escapeTokenActionHtml(weapon.system.range)}</p></div>`
        });
        return {actor: a, target, weapon, hit, crit, damage: hit ? fd : 0, backfire: effects.backfire, killed: effects.killed};
    }

    async _onRollBattalion(event) {
        event.preventDefault();
        const bn = this.actor.items.get(event.currentTarget.dataset.itemId);
        if (!bn) return;
        return this._beginBattalion(bn);
    }

    /** Aim the Battalion's area on the map, then order it. Battalions without an area resolve immediately. */
    async _beginBattalion(bn, options = {}) {
        const reason = battalionUseReason(this.actor, bn);
        if (reason) return ui.notifications.warn(reason);
        const doc = actorActionToken(this.actor, options.sourceToken);
        const source = doc?.object ?? options.sourceToken ?? null;
        const targeting = game.firesOfWar?.battalionTargeting;
        try {
            if (doc) assertUnitAction(this.actor, {sourceToken: doc});
            if (battalionArea(bn) && source?.document && targeting && canvas.scene?.id === doc.parent?.id && canvas.scene?.grid?.type === CONST.GRID_TYPES.SQUARE) {
                const choice = await targeting.start(source, bn);
                if (!choice) return;
                return await this._executeBattalion(bn, {...options, sourceToken: source, choice});
            }
            return await this._executeBattalion(bn, {...options, sourceToken: source ?? undefined});
        } catch (error) {
            console.error("FEUE | Battalion order failed", error);
            ui.notifications.error(error.message);
        }
    }

    async _executeBattalion(bn, options = {}) {
        const relay = relaySheetAction(this.actor, "battalion", bn, options);
        if (relay) return relay;
        if (!options.actionLocked) return withUnitActionLock(() => this._executeBattalion(bn, {...options, actionLocked: true}));
        assertUnitAction(this.actor, options);
        return resolveBattalion(this, bn, options);
    }

    async _onRollSpell(event) {
        event.preventDefault();
        const sp = this.actor.items.get(event.currentTarget.dataset.itemId);
        if (!sp) return;
        return this._castSpell(sp);
    }

    async _castSpell(sp, options = {}) {
        if (!options.actionLocked) return withUnitActionLock(() => this._castSpell(sp, {...options, actionLocked: true}));
        const a = this.actor;
        const ew = a.items.find(i => i.type === "weapon" && i.system?.equipped);
        if (isSilenced(a)) return ui.notifications.warn(`${a.name} is Silenced and cannot cast spells.`);
        const admix = !!spellAdmixWeapon(a, sp);
        const baseCost = Math.max(0, Number(sp.system.hpCost || 0)), cost = spellHpCost(a, sp, admix);
        if (cost > 0 && Number(a.system.attributes.hp.value) <= cost) return ui.notifications.warn("Not enough HP.");
        if (sp.system.school === "White Magic") {
            if (options.relayed) return this._resolveHealingAction(sp, options);
            return this._castHealingSpell(sp, a, Number(a.system.attributes.magic?.value || 0), admix ? 2 : 0, cost, baseCost, admix, ew, options);
        }
        if (options.validateTarget && !options.validateTarget()) return;
        const relay = relaySheetAction(a, "spell", sp, options);
        if (relay) return relay;
        assertUnitAction(a, options);
        validateUnitTarget(a, sp, options);
        const target = options.targetToken?.actor ?? this._getTarget();
        const spellWeapon = {id: sp.id, name: sp.name, type: "weapon", img: sp.img,
            system: {...sp.system, weaponType: "spell", properties: {magical: true}, uses: null}};
        if (cost > 0) await a.update({"system.attributes.hp.value": Number(a.system.attributes.hp.value) - cost});
        const result = await this._executeAttackStrike(spellWeapon, "none", target, {...options, durabilityCost: 0, strikeLabel: sp.name, targetCanCounter: false,
            modifiers: {might: admix ? 2 : 0, hit: admix ? 10 : 0, crit: admix ? 5 : 0, source: `Admix (${ew?.name ?? "tome"})`}});
        await completeMajorAction(a, {...options, attacked: true});
        await finishCombatEffects(a, target, Array.isArray(result) ? result : [result], options);
        await resolveExchangeFalls([[a, options.sourceToken], [target, options.targetToken]]);
        return result;
    }

    async _useStaff(weapon, {targetTokens, validateHealingTarget, sourceToken} = {}) {
        const caster = this.actor;
        if (isSilenced(caster)) return ui.notifications.warn(`${caster.name} is Silenced and cannot use staves.`);
        const isBroken = !hasInfiniteUses(weapon.system.uses) && (weapon.system.uses?.value ?? 1) <= 0;
        const isNonProf = !caster.canUseWeapon(weapon);
        const penalties = [];
        let mightMult = 1, hitMult = 1;
        if (isBroken) { hitMult = 0.5; penalties.push("BROKEN"); }
        else if (isNonProf) { mightMult = 0.5; hitMult = 0.5; penalties.push("NON-PROFICIENT"); }

        const mag = caster.system.attributes?.magic?.value || 0;
        const baseMight = isBroken ? 0 : Number(weapon.system.might || 0);
        const healing = Math.max(Math.floor((baseMight + mag) * mightMult), 0);
        const weaponHit = Number(weapon.system.hit || 0);
        const needsHitRoll = weaponHit > 0;
        const staffType = weaponTypeKey(weapon.system.weaponType);
        const masteryHit = Number(caster.system.weaponMasteryBonuses?.[staffType]?.hitRate || 0);
        const rawHit = needsHitRoll
            ? Math.max(Math.floor((Number(caster.system.combat?.baseHitRate || 0) + weaponHit + masteryHit) * hitMult), 0)
            : 0;

        const targetOptions = targetTokens
            ? targetTokens.map(t => `<option value="${_escapeTokenActionHtml(t.id)}">${_escapeTokenActionHtml(t.name)}</option>`)
            : [`<option value="self">Self (${caster.name})</option>`];
        if (!targetTokens && typeof canvas !== "undefined" && canvas.tokens?.placeables) {
            for (const token of canvas.tokens.placeables) {
                if (token.actor && token.actor.id !== caster.id) {
                    targetOptions.push(`<option value="${token.actor.id}">${token.actor.name}</option>`);
                }
            }
        }

        const penaltyLine = penalties.length ? `<p style="color:red;"><b>${penalties.join(", ")}</b></p>` : "";
        const hitLine = needsHitRoll ? `<p>Hit: <b>${rawHit}%</b></p>` : "";

        new Dialog({
            title: `Use ${weapon.name}`,
            content: `<form>
                ${penaltyLine}
                <div class="form-group"><label>Target</label><select id="staff-target">${targetOptions.join("")}</select></div>
                <p>Healing: <b>${healing}</b> HP (${baseMight} Mt + ${mag} MAG${mightMult !== 1 ? ` × ${mightMult}` : ""})</p>
                ${hitLine}
            </form>`,
            buttons: {
                use: {
                    icon: '<i class="fas fa-heart"></i>', label: "Use",
                    callback: async (h) => {
                        const targetId = h.find("#staff-target").val();
                        const targetToken = targetTokens?.find(t => t.id === targetId);
                        if (validateHealingTarget && !validateHealingTarget(targetToken)) return;
                        const target = targetTokens ? targetToken?.actor : targetId === "self" ? caster : game.actors.get(targetId);
                        if (!target) return;
                        return this._resolveHealingAction(weapon, {sourceToken, targetToken: targetToken ?? actorActionToken(target)});
                    }
                },
                cancel: { label: "Cancel" }
            },
            default: "use"
        }).render(true);
    }

    async _castHealingSpell(sp, caster, mag, admixMt, cost, baseCost, admix, admixWeapon, {targetTokens, validateHealingTarget, sourceToken} = {}) {
        const healing = Number(sp.system.might || 0) + mag + admixMt;

        // Build target options: Self + tokens on canvas
        const targetOptions = targetTokens
            ? targetTokens.map(t => `<option value="${_escapeTokenActionHtml(t.id)}">${_escapeTokenActionHtml(t.name)}</option>`)
            : [`<option value="self">Self (${caster.name})</option>`];
        if (!targetTokens && typeof canvas !== "undefined" && canvas.tokens?.placeables) {
            for (const token of canvas.tokens.placeables) {
                if (token.actor && token.actor.id !== caster.id) {
                    targetOptions.push(`<option value="${token.actor.id}">${token.actor.name}</option>`);
                }
            }
        }

        new Dialog({
            title: `${sp.name} — Healing`,
            content: `<form>
                <div class="form-group"><label>Target</label><select id="heal-target">${targetOptions.join("")}</select></div>
                <p>Healing: <b>${healing}</b> HP (${sp.system.might} Mt + ${mag} MAG${admixMt ? ` + ${admixMt} Admix` : ""})</p>
                <p>HP Cost: <b>${cost}</b>${admix ? ` (base ${baseCost})` : ""}</p>
            </form>`,
            buttons: {
                cast: {
                    icon: '<i class="fas fa-heart"></i>', label: "Cast",
                    callback: async (h) => {
                        const targetId = h.find("#heal-target").val();
                        const targetToken = targetTokens?.find(t => t.id === targetId);
                        if (validateHealingTarget && !validateHealingTarget(targetToken)) return;
                        const target = targetTokens ? targetToken?.actor : targetId === "self" ? caster : game.actors.get(targetId);
                        if (!target) return;
                        return this._resolveHealingAction(sp, {sourceToken, targetToken: targetToken ?? actorActionToken(target)});
                    }
                },
                cancel: { label: "Cancel" }
            },
            default: "cast"
        }).render(true);
    }

    async _onRollCombatArt(event) {
        event.preventDefault();
        const art = this.actor.items.get(event.currentTarget.dataset.itemId);
        if (!art) return;
        const weapons = this.actor.items.filter(i => i.type === "weapon");
        if (!weapons.length) return ui.notifications.warn("No weapons available.");
        const restr = art.system.weaponRestriction || "—";
        const valid = weapons.filter(w => !combatArtReason(this.actor, art, w));
        if (!valid.length) return ui.notifications.warn("No weapon meets this Combat Art's prerequisites.");
        if (valid.length === 1) return this._executeCombatArt(art, valid[0]);
        const opts = valid.map(w => `<option value="${w.id}">${w.name}</option>`).join("");
        new Dialog({
            title: `${art.name}`, content: `<form><div class="form-group"><label>Weapon</label><select id="ca-wpn">${opts}</select></div></form>`,
            buttons: { use: { label: "Use", callback: (h) => { const w = this.actor.items.get(h.find("#ca-wpn").val()); if (w) this._executeCombatArt(art, w); } }, cancel: { label: "Cancel" } }, default: "use"
        }).render(true);
    }

    async _executeCombatArt(art, weapon, options = {}) {
        if (!options.actionLocked) return withUnitActionLock(() => this._executeCombatArt(art, weapon, {...options, actionLocked: true}));
        if (options.validateTarget && !options.validateTarget()) return;
        const reason = combatArtReason(this.actor, art, weapon);
        if (reason) throw Error(reason);
        const dc = Math.max(Number(art.system.durabilityCost || 0), 0);
        // Risky Combat Arts: pay the cost in HP, durability, or let the player choose (Remove Durability always uses HP).
        const costMode = artCostMode();
        let payWith = dc <= 0 ? "durability" : costMode === "choice" ? options.choice?.artCost ?? null : costMode;
        if (!["hp", "durability"].includes(payWith)) {
            payWith = await this._chooseArtCost(art, weapon, dc);
            if (!payWith) return;
            options = {...options, choice: {...(options.choice ?? {}), artCost: payWith}};
        }
        const hp = Number(this.actor.system.attributes?.hp?.value) || 0;
        if (payWith === "hp" && dc >= hp) return ui.notifications.warn(`${this.actor.name} needs more than ${dc} HP to use ${art.name}.`);
        const perMap = payWith === "durability" && perMapTracked(weapon);
        if (perMap) {
            const mapReason = perMapArtReason(weapon, perMapArtCost(dc));
            if (mapReason) return ui.notifications.warn(mapReason);
        } else if (payWith === "durability" && weapon.system.uses && !hasInfiniteUses(weapon.system.uses) && dc > Number(weapon.system.uses.value || 0)) return ui.notifications.warn(`Not enough durability on ${weapon.name}.`);
        const relay = relaySheetAction(this.actor, "art", art, {...options, weapon});
        if (relay) return relay;
        assertUnitAction(this.actor, options);
        validateUnitTarget(this.actor, weapon, options);
        const target = options.targetToken?.actor ?? this._getTarget();
        if (payWith === "hp" && dc > 0) {
            if (dc >= (Number(this.actor.system.attributes?.hp?.value) || 0)) throw Error(`${this.actor.name} needs more than ${dc} HP to use ${art.name}.`);
            await this.actor.update({"system.attributes.hp.value": Number(this.actor.system.attributes.hp.value) - dc});
        }
        const mapCombat = perMap ? unitCombatant(actorActionToken(this.actor, options.sourceToken))?.parent ?? null : null;
        if (mapCombat) await recordMapUse(weapon, {combat: mapCombat, arts: perMapArtCost(dc)});
        const result = await this._executeAttackStrike(weapon, "auto", target, {...options, durabilityCost: payWith === "hp" ? 0 : dc, strikeLabel: payWith === "hp" && dc ? `${art.name} (${dc} HP)` : art.name, targetCanCounter: false,
            modifiers: {might: Number(art.system.might || 0), hit: Number(art.system.hit || 0), crit: Number(art.system.crit || 0), source: art.name}});
        await completeMajorAction(this.actor, {...options, attacked: true});
        await finishCombatEffects(this.actor, target, Array.isArray(result) ? result : [result], options);
        await resolveExchangeFalls([[this.actor, options.sourceToken], [target, options.targetToken]]);
        return result;
    }

    /** Risky Combat Arts (Player's Choice): spend weapon durability or the same amount of HP. */
    async _chooseArtCost(art, weapon, cost) {
        const hp = Number(this.actor.system.attributes?.hp?.value) || 0;
        return new Promise(resolve => {
            let choice = null;
            new Dialog({title: `${art.name} — Cost`, content: `<p>Pay for <b>${_escapeTokenActionHtml(art.name)}</b> with <b>${cost}</b> durability from ${_escapeTokenActionHtml(weapon.name)} (${formatUses(weapon.system.uses)}) or <b>${cost} HP</b> (${hp} HP)?</p>`,
                buttons: {durability: {label: `${cost} durability`, callback: () => { choice = "durability"; }},
                    hp: {label: `${cost} HP`, callback: () => { choice = "hp"; }}, cancel: {label: "Cancel"}},
                default: "durability", close: () => resolve(choice)}).render(true);
        });
    }

    async _resolveHealingAction(item, options = {}) {
        if (!options.actionLocked) return withUnitActionLock(() => this._resolveHealingAction(item, {...options, actionLocked: true}));
        const relay = relaySheetAction(this.actor, "healing", item, options);
        if (relay) return relay;
        assertUnitAction(this.actor, options);
        validateUnitTarget(this.actor, item, {...options, allowSelf: true});
        const target = options.targetToken?.actor;
        if (!target) throw Error("Choose a token to heal.");
        const caster = this.actor, spell = item.type === "spell";
        if (!spell && String(item.system.weaponType).toLowerCase() !== "staff" || spell && item.system.school !== "White Magic") throw Error("This item cannot heal.");
        if (isSilenced(caster)) throw Error(`${caster.name} is Silenced and cannot use staves or spells.`);
        const admix = spell && !!spellAdmixWeapon(caster, item);
        const cost = spell ? spellHpCost(caster, item, admix) : 0;
        if (cost >= Number(caster.system.attributes.hp.value) && cost > 0) throw Error("Not enough HP.");
        const broken = !spell && !hasInfiniteUses(item.system.uses) && Number(item.system.uses?.value ?? 1) <= 0, nonProf = !spell && !caster.canUseWeapon(item);
        const value = Number(caster.system.attributes?.[hasSkill(caster, "performance artist") ? "charm" : "magic"]?.value || 0);
        const healing = Math.max(0, Math.floor(((broken ? 0 : Number(item.system.might || 0)) + value + (admix ? 2 : 0) + (!spell && hasSkill(caster, "healtouch") ? 5 : 0)) * (nonProf ? 0.5 : 1)));
        let hit = true;
        if (!spell && Number(item.system.hit) > 0) {
            const chance = Math.max(0, Math.floor((Number(caster.system.combat.baseHitRate || 0) + Number(item.system.hit)) * (broken || nonProf ? 0.5 : 1)) - terrainCombatStats(target, options.targetToken).avoid);
            hit = (await new Roll("1d100").evaluate()).total <= chance;
        }
        if (cost) await caster.update({"system.attributes.hp.value": Number(caster.system.attributes.hp.value) - cost});
        if (!spell && item.system.uses && !hasInfiniteUses(item.system.uses)) await item.update({"system.uses.value": Math.max(0, Number(item.system.uses.value) - 1)});
        const healed = hit ? await healActor(target, healing) : 0;
        if (hit && !spell && hasSkill(caster, "live to serve")) await healActor(caster, healed);
        await completeMajorAction(caster, options);
        await ChatMessage.create({user: options.userId ?? game.user.id, speaker: ChatMessage.getSpeaker({actor: caster}), content: `<p><b>${_escapeTokenActionHtml(caster.name)}</b> uses <b>${_escapeTokenActionHtml(item.name)}</b> on ${_escapeTokenActionHtml(target.name)}: ${hit ? `${healed} HP restored` : "Miss"}.</p>`});
        return {hit, healed};
    }

    /** Compute the activation target number for a skill. */
    _computeSkillActivationTarget(skill) {
        const s = skill.system || {};
        const type = ["fixed", "stat", "stat_mult"].includes(s.activationTargetType)
            ? s.activationTargetType
            : "stat_mult";
        const statKey = FEUE.STAT_KEYS.includes(s.activationStat) ? s.activationStat : "skill";
        const statVal = Number(this.actor.system.attributes?.[statKey]?.value || 0);
        return computeSkillActivationTarget({
            type,
            statValue: statVal,
            multiplier: s.activationMult,
            fixed: s.activationFixed
        });
    }

    /** Roll activation for a single skill and post to chat. Returns {success, roll, target}. */
    async _rollSkillActivation(skill, { silent = false, targetOverride } = {}) {
        if (skill.system?.activationTrigger === "Passive") return {success: true, roll: null, target: null};
        const target = targetOverride ?? this._computeSkillActivationTarget(skill);
        const r = await new Roll("1d100").evaluate();
        // Fate Points: a failed activation may be rerolled once; the new result must be taken.
        const reroll = r.total > target ? await fateSkillReroll(this.actor, skill, target, r.total) : null;
        const total = reroll ?? r.total;
        const success = total <= target;
        if (!silent) {
            const s = skill.system || {};
            const type = ["fixed", "stat", "stat_mult"].includes(s.activationTargetType)
                ? s.activationTargetType
                : "stat_mult";
            const statKey = FEUE.STAT_KEYS.includes(s.activationStat) ? s.activationStat : "skill";
            const statLabel = FEUE.STAT_LABELS[statKey] || statKey.toUpperCase();
            const multiplier = Number.isFinite(Number(s.activationMult)) ? Number(s.activationMult) : 1;
            const desc = targetOverride !== undefined ? `${target}% (rulebook / automation)` : type === "fixed"
                ? `${target}%`
                : type === "stat"
                    ? `${statLabel} (${target}%)`
                    : `${statLabel} × ${multiplier} (${target}%)`;
            await ChatMessage.create({
                user: game.user.id, speaker: ChatMessage.getSpeaker({ actor: this.actor }),
                content: `<div class="feue-skill-activation"><h3>${this.actor.name} — ${skill.name}</h3><p><b>Activation:</b> rolled ${total} vs ${desc} — <b>${success ? "ACTIVATED" : "failed"}</b></p>${success && s.activation ? `<p><b>Effect:</b> ${s.activation}</p>` : ""}</div>`
            });
        }
        return { success, roll: total, target };
    }

    /** Auto-fire all "Passive (Activated)" skills with matching trigger ("Attack" or "Defense"). */
    async _autoTriggerSkills(triggerType) {
        return triggerSkills(this.actor, triggerType, {}, (item, tn) => this._rollSkillActivation(item, {targetOverride: tn}));
    }

    async _onTriggerSkill(event) {
        event.preventDefault();
        const id = $(event.currentTarget).data("item-id");
        const skill = this.actor.items.get(id);
        if (!skill || skill.type !== "skill") return;
        await this._rollSkillActivation(skill);
    }

    async _onUseSkill(event) {
        event.preventDefault();
        const itemId = $(event.currentTarget).data("item-id");
        const skill = this.actor.items.get(itemId);
        if (!skill || skill.type !== "skill") return;

        try { return await this._useSkill(skill); }
        catch (error) { ui.notifications.error(error.message); }
    }

    async _useSkill(skill, options = {}) {
        if (["dismount", "mount"].includes(String(skill.name).trim().toLowerCase())) {
            if (options.relayed) return toggleMount(this.actor, options);
            const token = actorActionToken(this.actor, options.sourceToken);
            if (token && globalThis.game?.firesOfWar?.requestUnitCommand) return game.firesOfWar.requestUnitCommand(token, "mount");
            return toggleMount(this.actor, options);
        }
        if (!options.actionLocked) return withUnitActionLock(() => this._useSkill(skill, {...options, actionLocked: true}));
        if (await useActiveSkill(this, skill, options)) return;
        assertUnitAction(this.actor, options);
        const relay = relaySheetAction(this.actor, "skill", skill, options);
        if (relay) return relay;
        await ChatMessage.create({
            user: game.user.id,
            speaker: ChatMessage.getSpeaker({ actor: this.actor }),
            content: `<div class="feue-skill-use"><h3>${this.actor.name} activates ${skill.name}!</h3><p><b>Type:</b> ${skill.system.skillType}</p>${skill.system.activation ? `<p><b>Effect:</b> ${skill.system.activation}</p>` : ""}</div>`
        });
        await completeMajorAction(this.actor, options);
    }

    /** Compute the max weapon rank index available to a given weapon type for this actor. */
    _weaponMaxRankIdx(weaponType) {
        const actor = this.actor;
        if (!Object.hasOwn(FEUE.WeaponTypes, weaponType)) return rankIdx("");
        const ec = actor.items.find(i => i.type === "class" && i.system?.equipped);
        const node = ec ? actor._getCurrentClassNode(ec) : null;
        if (!node) return rankIdx(normalizeWeaponRank(actor.system.weaponRanks?.[weaponType]));
        const classType = node.classType || "Standard";
        const isProficient = !!node?.weaponProficiencies?.[weaponType];

        const hasOtherS = Object.entries(actor.system.weaponRanks || {})
            .some(([key, value]) => normalizeWeaponRank(value) === "S" && key !== weaponType);
        return rankIdx(weaponRankLimit({ classType, isClassProficient: isProficient, hasOtherS }));
    }

    async _onSpendWexp(event) {
        event.preventDefault();
        const weaponType = event.currentTarget.dataset.weaponType;
        const actor = this.actor;
        if (!Object.hasOwn(FEUE.WeaponTypes, weaponType)) return ui.notifications.error("Unknown weapon type.");
        if (this._wexpSpendPending) return;
        this._wexpSpendPending = true;

        try {
            const ec = actor.items.find(i => i.type === "class" && i.system?.equipped);
            const node = ec ? actor._getCurrentClassNode(ec) : null;
            if (!node) return ui.notifications.warn("Equip a class before spending WEXP.");
            const isProficient = !!node.weaponProficiencies?.[weaponType];
            if (!isProficient && !canBuyOffClassWeaponRank(node.classType)) {
                return ui.notifications.warn("Only Promoted or Advanced classes can buy off-class weapon ranks.");
            }

            const currentRank = normalizeWeaponRank(actor.system.weaponRanks?.[weaponType]);
            const curIdx = rankIdx(currentRank);

            // Post-S mastery bonus: only for characters whose class grants a
            // single weapon proficiency.
            if (isProficient && curIdx >= rankIdx("S")) {
                const profCount = Object.values(node.weaponProficiencies || {}).filter(Boolean).length;
                if (profCount !== 1) return ui.notifications.warn("Already at max rank.");
                return this._promptWeaponMastery(weaponType);
            }

            const maxIdx = this._weaponMaxRankIdx(weaponType);
            if (curIdx >= maxIdx) {
                return ui.notifications.warn(`${FEUE.WeaponTypes[weaponType]} is at its max rank (${rankLabel(RANK_ORDER[maxIdx])}).`);
            }

            const cost = isProficient ? 1 : 2;
            const wexp = Math.max(Number(actor.system.weaponExp || 0), 0);
            if (wexp < cost) return ui.notifications.warn(`Need ${cost} WEXP.`);
            const nextRank = RANK_ORDER[curIdx + 1];
            if (!nextRank) return ui.notifications.error("Could not determine the next weapon rank.");
            await actor.update({
                [`system.weaponRanks.${weaponType}`]: nextRank,
                "system.weaponExp": wexp - cost
            });
            ui.notifications.info(`${FEUE.WeaponTypes[weaponType]} rank advanced to ${nextRank}! (${cost} WEXP spent)`);
            await actor._grantWeaponArts(weaponType, nextRank);
            // Weapon Training: every other class proficiency also advances one step (maximum S).
            if (hasSkill(actor, "weapon training")) {
                const others = Object.entries(node.weaponProficiencies || {}).filter(([type, on]) => on && type !== weaponType && Object.hasOwn(FEUE.WeaponTypes, type));
                const updates = {};
                for (const [type] of others) {
                    const rank = normalizeWeaponRank(actor.system.weaponRanks?.[type]), next = RANK_ORDER[Math.min(rankIdx(rank) + 1, rankIdx("S"))];
                    if (next && next !== rank) updates[`system.weaponRanks.${type}`] = next;
                }
                if (Object.keys(updates).length) {
                    await actor.update(updates);
                    for (const [path, rank] of Object.entries(updates)) await actor._grantWeaponArts(path.split(".").at(-1), rank);
                    ui.notifications.info(`Weapon Training: ${Object.keys(updates).length} other weapon rank(s) advanced.`);
                }
            }
        } finally {
            this._wexpSpendPending = false;
        }
    }

    async _promptWeaponMastery(weaponType) {
        const actor = this.actor;
        if (Number(actor.system.weaponExp || 0) < 1) return ui.notifications.warn("Need 1 WEXP.");
        const opts = Object.entries(FEUE.MASTERY_BONUSES)
            .map(([k, v]) => `<option value="${k}">+${v.step}${v.suffix} ${v.label}</option>`).join("");
        new Dialog({
            title: `${FEUE.WeaponTypes[weaponType]} Mastery — Spend 1 WEXP`,
            content: `<form><p>Choose a permanent bonus when wielding ${FEUE.WeaponTypes[weaponType]} weapons:</p>
                <div class="form-group"><label>Bonus</label><select id="feue-mastery-pick">${opts}</select></div></form>`,
            buttons: {
                spend: {
                    label: "Spend",
                    callback: async (h) => {
                        const stat = h.find("#feue-mastery-pick").val();
                        const spec = FEUE.MASTERY_BONUSES[stat];
                        if (!spec) return;
                        const currentWexp = Math.max(Number(actor.system.weaponExp || 0), 0);
                        const ec = actor.items.find(i => i.type === "class" && i.system?.equipped);
                        const node = ec ? actor._getCurrentClassNode(ec) : null;
                        const profCount = Object.values(node?.weaponProficiencies || {}).filter(Boolean).length;
                        if (normalizeWeaponRank(actor.system.weaponRanks?.[weaponType]) !== "S" || !node?.weaponProficiencies?.[weaponType] || profCount !== 1) {
                            return ui.notifications.warn("This weapon no longer qualifies for mastery.");
                        }
                        if (currentWexp < 1) return ui.notifications.warn("Need 1 WEXP.");
                        const cur = Number(actor.system.weaponMasteryBonuses?.[weaponType]?.[stat] || 0);
                        await actor.update({
                            [`system.weaponMasteryBonuses.${weaponType}.${stat}`]: cur + spec.step,
                            "system.weaponExp": currentWexp - 1
                        });
                        ui.notifications.info(`${actor.name}: +${spec.step}${spec.suffix} ${spec.label} with ${FEUE.WeaponTypes[weaponType]}!`);
                    }
                },
                cancel: { label: "Cancel" }
            },
            default: "spend"
        }).render(true);
    }

    async _onRepairWeapon(event) {
        event.preventDefault();
        const id = $(event.currentTarget).closest(".item").data("item-id");
        const weapon = this.actor.items.get(id);
        if (!weapon || weapon.type !== "weapon") return;
        if (normalizeWeaponProperties(weapon.system.properties).legendary) {
            return ui.notifications.warn("Legendary weapons require a special item or circumstance to repair.");
        }
        const maxUses = Number(weapon.system.uses?.max || 0);
        if (hasInfiniteUses(weapon.system.uses)) return ui.notifications.info("This weapon has infinite uses and does not need repairs.");
        if (!maxUses) return ui.notifications.warn("Weapon has no uses.");
        const curUses = Number(weapon.system.uses?.value || 0);
        if (curUses >= maxUses) return ui.notifications.info("Already at full durability.");
        const price = Number(weapon.system.price || 0);
        const missing = maxUses - curUses;
        const defaultCost = Math.max(0, Math.ceil((price * missing) / maxUses));

        // Find a party this character belongs to, for gold source.
        const party = game.actors.find(a => a.type === "party" && (a.system.memberIds || []).includes(this.actor.id));
        const partyGold = party ? Number(party.system.gold || 0) : null;

        new Dialog({
            title: `Repair ${weapon.name}`,
            content: `<form>
                <p>${curUses} / ${maxUses} uses — needs ${missing} repair(s).</p>
                <div class="form-group"><label>Gold Cost</label><input type="number" id="feue-repair-cost" value="${defaultCost}" readonly/></div>
                ${party ? `<p>${party.name} has ${partyGold} Gold.</p>` : `<p><i>No party — gold not deducted.</i></p>`}
            </form>`,
            buttons: {
                repair: {
                    icon: '<i class="fas fa-hammer"></i>', label: "Repair",
                    callback: async (h) => {
                        const cost = defaultCost;
                        const currentPartyGold = party ? Number(party.system.gold || 0) : null;
                        if (party && cost > currentPartyGold) return ui.notifications.warn("Not enough party gold.");
                        if (party && cost > 0) await party.update({ "system.gold": currentPartyGold - cost });
                        await weapon.update({ "system.uses.value": maxUses });
                        ChatMessage.create({
                            user: game.user.id, speaker: ChatMessage.getSpeaker({ actor: this.actor }),
                            content: `<div class="feue-repair"><h3>${this.actor.name} repaired ${weapon.name}</h3><p>Uses restored to ${maxUses}/${maxUses}${cost ? ` — ${cost} Gold spent` : ""}.</p></div>`
                        });
                    }
                },
                cancel: { label: "Cancel" }
            },
            default: "repair"
        }).render(true);
    }

    _onAddSupport() {
        const cha = this.actor.system.attributes?.charm?.value || 0;
        const limit = Math.min(1 + Math.floor(cha / 4), 8);
        const current = Object.keys(this.actor.system.supportRanks || {}).length;
        if (current >= limit) return ui.notifications.warn(`Support limit reached (${limit}).`);
        return openSupportPicker(this.actor, { affinities: FEUE.AFFINITIES, ranks: FEUE.SUPPORT_RANKS });
    }

    async _onRemoveSupport(key) {
        await this.actor.update({ [`system.supportRanks.-=${key}`]: null });
    }

    _onAddStatusEffect() {
        const opts = FEUE.STATUS_EFFECTS.map(e => `<option value="${e}">${e}</option>`).join("");
        new Dialog({
            title: "Add Condition",
            content: `<form>
                <div class="form-group"><label>Condition</label><select id="se-name">${opts}<option value="Dead">Dead</option><option value="__custom">Custom...</option></select></div>
                <div class="form-group" id="se-custom-group" style="display:none;"><label>Custom Name</label><input type="text" id="se-custom" /></div>
                <div class="form-group" id="se-dur-group"><label>Duration (turns, -1 = indefinite)</label><input type="number" id="se-dur" value="3" min="-1" /></div>
                <p class="hint" id="se-summary"></p>
            </form>`,
            buttons: {
                add: {
                    icon: '<i class="fas fa-plus"></i>', label: "Add",
                    callback: async (h) => {
                        let name = h.find("#se-name").val();
                        if (name === "Dead") return this.actor.toggleStatusEffect(DEAD_STATUS, {active: true, overlay: true});
                        if (name === "__custom") name = h.find("#se-custom").val()?.trim();
                        if (!name) return;
                        if (statusImmune(this.actor, name)) return ui.notifications.warn(`${this.actor.name} is immune to ${name}.`);
                        const dur = Number(h.find("#se-dur").val()) || 3;
                        // Rulebook conditions replace an earlier copy; their token icon follows the Conditions list.
                        if (STATUS_RULES[name.toLowerCase()]) return setCondition(this.actor, name, dur);
                        const statuses = foundry.utils.deepClone(this.actor.system.statusEffects || []);
                        statuses.push({ name, duration: dur });
                        await this.actor.update({ "system.statusEffects": statuses });
                    }
                },
                cancel: { label: "Cancel" }
            },
            default: "add",
            render: (h) => {
                const defaults = () => {
                    const name = String(h.find("#se-name").val()), rule = STATUS_RULES[name.toLowerCase()];
                    if (rule) h.find("#se-dur").val(rule.duration);
                    h.find("#se-dur-group").toggle(name !== "Dead");
                    h.find("#se-summary").text(name === "Dead" ? "Slain: defeated in the encounter. Lasts until removed." : rule?.summary ?? "");
                };
                h.find("#se-name").change(ev => {
                    h.find("#se-custom-group").toggle(ev.currentTarget.value === "__custom");
                    defaults();
                });
                defaults();
            }
        }).render(true);
    }

    async _onRemoveStatusEffect(idx) {
        const statuses = foundry.utils.deepClone(this.actor.system.statusEffects || []);
        if (idx >= 0 && idx < statuses.length) {
            statuses.splice(idx, 1);
            await this.actor.update({ "system.statusEffects": statuses });
        }
    }

    async _onUseItem(event) {
        event.preventDefault();
        const itemId = $(event.currentTarget).closest(".item").data("item-id");
        const item = this.actor.items.get(itemId);
        return this._useItem(item);
    }

    async _useItem(item, {consume = true, ...options} = {}) {
        if (!options.actionLocked) return withUnitActionLock(() => this._useItem(item, {...options, consume, actionLocked: true}));
        if (!item || item.type !== "item") return;
        if (item.system.itemType === "miscellaneous") return item.sheet?.render(true);

        const uses = consume && !hasInfiniteUses(item.system.uses) ? item.system.uses : null;
        if (uses && uses.value <= 0) {
            return ui.notifications.warn(`${item.name} has no uses remaining.`);
        }
        const classChange = activeClassChange(item);
        if (classChange) return this._useClassChangeItem(item, classChange, options);
        const relay = relaySheetAction(this.actor, "item", item, options);
        if (relay) return relay;
        assertUnitAction(this.actor, options);

        const a = this.actor;
        const effect = (item.system.effect || "").toLowerCase();
        const name = item.name.toLowerCase();
        const results = [];

        // Full HP restore
        if (/restore\s+all\s+hp|full\s+hp|restore.*max.*hp/.test(effect) || name === "elixir") {
            const maxHp = a.system.attributes.hp.max;
            const curHp = a.system.attributes.hp.value;
            const healed = maxHp - curHp;
            await a.update({ "system.attributes.hp.value": maxHp });
            results.push(`Restored all HP (+${healed})`);
        } else {
            // Partial HP restore
            const hpMatch = effect.match(/(?:restore|heal|\+)\s*(\d+)\s*hp/);
            if (hpMatch || name === "vulnerary") {
                const amount = hpMatch ? Number(hpMatch[1]) : 10;
                const maxHp = a.system.attributes.hp.max;
                const curHp = a.system.attributes.hp.value;
                const newHp = Math.min(curHp + amount, maxHp);
                const healed = newHp - curHp;
                await a.update({ "system.attributes.hp.value": newHp });
                results.push(`Restored ${healed} HP (${curHp} → ${newHp})`);
            }
        }

        // Stat boosters raise a stat permanently (up to its cap); a capped stat leaves the item unused.
        const stats = parseItemStatEffects(item.system.effect);
        if (stats.permanent.length) {
            let gainedAny = false;
            for (const {stat, amount} of stats.permanent) {
                const gained = await a._applyStatBooster(stat, amount);
                gainedAny ||= gained > 0;
                results.push(gained ? `${STAT_SHORT[stat]} permanently +${gained}${gained < amount ? " (reached its maximum)" : ""}` : `${STAT_SHORT[stat]} is already at its maximum`);
            }
            if (!gainedAny) return ui.notifications.warn(`${a.name} cannot use ${item.name}: ${results.join("; ")}.`);
        }
        // Temporary boosts, e.g. Pure Water: +7 RES that decreases by 1 each turn.
        for (const {stat, amount, decay, duration} of stats.temporary) {
            const applied = await addTimedEffect(a, {name: item.name, automationKey: `item-${item.name.toLowerCase()}`, duration, ...(decay ? {recover: decay} : {}), attributes: {[stat]: amount}});
            results.push(applied ? `${STAT_SHORT[stat]} +${amount}${decay ? `, decreasing by ${decay} each turn` : ` for ${duration} turn${duration === 1 ? "" : "s"}`}` : `${a.name} cannot benefit from ${item.name}`);
        }

        // Cure poison
        if (/cure.*poison|remove.*poison/.test(effect) || name === "antitoxin") {
            const statuses = foundry.utils.deepClone(a.system.statusEffects || []);
            const idx = statuses.findIndex(s => (s.name || s).toLowerCase() === "poison");
            if (idx >= 0) {
                statuses.splice(idx, 1);
                await a.update({ "system.statusEffects": statuses });
                results.push("Cured Poison");
            } else {
                results.push("No Poison to cure");
            }
        }

        // Generic effect — display text if no known pattern matched
        if (!results.length && item.system.effect) {
            results.push(item.system.effect);
        }

        // Decrement uses
        if (uses) {
            const newUses = Math.max(uses.value - 1, 0);
            await item.update({ "system.uses.value": newUses });
            if (newUses <= 0) results.push("Item depleted!");
        }

        await completeMajorAction(a, options);
        await ChatMessage.create({
            user: options.userId ?? game.user.id,
            speaker: ChatMessage.getSpeaker({ actor: a }),
            content: `<div class="feue-item-use"><h3>${a.name} uses ${item.name}</h3><p>${results.join("</p><p>")}</p></div>`
        });
    }

    /** Promote (crest / Master Seal) or reclass (Second Seal). The class is chosen on the user's client before relaying. */
    async _useClassChangeItem(item, mode, options = {}) {
        const actor = this.actor, reason = actor.classChangeReason(item, mode);
        if (reason) return ui.notifications.warn(reason);
        let targetId = options.choice?.classChange;
        if (!targetId) {
            targetId = await this._chooseClassChange(item, mode);
            if (!targetId) return;
            options = { ...options, choice: { ...(options.choice ?? {}), classChange: targetId } };
        }
        const relay = relaySheetAction(actor, "item", item, options);
        if (relay) return relay;
        assertUnitAction(actor, options);
        if (mode === "reclass") {
            if (!await actor.reclassTo(targetId, { item })) return;
        } else await actor.promoteTo(actor.items.find(i => i.type === "class" && i.system.equipped), targetId, { item });
        await completeMajorAction(actor, options);
    }

    _chooseClassChange(item, mode) {
        const choices = this.actor.classChangeChoices(mode), reclass = mode === "reclass";
        return new Promise(resolve => new Dialog({
            title: `${item.name}: ${reclass ? "Reclass" : "Promote"}`,
            content: `<p>${reclass ? `Choose the class ${esc(this.actor.name)} changes to. Stats and weapon ranks are preserved.` : `Choose ${esc(this.actor.name)}'s promotion. The level resets to 1.`} This uses ${esc(item.name)}.</p>
                <div class="form-group"><select class="feue-class-change-choice" style="width:100%;">${choices.map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join("")}</select></div>`,
            buttons: {
                use: { icon: '<i class="fas fa-arrow-up"></i>', label: reclass ? "Reclass" : "Promote", callback: html => resolve(html.find(".feue-class-change-choice").val() || null) },
                cancel: { label: "Cancel", callback: () => resolve(null) }
            },
            default: "use",
            close: () => resolve(null)
        }).render(true));
    }

    async _onAwardXp() {
        new Dialog({
            title: `Award XP to ${this.actor.name}`,
            content: `<form><div class="form-group"><label>XP Amount</label><input type="number" id="xp-amount" value="10" min="1"/></div></form>`,
            buttons: {
                award: {
                    icon: '<i class="fas fa-star"></i>', label: "Award",
                    callback: async (h) => {
                        const amount = Number(h.find("#xp-amount").val()) || 0;
                        if (amount <= 0) return;
                        await FEUEParty.awardXp([this.actor.id], amount);
                        ChatMessage.create({
                            user: game.user.id, speaker: ChatMessage.getSpeaker({ actor: this.actor }),
                            content: `<div class="feue-party-xp"><h3>${this.actor.name}: +${amount} XP</h3></div>`
                        });
                    }
                },
                cancel: { label: "Cancel" }
            },
            default: "award"
        }).render(true);
    }

    async _onItemCreate(event) {
        event.preventDefault();
        const type = event.currentTarget.dataset.type;
        if (!type) return ui.notifications.error("Missing item type.");
        if ((type === "item" || type === "weapon") && this._getInventoryUsage().full) return ui.notifications.error("Inventory full (5 max).");
        if (type === "battalion" && this.actor.items.filter(i => i.type === "battalion").length >= battalionLimit(this.actor)) return ui.notifications.error(battalionLimit(this.actor) > 1 ? "Battalion limit reached (Nobility: 2)." : "Only one battalion allowed.");

        const createBlank = async () => {
            const [created] = await this.actor.createEmbeddedDocuments("Item", [{ name: `New ${game.i18n.localize(CONFIG.Item.typeLabels?.[type] ?? type)}`, type }]);
            created?.sheet.render(true);
            return created;
        };
        if (type === "class") return openClassPicker(this.actor, {onBlank: createBlank});
        if (hasItemPicker(type)) return openItemPicker(this.actor, type, {onBlank: createBlank});
        return createBlank();
    }
}

// ====================================================================
// 4. ITEM CLASS & SHEET
// ====================================================================
const DEFAULT_WEAPON_PROPERTIES = () => ({
    illegal: false, legendary: false,
    slayer: { enabled: false, all: false, types: {} },
    cursed: false, shade: false, deadly: false, magical: false,
    unwieldy: false, slow: false, mechanical: false, abuse: false,
    absorb: false, puncture: false, piercing: false, brave: false,
    poison: false, reverse: false, superior: false, smash: false, crippling: false, vehicle: false, petrify: false
});

function normalizeWeaponProperties(p) {
    const def = DEFAULT_WEAPON_PROPERTIES();
    if (typeof p === "string" || Array.isArray(p)) {
        const text = Array.isArray(p) ? p.join(", ") : p;
        for (const key of Object.keys(def).filter(k => k !== "slayer")) def[key] = new RegExp(`\\b${key}\\b`, "i").test(text);
        const slayer = text.match(/slayer\s*\(([^)]+)\)/i);
        if (slayer) {def.slayer.enabled = true; for (const type of slayer[1].split(/[,/]/)) {const name = FEUE.UNIT_TYPES.find(t => t.toLowerCase() === type.trim().toLowerCase().replace(/s$/, "")); if (name) def.slayer.types[name] = true; else if (type.trim().toLowerCase() === "all") def.slayer.all = true;}}
        return def;
    }
    if (!p || typeof p !== "object") return def;
    const out = foundry.utils.mergeObject(def, p, { inplace: false });
    if (!out.slayer || typeof out.slayer !== "object") out.slayer = def.slayer;
    if (!out.slayer.types || typeof out.slayer.types !== "object") out.slayer.types = {};
    return out;
}

class FiresOfWarItem extends Item {
    /** New items start with the system's icon for their type instead of the core item bag. */
    static getDefaultArtwork(itemData) {
        const types = ["weapon", "item", "skill", "spell", "class", "battalion", "combatArt", "miscBonus"];
        return types.includes(itemData?.type) ? {img: `systems/fires-of-war/icons/items/defaults/${itemData.type}.svg`} : super.getDefaultArtwork(itemData);
    }

    prepareDerivedData() {
        if (this.type === "weapon") {
            this.system.properties = normalizeWeaponProperties(this.system.properties);
            // Remove Durability: weapons behave as infinite (staves excepted); stored Uses are kept for other rule sets.
            if (durabilityExempt(this)) this.system.uses = {...(this.system.uses ?? {}), infinite: true};
        }
    }
}

class FiresOfWarItemSheet extends ItemSheet {
    static _promotionClipboard = null;
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            classes: ["feue", "sheet", "item"], template: "systems/fires-of-war/templates/item/item-sheet.html",
            width: 600, height: 700, scrollY: [".sheet-body"],
            tabs: [{ navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "description" }]
        });
    }

    async getData() {
        const data = this._getSheetData();
        if (this.item.type === "spell") data.admixWeapons = await admixWeaponOptions();
        return data;
    }

    _getSheetData() {
        const data = super.getData();
        data.FEUE = FEUE;
        if (this.item.type === "skill") {
            const info = skillAutomationInfo(this.item, activeSkillRule(this.item));
            data.automationStatus = info.status;
            data.automationSummary = {auto: "Automated: ", partial: "Partly automated: ", manual: "GM-adjudicated: ", none: "", off: ""}[info.status] + info.summary;
            data.automationConfig = skillAutomationConfig(this.item);
        }
        const t = this.item.type, s = this.item.system || {};
        data.classChangeEnabled = t === "item" && classChangeItemsEnabled();
        if (data.classChangeEnabled) {
            const config = classChangeConfig(this.item), reclassing = !!game.settings.get("fires-of-war", "useReclassing");
            data.classChange = {...config, listId: `feue-class-names-${this.appId}`, isPromote: config.mode === "promote",
                modes: [["", "None"], ["promote", "Promotes the listed classes"], ["master", "Promotes any class (Master Seal)"],
                    ...(reclassing || config.mode === "reclass" ? [["reclass", `Changes to an alternate class (Second Seal)${reclassing ? "" : " — Reclassing is off"}`]] : [])]
                    .map(([value, label]) => ({value, label, selected: value === config.mode})),
                hint: {promote: "From Level 10, a unit whose current class is listed can use this item to promote. Drop class items here or type their names.",
                    master: "From Level 10, any unit with a promotion available can use this item to promote.",
                    reclass: "From Level 10, using this item switches to one of the unit's alternate classes. Reclassing needs one while class change items are in use."}[config.mode]
                    ?? "Choose how this item changes class. Use it from the inventory (Consumable type)."};
            data.classChangeSuggestions = config.mode === "promote" ? knownClassNames() : [];
        }
        data.itemTypeLabel = {
            weapon: "Weapon", item: "Item", skill: "Skill", spell: "Spell",
            class: "Class", battalion: "Battalion", combatArt: "Combat Art", miscBonus: "Misc Bonus"
        }[t] || t;
        if (t === "class") {
            data.classTypeChoices = [...new Set(["Recruit", "Standard", "Advanced", "Enemy Only", "Monster", s.classType].filter(Boolean))];
            data.classIsPromoted = ["Promoted", "Advanced"].includes(s.classType);
            data.classChipsHtml = classChipsHtml(s);
            data.classStatsHtml = classStatTableHtml(s);
        }
        data.replaceableMounts = replaceableMounts();
        data.mountTypes = ["Horse", "Pegasus", "Wyvern", "Dark Pegasus", "Puppet", "Other"];
        data.mountActors = Array.from(game.actors ?? []).filter(actor => actor.type === "character").map(actor => ({id: actor.id, name: actor.name}));
        data.mountIsLost = mountLost(this.item);
        data.revivalStonesEnabled = revivalEnabled() && t === "skill" && (this.item.parent?.type !== "character" || revivalAllowed(this.item.parent));
        data.revivalGateStones = Number(s.revivalGate?.stones ?? 0);
        data.showQuantity = t !== "weapon";
        data.showWeight = (t === "weapon" && s.weaponType !== "staff") || (t === "item" && s.itemType === "equippable");
        data.hidePrice = t === "weapon" && (s.properties?.illegal || s.properties?.legendary);
        if (t === "battalion") {
            // Area editor: presets from the rulebook, or a custom grid with a movable commander square.
            const shape = normalizeShape(s.range), editor = editorArea(this.item);
            data.areaMode = this._areaMode ?? "area";
            data.areaShape = shape;
            data.areaPresets = Object.entries(AREA_PRESETS).map(([key, preset]) => ({key, label: preset.label, selected: key === shape}));
            data.areaLegacy = shape && shape !== "custom" && !AREA_PRESETS[shape] ? shape : "";
            data.areaReach = Number(s.area?.reach) || 0;
            data.areaRows = Array.from({length: EDITOR_SIZE}, (_, y) => Array.from({length: EDITOR_SIZE}, (_, x) => {
                const key = `${x},${y}`;
                return {key, on: editor.cells.has(key), origin: key === editor.origin};
            }));
            data.areaSummary = battalionArea(this.item)?.label ?? "No area: the Battalion affects only its commander.";
        }
        if (t === "class") {
            data.classRoleplayTraits = getClassRoleplayTraits(this.item.name, s.roleplayTraits);
            while (data.classRoleplayTraits.length < 3) data.classRoleplayTraits.push({ base: "", alternative: "" });
        }

        // One-time migration: if legacy weapon has a string/array properties field, move text to propertiesNotes
        if (t === "weapon") {
            const raw = this.item._source?.system?.properties;
            if (raw != null && (typeof raw === "string" || Array.isArray(raw))) {
                const legacyText = typeof raw === "string" ? raw : raw.filter(v => typeof v === "string").join(", ");
                const update = { "system.properties": normalizeWeaponProperties(raw) };
                if (legacyText && !this.item._source?.system?.propertiesNotes) {
                    update["system.propertiesNotes"] = legacyText;
                    data.item.system.propertiesNotes = legacyText;
                }
                this.item.update(update);
            }
        }
        return data;
    }

    activateListeners(html) {
        super.activateListeners(html);
        // The promotion tree is drawn for read-only (e.g. compendium) class sheets too.
        if (this.item.type === "class" && !this.options.editable) {
            this._renderPromotionTree(html);
            html.find(".promo-tree-row a").remove();
        }
        if (!this.options.editable) return;
        html.find("input, select, textarea").change(ev => this._saveField(ev));
        const changeConfig = html.find(".feue-class-change-config")[0];
        if (changeConfig) {
            const classes = () => [...classChangeConfig(this.item).classes];
            const addClass = name => {
                name = String(name ?? "").trim();
                const list = classes();
                if (!name || list.some(n => n.toLowerCase() === name.toLowerCase())) return;
                return this.item.update({ "system.classChange.classes": [...list, name] });
            };
            changeConfig.querySelector(".feue-class-change-add")?.addEventListener("click", () => addClass(changeConfig.querySelector(".feue-class-change-name")?.value));
            changeConfig.querySelector(".feue-class-change-name")?.addEventListener("keydown", ev => {
                if (ev.key !== "Enter") return;
                ev.preventDefault();
                addClass(ev.currentTarget.value);
            });
            changeConfig.querySelectorAll("[data-class-change-remove]").forEach(link => link.addEventListener("click", () => {
                const list = classes();
                list.splice(Number(link.dataset.classChangeRemove), 1);
                this.item.update({ "system.classChange.classes": list });
            }));
            changeConfig.addEventListener("dragover", ev => ev.preventDefault());
            changeConfig.addEventListener("drop", async ev => {
                ev.preventDefault(); ev.stopPropagation();
                try {
                    const data = JSON.parse(ev.dataTransfer.getData("text/plain"));
                    const dropped = data?.type === "Item" ? await Item.implementation.fromDropData(data) : null;
                    if (dropped?.type !== "class") throw Error("Drop a class item to list it.");
                    await addClass(dropped.name);
                } catch (error) { ui.notifications.warn(error.message); }
            });
        }
        html.find(".bonus-toggle").click(ev => {
            ev.preventDefault();
            const section = $(ev.currentTarget).closest(".feue-bonus-section");
            section.toggleClass("collapsed");
            const label = section.hasClass("collapsed") ? "Show All" : "Hide";
            const icon = section.hasClass("collapsed") ? "fa-chevron-down" : "fa-chevron-up";
            $(ev.currentTarget).html(`<i class="fas ${icon}"></i> ${label}`);
        });

        if (this.item.type === "battalion") {
            html.find("[data-area-mode]").click(ev => {
                ev.preventDefault();
                this._areaMode = ev.currentTarget.dataset.areaMode;
                html.find("[data-area-mode]").removeClass("active");
                $(ev.currentTarget).addClass("active");
                html.find(".feue-area-editor").attr("data-mode", this._areaMode);
            });
            html.find(".feue-area-cell").click(async ev => {
                ev.preventDefault();
                const key = ev.currentTarget.dataset.cell, current = editorArea(this.item);
                const cells = new Set(current.cells);
                let origin = current.origin;
                if ((this._areaMode ?? "area") === "origin") { origin = key; cells.delete(key); }
                else if (key !== origin) { if (cells.has(key)) cells.delete(key); else cells.add(key); }
                await this.item.update({"system.range": "custom", "system.area.cells": [...cells], "system.area.origin": origin});
            });
            html.find(".feue-area-clear").click(ev => {
                ev.preventDefault();
                return this.item.update({"system.range": "custom", "system.area.cells": [], "system.area.origin": DEFAULT_ORIGIN.join(",")});
            });
        }

        if (this.item.type === "class") {
            this._renderPromotionTree(html);
            html.find(".class-roleplay-trait").change(async () => {
                const traits = [];
                html.find(".class-roleplay-trait-row").each((_, row) => {
                    const base = $(row).find("[data-roleplay-field='base']").val()?.trim() || "";
                    const alternative = $(row).find("[data-roleplay-field='alternative']").val()?.trim() || "";
                    traits.push({ base, alternative });
                });
                await this.item.update({ "system.roleplayTraits": traits });
            });
            html.find(".promo-add-root").click(() => this._addPromotion([]));
            html.on("click", ".promo-add-sub", (ev) => this._addPromotion($(ev.currentTarget).data("path").toString().split(",")));
            html.on("click", ".promo-edit", (ev) => this._editPromotion($(ev.currentTarget).data("path").toString().split(",")));
            html.on("click", ".promo-delete", async (ev) => {
                const ok = await Dialog.confirm({ title: "Delete Promotion", content: "<p>Delete this promotion and all sub-promotions?</p>" });
                if (ok) this._deletePromotion($(ev.currentTarget).data("path").toString().split(","));
            });
            html.on("click", ".promo-copy", (ev) => {
                const path = $(ev.currentTarget).data("path").toString().split(",");
                this._copyPromotion(path);
            });
            html.find(".promo-paste-root").click(() => this._pastePromotion([]));
            html.on("click", ".promo-paste-sub", (ev) => {
                const parentPath = $(ev.currentTarget).data("path").toString().split(",");
                this._pastePromotion(parentPath);
            });

            // ── Promotion Tree: drag-and-drop class items ──
            const promoContainer = html.find("#promotion-tree-container")[0];
            if (promoContainer) {
                promoContainer.addEventListener("dragover", (e) => e.preventDefault());
                promoContainer.addEventListener("drop", (e) => this._onDropClassPromotion(e, []));
            }
            html.on("dragover", ".promo-add-sub, .promo-paste-sub", (e) => e.preventDefault());
            html.on("drop", ".promo-add-sub, .promo-paste-sub", (e) => {
                const parentPath = $(e.currentTarget).data("path").toString().split(",");
                this._onDropClassPromotion(e.originalEvent, parentPath);
            });

            // ── Class Skills: drag-and-drop, level change, removal ──
            const skillList = html.find(".class-skills-list");
            if (skillList.length) {
                skillList[0].addEventListener("dragover", (e) => e.preventDefault());
                skillList[0].addEventListener("drop", this._onDropClassSkill.bind(this));
            }

            html.find(".class-skill-level").change(async (ev) => {
                const idx = Number($(ev.currentTarget).data("skill-index"));
                const classSkills = foundry.utils.deepClone(this.item.system.classSkills || []);
                if (classSkills[idx]) {
                    classSkills[idx].level = ev.currentTarget.value;
                    await this.item.update({ "system.classSkills": classSkills });
                }
            });

            html.find(".class-skill-remove").click(async (ev) => {
                const idx = Number($(ev.currentTarget).data("skill-index"));
                const classSkills = foundry.utils.deepClone(this.item.system.classSkills || []);
                classSkills.splice(idx, 1);
                await this.item.update({ "system.classSkills": classSkills });
            });
        }
    }

    async _saveField(ev) {
        const el = ev.currentTarget;
        if (!el.name) return;
        let value = el.value;
        if (el.dataset.dtype === "Number") { const n = Number(value); value = Number.isFinite(n) ? n : null; }
        else if (el.type === "checkbox") value = el.checked;

        const update = { [el.name]: value };
        if (this.item.type === "item" && el.name === "system.itemType" && value !== "equippable") update["system.equipped"] = false;
        // The Class Change setting replaces the earlier "Promotion Item" checkbox.
        if (el.name === "system.classChange.mode" && this.item.getFlag("fires-of-war", "isPromotionItem")) update["flags.fires-of-war.-=isPromotionItem"] = null;
        // Switching a preset to Custom starts the editor from that preset's squares.
        if (this.item.type === "battalion" && el.name === "system.range" && value === "custom" && !this.item.system.area?.cells?.length) {
            const current = editorArea(this.item);
            update["system.area.cells"] = [...current.cells];
            update["system.area.origin"] = current.origin;
        }
        const customizeSkill = el.name === "system.automation.mode" ? value === "custom" : el.name.startsWith("system.automation.") && (this.item.system.automation?.mode ?? "auto") === "auto";
        if (this.item.type === "skill" && customizeSkill && this.item.system.automation?.mode !== "custom") {
            const rule = skillRule(this.item), config = skillAutomationConfig(this.item);
            for (const [key, value] of Object.entries(config)) if (!["mode", "weaponsText"].includes(key)) update[`system.automation.${key}`] = value;
            update["system.automation.mode"] = "custom";
            if (rule?.roll) {
                update["system.skillType"] = "Passive (Activated)";
                update["system.activationTrigger"] = rule.trigger;
                if (!this.item.system.activationTrigger || ["Manual", "Passive"].includes(this.item.system.activationTrigger)) {
                    update["system.activationTargetType"] = "stat_mult";
                    update["system.activationStat"] = rule.stat ?? "skill";
                    update["system.activationMult"] = rule.mult ?? 1;
                }
            } else if (rule) {
                update["system.skillType"] = "Passive";
                update["system.activationTrigger"] = "Passive";
            }
            update[el.name] = value;
        }

        // Migrate legacy array/string shape of weapon properties before nested writes.
        // Preserve any prior free-form text into system.propertiesNotes.
        if (this.item.type === "weapon" && el.name.startsWith("system.properties.")) {
            const raw = this.item._source?.system?.properties;
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
                const migration = { "system.properties": normalizeWeaponProperties(raw) };
                const legacyText = typeof raw === "string" ? raw : (Array.isArray(raw) ? raw.filter(v => typeof v === "string").join(", ") : "");
                if (legacyText && !this.item._source?.system?.propertiesNotes) {
                    migration["system.propertiesNotes"] = legacyText;
                }
                await this.item.update(migration);
            }
        }

        // Roll randomized price (5d10 × 1000) the first time Illegal or Legendary is turned on
        if (this.item.type === "weapon" && value === true &&
            (el.name === "system.properties.illegal" || el.name === "system.properties.legendary")) {
            const p = this.item.system.properties || {};
            if (!p.illegal && !p.legendary) {
                const r = await new Roll("5d10 * 1000").evaluate();
                update["system.price"] = r.total;
            }
        }
        await this.item.update(update);
    }

    async _updateObject(event, formData) { return await this.object.update(foundry.utils.expandObject(formData)); }

    // ── PROMOTION TREE ──

    _renderPromotionTree(html) {
        const c = html.find("#promotion-tree-container");
        if (!c.length) return;
        const promos = this.item.system.promotions || [];
        const currentPath = this.item.system.currentPath || [];
        c.html(promos.length ? this._buildTreeHTML(promos, [], currentPath) : '<p class="feue-class-hint">No promotions yet. Drag class items here or click Add promotion.</p>');
    }

    _buildTreeHTML(promos, parentPath, currentPath) {
        let html = '<ul class="promo-tree-list">';
        for (const p of promos) {
            const nodePath = [...parentPath, p.id];
            const path = nodePath.join(",");
            const isProm = ["Promoted", "Advanced"].includes(p.classType);
            const checked = nodePath.length === currentPath.length && nodePath.every((id, idx) => id === currentPath[idx]);
            html += `<li class="promo-tree-node${checked ? " is-selected" : ""}">
                <div class="promo-tree-row">
                    <span class="promo-tree-label">
                        <b>${_escapeTokenActionHtml(p.name)}</b>
                        <span class="promo-tree-type">${_escapeTokenActionHtml(p.classType)}</span>
                        ${checked ? '<span class="promo-tree-check"><i class="fas fa-check-circle"></i> Active</span>' : ""}
                        <small class="promo-tree-summary">Move ${Number(p.movement) || 0}${Object.entries(FEUE.WeaponTypes).filter(([key]) => p.weaponProficiencies?.[key]).map(([, label]) => label).join(", ").replace(/^(?=.)/, " · ")}${p.classSkills?.length ? ` · ${p.classSkills.length} skill${p.classSkills.length === 1 ? "" : "s"}` : ""}</small>
                    </span>
                    <a class="promo-edit" data-path="${path}" title="Edit"><i class="fas fa-edit"></i></a>
                    <a class="promo-copy" data-path="${path}" title="Copy Promotion"><i class="fas fa-copy"></i></a>
                    <a class="promo-delete" data-path="${path}" title="Delete"><i class="fas fa-trash"></i></a>
                    ${isProm ? "" : `<a class="promo-add-sub" data-path="${path}" title="Add Sub-Promotion"><i class="fas fa-plus"></i></a>
                    <a class="promo-paste-sub" data-path="${path}" title="Paste Sub-Promotion"><i class="fas fa-paste"></i></a>`}
                </div>
                ${p.promotions?.length ? this._buildTreeHTML(p.promotions, nodePath, currentPath) : ""}
            </li>`;
        }
        html += "</ul>";
        return html;
    }

    async _addPromotion(parentPath) {
        const newP = {
            id: foundry.utils.randomID(), name: "New Class", classType: parentPath.length ? "Promoted" : "Standard",
            movement: 5, maxLevel: 20, unitTypes: {}, weaponProficiencies: {}, baseStats: {}, growthRates: {}, statCaps: {}, classSkills: [], roleplayTraits: [], promotions: []
        };
        this._openPromotionDialog(newP, async (data) => {
            const promos = foundry.utils.deepClone(this.item.system.promotions || []);
            if (!parentPath.length) { promos.push(data); }
            else {
                let nodes = promos, parent = null;
                for (const id of parentPath) { parent = nodes.find(n => n.id === id); if (!parent) return; parent.promotions ??= []; nodes = parent.promotions; }
                if (parent) parent.promotions.push(data);
            }
            await this.item.update({ "system.promotions": promos });
        });
    }

    async _editPromotion(path) {
        const promos = foundry.utils.deepClone(this.item.system.promotions || []);
        let nodes = promos, node = null, parentNodes = null, nodeIdx = -1;
        for (let i = 0; i < path.length; i++) {
            const idx = nodes.findIndex(n => n.id === path[i]);
            if (idx === -1) return;
            if (i === path.length - 1) { parentNodes = nodes; nodeIdx = idx; node = nodes[idx]; }
            else { nodes[idx].promotions ??= []; nodes = nodes[idx].promotions; }
        }
        if (!node) return;
        this._openPromotionDialog(node, async (data) => {
            data.promotions = node.promotions; data.id = node.id;
            parentNodes[nodeIdx] = data;
            await this.item.update({ "system.promotions": promos });
        });
    }

    async _deletePromotion(path) {
        const promos = foundry.utils.deepClone(this.item.system.promotions || []);
        let nodes = promos;
        for (let i = 0; i < path.length - 1; i++) { const n = nodes.find(x => x.id === path[i]); if (!n) return; n.promotions ??= []; nodes = n.promotions; }
        const idx = nodes.findIndex(n => n.id === path[path.length - 1]);
        if (idx !== -1) nodes.splice(idx, 1);
        await this.item.update({ "system.promotions": promos });
    }

    _copyPromotion(path) {
        const promos = this.item.system.promotions || [];
        let nodes = promos, node = null;
        for (const id of path) {
            node = nodes.find(n => n.id === id);
            if (!node) return;
            nodes = node.promotions || [];
        }
        if (!node) return;
        FiresOfWarItemSheet._promotionClipboard = foundry.utils.deepClone(node);
        ui.notifications.info(`Copied promotion "${node.name}" to clipboard.`);
    }

    async _pastePromotion(parentPath) {
        const clip = FiresOfWarItemSheet._promotionClipboard;
        if (!clip) {
            ui.notifications.warn("No promotion copied. Use the copy button on a promotion first.");
            return;
        }
        const reassignIds = (node) => {
            node.id = foundry.utils.randomID();
            for (const child of (node.promotions || [])) reassignIds(child);
        };
        const newP = foundry.utils.deepClone(clip);
        reassignIds(newP);
        const promos = foundry.utils.deepClone(this.item.system.promotions || []);
        if (!parentPath.length) {
            promos.push(newP);
        } else {
            let nodes = promos, parent = null;
            for (const id of parentPath) { parent = nodes.find(n => n.id === id); if (!parent) return; parent.promotions ??= []; nodes = parent.promotions; }
            if (parent) parent.promotions.push(newP);
        }
        await this.item.update({ "system.promotions": promos });
        ui.notifications.info(`Pasted promotion "${newP.name}".`);
    }

    async _onDropClassPromotion(event, parentPath) {
        event.preventDefault();
        event.stopPropagation();
        let data;
        try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
        if (data.type !== "Item") return;
        const item = await Item.implementation.fromDropData(data);
        if (!item || item.type !== "class") {
            ui.notifications.warn("Only class items can be dropped onto the promotion tree.");
            return;
        }
        const newP = {
            id: foundry.utils.randomID(),
            name: item.name,
            classType: item.system.classType || "Promoted",
            maxLevel: item.system.maxLevel || 20,
            movement: item.system.movement || 5,
            unitTypes: foundry.utils.deepClone(item.system.unitTypes || {}),
            weaponProficiencies: foundry.utils.deepClone(item.system.weaponProficiencies || {}),
            baseStats: foundry.utils.deepClone(item.system.baseStats || {}),
            growthRates: foundry.utils.deepClone(item.system.growthRates || {}),
            statCaps: foundry.utils.deepClone(item.system.statCaps || {}),
            classSkills: foundry.utils.deepClone(item.system.classSkills || []),
            roleplayTraits: foundry.utils.deepClone(getClassRoleplayTraits(item.name, item.system.roleplayTraits)),
            promotions: []
        };
        const promos = foundry.utils.deepClone(this.item.system.promotions || []);
        if (!parentPath.length) {
            promos.push(newP);
        } else {
            let nodes = promos, parent = null;
            for (const id of parentPath) { parent = nodes.find(n => n.id === id); if (!parent) return; parent.promotions ??= []; nodes = parent.promotions; }
            if (parent) parent.promotions.push(newP);
        }
        await this.item.update({ "system.promotions": promos });
        ui.notifications.info(`Added "${item.name}" as a promotion.`);
    }

    _openPromotionDialog(promo, onSave) {
        let promoSkills = foundry.utils.deepClone(promo.classSkills || []);
        const promoTraits = getClassRoleplayTraits(promo.name, promo.roleplayTraits);
        while (promoTraits.length < 3) promoTraits.push({ base: "", alternative: "" });
        const promoTraitRows = promoTraits.map((trait, index) => `<div class="class-roleplay-trait-row">
            <input type="text" data-roleplay-index="${index}" data-roleplay-field="base" value="${_escapeTokenActionHtml(trait.base)}" placeholder="Base trait ${index + 1}" />
            <input type="text" data-roleplay-index="${index}" data-roleplay-field="alternative" value="${_escapeTokenActionHtml(trait.alternative)}" placeholder="Optional replacement" />
        </div>`).join("");

        const buildSkillListHTML = (skills) => {
            if (!skills.length) return '<p class="class-skills-empty">No skills yet. Drag skill items here.</p>';
            return skills.map((cs, idx) => `
                <div class="class-skill-entry promo-skill-entry">
                    <img src="${_escapeTokenActionHtml(cs.skillData.img || "icons/svg/book.svg")}" width="24" height="24" alt="" />
                    <span class="class-skill-name">${_escapeTokenActionHtml(cs.skillData.name)}</span>
                    <label class="class-skill-level-label">Level <select class="promo-skill-level" data-skill-idx="${idx}">
                        <option value="Innate" ${cs.level === "Innate" ? "selected" : ""}>Innate</option>
                        <option value="1" ${cs.level === "1" ? "selected" : ""}>1</option>
                        <option value="5" ${cs.level === "5" ? "selected" : ""}>5</option>
                        <option value="10" ${cs.level === "10" ? "selected" : ""}>10</option>
                        <option value="15" ${cs.level === "15" ? "selected" : ""}>15</option>
                        <option value="20" ${cs.level === "20" ? "selected" : ""}>20</option>
                        <option value="30" ${cs.level === "30" ? "selected" : ""}>30</option>
                    </select></label>
                    <a class="promo-skill-remove" data-skill-idx="${idx}" title="Remove"><i class="fas fa-trash"></i></a>
                </div>
            `).join("");
        };

        const types = FEUE.CLASS_TYPES.filter(t => ["Standard", "Promoted"].includes(t) || t === promo.classType);
        new Dialog({
            title: `Edit Promotion: ${promo.name}`,
            content: `<form class="feue-class-sheet feue-promo-form">
                <section class="feue-class-block feue-class-overview feue-promo-overview">
                    <label class="feue-promo-name"><span>Name</span><input type="text" id="pn" value="${_escapeTokenActionHtml(promo.name)}"/></label>
                    <label><span>Class type</span><select id="pct">${types.map(t => `<option value="${t}" ${promo.classType === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
                    <label><span>Max level</span><input type="number" id="pml" value="${promo.maxLevel || 20}" min="1" max="40"/></label>
                    <label><span>Movement</span><input type="number" id="pmv" value="${promo.movement || 5}" min="0"/></label>
                </section>
                ${classChipsHtml(promo, {named: false})}
                <section class="feue-class-block"><h4>Stats</h4>${classStatTableHtml(promo, {named: false})}
                    <p class="feue-class-hint">For a Promoted class the first row is the bonus added once on promotion.</p></section>
                <section class="feue-class-block class-skills-section"><h4>Class Skills <small>Drag &amp; drop skill items here</small></h4>
                    <div class="promo-skills-drop"><div class="promo-skills-list class-skills-list">${buildSkillListHTML(promoSkills)}</div></div></section>
                <section class="feue-class-block class-roleplay-traits-section"><h4>Roleplay Traits <small>Each optional trait replaces the base trait beside it</small></h4>
                    <div class="class-roleplay-traits-grid"><b>Base trait</b><b>Optional replacement</b>${promoTraitRows}</div></section>
                </form>`,
            buttons: {
                save: {
                    icon: '<i class="fas fa-save"></i>', label: "Save", callback: (h) => {
                        const d = {
                            id: promo.id, name: h.find("#pn").val() || "Unnamed", classType: h.find("#pct").val(), maxLevel: Number(h.find("#pml").val()) || 20, movement: Number(h.find("#pmv").val()) || 5,
                            unitTypes: {}, weaponProficiencies: {}, baseStats: {}, growthRates: {}, statCaps: {}, classSkills: promoSkills, roleplayTraits: [], promotions: promo.promotions || []
                        };
                        h.find("input[type='number'][data-key]").each((_, el) => { const [g, s] = el.dataset.key.split("."); const map = { bs: "baseStats", gr: "growthRates", sc: "statCaps" }; d[map[g]][s] = Number(el.value) || 0; });
                        h.find("input[type='checkbox'][data-key^='ut.']").each((_, el) => { const key = el.dataset.key.slice(3); d.unitTypes[key] = el.checked; });
                        h.find("input[type='checkbox'][data-key^='wp.']").each((_, el) => { const key = el.dataset.key.slice(3); d.weaponProficiencies[key] = el.checked; });
                        h.find("input[data-roleplay-field='base']").each((_, el) => {
                            const index = Number(el.dataset.roleplayIndex);
                            d.roleplayTraits[index] = {
                                base: el.value.trim(),
                                alternative: h.find(`input[data-roleplay-index='${index}'][data-roleplay-field='alternative']`).val()?.trim() || ""
                            };
                        });
                        onSave(d);
                    }
                }, cancel: { label: "Cancel" }
            }, default: "save",
            render: (h) => {
                // ── Existing: Class type change toggles base stats visibility ──
                h.find("#pct").change(ev => h.find(".feue-base-label").text(baseStatLabel(ev.currentTarget.value)));

                // ── Skills: drop zone ──
                const dropZone = h.find(".promo-skills-drop")[0];
                if (dropZone) {
                    dropZone.addEventListener("dragover", (e) => e.preventDefault());
                    dropZone.addEventListener("drop", async (e) => {
                        e.preventDefault();
                        let data;
                        try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
                        if (data.type !== "Item") return;
                        const item = await Item.implementation.fromDropData(data);
                        if (!item || item.type !== "skill") {
                            ui.notifications.warn("Only skill items can be dropped here.");
                            return;
                        }
                        if (promoSkills.some(cs => cs.skillData.name === item.name)) {
                            ui.notifications.warn(`${item.name} is already listed.`);
                            return;
                        }
                        promoSkills.push({
                            id: foundry.utils.randomID(),
                            level: item.system.level || "1",
                            skillData: {
                                name: item.name,
                                img: item.img,
                                system: foundry.utils.deepClone(item.system)
                            }
                        });
                        h.find(".promo-skills-list").html(buildSkillListHTML(promoSkills));
                        bindSkillListEvents(h);
                    });
                }

                // ── Skills: level change & remove ──
                const bindSkillListEvents = (html) => {
                    html.find(".promo-skill-level").off("change").on("change", (ev) => {
                        const idx = Number($(ev.currentTarget).data("skill-idx"));
                        if (promoSkills[idx]) promoSkills[idx].level = ev.currentTarget.value;
                    });
                    html.find(".promo-skill-remove").off("click").on("click", (ev) => {
                        const idx = Number($(ev.currentTarget).data("skill-idx"));
                        promoSkills.splice(idx, 1);
                        html.find(".promo-skills-list").html(buildSkillListHTML(promoSkills));
                        bindSkillListEvents(html);
                    });
                };
                bindSkillListEvents(h);
            },
        }, { classes: ["dialog", "feue-promo-editor"], width: 640, height: 720, resizable: true }).render(true);
    }

    async _onDropClassSkill(event) {
        event.preventDefault();
        let data;
        try {
            data = JSON.parse(event.dataTransfer.getData("text/plain"));
        } catch { return; }

        if (data.type !== "Item") return;

        const item = await Item.implementation.fromDropData(data);
        if (!item || item.type !== "skill") {
            ui.notifications.warn("Only skill items can be dropped here.");
            return;
        }

        const classSkills = foundry.utils.deepClone(this.item.system.classSkills || []);

        // Check for duplicate by name
        if (classSkills.some(cs => cs.skillData.name === item.name)) {
            ui.notifications.warn(`${item.name} is already on this class.`);
            return;
        }

        classSkills.push({
            id: foundry.utils.randomID(),
            level: item.system.level || "1",   // Pre-fill from skill's own level field
            skillData: {
                name: item.name,
                img: item.img,
                system: foundry.utils.deepClone(item.system)
            }
        });

        await this.item.update({ "system.classSkills": classSkills });
    }
}

// ====================================================================
// 4b. PARTY SHEET
// ====================================================================
class FiresOfWarPartySheet extends ActorSheet {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            classes: ["feue", "sheet", "actor", "party"],
            template: "systems/fires-of-war/templates/actor/party-sheet.html",
            width: 600, height: 600
        });
    }

    getData() {
        const data = super.getData();
        const memberIds = this.actor.system.memberIds || [];
        data.members = memberIds
            .map(id => game.actors.get(id))
            .filter(a => a && a.type === "character")
            .map(a => ({
                id: a.id,
                name: a.name,
                img: a.img,
                level: a.system.level || 1,
                totalLevel: a.system.totalLevel || 1,
                hp: a.system.attributes?.hp?.value || 0,
                hpMax: a.system.attributes?.hp?.max || 0,
                className: a.system.activeClassName || "—",
                experience: a.system.experience || 0
            }));
        data.isGM = game.user.isGM;
        data.convoy = convoySheetData(this.actor, this._convoyUnitUuid);
        this._convoyUnitUuid = data.convoy.selectedUuid;
        return data;
    }

    _disableFields(form) {
        super._disableFields(form);
        const data = convoySheetData(this.actor, this._convoyUnitUuid);
        const set = (selector, disabled) => form.querySelectorAll(selector).forEach(control => { control.disabled = disabled; });
        set(".party-convoy-unit", !data.units.length);
        set(".party-convoy-deposit", !data.canDeposit);
        set(".party-convoy-add, .party-convoy-discard", !data.canManage);
        set(".party-convoy-details", false);
        for (const item of data.items) set(`[data-convoy-item="${item.id}"] .party-convoy-withdraw`, !item.canWithdraw);
    }

    _canDragDrop(selector) { return super._canDragDrop(selector) || convoyUnits(this.actor).length > 0; }

    _onChangeInput(event) {
        if (!event.target.name && event.target.closest(".party-convoy")) return;
        return super._onChangeInput(event);
    }

    activateListeners(html) {
        super.activateListeners(html);
        bindConvoySheet(this, html);
        if (!this.options.editable) return;

        html.find(".party-member-open").click(ev => {
            const id = $(ev.currentTarget).closest(".party-member").data("actor-id");
            game.actors.get(id)?.sheet.render(true);
        });

        html.find(".party-member-remove").click(async ev => {
            const id = $(ev.currentTarget).closest(".party-member").data("actor-id");
            const ids = (this.actor.system.memberIds || []).filter(x => x !== id);
            await this.actor.update({ "system.memberIds": ids });
        });

        html.find(".party-award-xp").click(() => this._onAwardXp());
        html.find(".party-gold-adjust").click(ev => this._onAdjustGold($(ev.currentTarget).data("amount")));
        html.find(".party-starting-package").click(() => this._onGrantStartingPackage());
    }

    /** Grant starting package to each Level-1 / 0-XP member. */
    async _onGrantStartingPackage() {
        const members = (this.actor.system.memberIds || [])
            .map(id => game.actors.get(id))
            .filter(a => a && a.type === "character");
        const eligible = members.filter(a => (a.system.level || 1) === 1 && (a.system.experience || 0) === 0);
        if (!eligible.length) return ui.notifications.warn("No eligible members (must be Level 1 with 0 EXP).");

        // Gather compendium indexes once
        const packs = game.packs.filter(p => p.metadata.type === "Item");
        const weaponEntries = [];
        const itemEntries = [];
        for (const pack of packs) {
            let index;
            try { index = await pack.getIndex({ fields: ["type", "img", "name", "system.rank", "system.weaponType", "system.itemType"] }); }
            catch (e) { continue; }
            for (const e of index) {
                const uuid = `Compendium.${pack.collection}.${e._id}`;
                if (e.type === "weapon" && (e.system?.rank === "E")) {
                    weaponEntries.push({ uuid, name: e.name, img: e.img, weaponType: e.system?.weaponType || "", pack: pack.metadata.label });
                } else if (e.type === "item") {
                    itemEntries.push({ uuid, name: e.name, img: e.img, pack: pack.metadata.label });
                }
            }
        }

        const vulneraryEntry = itemEntries.find(e => /vulnerary/i.test(e.name));
        const lockpickEntry = itemEntries.find(e => /lockpick/i.test(e.name));
        if (!vulneraryEntry) ui.notifications.warn("No Vulnerary found in compendiums — skipping.");

        const addFromUuid = async (actor, uuid) => {
            const src = await fromUuid(uuid);
            if (!src) return null;
            const data = src.toObject();
            delete data._id;
            const [created] = await actor.createEmbeddedDocuments("Item", [data]);
            return created;
        };

        for (const actor of eligible) {
            await this._grantStartingPackageFor(actor, weaponEntries, vulneraryEntry, lockpickEntry, addFromUuid);
        }
    }

    async _grantStartingPackageFor(actor, weaponEntries, vulneraryEntry, lockpickEntry, addFromUuid) {
        // Filter weapons by this actor's class proficiencies if any
        const ec = actor.items.find(i => i.type === "class" && i.system?.equipped);
        const node = ec ? actor._getCurrentClassNode(ec) : null;
        const profs = node?.weaponProficiencies || {};
        const profKeys = Object.entries(profs).filter(([, v]) => v).map(([k]) => k);
        const filtered = weaponEntries.filter(w => !profKeys.length || profKeys.includes(w.weaponType));
        const choices = filtered.length ? filtered : weaponEntries;
        const opts = choices.map(w => `<option value="${w.uuid}">${w.name} (${FEUE.WeaponTypes[w.weaponType] || w.weaponType})</option>`).join("");

        const className = node?.name || actor.system.activeClassName || "";
        const isThief = /thief/i.test(className) || /thief/i.test(ec?.name || "");

        return new Promise(resolve => {
            new Dialog({
                title: `Starting Package — ${actor.name}`,
                content: `<form>
                    <p>Choose an E-Rank weapon for <b>${actor.name}</b>.</p>
                    ${choices.length ? `<div class="form-group"><label>Weapon</label><select id="feue-sp-weapon" style="width:100%;">${opts}</select></div>`
                    : `<p><i>No E-Rank weapons found in compendiums.</i></p>`}
                    <p>Also grants: Vulnerary${isThief ? " + Lockpick" : ""}.</p>
                </form>`,
                buttons: {
                    grant: {
                        icon: '<i class="fas fa-gift"></i>', label: "Grant",
                        callback: async (h) => {
                            const log = [];
                            const weaponUuid = h.find("#feue-sp-weapon").val();
                            if (weaponUuid) {
                                const w = await addFromUuid(actor, weaponUuid);
                                if (w) log.push(w.name);
                            }
                            if (vulneraryEntry) {
                                const v = await addFromUuid(actor, vulneraryEntry.uuid);
                                if (v) log.push(v.name);
                            }
                            if (isThief && lockpickEntry) {
                                const l = await addFromUuid(actor, lockpickEntry.uuid);
                                if (l) log.push(l.name);
                            } else if (isThief && !lockpickEntry) {
                                ui.notifications.warn("No Lockpick found in compendiums.");
                            }
                            if (log.length) {
                                ChatMessage.create({
                                    user: game.user.id, speaker: ChatMessage.getSpeaker({ actor }),
                                    content: `<div class="feue-starting-package"><h3>${actor.name} — Starting Package</h3><p>Received: ${log.join(", ")}.</p></div>`
                                });
                            }
                            resolve();
                        }
                    },
                    skip: { label: "Skip", callback: () => resolve() }
                },
                default: "grant",
                close: () => resolve()
            }).render(true);
        });
    }

    async _onDrop(event) {
        let data;
        try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return super._onDrop(event); }
        if (data?.type === "Item") {
            try {
                const item = await Item.implementation.fromDropData(data);
                return await dropConvoyItem(this.actor, item, this._convoyUnitUuid);
            } catch (error) { ui.notifications.warn(error.message); return false; }
        }
        if (data?.type !== "Actor") return super._onDrop(event);
        if (!this.actor.isOwner) return ui.notifications.warn("Only Party owners can add members.");
        const actor = await Actor.implementation.fromDropData(data);
        if (!actor || actor.type !== "character") {
            ui.notifications.warn("Only character actors can be added to a party.");
            return;
        }
        const ids = this.actor.system.memberIds || [];
        if (ids.includes(actor.id)) {
            ui.notifications.warn(`${actor.name} is already in this party.`);
            return;
        }
        await this.actor.update({ "system.memberIds": [...ids, actor.id] });
        ui.notifications.info(`Added ${actor.name} to ${this.actor.name}.`);
    }

    async _onAwardXp() {
        const members = (this.actor.system.memberIds || [])
            .map(id => game.actors.get(id))
            .filter(a => a && a.type === "character");
        if (!members.length) return ui.notifications.warn("No party members to award XP.");

        new Dialog({
            title: "Award XP to All Party Members",
            content: `<form><div class="form-group"><label>XP per character</label><input type="number" id="party-xp-amount" value="10" min="1"/></div><p style="font-size:12px;color:#666;">Will award to ${members.length} member(s).</p></form>`,
            buttons: {
                award: {
                    icon: '<i class="fas fa-star"></i>', label: "Award",
                    callback: async (h) => {
                        const amount = Number(h.find("#party-xp-amount").val()) || 0;
                        if (amount <= 0) return;
                        await FEUEParty.awardXp(members.map(m => m.id), amount);
                        ChatMessage.create({
                            user: game.user.id,
                            content: `<div class="feue-party-xp"><h3>${this.actor.name}: +${amount} XP</h3><p>Awarded to: ${members.map(m => m.name).join(", ")}</p></div>`
                        });
                    }
                },
                cancel: { label: "Cancel" }
            },
            default: "award"
        }).render(true);
    }

    async _onAdjustGold(amount) {
        amount = Number(amount);
        if (!amount) return;
        const sign = amount > 0 ? "+" : "";
        new Dialog({
            title: `${sign}${amount} Gold`,
            content: `<form><div class="form-group"><label>Amount</label><input type="number" id="party-gold-amount" value="${Math.abs(amount)}" min="1"/></div></form>`,
            buttons: {
                ok: {
                    label: "Apply",
                    callback: async (h) => {
                        const v = Number(h.find("#party-gold-amount").val()) || 0;
                        const delta = amount > 0 ? v : -v;
                        await FEUEParty.adjustGold(this.actor.id, delta);
                    }
                },
                cancel: { label: "Cancel" }
            },
            default: "ok"
        }).render(true);
    }
}

// ====================================================================
// 4c. SHOP SHEET
// ====================================================================
class FiresOfWarShopSheet extends ActorSheet {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            classes: ["feue", "sheet", "actor", "shop"],
            template: "systems/fires-of-war/templates/actor/shop-sheet.html",
            width: 700, height: 650
        });
    }

    getData() {
        const data = super.getData();
        data.isGM = game.user.isGM;
        const buyMult = Number(this.actor.system.buyMultiplier ?? 1);
        const sellMult = Number(this.actor.system.sellMultiplier ?? 0.5);
        data.buyMultiplier = buyMult;
        data.sellMultiplier = sellMult;
        data.stock = this.actor.items
            .filter(i => i.type === "weapon" || i.type === "item")
            .map(i => {
                const baseValue = effectivePrice(i);
                const buyPrice = Math.floor(baseValue * buyMult);
                const stockQty = Number(i.getFlag("fires-of-war", "stockQuantity") ?? -1);
                return {
                    id: i.id,
                    name: i.name,
                    img: i.img,
                    type: i.type,
                    baseValue,
                    buyPrice,
                    stockQty,
                    unlimited: stockQty < 0
                };
            });
        data.parties = game.actors.filter(a => a.type === "party").map(p => ({ id: p.id, name: p.name }));
        const party = game.actors.get(this.actor.system.partyId);
        data.party = party ? { id: party.id, name: party.name, gold: party.system.gold || 0 } : null;
        return data;
    }

    activateListeners(html) {
        super.activateListeners(html);
        if (!this.options.editable && !game.user.isGM) {
            // Players still need buy/sell listeners
        }

        html.find(".shop-toggle-open").click(async () => {
            await this.actor.update({ "system.isOpen": !this.actor.system.isOpen });
        });

        html.find(".shop-party-select").change(async ev => {
            await this.actor.update({ "system.partyId": ev.currentTarget.value });
        });

        html.find(".shop-buy-mult").change(async ev => {
            await this.actor.update({ "system.buyMultiplier": Number(ev.currentTarget.value) || 1 });
        });
        html.find(".shop-sell-mult").change(async ev => {
            await this.actor.update({ "system.sellMultiplier": Number(ev.currentTarget.value) || 0.5 });
        });

        html.find(".shop-stock-quantity").change(async ev => {
            const id = $(ev.currentTarget).closest(".shop-item").data("item-id");
            const item = this.actor.items.get(id);
            if (!item) return;
            const v = ev.currentTarget.value === "" ? -1 : Number(ev.currentTarget.value);
            await item.setFlag("fires-of-war", "stockQuantity", v);
        });

        html.find(".shop-item-edit").click(ev => {
            const id = $(ev.currentTarget).closest(".shop-item").data("item-id");
            this.actor.items.get(id)?.sheet.render(true);
        });

        html.find(".shop-item-delete").click(async ev => {
            const id = $(ev.currentTarget).closest(".shop-item").data("item-id");
            await this.actor.items.get(id)?.delete();
        });

        html.find(".shop-item-buy").click(ev => {
            const id = $(ev.currentTarget).closest(".shop-item").data("item-id");
            this._onBuy(id);
        });

        html.find(".shop-open-sell").click(() => this._onOpenSell());
    }

    async _onDrop(event) {
        if (!game.user.isGM) return;
        let data;
        try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return super._onDrop(event); }
        if (data?.type !== "Item") return super._onDrop(event);
        const item = await Item.implementation.fromDropData(data);
        if (!item || (item.type !== "weapon" && item.type !== "item")) {
            ui.notifications.warn("Only weapons and items can be stocked.");
            return;
        }
        const itemData = item.toObject();
        delete itemData._id;
        await this.actor.createEmbeddedDocuments("Item", [itemData]);
    }

    async _onBuy(itemId) {
        const partyId = this.actor.system.partyId;
        const party = game.actors.get(partyId);
        if (!party || party.type !== "party") {
            return ui.notifications.error("This shop has no party linked.");
        }
        const item = this.actor.items.get(itemId);
        if (!item) return;
        let members = (party.system.memberIds || [])
            .map(id => game.actors.get(id))
            .filter(a => a && a.type === "character");
        if (!game.user.isGM) {
            members = members.filter(m => m.isOwner);
        }
        if (!members.length) return ui.notifications.warn(game.user.isGM ? "Party has no members." : "You don't own any party members.");

        const opts = members.map(m => `<option value="${m.id}">${m.name}</option>`).join("");
        const buyMult = Number(this.actor.system.buyMultiplier ?? 1);
        const price = Math.floor(effectivePrice(item) * buyMult);

        new Dialog({
            title: `Buy ${item.name}`,
            content: `<form>
                <p><b>Price:</b> ${price}g | <b>Party Gold:</b> ${party.system.gold || 0}g</p>
                <div class="form-group"><label>For Character</label><select id="buy-character">${opts}</select></div>
            </form>`,
            buttons: {
                buy: {
                    icon: '<i class="fas fa-coins"></i>', label: "Buy",
                    callback: async (h) => {
                        const characterId = h.find("#buy-character").val();
                        await FEUEShop.requestBuy({
                            shopId: this.actor.id, itemId, characterId, partyId
                        });
                    }
                },
                cancel: { label: "Cancel" }
            },
            default: "buy"
        }).render(true);
    }

    async _onOpenSell() {
        const partyId = this.actor.system.partyId;
        const party = game.actors.get(partyId);
        if (!party) return ui.notifications.error("This shop has no party linked.");
        const sellMult = Number(this.actor.system.sellMultiplier ?? 0.5);

        let members = (party.system.memberIds || [])
            .map(id => game.actors.get(id))
            .filter(a => a && a.type === "character");
        if (!game.user.isGM) members = members.filter(m => m.isOwner);

        const rows = [];
        for (const m of members) {
            for (const it of m.items.filter(i => (i.type === "weapon" || i.type === "item") && Number(i.system.price || 0) > 0)) {
                const price = Math.floor(effectivePrice(it) * sellMult);
                rows.push(`<tr>
                    <td>${m.name}</td>
                    <td><img src="${it.img}" width="20" height="20"/> ${it.name}</td>
                    <td>${price}g</td>
                    <td><a class="sell-btn" data-actor-id="${m.id}" data-item-id="${it.id}" data-price="${price}" style="cursor:pointer;color:#5a8a5a;"><i class="fas fa-coins"></i> Sell</a></td>
                </tr>`);
            }
        }
        if (!rows.length) return ui.notifications.warn("No sellable items in the party.");

        const dlg = new Dialog({
            title: `Sell to ${this.actor.name}`,
            content: `<table style="width:100%;font-size:12px;"><thead><tr><th>Owner</th><th>Item</th><th>Price</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>`,
            buttons: { close: { label: "Close" } },
            default: "close",
            render: (h) => {
                h.find(".sell-btn").click(async (ev) => {
                    const actorId = $(ev.currentTarget).data("actor-id");
                    const itemId = $(ev.currentTarget).data("item-id");
                    const price = Number($(ev.currentTarget).data("price"));
                    await FEUEShop.requestSell({
                        shopId: this.actor.id, partyId, characterId: actorId, itemId, price
                    });
                    dlg.close();
                });
            }
        }, { width: 500 });
        dlg.render(true);
    }
}

// ====================================================================
// 4d. PARTY / SHOP HELPERS (with GM-relay socket)
// ====================================================================
const FEUE_SOCKET = "system.fires-of-war";

const FEUEParty = {
    async adjustGold(partyId, delta) {
        if (game.user.isGM) {
            const party = game.actors.get(partyId);
            if (!party) return;
            const cur = Number(party.system.gold || 0);
            await party.update({ "system.gold": Math.max(cur + delta, 0) });
            return;
        }
        if (!game.users.activeGM) return ui.notifications.error("No GM online to update party gold.");
        game.socket.emit(FEUE_SOCKET, { action: "adjustGold", partyId, delta, userId: game.user.id });
    },

    async awardXp(characterIds, amount) {
        if (game.user.isGM) {
            for (const id of characterIds) {
                const c = game.actors.get(id);
                if (!c || c.type !== "character") continue;
                // Underdog doubles awarded EXP (not WEXP).
                const newXp = Number(c.system.experience || 0) + amount * (hasSkill(c, "underdog") ? 2 : 1);
                await c.update({ "system.experience": newXp });
            }
            return;
        }
        if (!game.users.activeGM) return ui.notifications.error("No GM online to award XP.");
        game.socket.emit(FEUE_SOCKET, { action: "awardXp", characterIds, amount, userId: game.user.id });
    }
};

const FEUEShop = {
    async requestBuy(payload) {
        if (game.user.isGM) return this._executeBuy(payload);
        if (!game.users.activeGM) return ui.notifications.error("No GM online to process purchase.");
        game.socket.emit(FEUE_SOCKET, { action: "buy", ...payload, userId: game.user.id });
    },
    async requestSell(payload) {
        if (game.user.isGM) return this._executeSell(payload);
        if (!game.users.activeGM) return ui.notifications.error("No GM online to process sale.");
        game.socket.emit(FEUE_SOCKET, { action: "sell", ...payload, userId: game.user.id });
    },

    async _executeBuy({ shopId, itemId, characterId, partyId }) {
        const shop = game.actors.get(shopId);
        const party = game.actors.get(partyId);
        const character = game.actors.get(characterId);
        const item = shop?.items.get(itemId);
        if (!shop || !party || !character || !item) return ui.notifications.error("Buy failed: missing reference.");
        if (!shop.system.isOpen) return ui.notifications.warn("Shop is closed.");

        const price = Math.floor(effectivePrice(item) * Number(shop.system.buyMultiplier ?? 1));
        const gold = Number(party.system.gold || 0);
        if (gold < price) return ui.notifications.warn(`Not enough gold (${gold}/${price}).`);

        const stockQty = Number(item.getFlag("fires-of-war", "stockQuantity") ?? -1);
        if (stockQty === 0) return ui.notifications.warn("Out of stock.");

        // Inventory check on character (5 max for items+weapons)
        const carried = character.items.filter(i => i.type === "item" || i.type === "weapon").length;
        if (carried >= 5) return ui.notifications.warn(`${character.name}'s inventory is full.`);

        const itemData = item.toObject();
        delete itemData._id;
        if (itemData.flags?.["fires-of-war"] && "stockQuantity" in itemData.flags["fires-of-war"]) {
            delete itemData.flags["fires-of-war"].stockQuantity;
        }
        await character.createEmbeddedDocuments("Item", [itemData]);
        await party.update({ "system.gold": gold - price });
        if (stockQty > 0) await item.setFlag("fires-of-war", "stockQuantity", stockQty - 1);

        ChatMessage.create({
            content: `<div class="feue-shop-tx"><h3>${character.name} bought ${item.name}</h3><p>From ${shop.name} for ${price}g. Party gold: ${gold - price}.</p></div>`
        });
    },

    async _executeSell({ shopId, partyId, characterId, itemId, price }) {
        const shop = game.actors.get(shopId);
        const party = game.actors.get(partyId);
        const character = game.actors.get(characterId);
        const item = character?.items.get(itemId);
        if (!shop || !party || !character || !item) return ui.notifications.error("Sell failed: missing reference.");
        if (!shop.system.isOpen) return ui.notifications.warn("Shop is closed.");

        const gold = Number(party.system.gold || 0);
        await item.delete();
        await party.update({ "system.gold": gold + Number(price) });

        ChatMessage.create({
            content: `<div class="feue-shop-tx"><h3>${character.name} sold ${item.name}</h3><p>To ${shop.name} for ${price}g. Party gold: ${gold + Number(price)}.</p></div>`
        });
    }
};

function _onFeueSocket(payload) {
    if (!game.user.isGM) return;
    // Only the first GM acts to avoid duplicate writes.
    const firstGM = game.users.filter(u => u.isGM && u.active).sort((a, b) => a.id.localeCompare(b.id))[0];
    if (firstGM?.id !== game.user.id) return;
    switch (payload?.action) {
        case "adjustGold": return FEUEParty.adjustGold(payload.partyId, payload.delta);
        case "awardXp": return FEUEParty.awardXp(payload.characterIds, payload.amount);
        case "buy": return FEUEShop._executeBuy(payload);
        case "sell": return FEUEShop._executeSell(payload);
    }
}

function _escapeTokenActionHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function _tokenActionItemRow({ action, item, meta = "", disabled = false, title = "" }) {
    const safeId = _escapeTokenActionHtml(item?.id || "");
    const safeName = _escapeTokenActionHtml(item?.name || "Unavailable");
    const safeImage = _escapeTokenActionHtml(item?.img || "icons/svg/item-bag.svg");
    const safeMeta = _escapeTokenActionHtml(meta);
    const safeTitle = _escapeTokenActionHtml(title);
    return `<button type="button" class="feue-token-action-row" data-feue-action="${action}" data-item-id="${safeId}"${disabled ? " disabled" : ""}${safeTitle ? ` title="${safeTitle}"` : ""}>
        <img src="${safeImage}" alt="" />
        <span class="feue-token-action-copy"><b>${safeName}</b>${safeMeta ? `<small>${safeMeta}</small>` : ""}</span>
        <i class="fas ${action === "attack" ? "fa-crosshairs" : action === "art" ? "fa-fist-raised" : action === "spell" ? "fa-hat-wizard" : "fa-bolt"}"></i>
    </button>`;
}

/** Open the quick-action palette for optional macros. */
function openTokenActionMenu(subject) {
    const actor = subject?.actor ?? subject?.document?.actor ?? subject;
    if (!actor || actor.type !== "character") return ui.notifications.warn("Token actions require a character actor.");
    if (!actor.isOwner) return ui.notifications.warn(`You do not have permission to use ${actor.name}.`);

    const sheet = actor.sheet;
    if (!(sheet instanceof FiresOfWarCharacterSheet)) return ui.notifications.error("The Fires of War character sheet is unavailable.");

    const equipped = actor.items.find(item => item.type === "weapon" && item.system?.equipped) || null;
    const equippedType = weaponTypeKey(equipped?.system?.weaponType);
    const weaponUses = equipped?.system?.uses;
    const weaponMeta = equipped
        ? `${FEUE.WeaponTypes[equippedType] || "Weapon"} · ${hasInfiniteUses(weaponUses) ? "∞ uses" : weaponUses?.max > 0 ? `${Number(weaponUses.value || 0)}/${Number(weaponUses.max || 0)} uses` : "No durability"}`
        : "Equip a weapon on the character sheet";

    const arts = actor.items.filter(item => item.type === "combatArt" && !combatArtReason(actor, item, equipped)).sort((a, b) => a.name.localeCompare(b.name));
    const spells = actor.items.filter(item => item.type === "spell").sort((a, b) => a.name.localeCompare(b.name));
    const skills = actor.items
        // Automated Passive (Activated) skills roll on their own; declared and rider skills are not pressed.
        .filter(item => item.type === "skill" && (activeSkillRule(item) ? activeSkillUsable(item)
            : isTokenActionSkillType(item.system?.skillType) && !(item.system?.skillType === "Passive (Activated)" && skillRule(item))))
        .sort((a, b) => a.name.localeCompare(b.name));
    const equippedCanUseArts = !!equipped && !["anima", "light", "dark", "staff"].includes(equippedType);
    const target = Array.from(game.user.targets || [])[0]?.actor;

    const attackRow = _tokenActionItemRow({
        action: "attack",
        item: equipped || { name: "No Weapon Equipped", img: "icons/svg/sword.svg" },
        meta: weaponMeta,
        disabled: !equipped,
        title: equipped ? `Attack with ${equipped.name}` : "Equip a weapon first"
    });
    const artRows = arts.length
        ? arts.map(art => {
            const compatible = equippedCanUseArts && combatArtAllowsWeaponType(art.system?.weaponRestriction, equippedType);
            const restriction = art.system?.weaponRestriction || "Any weapon";
            const cost = Math.max(Number(art.system?.durabilityCost || 0), 0);
            return _tokenActionItemRow({
                action: "art", item: art,
                meta: `${restriction} · ${cost} durability`,
                disabled: !compatible,
                title: compatible ? `Use with ${equipped.name}` : `Requires a compatible equipped weapon (${restriction})`
            });
        }).join("")
        : '<p class="feue-token-action-empty">No Combat Arts available.</p>';
    const spellRows = spells.length
        ? spells.map(spell => _tokenActionItemRow({
            action: "spell", item: spell,
            meta: `${spell.system?.school || "Spell"} · ${Math.max(Number(spell.system?.hpCost || 0), 0)} HP · Range ${spell.system?.range || "—"}`
        })).join("")
        : '<p class="feue-token-action-empty">No Spells available.</p>';
    const skillRows = skills.length
        ? skills.map(skill => _tokenActionItemRow({
            action: "skill", item: skill,
            meta: activeSkillRule(skill) ? activeSkillRule(skill).summary : skill.system?.skillType === "Passive (Activated)" ? "Roll d100 activation" : "Active Skill"
        })).join("")
        : '<p class="feue-token-action-empty">No actionable Skills available.</p>';

    let actionDialog;
    actionDialog = new Dialog({
        title: `${actor.name} — Token Actions`,
        content: `<div class="feue-token-actions-menu">
            <p class="feue-token-action-target"><i class="fas fa-bullseye"></i> ${target ? `Target: <b>${_escapeTokenActionHtml(target.name)}</b>` : "No target selected"}</p>
            <section><h3>Equipped Weapon</h3>${attackRow}</section>
            <section><h3>Combat Arts</h3>${artRows}</section>
            <section><h3>Spells</h3>${spellRows}</section>
            <section><h3>Skills</h3>${skillRows}</section>
        </div>`,
        buttons: { close: { label: "Close" } },
        render: html => {
            html.find(".feue-token-action-row:not(:disabled)").click(async event => {
                event.preventDefault();
                const button = event.currentTarget;
                const action = button.dataset.feueAction;
                const item = actor.items.get(button.dataset.itemId);
                actionDialog.close();
                if (!item) return ui.notifications.warn("That action is no longer available.");
                if (action === "attack") return sheet._promptWeaponAttack(item);
                if (action === "art") {
                    const currentWeapon = actor.items.find(entry => entry.type === "weapon" && entry.system?.equipped);
                    const currentType = weaponTypeKey(currentWeapon?.system?.weaponType);
                    const canUseArts = !!currentWeapon && !["anima", "light", "dark", "staff"].includes(currentType);
                    if (!canUseArts || !combatArtAllowsWeaponType(item.system?.weaponRestriction, currentType)) {
                        return ui.notifications.warn("Equip a compatible weapon before using that Combat Art.");
                    }
                    return sheet._executeCombatArt(item, currentWeapon);
                }
                if (action === "spell") return sheet._castSpell(item);
                if (action === "skill" && !activeSkillRule(item) && item.system?.skillType === "Passive (Activated)") return sheet._rollSkillActivation(item);
                if (action === "skill") return sheet._useSkill(item).catch(error => ui.notifications.error(error.message));
            });
        }
    }, { classes: ["dialog", "feue-token-action-dialog"], width: 420 });
    actionDialog.render(true);
}

// ====================================================================
// 5. HOOKS
// ====================================================================
Hooks.once("init", () => {
    console.log("FEUE | Initializing system");
    Handlebars.registerHelper("math", function (l, o, r) { l = parseFloat(l); r = parseFloat(r); return { "+": l + r, "-": l - r, "*": l * r, "/": l / r, "%": l % r }[o]; });
    Handlebars.registerHelper("ifEquals", function (a, b, opts) { return a == b ? opts.fn(this) : opts.inverse(this); });
    Handlebars.registerHelper("join", function (arr, sep) { return Array.isArray(arr) ? arr.join(sep || ", ") : ""; });
    Handlebars.registerHelper("eq", function (a, b) { return a === b; });
    Handlebars.registerHelper("checked", function (v) { return v ? "checked" : ""; });
    Handlebars.registerHelper("lookup", function (obj, key) { return obj?.[key]; });

    const _reRenderAll = () => {
        for (const a of game.actors.filter(x => x.type === "character")) a.sheet?.render(false);
    };

    game.settings.register("fires-of-war", "automaticCombatDamage", {
        name: "Apply Combat Damage Automatically", hint: "Apply attack damage to HP, stop attacks when a unit falls, and resolve on-hit, lethal, healing, and kill skills. Disable for manual HP adjustment.",
        scope: "world", config: true, type: Boolean, default: true
    });

    game.settings.register("fires-of-war", "useHolyBlood", {
        name: "Use Holy Blood",
        hint: "Enable Holy Blood character creation rule (alt rule). Adds growth rate bonuses and grants Prf rank for the bloodline weapon.",
        scope: "world",
        config: true,
        type: Boolean,
        default: false,
        onChange: _reRenderAll
    });

    game.settings.register("fires-of-war", "useStaticGrowths", {
        name: "Use Static Growth Bonuses",
        hint: "Alt rule. Replaces random d10 growth rolls on level-up with deterministic gains from a fixed table.",
        scope: "world",
        config: true,
        type: Boolean,
        default: false,
        onChange: _reRenderAll
    });

    game.settings.register("fires-of-war", "statMaxBonus", {
        name: "Higher Stat Maximums",
        hint: "Alt rule. Flat bonus added to every non-HP stat cap.",
        scope: "world",
        config: true,
        type: Number,
        choices: { 0: "Off (GBA cap)", 10: "+10", 20: "+20" },
        default: 0,
        onChange: _reRenderAll
    });

    game.settings.register("fires-of-war", "useFatigue", {
        name: "Use Fatigue",
        hint: "Alt rule. Track Fatigue per map; when Fatigue equals BLD, max HP is halved. Resting reduces fatigue by 1d10.",
        scope: "world",
        config: true,
        type: Boolean,
        default: false,
        onChange: _reRenderAll
    });

    game.settings.register("fires-of-war", "useCrests", {
        name: "Use Crests",
        hint: "Alt rule. Unique to Fódlan — Crests interact with HP, Skills, and weapons, and apply growth rate reductions when taken.",
        scope: "world",
        config: true,
        type: Boolean,
        default: false,
        onChange: _reRenderAll
    });

    game.settings.register("fires-of-war", "useHeroRelics", {
        name: "Use Hero's Relic Alt Rule",
        hint: "Alt rule. Relics only work properly with matching Crest — wielders without it take 10 damage/turn. With it, Rank requirement is bypassed (treated as E).",
        scope: "world",
        config: true,
        type: Boolean,
        default: false,
        onChange: _reRenderAll
    });

    game.settings.register("fires-of-war", "properPromotion", {
        name: "Proper Promotion (Class Change Items)",
        hint: "Alt rule. Turns on class change items, set on an item's Class Change section: crests that promote listed classes, Master Seals that promote any class, and (with Reclassing) Second Seals. From Level 10, using one promotes the unit. Full Classic: Standard classes need one even at maximum level. Partial Classic: without one they still promote naturally at maximum level.",
        scope: "world",
        config: true,
        type: String,
        choices: { off: "Off", partial: "Partial Classic (natural promotion if no item)", full: "Full Classic (item required)" },
        default: "off",
        onChange: _reRenderAll
    });

    game.settings.register("fires-of-war", "useReclassing", {
        name: "Use Reclassing",
        hint: "Alt rule. Choose 2 alternate Standard classes at creation. At Level 10+, switch between them; with Proper Promotion on, each switch uses a Second Seal. Stats and weapon ranks are preserved.",
        scope: "world",
        config: true,
        type: Boolean,
        default: false,
        onChange: _reRenderAll
    });

    // Durability, Revival Stones and mount rules change prepared item and actor data, so re-prepare everything.
    registerAltRuleSettings(() => {
        const actors = new Set(game.actors);
        for (const token of canvas?.tokens?.placeables ?? []) if (token.actor) actors.add(token.actor);
        for (const item of game.items) item.reset();
        for (const actor of actors) actor.reset();
        _reRenderAll();
        ui.combat?.render();
        game.firesOfWar?.characterActionHud?.queueRefresh();
        game.firesOfWar?.tokenIndicators?.refreshAll?.();
    });

    Actors.unregisterSheet("core", ActorSheet);
    Actors.registerSheet("fires-of-war", FiresOfWarCharacterSheet, { types: ["character"], makeDefault: true });
    Actors.registerSheet("fires-of-war", FiresOfWarPartySheet, { types: ["party"], makeDefault: true });
    Actors.registerSheet("fires-of-war", FiresOfWarShopSheet, { types: ["shop"], makeDefault: true });
    Items.unregisterSheet("core", ItemSheet);
    Items.registerSheet("fires-of-war", FiresOfWarItemSheet, { makeDefault: true });
    CONFIG.Actor.documentClass = FiresOfWarActor;
    CONFIG.Item.documentClass = FiresOfWarItem;
});

Hooks.once("ready", () => {
    console.log("FEUE | System Ready");
    game.socket.on(FEUE_SOCKET, _onFeueSocket);
    game.firesOfWar = Object.assign(game.firesOfWar || {}, { openTokenActions: openTokenActionMenu, seedMonsterContent });
    // The rulebook's Monster classes and weapons are added to the system compendiums once, by the active GM.
    void seedMonsterContent();
});

// Status durations now decrement for every unit at the end of its allegiance phase.

Hooks.on("preCreateItem", (item, createData) => {
    const p = item.parent;
    if (!p || p.documentName !== "Actor") return true;
    if (p.type !== "character") return true;
    const t = createData.type ?? item.type;
    if ((t === "item" || t === "weapon") && p.items.filter(i => i.type === "item" || i.type === "weapon").length >= 5) { ui.notifications.error("Inventory full (5 max)."); return false; }
    if (t === "battalion" && p.items.filter(i => i.type === "battalion").length >= battalionLimit(p)) { ui.notifications.error(battalionLimit(p) > 1 ? "Battalion limit reached (Nobility: 2)." : "Only one battalion."); return false; }
    return true;
});
