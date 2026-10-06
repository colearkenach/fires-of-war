import {term, sumTerms, breakdownHtml, signed} from "./stat-breakdown.mjs";
import {displaySkillModifiers, hasSkill, modifierText} from "../skills/skill-automation.mjs";
import {tokenTerrain, terrainMovement, terrainTraits, terrainCombatStats} from "../map/terrain.mjs";
import {timedEffectTerms} from "../combat/combat-effects.mjs";

const STAT_LABELS = {hp: "Max HP", strength: "STR", magic: "MAG", skill: "SKL", speed: "SPD", defense: "DEF", resistance: "RES", luck: "LUK", charm: "CHA", build: "BLD"};
export const COMBAT_STATS = Object.freeze([
    {key: "damage", label: "Damage", field: "damage", suffix: ""},
    {key: "attackSpeed", label: "Attack Speed", field: null, suffix: ""},
    {key: "hitRate", label: "Hit Rate", field: "hit", suffix: "%"},
    {key: "critRate", label: "Crit Rate", field: "crit", suffix: "%"},
    {key: "avoid", label: "Avoid", field: "avoid", suffix: "%"},
    {key: "dodge", label: "Dodge", field: "dodge", suffix: "%"},
    {key: "aid", label: "Aid", field: null, suffix: ""}
]);
const docOf = token => token?.document ?? token;
const derived = terms => terms.some(t => t.kind === "set") ? terms.filter(t => t.kind === "set").at(-1).value : sumTerms(terms);
const prepared = (actor, path, label, value) => {
    const terms = actor?.system?.breakdown?.[path];
    return terms?.length ? [...terms] : [term(label, value, "base")];
};

/** Replace the prepared terrain term with the terrain under this token (linked actors can have several copies). */
function rebaseTerrain(actor, terms, token, field) {
    const doc = docOf(token);
    if (!doc?.parent) return terms;
    // Without a prepared ledger the single base term already includes terrain; rebase its total instead.
    if (!terms.some(t => t.kind !== "base") && terms.length === 1 && !actor?.system?.breakdown) return [term(terms[0].label, terrainCombatStats(actor, doc)[field], "base")];
    const terrain = tokenTerrain(doc);
    const value = field === "avoid" ? (actor.system.combat?.zeroed?.includes("avoid") ? 0 : Number(terrain.avoid) || 0) : Number(terrain.defense) || 0;
    return [...terms.filter(t => t.key !== "terrain"), ...(value ? [term(`Terrain (${terrain.name})`, value, "add", {key: "terrain"})] : [])];
}

/**
 * Equipment combat stats as currently displayed: prepared values plus skill effects active right now
 * (equipped-weapon bonuses, HP thresholds, turn, phase, terrain, nearby units). Opponent-dependent effects
 * are listed as situational and not added.
 */
export function combatStatDisplay(actor, token = null) {
    const mods = displaySkillModifiers(actor, token);
    const zeroed = new Set(actor?.system?.combat?.zeroed ?? []);
    const result = {};
    for (const {key, label, field, suffix} of COMBAT_STATS) {
        let terms = prepared(actor, `combat.${key}`, label, Number(actor?.system?.combat?.[key] ?? 0));
        if (key === "avoid") terms = rebaseTerrain(actor, terms, token, "avoid");
        if (field && !zeroed.has(key)) terms.push(...mods.terms[field]);
        if (key === "damage") terms.push(...timedEffectTerms(actor).filter(t => t.path === "effects.damage").map(t => term(t.label, t.value)));
        let value = derived(terms);
        const mult = terms.filter(t => t.kind === "mult").reduce((product, t) => product * t.value, 1);
        if (mult !== 1) value = Math.floor(value * mult);
        const situational = [...(field ? mods.situational[field] : [])];
        const notes = [];
        if (key === "attackSpeed") {
            for (const t of mods.terms.doubleSpeed) situational.push({label: `${t.label}: ${signed(t.value)} SPD for follow-ups`, text: t.text, active: true});
            situational.push(...mods.situational.doubleSpeed);
            notes.push("Strike twice with 5 or more AS than the opponent.");
        }
        if (key === "hitRate") notes.push("Before the target's Avoid.");
        if (key === "critRate") notes.push("Before the target's Dodge.");
        if (key === "damage" && actor?.items?.find?.(i => i.type === "weapon" && i.system?.equipped)) notes.push("Before the target's DEF/RES.");
        result[key] = {key, label, value, suffix, terms, situational, html: breakdownHtml({title: label, total: value, suffix, terms, situational, notes})};
    }
    return result;
}

/** Ability scores, maximums, growth rates, HP and Move for the Personal Data page. */
export function attributeDisplay(actor, token = null) {
    const mods = displaySkillModifiers(actor, token);
    const result = {};
    for (const [key, label] of Object.entries(STAT_LABELS)) {
        const attribute = actor?.system?.attributes?.[key] ?? {value: 0, max: 0};
        const value = key === "hp" ? Number(attribute.max || 0) : Number(attribute.value || 0);
        let terms = prepared(actor, `attributes.${key}`, label, value);
        if (key === "defense") terms = rebaseTerrain(actor, terms, token, "defense");
        const situational = [];
        for (const t of mods.terms[key] ?? []) situational.push({label: `${t.label}: ${signed(t.value)} ${label} in combat`, text: t.text, active: true});
        situational.push(...(mods.situational[key] ?? []));
        if (["defense", "resistance"].includes(key)) {
            for (const field of ["damageTaken", "damageReduction"]) {
                for (const t of mods.terms[field]) situational.push({label: `${t.label}: ${signed(t.value)} damage taken`, text: t.text, active: true});
                situational.push(...mods.situational[field]);
            }
            for (const t of timedEffectTerms(actor).filter(t => t.path === "effects.damageReduction")) situational.push({label: `${t.label}: ${signed(-t.value)} damage taken`, active: true});
        }
        const maxTerms = actor?.system?.breakdown?.[`maximums.${key}`] ?? [];
        const notes = key !== "hp" && Number(attribute.max) > 0 ? [`Cap ${attribute.max}${maxTerms.length > 1 ? ` (${maxTerms.filter(t => t.value).map(t => `${t.label} ${t.kind === "base" ? t.value : signed(t.value)}`).join(", ")})` : ""}`] : [];
        result[key] = {key, label, value, terms, html: breakdownHtml({title: label, total: derivedOr(terms, value), terms, situational, notes})};
        const growthTerms = (actor?.system?.breakdown?.[`growthRates.${key}`] ?? []).map(t => ({...t, value: t.value * 10}));
        const growth = Number(actor?.system?.growthRates?.[key] || 0) * 10;
        result[key].growthHtml = breakdownHtml({title: `${label} growth`, total: growth, suffix: "%", terms: growthTerms.length ? growthTerms : [term("Growth rate", growth, "base")]});
    }
    return result;
}
const derivedOr = (terms, fallback) => terms.length ? derived(terms) : fallback;

/** Base Movement, with Open Field (terrain-dependent) shown separately. */
export function movementDisplay(actor, token = null) {
    const value = Number(actor?.system?.movement?.base || 0);
    const terms = prepared(actor, "movement", "Move", value);
    const situational = [];
    if (hasSkill(actor, "open field")) {
        const bonus = openFieldBonus(actor, token);
        situational.push({label: "Open Field: +3 Move", text: "while standing on terrain without a movement penalty", active: bonus > 0});
    }
    return {value, html: breakdownHtml({title: "Base Movement", total: value, terms, situational})};
}

/** Open Field: +3 Move while standing on terrain without a movement penalty. */
export function openFieldBonus(actor, token) {
    const doc = docOf(token);
    if (!doc?.parent || !hasSkill(actor, "open field")) return 0;
    const rule = terrainMovement(tokenTerrain(doc).key, terrainTraits(actor, doc));
    return !rule.blocked && !rule.extra ? 3 : 0;
}

export {modifierText};
