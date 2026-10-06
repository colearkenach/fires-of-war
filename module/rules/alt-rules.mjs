/** Alternate & Advanced Rules (p. 172–179), Revival Stones, Capture and the Weapon Triangle.
 * Settings reads are guarded so these helpers also work in tests and before "init". */
import {actorAllegiance} from "../units/allegiance-ui.mjs";

export const SYSTEM = "fires-of-war";
const int = value => Math.trunc(Number(value) || 0);
const hp = actor => Number(actor?.system?.attributes?.hp?.value) || 0;
const weaponType = item => String(item?.system?.weaponType ?? "").trim().toLowerCase();

export function setting(key, fallback) {
    try { return globalThis.game?.settings?.get(SYSTEM, key) ?? fallback; } catch { return fallback; }
}

// ── Weapon Triangle (p. 13): each weapon beats the next one in its cycle ──
export const WEAPON_TRIANGLES = Object.freeze({
    physical: Object.freeze(["sword", "axe", "lance"]),
    special: Object.freeze(["bow", "firearm", "knife"]),
    magic: Object.freeze(["anima", "light", "dark"])
});
export const flipTriangle = triangle => triangle === "advantage" ? "disadvantage" : triangle === "disadvantage" ? "advantage" : triangle;

export function baseTriangle(mine, theirs) {
    for (const cycle of Object.values(WEAPON_TRIANGLES)) {
        const a = cycle.indexOf(mine), b = cycle.indexOf(theirs);
        if (a < 0 || b < 0 || a === b) continue;
        return cycle[(a + 1) % 3] === theirs ? "advantage" : "disadvantage";
    }
    return "none";
}

/** The triangle from the first weapon's side. Reverse inverts the matchup for both wielders;
 * Superior replaces the triangle with a bonus against its own weapon type. */
export function weaponTriangle(mine, theirs, {reverse = false, superior = false, foeReverse = false, foeSuperior = false} = {}) {
    if (superior || foeSuperior) {
        if (!mine || mine !== theirs || superior && foeSuperior) return "none";
        return superior ? "advantage" : "disadvantage";
    }
    const triangle = baseTriangle(mine, theirs);
    return !!reverse !== !!foeReverse ? flipTriangle(triangle) : triangle;
}

export const triangleOverride = () => !!setting("weaponTriangleOverride", false);

// ── Modifying Durability and Risky Combat Arts (p. 177) ──
export function durabilityMode() {
    const mode = setting("durabilityRule", "standard");
    return ["remove", "perMap"].includes(mode) ? mode : "standard";
}
const isStaff = item => weaponType(item) === "staff";
/** Remove Durability: weapons have infinite uses; staves keep theirs. */
export const durabilityExempt = item => item?.type === "weapon" && !isStaff(item) && durabilityMode() === "remove";
/** Per-Map Durability: weapons spend durability at the end of each map instead of per attack. */
export const perMapTracked = item => item?.type === "weapon" && !isStaff(item) && durabilityMode() === "perMap" &&
    Number(item.system?.uses?.max) > 0;
export const PER_MAP_UNIT = 5;
export const perMapDurability = uses => Number(uses?.value) > 0 ? Math.max(1, Math.floor(Number(uses.value) / PER_MAP_UNIT)) : 0;
export const perMapArtCost = cost => Number(cost) > 0 ? Math.max(1, Math.floor(Number(cost) / PER_MAP_UNIT)) : 0;
/** Durability this weapon will lose at the end of the current map (1 for being used, plus Combat Arts). */
export function pendingMapLoss(weapon, combatId = globalThis.game?.combat?.id) {
    const usage = weapon?.flags?.[SYSTEM]?.mapUse;
    return usage && usage.combat === combatId ? 1 + int(usage.arts) : 0;
}
/** Remaining Uses once a map's losses are applied; per-map durability is Uses ÷ 5 (round down, minimum 1). */
export function usesAfterMap(uses, loss) {
    if (!(int(loss) > 0)) return Number(uses?.value) || 0;
    const remaining = Math.max(0, perMapDurability(uses) - Math.max(0, int(loss)));
    return remaining ? Math.min(Number(uses.value), remaining * PER_MAP_UNIT) : 0;
}

export function artCostMode() {
    if (durabilityMode() === "remove") return "hp";
    const mode = setting("riskyCombatArts", "durability");
    return ["hp", "choice"].includes(mode) ? mode : "durability";
}
/** Remove Durability doubles weapon prices (staves excepted). */
export const effectivePrice = item => Math.max(0, Number(item?.system?.price || 0)) * (durabilityExempt(item) ? 2 : 1);

// ── Revival Stones ──
export const revivalEnabled = () => !!setting("useRevivalStones", false);
export const REVIVAL_STAT_KEYS = Object.freeze({
    strength: "STR", magic: "MAG", skill: "SKL", speed: "SPD", defense: "DEF", resistance: "RES", luck: "LUK", charm: "CHA", build: "BLD",
    move: "Move", hitRate: "Hit", critRate: "Crit", avoid: "Avoid", dodge: "Dodge", attackSpeed: "AS"
});

/** Revival Stones belong to Neutral, Enemy and Other units; Player units never have them. */
export const revivalAllowed = actor => actorAllegiance(actor) !== "player";

export function revivalState(actor) {
    const stones = revivalAllowed(actor) ? actor?.system?.revivalStones ?? {} : {};
    const max = Math.min(5, Math.max(0, int(stones.max)));
    const value = Math.min(max, Math.max(0, int(stones.value)));
    return {max, value, lost: max - value, enraged: !!stones.enraged, bonuses: Array.isArray(stones.bonuses) ? stones.bonuses : []};
}

/** Enraged Revival: units with more than two stones grow hardier as they lose them (not additive). */
export function enragedMultiplier(lost, max) {
    if (max <= 2 || lost < 2) return 1;
    return lost >= 4 ? 2 : lost === 3 ? 1.75 : 1.5;
}
export function revivalHpMultiplier(actor) {
    if (!revivalEnabled()) return 1;
    const state = revivalState(actor);
    return state.enraged ? enragedMultiplier(state.lost, state.max) : 1;
}
/** A fallen unit with a stone left revives at the end of combat instead of dying. */
export const pendingRevival = actor => revivalEnabled() && revivalState(actor).value > 0 && hp(actor) <= 0;

/** Empowering Revival on skills: "until" locks a skill until X or fewer stones remain; "disabled" turns it off at X or fewer. */
export function revivalSkillOpen(item) {
    const gate = item?.system?.revivalGate;
    if (!gate?.mode || !revivalEnabled()) return true;
    const state = revivalState(item.parent);
    if (!state.max) return true;
    const atOrBelow = state.value <= Math.max(0, int(gate.stones));
    return gate.mode === "until" ? atOrBelow : gate.mode === "disabled" ? !atOrBelow : true;
}
export function revivalSkillNote(item) {
    const gate = item?.system?.revivalGate;
    if (!gate?.mode || !revivalEnabled()) return "";
    const stones = Math.max(0, int(gate.stones));
    return gate.mode === "until" ? `Sealed until ${stones} or fewer Revival Stones remain` : `Lost at ${stones} or fewer Revival Stones`;
}

/** Empowering Revival on stats: each row applies while the stone count is at/below or above its threshold. */
export function revivalBonusTerms(actor) {
    if (!revivalEnabled()) return [];
    const state = revivalState(actor);
    if (!state.max) return [];
    return state.bonuses.filter(row => REVIVAL_STAT_KEYS[row?.stat] && int(row.value)).filter(row =>
        row.when === "above" ? state.value > int(row.stones) : state.value <= int(row.stones)).map(row => ({
        path: row.stat === "move" ? "movement" : ["hitRate", "critRate", "avoid", "dodge", "attackSpeed"].includes(row.stat) ? `combat.${row.stat}` : `attributes.${row.stat}`,
        key: row.stat, label: `Revival Stones (${row.when === "above" ? "more than" : "at most"} ${int(row.stones)})`, value: int(row.value)}));
}

// ── Fate Points (p. 177) ──
export const fateEnabled = () => !!setting("useFatePoints", false);
export const fateMax = actor => Math.max(0, Math.floor(Number(actor?.system?.attributes?.luck?.value || 0) / 5));
export const fatePoints = actor => fateEnabled() ? Math.max(0, int(actor?.system?.fatePoints?.value)) : 0;
/** Player-owned units spend a Fate Point to survive by default; GMs can change it per unit. */
export const fateNegatesLethal = actor => fatePoints(actor) > 0 && (actor.system.fatePoints?.autoNegate ?? !!actor.hasPlayerOwner) !== false;
export const fateRerollsSkills = actor => fatePoints(actor) > 0 && !!actor.system.fatePoints?.rerollSkills;

// ── Capture (p. 14) ──
export function captureMode() {
    const mode = setting("captureRule", "capture");
    return ["off", "capture", "lenient", "subdue"].includes(mode) ? mode : "capture";
}

// ── Replaceable Mounts (p. 178) ──
export const replaceableMounts = () => !!setting("replaceableMounts", false);
export const isMountItem = item => item?.type === "item" && item.system?.itemType === "equippable" && !!item.system?.mountSlot;
export const mountLost = item => !!item?.flags?.[SYSTEM]?.mountLost;
/** Equipment slots: one weapon, one accessory and (Replaceable Mounts) one mount. */
export function equipSlot(item) {
    if (item?.type === "weapon") return "weapon";
    if (item?.type === "item" && item.system?.itemType === "equippable") return isMountItem(item) ? "mount" : "accessory";
    return null;
}
export const sameEquipSlot = (a, b) => !!equipSlot(a) && equipSlot(a) === equipSlot(b);

const sourceTypes = actor => {
    const raw = actor?._source?.system?.unitTypes ?? actor?.system?.unitTypes ?? [];
    return Array.isArray(raw) ? raw : Object.keys(raw).filter(key => raw[key]);
};
export const ridesMount = actor => sourceTypes(actor).some(type => ["Mounted", "Flying"].includes(type)) && !actor?.system?.mount?.dismounted;
/** Forcibly Dismounted: a mounted unit reduced to 0 HP is thrown from its mount instead of dying. */
export const forcedDismountPending = actor => replaceableMounts() && hp(actor) <= 0 && ridesMount(actor);

export const hasKnockedOut = actor => (actor?.system?.statusEffects ?? []).some(effect =>
    String(effect?.name ?? effect).trim().toLowerCase() === "knocked out" && (effect?.duration === undefined || effect.duration === -1 || Number(effect.duration) > 0));
/** A unit at 0 HP that is not (yet) dead: it revives, is thrown from its mount, or is knocked out. */
export const deathDeferred = actor => pendingRevival(actor) || forcedDismountPending(actor) || hp(actor) <= 0 && hasKnockedOut(actor);

/** Settings shown with the other alternate rules in Configure Settings. */
export function registerAltRuleSettings(onChange = () => {}) {
    const register = (key, data) => game.settings.register(SYSTEM, key, {scope: "world", config: true, onChange, ...data});
    register("durabilityRule", {name: "Modifying Durability", type: String, default: "standard",
        hint: "Alt rule. Remove Durability: weapons never lose uses (staves still do), weapon prices double and Combat Arts cost HP. Per-Map Durability: weapons lose 1 per-map durability (5 Uses) at the end of each encounter they were used in, plus each Combat Art's cost ÷ 5 (minimum 1).",
        choices: {standard: "Standard (per attack)", remove: "Remove Durability", perMap: "Per-Map Durability"}});
    register("riskyCombatArts", {name: "Risky Combat Arts", type: String, default: "durability",
        hint: "Alt rule. HP Cost: Combat Arts cost HP equal to their durability cost. Player's Choice: choose durability or HP each time. Remove Durability always uses HP.",
        choices: {durability: "Off (Combat Arts cost durability)", hp: "HP Cost", choice: "Player's Choice"}});
    register("useFatePoints", {name: "Use Fate Points", type: Boolean, default: false,
        hint: "Alt rule. Each character has LUK ÷ 5 Fate Points to reroll an attack or skill activation, or negate an attack that would kill them. Refresh them from the character sheet at the start of each session."});
    register("replaceableMounts", {name: "Replaceable Mounts", type: Boolean, default: false,
        hint: "Alt rule. Mounts use a separate Mount equipment slot. A mounted unit reduced to 0 HP is forcibly dismounted instead of dying (max HP halved for the encounter) and cannot remount until it equips a new mount. A mount can be linked to an Actor that becomes a separate unit when its rider dismounts."});
    register("useRevivalStones", {name: "Revival Stones", type: Boolean, default: false,
        hint: "Alt rule for bosses. A unit reaching 0 HP at the end of combat spends a Revival Stone and heals to full. Configure stones, Enraged Revival and stat bonuses on the character sheet; lock skills to stone counts on the skill sheet."});
    register("captureRule", {name: "Capture", type: String, default: "capture",
        hint: "Declare Capture in the Battle Forecast. A captured enemy is Knocked Out and carried by the attacker. Choose what happens when a captive is dropped, or use Subdue to knock enemies out without carrying them.",
        choices: {capture: "Capture (dropped captives are slain)", lenient: "Capture (dropped captives stay Knocked Out)", subdue: "Subdue (knock out at 0 HP, no carrying)", off: "Off"}});
    register("weaponTriangleOverride", {name: "Weapon Triangle Override", type: Boolean, default: false,
        hint: "Show a manual Weapon Triangle selector in the Battle Forecast. When off, the triangle is determined from both units' weapons, including Reverse, Superior and Beyond Morality."});
}
