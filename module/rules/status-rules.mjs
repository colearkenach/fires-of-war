import {hasSkill} from "../skills/skill-names.mjs";

/** Rulebook status effects (Status Effects, p. 16–18). Durations are the defaults when a source names none. */
const ZERO = Object.freeze(["avoid", "dodge", "attackSpeed"]);
export const STATUS_RULES = Object.freeze({
    berserk: {duration: 3, summary: "Attacks the weakest unit in range at the end of its phase (GM controlled)."},
    silence: {duration: 1, silenced: true, summary: "Cannot use tomes, staves or spells."},
    sleep: {duration: 3, incapacitated: true, zero: ZERO, move: "zero", wakeOnDamage: true, summary: "Cannot act, move or counter; Avoid, Dodge and AS are 0. Damage wakes the unit."},
    poison: {duration: 5, damage: "poison", summary: "Takes 1d10÷2 (min 1) damage at the start of its phase."},
    petrification: {duration: 10, incapacitated: true, zero: ZERO, attributes: {defense: 10}, critTaken: 30, move: "zero", summary: "Cannot act, move or counter; Avoid, Dodge and AS are 0; +10 DEF; attackers gain +30 Crit."},
    paralysis: {duration: 1, incapacitated: true, move: "zero", summary: "Cannot act, move or counter."},
    shock: {duration: 1, move: "zero", summary: "Move is 0; can still act and counter."},
    rattled: {duration: 1, move: "zero", combat: {hitRate: -10, critRate: -10, avoid: -10, attackSpeed: -10}, summary: "Move 0; −10 Hit, Crit, Avoid and AS."},
    confusion: {duration: 1, noCounter: true, endsWhenAttacked: true, expiresAtPhaseStart: true, summary: "Cannot counterattack until attacked or until its next phase."},
    "blood sacrifice": {duration: -1, damage: "1d10", summary: "Takes 1d10 damage at the start of its phase."},
    burning: {duration: 3, combat: {avoid: -10, dodge: -10}, damage: 3, summary: "−10 Avoid and Dodge; takes 3 damage at the start of its phase."},
    buffeted: {duration: 1, move: "half", combat: {avoid: -10}, summary: "Move halved; −10 Avoid."},
    frozen: {duration: 3, incapacitated: true, move: "zero", summary: "Cannot act, move or counter."},
    "guard break": {duration: 1, noCounter: true, attributes: {defense: -5, resistance: -5}, endsWhenAttacked: true, expiresAtPhaseStart: true, summary: "Cannot counterattack; −5 DEF and RES until attacked or until its next phase."},
    "knocked out": {duration: -1, incapacitated: true, zero: ZERO, move: "zero", summary: "At 0 HP but alive; functions as Sleep."}
});
export const RANDOM_STATUSES = Object.freeze(["Berserk", "Silence", "Paralysis", "Confusion"]);
export const statusKey = effect => String(effect?.name ?? effect ?? "").trim().toLowerCase();
export const statusRule = effect => STATUS_RULES[statusKey(effect)] ?? null;

/** Token status icons: one per rulebook condition, plus Foundry's own Dead. */
export const DEAD_STATUS = "dead";
export const CONDITION_ICONS = Object.freeze({
    berserk: "icons/svg/terror.svg", silence: "icons/svg/silenced.svg", sleep: "icons/svg/sleep.svg", poison: "icons/svg/poison.svg",
    petrification: "icons/svg/stoned.svg", paralysis: "icons/svg/paralysis.svg", shock: "icons/svg/lightning.svg", rattled: "icons/svg/downgrade.svg",
    confusion: "icons/svg/daze.svg", "blood sacrifice": "icons/svg/blood.svg", burning: "icons/svg/fire.svg", buffeted: "icons/svg/falling.svg",
    frozen: "icons/svg/frozen.svg", "guard break": "icons/svg/shield.svg", "knocked out": "icons/svg/unconscious.svg"
});
/** "guard break" → "Guard Break" (sheet name) and "guardBreak" (token status id). */
export const conditionName = key => statusKey(key).replace(/(^|\s)\S/g, c => c.toUpperCase());
export const conditionStatusId = effect => statusKey(effect).replace(/\s+(\S)/g, (_, c) => c.toUpperCase());
export const conditionForStatus = id => Object.keys(STATUS_RULES).find(key => conditionStatusId(key) === id) ?? null;
/** CONFIG.statusEffects entries for the rulebook conditions, in rulebook order. */
export const conditionStatusEffects = () => Object.entries(STATUS_RULES).map(([key, rule]) =>
    ({id: conditionStatusId(key), name: conditionName(key), img: CONDITION_ICONS[key], description: rule.summary}));
const live = effect => effect && typeof effect === "object" ? effect.duration === undefined || effect.duration === -1 || Number(effect.duration) > 0 : !!effect;

export function activeStatuses(actor) {
    return (actor?.system?.statusEffects ?? []).filter(live).map(effect => ({effect, name: String(effect?.name ?? effect), rule: statusRule(effect)}));
}
export const hasStatus = (actor, name) => activeStatuses(actor).some(s => statusKey(s.effect) === name.toLowerCase());
/** Token status ids of the rulebook conditions the unit currently has. */
export const activeConditionIds = actor => new Set(activeStatuses(actor).filter(s => s.rule).map(s => conditionStatusId(s.effect)));
export const isIncapacitated = actor => activeStatuses(actor).some(s => s.rule?.incapacitated);
export const cannotCounter = actor => activeStatuses(actor).some(s => s.rule?.incapacitated || s.rule?.noCounter);
export const isSilenced = actor => activeStatuses(actor).some(s => s.rule?.silenced);
export function incapacitatingStatus(actor) {
    return activeStatuses(actor).find(s => s.rule?.incapacitated)?.name ?? "";
}

/** Divine Aura and Undeath block every status; Silence Ward blocks Silence. */
export function statusImmune(actor, name) {
    const key = statusKey(name);
    if (!STATUS_RULES[key]) return false;
    return hasSkill(actor, "divine aura") || hasSkill(actor, "undeath") || key === "silence" && hasSkill(actor, "silence ward");
}

/** Goddess ignores stat penalties; Headlong Rush and Ultra Heavyweight ignore Move reductions. */
export function ignoresStatPenalties(actor) { return hasSkill(actor, "goddess"); }
export function ignoresMoveReduction(actor) { return hasSkill(actor, "headlong rush") || hasSkill(actor, "ultra heavyweight"); }

/** Stat effects of rulebook statuses for actor preparation, with tooltip terms. */
export function statusStatModifiers(actor) {
    const result = {attributes: {}, combat: {}, zero: new Set(), move: null, critTaken: 0, terms: []};
    const freeStats = ignoresStatPenalties(actor), freeMove = ignoresMoveReduction(actor);
    for (const {name, rule} of activeStatuses(actor)) {
        if (!rule) continue;
        for (const [key, value] of Object.entries(rule.attributes ?? {})) {
            if (value < 0 && freeStats) continue;
            result.attributes[key] = (result.attributes[key] ?? 0) + value;
            result.terms.push({path: `attributes.${key}`, label: name, value});
        }
        for (const [key, value] of Object.entries(rule.combat ?? {})) {
            result.combat[key] = (result.combat[key] ?? 0) + value;
            result.terms.push({path: `combat.${key}`, label: name, value});
        }
        for (const key of rule.zero ?? []) result.zero.add(key);
        if (rule.move && !freeMove) result.move = rule.move === "zero" || result.move === "zero" ? "zero" : "half";
        result.critTaken += Number(rule.critTaken) || 0;
    }
    return result;
}
