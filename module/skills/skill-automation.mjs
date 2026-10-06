import {computeSkillActivationTarget, parseSignedSkillBonuses} from "../rules/feue.mjs";
import {canonicalSkillName, skillName, hasSkill, findSkill} from "./skill-names.mjs";
import {tokenDocument, skillTokenDistance, alliedTokens, activeSkillUnit, sceneTokens, unitsWithin, currentRound, currentPhase,
    unitCombatantOf, sceneEnvironment, terrainOf} from "./skill-context.mjs";
import {SYSTEM_ID} from "../map/terrain.mjs";
import {term, signed} from "../ui/stat-breakdown.mjs";
import {revivalSkillOpen} from "../rules/alt-rules.mjs";

export {skillName, hasSkill, findSkill, canonicalSkillName};
export const hpBelow = (actor, percent) => {
    const hp = actor?.system?.attributes?.hp;
    return Number(hp?.max) > 0 && Number(hp.value) > 0 && Number(hp.value) * 100 <= Number(hp.max) * percent;
};
const stat = (actor, key) => Number(actor?.system?.attributes?.[key]?.value) || 0;
export const TOME_TYPES = Object.freeze(["anima", "light", "dark"]);
export const MAGIC_TYPES = Object.freeze(["anima", "light", "dark", "staff", "stone", "spell"]);
export const weaponKey = weapon => String(weapon?.system?.weaponType ?? "").trim().toLowerCase();
export const isMagicWeapon = weapon => !!weapon && (MAGIC_TYPES.includes(weaponKey(weapon)) || !!weapon.system?.properties?.magical);
export const equippedWeapon = actor => Array.from(actor?.items ?? []).find(i => i.type === "weapon" && i.system?.equipped) ?? null;
export function unitTypeList(actor) {
    const types = actor?.system?.unitTypes ?? [];
    return (Array.isArray(types) ? types : Object.keys(types).filter(key => types[key])).map(type => String(type));
}
const hasUnitType = (actor, list) => {
    const types = unitTypeList(actor).map(type => type.toLowerCase().replace(/s$/, ""));
    return list.some(type => types.includes(type.toLowerCase().replace(/s$/, "")));
};
const STAT_ABBR = {hp: "HP", strength: "STR", magic: "MAG", skill: "SKL", speed: "SPD", defense: "DEF", resistance: "RES", luck: "LUK", charm: "CHA", build: "BLD", move: "Move"};
const WEAPON_LABELS = {anima: "Anima", light: "Light", dark: "Dark", stone: "Dragonstone", spell: "Spell", unarmed: "Unarmed", firearm: "Firearm", monster: "Monster weapon"};
const listText = list => list.map(type => WEAPON_LABELS[type] ?? type[0].toUpperCase() + type.slice(1)).join("/");
const tomeList = type => type === "tome" ? [...TOME_TYPES] : [type === "gun" ? "firearm" : type];

/**
 * Rulebook skills. Declarative fields drive combat calculations, forecasts and stat tooltips.
 * trigger:
 *   Passive  constant or HP-dependent bonus prepared on the actor
 *   Attack / Combat  non-rolled bonus while fighting (Attack: legacy name; both apply to either side's relevant stats)
 *   Opponent  bonus against an opponent's weapon type; Defense (rolled or not) reacts to incoming hits
 *   Aura  affects other units nearby; CombatStart / Critical / Lethal / Hit / Kill / CombatEnd / PhaseStart are events
 *   Other triggers mark mechanics implemented by dedicated code (movement, order, range, actions); `summary` describes them.
 */
const fair = weapons => ({trigger: "Attack", weapons, damage: 5});
const breaker = weapons => ({trigger: "Opponent", weapons, hit: 50, avoid: 50});
export const SKILL_RULES = Object.freeze({
    // Prepared bonuses
    "blood fury": {trigger: "Passive", hp: 25, crit: 20},
    "defiant speed": {trigger: "Passive", hp: 25, attributes: {speed: 6}},
    resolve: {trigger: "Passive", hp: 75, attributes: {defense: 5, resistance: 5}},
    gamble: {trigger: "Passive", hit: -5, crit: 10},
    "loptous blood": {trigger: "Passive", hp: 50, attributes: {defense: 10, resistance: 10}, summary: "At ≤50% HP: +10 DEF and +10 RES. The Loptous tome never loses durability."},
    "ultra heavyweight": {trigger: "Passive", attributes: {defense: 10, resistance: 10, build: 10}, summary: "+10 DEF, RES and BLD. Immune to forced movement, Move reductions (including terrain costs) and Slayer (Armored)."},
    "great haul": {trigger: "Weight", summary: "Equipped weapons weigh 4 less for Attack Speed."},
    // Contextual combat bonuses
    aggressor: {trigger: "Attack", initiating: true, damage: 7},
    "quick draw": {trigger: "Attack", initiating: true, damage: 4},
    "strong riposte": {trigger: "Attack", initiating: false, damage: 3},
    "certain blow": {trigger: "Attack", initiating: true, hit: 40},
    "uncanny blow": {trigger: "Attack", initiating: true, hit: 30},
    "death blow": {trigger: "Attack", initiating: true, crit: 20},
    "darting blow": {trigger: "Combat", initiating: true, doubleSpeed: 5},
    "ancient wisdom": {trigger: "Combat", initiating: true, damageReduction: 6},
    "warding blow": {trigger: "Combat", initiating: true, incoming: "magic", damageReduction: 20},
    "armored blow": {trigger: "Combat", initiating: true, incoming: "physical", damageReduction: 20},
    "dark charge": {trigger: "Attack", hp: 25, brave: true},
    "life and death": {trigger: "Combat", damage: 10, damageTaken: 10},
    biorhythm: {trigger: "Combat", dynamic: "biorhythm"},
    evenhanded: {trigger: "Combat", round: "even", damage: 4},
    shadowgift: {trigger: "Attack", weapons: ["dark"], hit: 10, damage: 2, summary: "+10 Hit and +2 damage with Dark tomes; Dark tomes up to C rank remain usable without Dark proficiency."},
    momentum: {trigger: "Combat", dynamic: "momentum"},
    beastbane: {trigger: "Attack", vsUnitTypes: ["Beast"], hit: 20, damage: 5},
    wyrmsbane: {trigger: "Attack", vsUnitTypes: ["Dragon"], hit: 20, damage: 5},
    quickburn: {trigger: "Combat", dynamic: "quickburn"},
    "lucky seven": {trigger: "Combat", roundMax: 7, hit: 20, avoid: 20},
    "big game": {trigger: "Combat", dynamic: "bigGame"},
    duelist: {trigger: "Combat", dynamic: "duelist"},
    "elbow room": {trigger: "Combat", terrain: "plain", damage: 3},
    "natural cover": {trigger: "Combat", terrain: "bonus", damageReduction: 3},
    "take cover": {trigger: "Combat", terrain: "avoid", avoid: 20, dodge: 20},
    outdoorsman: {trigger: "Combat", terrain: "forest", defense: 4},
    "outdoor fighter": {trigger: "Combat", outdoor: true, hit: 10, avoid: 10},
    focus: {trigger: "Combat", allies: {radius: 3, max: 0}, crit: 10},
    tantivy: {trigger: "Combat", allies: {radius: 3, max: 0}, hit: 10, avoid: 10},
    "dark poise": {trigger: "Combat", allies: {radius: 1, min: 2}, damageReduction: 3},
    "spell harmony": {trigger: "Combat", dynamic: "spellHarmony"},
    "squad tactics": {trigger: "Combat", dynamic: "squadTactics"},
    patience: {trigger: "Combat", phase: "other", hit: 10, avoid: 10},
    prescience: {trigger: "Combat", phase: "own", hit: 15, avoid: 15},
    vendetta: {trigger: "Combat", dynamic: "vendetta"},
    "keen intuition": {trigger: "Combat", foeCannotCounter: true, avoid: 30},
    "alert stance": {trigger: "Combat", waited: true, avoid: 10},
    "battle maiden": {trigger: "Combat", waited: true, defense: 2, resistance: 2},
    "unarmed combat": {trigger: "Attack", weapons: ["unarmed"], damage: 3, summary: "Unarmed weapons gain +3 Might."},
    swordfaire: fair(["sword"]), lancefaire: fair(["lance"]), axefaire: fair(["axe"]), bowfaire: fair(["bow"]),
    gunfaire: fair(["firearm"]), knifefaire: fair(["knife"]), tomefaire: fair([...TOME_TYPES]),
    swordbreaker: breaker(["sword"]), lancebreaker: breaker(["lance"]), axebreaker: breaker(["axe"]), bowbreaker: breaker(["bow"]),
    knifebreaker: breaker(["knife"]), tomebreaker: breaker([...TOME_TYPES]),
    // Auras
    heartseeker: {trigger: "Aura", auraTarget: "enemies", auraRadius: 1, avoid: -20},
    charm: {trigger: "Aura", auraTarget: "allies", auraRadius: 3, hit: 5, avoid: 5},
    solidarity: {trigger: "Aura", auraTarget: "allies", auraRadius: 3, crit: 10, avoid: 10},
    demoiselle: {trigger: "Aura", auraTarget: "allies", auraRadius: 3, receiverSex: "male", avoid: 10, dodge: 10},
    "fierce mien": {trigger: "Aura", auraTarget: "enemies", auraRadius: 2, avoid: -10, dodge: -5},
    "divine light": {trigger: "Aura", auraTarget: "all", auraRadius: 3, receiverTypes: ["Monster"], avoid: -15, dodge: -15},
    "holy aura": {trigger: "Aura", auraTarget: "team", auraRadius: 2, vsUnitTypes: ["Monster", "Beast"], damage: 2},
    "malefic aura": {trigger: "Aura", auraTarget: "enemies", auraRadius: 2, incoming: "magic", damageTaken: 2},
    // Rolled attack skills
    luna: {trigger: "Attack", roll: true, defenseMultiplier: 0.5},
    pierce: {trigger: "Attack", roll: true, mult: 0.5, defenseMultiplier: 0},
    ignis: {trigger: "Attack", roll: true, dynamic: "ignis"},
    vengeance: {trigger: "Attack", roll: true, mult: 1.5, dynamic: "vengeance"},
    "dragon fang": {trigger: "Attack", roll: true, mult: 0.75, damageMultiplier: 1.5},
    sol: {trigger: "Attack", roll: true, healingFraction: 0.5},
    astra: {trigger: "Attack", roll: true, mult: 0.5, strikes: 5, damageMultiplier: 0.5},
    armsthrift: {trigger: "Attack", roll: true, stat: "luck", useMultiplier: 0.5},
    "court mage": {trigger: "Attack", roll: true, stat: "charm", weapons: [...TOME_TYPES, "spell"], inflict: "random"},
    "brave attacker": {trigger: "CombatStart", initiating: true, roll: true, mult: 0.5, brave: true},
    "crest of flames": {trigger: "CombatStart", initiating: true, roll: true, fixed: 20, damage: 5, healingFraction: 0.5, absorb: true, noCounter: true},
    // Rolled or event defense
    aegis: {trigger: "Defense", roll: true, weapons: ["bow", "knife", ...TOME_TYPES, "stone", "spell"], damageMultiplier: 0.5},
    pavise: {trigger: "Defense", roll: true, weapons: ["sword", "lance", "axe", "unarmed", "firearm", "stone", "monster"], damageMultiplier: 0.5},
    "great shield": {trigger: "Defense", roll: true, dynamic: "levelDifference", damageMultiplier: 0},
    miracle: {trigger: "Lethal", roll: true, stat: "luck"},
    lethality: {trigger: "Critical", roll: true, mult: 0.25, lethal: true},
    plunder: {trigger: "Hit", roll: true, stat: "luck", gold: 300},
    "soul rend": {trigger: "Hit", halveResistance: true},
    "poison strike": {trigger: "CombatEnd", chipFraction: 0.2},
    "grisly wound": {trigger: "CombatEnd", adjacentFraction: 0.2},
    lifetaker: {trigger: "Kill", initiating: true, healMaxFraction: 0.5},
    galeforce: {trigger: "Kill", refresh: true},
    bloodlust: {trigger: "Kill", phase: "own", attributes: {strength: 2, defense: 2}, summary: "Killing an enemy on your own phase grants +2 STR and +2 DEF until your next phase starts."},
    "spinning axe": {trigger: "Kill", weapons: ["axe"], adjacentFraction: 0.1, summary: "Killing with an Axe deals 10% max HP to every enemy adjacent to you."},
    renewal: {trigger: "PhaseStart", healMaxFraction: 0.3},
    "better odds": {trigger: "PhaseStart", round: "odd", healMaxFraction: 0.2},
    "draconic recovery": {trigger: "PhaseStart", weapons: ["stone"], healMaxFraction: 0.1},
    relief: {trigger: "PhaseStart", allies: {radius: 3, max: 0}, healMaxFraction: 0.2},
    mantle: {trigger: "PhaseStart", healStat: "luck", summary: "Only Legendary weapons and S-rank spells can damage this unit. Recovers LUK HP at the start of each of its phases."},
    "opportunity shot": {trigger: "PhaseStart", roll: true, stat: "skill", freeAttack: true, summary: "Phase start: roll SKL. On success, the unit's next attack this phase does not spend its Major Action (choose the foe as normal)."},
    // Mechanics implemented by dedicated code
    canto: {trigger: "Movement", summary: "After a Major Action, the unit may spend its remaining movement."},
    acrobat: {trigger: "Movement", summary: "Every traversable square costs 1 movement."},
    pass: {trigger: "Movement", summary: "Move through enemy-occupied squares."},
    "forest stride": {trigger: "Movement", summary: "No Forest penalty; can enter Woods."},
    "mountain stride": {trigger: "Movement", summary: "Can enter Mountain Peaks."},
    "water stride": {trigger: "Movement", summary: "Can enter Sea / Ocean."},
    "open field": {trigger: "Movement", summary: "+3 Move while standing on terrain without a movement penalty."},
    "headlong rush": {trigger: "Movement", summary: "Immune to Move reductions from statuses, Seal Movement and Buffeted."},
    waterbound: {trigger: "Movement", summary: "Can only move on River, Sea and Ocean terrain."},
    vantage: {trigger: "Order", summary: "At ≤50% HP, strikes first even when attacked."},
    alacrity: {trigger: "Order", summary: "When initiating at ≤50% HP, the follow-up strike comes before the counterattack."},
    "wary fighter": {trigger: "Order", summary: "Neither unit can make speed follow-ups."},
    "swift caster": {trigger: "Order", summary: "Strikes first when attacked by a non-magical weapon (Vantage and Alacrity take priority)."},
    "close counter": {trigger: "Range", summary: "Bows can counterattack at 1 range."},
    "close range": {trigger: "Range", summary: "Bows can attack at 1 range (no 1-range counterattacks)."},
    "rifled barrel": {trigger: "Range", summary: "Ballista range extends by 1 in both directions."},
    "curse proficiency": {trigger: "Proficiency", summary: "Cursed weapons count as proficient."},
    "axe slam": {trigger: "Property", summary: "Axe attacks push the target (Smash), one extra square if the axe already has Smash."},
    "monster hunter": {trigger: "Property", summary: "All attacks gain Slayer (Monster)."},
    golembane: {trigger: "Property", summary: "All attacks gain Slayer (Puppet / Mechanical units)."},
    "dark pact": {trigger: "Property", summary: "Tomes and spells gain Absorb; if they already have Absorb, +5 Mt."},
    ballistician: {trigger: "Property", summary: "Ballistae lose the Vehicle property, so they can counterattack and be carried."},
    "crippling knife": {trigger: "Property", summary: "Crippling Knives also lower SKL and SPD."},
    "beyond morality": {trigger: "Triangle", summary: "Weapon Triangle bonuses and penalties never apply in this unit's combats."},
    counter: {trigger: "Reflect", summary: "Reflects half of physical damage taken at 1 range, unless the hit is lethal."},
    "magic counter": {trigger: "Reflect", summary: "Reflects half of magical damage taken at 1–2 range, unless the hit is lethal."},
    "performance artist": {trigger: "Special", summary: "Uses CHA instead of STR for Sword damage and instead of MAG for Staff healing."},
    healtouch: {trigger: "Special", summary: "Staff healing +5."},
    "live to serve": {trigger: "Special", summary: "Staff healing also heals the caster by the same amount."},
    "spell mastery": {trigger: "Special", summary: "Spell HP costs are halved (rounded down)."},
    "terrain resistance": {trigger: "Special", summary: "Ignores damaging terrain (Swamp, Lava, Acid) at phase start."},
    "silence ward": {trigger: "Immunity", summary: "Immune to Silence."},
    "divine aura": {trigger: "Immunity", summary: "Immune to all status effects."},
    undeath: {trigger: "Immunity", summary: "Immune to statuses and Dark tome/spell damage; Absorb hits damage their attacker instead of healing it."},
    goddess: {trigger: "Immunity", summary: "Immune to stat penalties (Crippling, Seal, etc.); Hit/Crit/Avoid/Dodge penalties still apply."},
    "magical flight": {trigger: "Immunity", summary: "Counts as Flying, but Slayer (Flying) does not apply."},
    "mighty king of legend": {trigger: "Immunity", summary: "The first damaging attack against this unit each turn deals 0 damage."},
    quintessence: {trigger: "Immunity", summary: "The first time this unit falls in an encounter, it returns to full HP."},
    "ballista use": {trigger: "Access", summary: "Can operate Ballistae."},
    "cannon use": {trigger: "Access", summary: "Can operate Cannons."},
    "lockpick usage": {trigger: "Access", summary: "Can open doors and chests with a Lockpick."},
    locktouch: {trigger: "Access", summary: "Opens doors and chests without a key (Interact)."},
    demolish: {trigger: "Access", summary: "Break interactions instantly destroy the structure, with or without a weapon."},
    nobility: {trigger: "Access", summary: "Can attach two Battalions."},
    underdog: {trigger: "Access", summary: "Doubles awarded EXP."},
    "weapon training": {trigger: "Access", summary: "Advancing a weapon rank with WEXP also advances every other class proficiency by one step (max S)."},
    rulership: {trigger: "Grant", summary: "Allies on the map gain Miracle, Aegis and Pavise (not this unit)."},
    "rightful ruler": {trigger: "Grant", status: "partial", summary: "Can trigger adjacent allies' Passive (Activated) skills with +10% activation. Allies' Active skills still need GM approval."},
    "sword & pistol": {trigger: "Order", summary: "When attacked, automatically swaps to the Sword or Pistol that can counterattack."},
    dismount: {trigger: "Free", summary: "Free Action: become Infantry (loses Mounted, Flying and Dragon) until Mounting again."},
    mount: {trigger: "Free", summary: "Free Action: remount (not after attacking)."},
    // Judgement calls the system cannot make on its own
    stealth: {trigger: "Manual", status: "manual", summary: "Enemy targeting priorities are decided by the GM."},
    replicate: {trigger: "Manual", status: "manual", summary: "Creating the duplicate token is left to the GM."},
    summon: {trigger: "Manual", status: "manual", summary: "Creating the summoned unit is left to the GM (use the stats in the description)."},
    "dark summon": {trigger: "Manual", status: "manual", summary: "Creating the summoned monsters is left to the GM."},
    "summon auroras": {trigger: "Manual", status: "manual", summary: "Creating the Auroras is left to the GM."},
    "fell rebirth": {trigger: "Manual", status: "manual", summary: "Reviving fallen units is left to the GM."},
    "trap disarmer": {trigger: "Manual", status: "manual", summary: "Disabling traps and neutralising Lava/Acid Regions is left to the GM."}
});

const registeredRules = new Map();
export function registerSkillRule(name, rule) {
    if (!rule || typeof rule !== "object" || !rule.trigger) throw Error("A skill rule requires a trigger and effect fields.");
    registeredRules.set(canonicalSkillName(name), structuredClone(rule));
}

/** Rules recognised from a name pattern (Faire/Breaker variants, "Avoid +10", "Critical [Sword] +15", Seal X, Range +X). */
function patternRule(name) {
    const fixed = name.match(/^(avoid|dodge|hit|crit(?:ical)?|speed|strength|magic|defense|resistance|luck|skill|movement)\s*\+(\d+)$/);
    if (fixed) {
        const key = {avoid: "avoid", dodge: "dodge", hit: "hit", crit: "crit", critical: "crit", movement: "move"}[fixed[1]] ?? fixed[1];
        return {trigger: "Passive", ...(["avoid", "dodge", "hit", "crit"].includes(key) ? {[key]: Number(fixed[2])} : {attributes: {[key]: Number(fixed[2])}})};
    }
    const critical = name.match(/^critical \[([a-z]+)\] \+(\d+)$/);
    if (critical) return {trigger: "Attack", weapons: tomeList(critical[1]), crit: Number(critical[2])};
    const faire = name.match(/^(sword|lance|axe|bow|gun|knife|tome)faire$/);
    if (faire) return fair(tomeList(faire[1]));
    const broken = name.match(/^(sword|lance|axe|bow|gun|knife|tome)breaker$/);
    if (broken) return breaker(tomeList(broken[1]));
    const seal = name.match(/^seal (strength|magic|skill|speed|defense|resistance|luck|movement)$/);
    if (seal) return {trigger: "Hit", seal: seal[1] === "movement" ? "move" : seal[1], summary: `Damaging hits lower the target's ${STAT_ABBR[seal[1] === "movement" ? "move" : seal[1]]} by ${seal[1] === "movement" ? 3 : 6}, recovering ${seal[1] === "movement" ? 1 : 2} per turn.`};
    const range = name.match(/^(bow|firearm) range \+(\d+)$/);
    if (range) return {trigger: "Range", summary: `${range[1] === "bow" ? "Bows" : "Firearms"} gain +${range[2]} maximum range (highest version applies).`};
    return null;
}

const COMBAT_FIELDS = {hit: "hitRate", crit: "critRate", avoid: "avoid", dodge: "dodge"};
/** The rule of a skill currently in play: Revival Stone locks (Empowering Revival) remove it. */
const liveRule = item => revivalSkillOpen(item) ? skillRule(item) : null;
export function skillRule(item) {
    const automation = item?.system?.automation ?? {};
    if (automation.mode === "off") return null;
    if (automation.mode === "custom") {
        const bonuses = item.system.bonuses ?? {};
        const rule = {...automation, attributes: {...bonuses.attributes}, maximums: {...bonuses.maximums}, growthRates: {...bonuses.growthRates},
            roll: item.system.skillType === "Passive (Activated)" && item.system.activationTrigger !== "Passive" && !["Passive", "Aura", "Combat", "Opponent"].includes(automation.trigger)};
        for (const [key, value] of Object.entries(automation.attributes ?? {})) if (Number(value)) rule.attributes[key] = Number(value);
        for (const [key, field] of Object.entries(COMBAT_FIELDS)) rule[key] = Number(automation[key]) || Number(bonuses.combat?.[field]) || 0;
        if (["initiating", "retaliating"].includes(automation.phase)) rule.initiating = automation.phase === "initiating";
        if (automation.phase && !["own", "other"].includes(automation.phase)) delete rule.phase;
        const types = Array.isArray(automation.weapons) ? automation.weapons : String(automation.weapons ?? "").split(/[,;/]/);
        rule.weapons = types.map(type => String(type).trim().toLowerCase()).filter(type => type && !["any", "all"].includes(type));
        if (!rule.weapons.length) delete rule.weapons;
        return rule;
    }
    const name = skillName(item), builtIn = registeredRules.get(name) ?? SKILL_RULES[name] ?? patternRule(name);
    if (builtIn) return item.system?.activationTrigger === "Passive" && builtIn.roll ? {...builtIn, roll: false} : builtIn;
    if (item?.system?.activationTrigger === "Passive") {
        const bonuses = item.system.bonuses ?? {}, parsed = parseSignedSkillBonuses(item.system.activation ?? "");
        const constantText = !/\b(if|when|while|after|before|against|during|until|turn|phase|adjacent|enemies|allies|within)\b|[≤<>%]/i.test(item.system.activation ?? "");
        const attributes = {...bonuses.attributes}, maximums = {...bonuses.maximums}, growthRates = {...bonuses.growthRates};
        for (const [result, fields] of [[attributes, parsed.attributes], [maximums, parsed.maximums], [growthRates, parsed.growthRates]]) if (constantText) {
            for (const [key, value] of Object.entries(fields)) result[key] = (Number(result[key]) || 0) + value;
        }
        return {trigger: "Passive", attributes, maximums, growthRates,
            ...Object.fromEntries(Object.entries(COMBAT_FIELDS).map(([key, field]) => [key, (Number(bonuses.combat?.[field]) || 0) + (constantText ? parsed.combat[field] : 0)]))};
    }
    if (item?.system?.skillType === "Passive (Activated)" && ["Attack", "Defense"].includes(item.system.activationTrigger)) {
        const bonuses = item.system.bonuses?.combat ?? {};
        return {trigger: item.system.activationTrigger, roll: true, hit: Number(bonuses.hitRate || 0), crit: Number(bonuses.critRate || 0)};
    }
    return null;
}

/** Show actual rulebook conditions in the editor, and preserve them when switching to Custom. */
export function skillAutomationConfig(item) {
    const stored = item.system?.automation ?? {};
    const rule = stored.mode === "custom" || stored.mode === "off" ? stored : skillRule(item) ?? stored;
    const config = {trigger: "Passive", hp: 0, phase: "any", weapons: "", auraTarget: "enemies", auraRadius: 1,
        hit: 0, crit: 0, avoid: 0, dodge: 0, damage: 0, damageReduction: 0, defenseMultiplier: 1, damageMultiplier: 1,
        healingFraction: 0, useMultiplier: 1, strikes: 1, brave: false, ...rule};
    config.phase = typeof rule.initiating === "boolean" ? rule.initiating ? "initiating" : "retaliating" : rule.phase ?? "any";
    config.weapons = Array.isArray(rule.weapons) ? rule.weapons.join(", ") : rule.weapons ?? "";
    delete config.roll;
    delete config.initiating;
    delete config.summary;
    delete config.status;
    return config;
}

/** Conditions shared by prepared, event and rolled triggers (weapons = the weapon in `context.weapon`). */
export function skillEligible(actor, rule, {weapon, initiating = true, round = currentRound(), token} = {}) {
    if (rule.hp && !hpBelow(actor, rule.hp)) return false;
    if (typeof rule.initiating === "boolean" && rule.initiating !== initiating) return false;
    if (rule.weapons && !rule.weapons.includes(weaponKey(weapon))) return false;
    if ((rule.odd || rule.round === "odd") && round % 2 !== 1) return false;
    if (rule.round === "even" && round % 2 !== 0) return false;
    if (rule.roundMax && round > rule.roundMax) return false;
    if (rule.allies && token && !countMatches(unitsWithin(token, rule.allies.radius, {relation: "allies"}).length, rule.allies)) return false;
    return true;
}

/** Only constant, passive text can become a permanent prepared bonus. */
export function passiveTextBonuses(item) {
    if (item.system?.skillType !== "Passive" || skillRule(item)) return null;
    const text = String(item.system?.activation ?? "");
    if (/\b(if|when|while|after|before|against|during|until|turn|phase|at|within|adjacent|enemies|allies)\b|[≤<>%]/i.test(text)) return null;
    return parseSignedSkillBonuses(text);
}

/** Prepared (always-on or HP-threshold) skill bonuses, with ledger terms for stat tooltips. */
export function passiveSkillBonuses(actor) {
    const result = {attributes: {}, maximums: {}, growthRates: {}, combat: {}, terms: []};
    const weapon = equippedWeapon(actor);
    for (const item of actor?.items ?? []) {
        if (item.type !== "skill") continue;
        const rule = liveRule(item);
        if (!rule || rule.trigger !== "Passive" || !skillEligible(actor, rule, {weapon})) continue;
        for (const field of ["attributes", "maximums", "growthRates"]) for (const [key, raw] of Object.entries(rule[field] ?? {})) {
            const value = Number(raw) || 0;
            if (!value) continue;
            result[field][key] = (result[field][key] ?? 0) + value;
            result.terms.push({path: `${field}.${key}`, label: item.name, value});
        }
        for (const [field, key] of Object.entries(COMBAT_FIELDS)) {
            const value = Number(rule[field]) || 0;
            result.combat[key] = (result.combat[key] ?? 0) + value;
            if (value) result.terms.push({path: `combat.${key}`, label: item.name, value});
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// Contextual modifiers
// ---------------------------------------------------------------------------
export const MODIFIER_FIELDS = Object.freeze(["hit", "crit", "damage", "avoid", "dodge", "defense", "resistance", "damageTaken", "damageReduction", "doubleSpeed"]);
const OFFENSIVE = new Set(["hit", "crit", "damage", "doubleSpeed"]);
const FIELD_LABELS = {hit: "Hit", crit: "Crit", damage: "damage", avoid: "Avoid", dodge: "Dodge", defense: "DEF", resistance: "RES",
    damageTaken: "damage taken", damageReduction: "damage taken", doubleSpeed: "SPD for follow-ups"};
const fieldValue = (field, value) => field === "damageReduction" ? -value : value;
export const modifierText = (field, value) => `${signed(fieldValue(field, value))} ${FIELD_LABELS[field]}`;

/** Normalize a rule into a non-rolled contextual modifier, or null when it is not one. */
function contextualRule(rule) {
    if (!rule || rule.roll) return null;
    if (["Attack", "Combat"].includes(rule.trigger)) return rule;
    if (rule.trigger === "Opponent") return {...rule, weapons: undefined, vsWeapons: rule.weapons};
    if (rule.trigger === "Defense") return {...rule, weapons: undefined, vsWeapons: rule.weapons, defensiveOnly: true,
        takenMultiplier: rule.damageMultiplier, damageMultiplier: undefined, defenseMultiplier: undefined};
    return null;
}

const countMatches = (count, {min, max} = {}) => (min === undefined || count >= min) && (max === undefined || count <= max);
const alliesText = ({radius, min, max}) => max === 0 ? `with no allies within ${radius}` : `with ${min ?? 0}+ ${radius === 1 ? "adjacent allies" : `allies within ${radius}`}`;
const TERRAIN_TESTS = {
    plain: terrain => terrain.key === "plain",
    bonus: terrain => Number(terrain.avoid) > 0 || Number(terrain.defense) > 0 || Number(terrain.heal) > 0,
    avoid: terrain => Number(terrain.avoid) > 0,
    forest: terrain => ["forest", "woods"].includes(terrain.key)
};
const TERRAIN_TEXT = {plain: "on terrain without bonuses or penalties", bonus: "on terrain that grants a bonus", avoid: "on terrain that grants Avoid", forest: "on Forest or Woods"};

/** Each condition returns true/false, or null when it depends on an unknown opponent or position. */
const CONDITIONS = [
    [r => r.hp, (r, a) => hpBelow(a, r.hp), r => `at ≤${r.hp}% HP`],
    [r => r.weapons?.length, (r, a, c) => r.weapons.includes(weaponKey(c.weapon)), r => `with ${listText(r.weapons)}`],
    [r => r.vsWeapons?.length, (r, a, c) => c.foeWeapon === undefined ? null : !!c.foeWeapon && r.vsWeapons.includes(weaponKey(c.foeWeapon)), r => `vs ${listText(r.vsWeapons)} users`],
    [r => r.vsUnitTypes?.length, (r, a, c) => c.foe === undefined ? null : !!c.foe && hasUnitType(c.foe, r.vsUnitTypes), r => `vs ${r.vsUnitTypes.join("/")} units`],
    [r => typeof r.initiating === "boolean", (r, a, c) => typeof c.initiating === "boolean" ? c.initiating === r.initiating : null, r => r.initiating ? "when initiating combat" : "when an enemy initiates"],
    [r => r.incoming, (r, a, c) => c.incomingWeapon === undefined ? null : !!c.incomingWeapon && (r.incoming === "magic") === isMagicWeapon(c.incomingWeapon), r => `vs ${r.incoming} attacks`],
    [r => r.round, (r, a, c) => (c.round % 2 === 1) === (r.round === "odd"), r => `on ${r.round}-numbered turns`],
    [r => r.roundMax, (r, a, c) => c.round <= r.roundMax, r => `during turns 1–${r.roundMax}`],
    [r => r.phase, (r, a, c) => c.phase ? c.phase === r.phase : typeof c.initiating === "boolean" ? c.initiating === (r.phase === "own") : null, r => r.phase === "own" ? "during your own phase" : "during an enemy phase"],
    [r => r.terrain, (r, a, c) => c.terrain ? TERRAIN_TESTS[r.terrain]?.(c.terrain) ?? false : null, r => TERRAIN_TEXT[r.terrain] ?? `on ${r.terrain}`],
    [r => r.outdoor, (r, a, c) => c.environment ? c.environment === "outdoor" : null, () => "on outdoor maps"],
    [r => r.allies, (r, a, c) => c.token ? countMatches(unitsWithin(c.token, r.allies.radius, {relation: "allies", tokens: c.tokens}).length, r.allies) : null, r => alliesText(r.allies)],
    [r => r.waited, (r, a, c) => c.token ? !!unitCombatantOf(c.token)?.flags?.[SYSTEM_ID]?.waitBonus : null, () => "after Waiting without acting"],
    [r => r.foeCannotCounter, (r, a, c) => c.initiating === true ? false : typeof c.canCounter === "boolean" ? !c.canCounter : null, () => "when attacked by a foe you cannot counter"]
];
function conditionStatus(rule, actor, context) {
    let state = true;
    const texts = [];
    for (const [applies, test, describe] of CONDITIONS) {
        if (!applies(rule)) continue;
        texts.push(describe(rule));
        const result = test(rule, actor, context);
        if (result === false) state = false;
        else if (result === null && state) state = null;
    }
    return {state, text: texts.join(", ")};
}
export function describeConditions(rule) { return conditionStatus(rule, null, {round: 1}).text; }

/** Movement since the start of this unit's phase (Momentum). */
export function movedSquares(token) {
    const doc = tokenDocument(token), history = unitCombatantOf(doc)?.token?.movementHistory ?? [];
    return history.length > 1 ? Math.max(0, (doc.getCompleteMovementPath?.(history) ?? history).length - 1) : 0;
}
export function vendettaCount(token, foeToken) {
    const foe = tokenDocument(foeToken);
    return Number(unitCombatantOf(token)?.flags?.[SYSTEM_ID]?.vendetta?.[foe?.id] ?? 0) || 0;
}
const adjacentAllies = (c, filter = () => true) => c.token ? unitsWithin(c.token, 1, {relation: "allies", tokens: c.tokens}).filter(filter) : null;
const DYNAMIC = {
    biorhythm: (a, c) => c.round % 2 ? {values: {damage: 2}, text: `turn ${c.round} (odd): +2 damage; even turns: +5 Hit`} : {values: {hit: 5}, text: `turn ${c.round} (even): +5 Hit; odd turns: +2 damage`},
    quickburn: (a, c) => {
        const value = Math.max(0, 10 - 2 * (c.round - 1));
        return {values: {hit: value, avoid: value}, text: `turn ${c.round}: decreases by 2 each turn`};
    },
    momentum: (a, c) => ({values: {damage: c.moved ?? 0}, state: c.moved === undefined ? null : true, text: `${c.moved ?? 0} square(s) moved this turn`}),
    spellHarmony: (a, c) => {
        const allies = adjacentAllies(c, t => TOME_TYPES.includes(weaponKey(equippedWeapon(t.actor))));
        return allies ? {values: {hit: 5 * allies.length, crit: 5 * allies.length}, state: true, text: `${allies.length} adjacent ally/allies with a Tome`} : {values: {hit: 5, crit: 5}, state: null, text: "per adjacent ally with a Tome"};
    },
    squadTactics: (a, c) => {
        const allies = adjacentAllies(c);
        return allies ? {values: {doubleSpeed: 2 * allies.length}, state: true, text: `${allies.length} adjacent ally/allies`} : {values: {doubleSpeed: 2}, state: null, text: "per adjacent ally"};
    },
    vendetta: (a, c) => {
        if (c.foe === undefined || !c.foeToken) return {values: {damage: 2}, state: null, text: "+2 per engagement with the same foe this map (max +10)"};
        const count = vendettaCount(c.token, c.foeToken);
        return {values: {damage: Math.min(10, 2 * (count + 1))}, state: true, text: `engagement ${count + 1} with this foe`};
    },
    bigGame: (a, c) => {
        if (c.foe === undefined) return {values: {hit: 10, crit: 10}, state: null, text: "when attacking a foe with 4+ more BLD (doubled vs Beasts)"};
        const ok = !!c.foe && stat(c.foe, "build") >= stat(a, "build") + 4;
        const scale = ok && hasUnitType(c.foe, ["Beast"]) ? 2 : 1;
        return {values: {hit: 10 * scale, crit: 10 * scale}, state: ok, text: `foe BLD ${stat(c.foe, "build")} vs ${stat(a, "build")}${scale > 1 ? ", Beast ×2" : ""}`};
    },
    duelist: (a, c) => {
        const values = {hit: 30, crit: 30, avoid: 30}, text = "adjacent to exactly one foe, with no allies adjacent to it";
        if (!c.token) return {values, state: null, text};
        const foes = unitsWithin(c.token, 1, {relation: "enemies", tokens: c.tokens});
        const ok = foes.length === 1 && !unitsWithin(foes[0], 1, {relation: "enemies", tokens: c.tokens}).some(t => t.id !== c.token.id);
        return {values, state: ok, text};
    }
};

function blankModifiers() {
    return {totals: Object.fromEntries(MODIFIER_FIELDS.map(field => [field, 0])), terms: Object.fromEntries(MODIFIER_FIELDS.map(field => [field, []])),
        situational: Object.fromEntries(MODIFIER_FIELDS.map(field => [field, []])), defenseMultiplier: 1, damageMultiplier: 1, takenMultiplier: 1,
        useMultiplier: 1, healingFraction: 0, strikes: 1, brave: false, notes: [], multiplierTerms: []};
}

function resolveContext(actor, context = {}) {
    const token = tokenDocument(context.token) ?? null;
    const foe = context.foe;
    return {...context, token,
        weapon: context.weapon !== undefined ? context.weapon : equippedWeapon(actor),
        foeToken: tokenDocument(context.foeToken) ?? null,
        foeWeapon: context.foeWeapon !== undefined ? context.foeWeapon : foe === undefined ? undefined : equippedWeapon(foe),
        round: context.round ?? currentRound(),
        phase: context.phase !== undefined ? context.phase : token ? currentPhase(token) : null,
        moved: context.moved !== undefined ? context.moved : token ? movedSquares(token) : undefined,
        terrain: context.terrain ?? (token ? terrainOf(token) : null),
        environment: token ? sceneEnvironment(token) : null};
}

function applyRule(out, label, rule, actor, context, {display = false} = {}) {
    let {state, text} = conditionStatus(rule, actor, context);
    let values = Object.fromEntries(MODIFIER_FIELDS.map(field => [field, Number(rule[field]) || 0]));
    if (rule.dynamic && DYNAMIC[rule.dynamic]) {
        const result = DYNAMIC[rule.dynamic](actor, context, rule);
        values = {...Object.fromEntries(MODIFIER_FIELDS.map(field => [field, 0])), ...result.values};
        if (state !== false && result.state !== undefined) state = result.state === false ? false : state === null || result.state === null ? null : true;
        text = [text, result.text].filter(Boolean).join(", ");
    }
    if (rule.defensiveOnly) for (const field of OFFENSIVE) values[field] = 0;
    if (state === false && !display) return;
    for (const field of MODIFIER_FIELDS) {
        const value = values[field];
        if (!value) continue;
        if (state === true) {
            out.totals[field] += value;
            out.terms[field].push(term(label, fieldValue(field, value), "add", {text}));
        } else out.situational[field].push({label: `${label}: ${modifierText(field, value)}`, text, active: false});
    }
    if (state !== true) {
        for (const [key, word, field] of [["defenseMultiplier", "enemy DEF/RES", "damage"], ["damageMultiplier", "damage dealt", "damage"], ["takenMultiplier", "damage taken", "damageTaken"]]) {
            const mult = Number(rule[key]);
            if (Number.isFinite(mult) && mult !== 1) out.situational[field].push({label: `${label}: ${word} ×${mult}`, text, active: false});
        }
        if (rule.brave) out.situational.hit.push({label: `${label}: Brave`, text, active: false});
        return;
    }
    for (const key of ["defenseMultiplier", "damageMultiplier", "takenMultiplier", "useMultiplier"]) {
        const mult = Number(rule[key]);
        if (rule[key] !== undefined && Number.isFinite(mult) && mult !== 1) { out[key] *= mult; out.multiplierTerms.push({key, label, value: mult}); }
    }
    out.healingFraction = Math.max(out.healingFraction, Number(rule.healingFraction) || 0);
    out.strikes = Math.max(out.strikes, Math.min(10, Number(rule.strikes) || 1));
    out.brave ||= !!rule.brave;
    if (MODIFIER_FIELDS.some(field => values[field]) || rule.brave || out.multiplierTerms.some(m => m.label === label)) out.notes.push(label);
}

function collectAuras(out, actor, context, {display = false} = {}) {
    const doc = context.token;
    if (!doc) return;
    const seen = new Set();
    for (const origin of sceneTokens(doc, context.tokens)) {
        const owner = origin?.actor;
        if (!owner || !activeSkillUnit(origin)) continue;
        const self = origin.id === doc.id;
        for (const item of owner.items ?? []) {
            const rule = item.type === "skill" ? liveRule(item) : null;
            if (rule?.trigger !== "Aura") continue;
            const target = rule.auraTarget ?? "enemies";
            if (self ? target !== "team" : skillTokenDistance(origin, doc) > Math.max(0, Number(rule.auraRadius ?? 1))) continue;
            if (!self && target !== "all" && alliedTokens(origin, doc) !== (["allies", "team"].includes(target))) continue;
            if (rule.hp && !hpBelow(owner, rule.hp)) continue;
            if (rule.receiverTypes?.length && !hasUnitType(actor, rule.receiverTypes)) continue;
            if (rule.receiverSex && !String(actor.system?.personalDetails?.sex ?? "").toLowerCase().startsWith(rule.receiverSex[0])) continue;
            const key = skillName(item);
            if (seen.has(key)) continue;
            seen.add(key);
            applyRule(out, self ? item.name : `${item.name} (${origin.name})`, {...rule, hp: 0, trigger: "Combat"}, actor, context, {display});
        }
    }
}

/**
 * Non-rolled skill effects on `actor` in a combat context. Offensive totals (hit, crit, damage, doubleSpeed) apply to
 * the actor's strikes; defensive totals (avoid, dodge, defense, resistance, damageTaken, damageReduction) when struck.
 * context: {token, weapon, foe, foeToken, foeWeapon, incomingWeapon, initiating, canCounter, round, phase, moved, tokens}
 * A missing `foe` (undefined) means "unknown": matchup-dependent effects are reported as situational.
 */
export function skillModifiers(actor, context = {}, {auras = true, display = false, own = true} = {}) {
    const out = blankModifiers();
    if (!actor) return out;
    const c = resolveContext(actor, context);
    if (own) for (const item of actor.items ?? []) {
        if (item.type !== "skill") continue;
        const rule = contextualRule(liveRule(item));
        if (rule) applyRule(out, item.name, rule, actor, c, {display});
    }
    if (auras) collectAuras(out, actor, c, {display});
    return out;
}

/** Legacy summary used by older callers: own-strike and defensive totals without auras. */
export function contextualSkills(actor, weapon, target, {initiating = true, round, moved, incomingWeapon, token, targetToken, tokens} = {}) {
    const result = skillModifiers(actor, {weapon, foe: target ?? null, foeToken: targetToken, incomingWeapon, foeWeapon: incomingWeapon ?? equippedWeapon(target), initiating, round, moved, token, tokens}, {auras: false});
    return {...Object.fromEntries(MODIFIER_FIELDS.map(field => [field, result.totals[field]])), brave: result.brave, notes: result.notes};
}

/** Auras affect the actual scene tokens at roll time; they never mutate prepared actor bonuses. */
export function auraCombatBonuses(actor, token, {tokens, weapon, initiating = true, foe, incomingWeapon} = {}) {
    const out = blankModifiers();
    if (actor && tokenDocument(token)) collectAuras(out, actor, resolveContext(actor, {token, tokens, weapon, initiating, foe, incomingWeapon}));
    return {hit: out.totals.hit, crit: out.totals.crit, avoid: out.totals.avoid, dodge: out.totals.dodge, damage: out.totals.damage, damageReduction: out.totals.damageReduction};
}

/** Display modifiers for the sheet and action bars: active effects plus conditional ones that are not active now. */
export function displaySkillModifiers(actor, token = null) {
    const out = skillModifiers(actor, {token, foe: undefined, initiating: undefined}, {display: true});
    const weapon = equippedWeapon(actor);
    for (const item of actor?.items ?? []) {
        if (item.type !== "skill") continue;
        const rule = liveRule(item);
        if (rule?.trigger !== "Passive" || !rule.hp || skillEligible(actor, rule, {weapon})) continue;
        for (const [field, value] of Object.entries({hit: rule.hit, crit: rule.crit, avoid: rule.avoid, dodge: rule.dodge})) if (Number(value)) out.situational[field].push({label: `${item.name}: ${modifierText(field, value)}`, text: `at ≤${rule.hp}% HP`, active: false});
        for (const [key, value] of Object.entries(rule.attributes ?? {})) if (Number(value)) (out.situational[key] ??= []).push({label: `${item.name}: ${signed(value)} ${STAT_ABBR[key] ?? key}`, text: `at ≤${rule.hp}% HP`, active: false});
    }
    return out;
}

// ---------------------------------------------------------------------------
// Rolled and event triggers
// ---------------------------------------------------------------------------
const GRANTS = {rulership: ["Miracle", "Aegis", "Pavise"]};

/** Skill entries an actor can trigger: its own, Rulership grants from allies, and Rightful Ruler borrowings. */
export function triggerEntries(actor, {token} = {}) {
    const entries = Array.from(actor?.items ?? []).filter(item => item.type === "skill" && revivalSkillOpen(item)).map(item => ({item, rule: skillRule(item), name: item.name, tnBonus: 0}));
    const doc = tokenDocument(token);
    if (!doc) return entries;
    const owned = new Set(entries.map(entry => skillName(entry.item)));
    for (const ally of unitsWithin(doc, Infinity, {relation: "allies"})) {
        for (const [grant, skills] of Object.entries(GRANTS)) if (hasSkill(ally.actor, grant)) for (const granted of skills) {
            const key = canonicalSkillName(granted);
            if (owned.has(key)) continue;
            owned.add(key);
            const item = {name: granted, type: "skill", system: {skillType: "Passive (Activated)", activationTrigger: "Manual", automation: {mode: "auto"}}};
            entries.push({item, rule: skillRule(item), name: `${granted} (${findSkill(ally.actor, grant)?.name ?? "Rulership"})`, tnBonus: 0});
        }
    }
    if (hasSkill(actor, "rightful ruler")) for (const ally of unitsWithin(doc, 1, {relation: "allies"})) for (const item of ally.actor?.items ?? []) {
        if (item.type !== "skill" || item.system?.skillType !== "Passive (Activated)" || owned.has(skillName(item)) || !revivalSkillOpen(item)) continue;
        owned.add(skillName(item));
        entries.push({item, rule: skillRule(item), name: `${item.name} (Rightful Ruler)`, tnBonus: 10, lender: ally.actor});
    }
    return entries;
}

/** The activation TN a rolled rule uses. Rulebook-only TNs (level difference) cannot be configured on the item. */
export function skillActivationTarget(actor, item, rule, context = {}, tnBonus = 0) {
    const custom = item.system?.automation?.mode === "custom";
    let target;
    if (!custom && rule.dynamic === "levelDifference") target = computeSkillActivationTarget({type: "fixed", fixed: Number(actor.system.totalLevel || 1) - Number(context.target?.system?.totalLevel || 1)});
    else if (custom || item.system?.activationTrigger && item.system.activationTrigger !== "Manual") {
        target = computeSkillActivationTarget({type: item.system.activationTargetType, statValue: stat(actor, item.system.activationStat || "skill"), multiplier: item.system.activationMult, fixed: item.system.activationFixed});
    } else if (rule.fixed !== undefined) target = computeSkillActivationTarget({type: "fixed", fixed: rule.fixed});
    else target = computeSkillActivationTarget({type: "stat_mult", statValue: stat(actor, rule.stat || "skill"), multiplier: rule.mult ?? 1});
    return Math.min(100, target + tnBonus);
}

const ROLLED_TRIGGERS = new Set(["Attack", "Defense", "CombatStart", "Critical", "Lethal"]);
/** Returns mechanical effects; activation messages are produced by the sheet callback. */
export async function triggerSkills(actor, trigger, context = {}, rollActivation) {
    const result = {hit: 0, crit: 0, damage: 0, damageReduction: 0, defenseMultiplier: 1, damageMultiplier: 1, healingFraction: 0, useMultiplier: 1,
        strikes: 1, brave: false, lethal: false, noCounter: false, inflict: [], gold: 0, halveResistance: false, seals: [], notes: []};
    for (const {item, rule, name, tnBonus} of triggerEntries(actor, context)) {
        if (!rule || rule.trigger !== trigger || !skillEligible(actor, rule, context)) continue;
        if (ROLLED_TRIGGERS.has(trigger) && !rule.roll) continue;
        if (rule.roll) {
            const target = skillActivationTarget(actor, item, rule, context, tnBonus);
            if (!(await rollActivation(item, target)).success) continue;
        }
        for (const key of ["hit", "crit", "damage", "damageReduction", "gold"]) result[key] += Number(rule[key]) || 0;
        if (rule.dynamic === "vengeance") result.damage += Math.floor(Math.max(0, Number(actor.system.attributes.hp.max) - stat(actor, "hp")) / 2);
        if (rule.dynamic === "ignis") result.damage += Math.floor(stat(actor, isMagicWeapon(context.weapon) ? "strength" : "magic") / 2);
        for (const key of ["defenseMultiplier", "damageMultiplier", "useMultiplier"]) result[key] *= Number.isFinite(Number(rule[key])) ? Number(rule[key]) : 1;
        result.healingFraction = Math.max(result.healingFraction, Number(rule.healingFraction) || 0);
        result.strikes = Math.max(result.strikes, Math.min(10, Number(rule.strikes) || 1));
        result.brave ||= !!rule.brave; result.lethal ||= !!rule.lethal; result.noCounter ||= !!rule.noCounter; result.halveResistance ||= !!rule.halveResistance; result.absorb ||= !!rule.absorb;
        if (rule.inflict) result.inflict.push(rule.inflict);
        if (rule.seal) result.seals.push({key: rule.seal, name: item.name});
        result.notes.push(name);
    }
    return result;
}

// ---------------------------------------------------------------------------
// Descriptions for sheets
// ---------------------------------------------------------------------------
const MULT_TEXT = value => ({0: "0", 0.5: "½", 0.25: "¼", 0.75: "¾", 1.5: "1½", 2: "2"})[value] ?? String(value);
function effectSummary(rule) {
    const parts = [];
    for (const [key, value] of Object.entries(rule.attributes ?? {})) if (Number(value)) parts.push(`${signed(value)} ${STAT_ABBR[key] ?? key}`);
    for (const field of MODIFIER_FIELDS) if (Number(rule[field])) parts.push(modifierText(field, Number(rule[field])));
    if (rule.defenseMultiplier !== undefined && rule.defenseMultiplier !== 1) parts.push(rule.defenseMultiplier ? `enemy DEF/RES ×${MULT_TEXT(rule.defenseMultiplier)}` : "ignores enemy DEF/RES");
    if (rule.damageMultiplier !== undefined && rule.damageMultiplier !== 1) parts.push(rule.trigger === "Defense" ? rule.damageMultiplier ? `damage taken ×${MULT_TEXT(rule.damageMultiplier)}` : "negates the damage" : `damage ×${MULT_TEXT(rule.damageMultiplier)}`);
    if (rule.strikes > 1) parts.push(`${rule.strikes} strikes`);
    if (rule.healingFraction) parts.push(`heals ${MULT_TEXT(rule.healingFraction)} of damage dealt`);
    if (rule.useMultiplier !== undefined && rule.useMultiplier !== 1) parts.push(`weapon uses ×${MULT_TEXT(rule.useMultiplier)}`);
    if (rule.brave) parts.push("Brave");
    if (rule.noCounter) parts.push("target cannot counter");
    if (rule.lethal) parts.push("instant kill");
    if (rule.trigger === "Lethal") parts.push("survive with 1 HP");
    if (rule.healMaxFraction) parts.push(`heal ${Math.round(rule.healMaxFraction * 100)}% max HP`);
    if (rule.chipFraction) parts.push(`target loses ${Math.round(rule.chipFraction * 100)}% max HP (min 1 HP)`);
    if (rule.adjacentFraction) parts.push(`adjacent enemies lose ${Math.round(rule.adjacentFraction * 100)}% max HP`);
    if (rule.refresh) parts.push("act again (once per turn)");
    if (rule.gold) parts.push(`+${rule.gold} gold`);
    if (rule.inflict) parts.push("random status (Berserk/Silence/Paralysis/Confusion)");
    if (rule.halveResistance) parts.push("halves target RES for 1 turn");
    if (rule.dynamic === "ignis") parts.push("+½ MAG (STR attacks) or +½ STR (MAG attacks)");
    if (rule.dynamic === "vengeance") parts.push("+½ missing HP damage");
    return parts.join(", ");
}
function tnText(rule, item) {
    if (!rule.roll) return "";
    if (item?.system?.automation?.mode !== "custom" && rule.dynamic === "levelDifference") return "roll TL difference";
    if (item?.system?.activationTrigger && item.system.activationTrigger !== "Manual" || item?.system?.automation?.mode === "custom") {
        const s = item.system, key = STAT_ABBR[s.activationStat] ?? "SKL";
        return s.activationTargetType === "fixed" ? `roll ${s.activationFixed}%` : s.activationTargetType === "stat" ? `roll ${key}` : `roll ${key}×${s.activationMult ?? 1}`;
    }
    if (rule.fixed !== undefined) return `roll ${rule.fixed}%`;
    return `roll ${STAT_ABBR[rule.stat ?? "skill"]}${rule.mult && rule.mult !== 1 ? `×${MULT_TEXT(rule.mult)}` : ""}`;
}
const TRIGGER_TEXT = {Passive: "Always", Attack: "In combat", Combat: "In combat", Opponent: "In combat", Defense: "When hit", Aura: "Aura",
    CombatStart: "When combat starts", Critical: "On a critical hit", Lethal: "When an attack would kill", Hit: "After a damaging hit",
    Kill: "After a kill", CombatEnd: "After combat", PhaseStart: "At phase start"};

/** {status: "auto" | "partial" | "manual" | "none", summary} for item and actor sheets. */
export function skillAutomationInfo(item, activeRule = null) {
    if (item?.system?.automation?.mode === "off") return {status: "off", summary: "Automation disabled for this skill."};
    if (activeRule) return {status: activeRule.status ?? "auto", summary: activeRule.summary ?? "Use from the Skills bar or sheet; effects apply automatically."};
    const rule = skillRule(item);
    if (!rule) return {status: "none", summary: "No built-in automation. Configure Custom effects, register a rule, or resolve it manually."};
    if (rule.summary) return {status: rule.status ?? "auto", summary: rule.summary};
    const conditions = describeConditions({...rule, weapons: rule.trigger === "Defense" || rule.trigger === "Opponent" ? undefined : rule.weapons,
        vsWeapons: ["Defense", "Opponent"].includes(rule.trigger) ? rule.weapons : rule.vsWeapons});
    const aura = rule.trigger === "Aura" ? `${{enemies: "Enemies", allies: "Allies", all: "Units", team: "This unit and allies"}[rule.auraTarget ?? "enemies"]} within ${rule.auraRadius ?? 1}` : "";
    const lead = [aura || TRIGGER_TEXT[rule.trigger] || rule.trigger, tnText(rule, item)].filter(Boolean).join(", ");
    const dynamic = rule.dynamic && DYNAMIC[rule.dynamic] ? DYNAMIC[rule.dynamic]({system: {attributes: {}}}, {round: 1}, rule).text : "";
    return {status: rule.status ?? "auto", summary: `${lead}${conditions ? ` (${conditions})` : ""}: ${effectSummary(rule) || dynamic || "see description"}.`};
}
