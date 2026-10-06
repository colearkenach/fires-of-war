/** Terrain rules are contextual to a token, never permanent actor bonuses. */
import {hasSkill} from "../skills/skill-names.mjs";
import {replaceBreakdownTerm} from "../ui/stat-breakdown.mjs";
export const SYSTEM_ID = "fires-of-war";
export const TERRAINS = Object.freeze({
    plain: {name: "Plain / Flat Ground", text: "No effect."},
    desert: {name: "Desert", text: "Infantry and Armored: +1 movement cost; Mounted: +3. Magicians unaffected."},
    mountain: {name: "Mountain", avoid: 20, defense: 4, text: "+20% Avoid, +4 Defense. Infantry: +3 movement cost. Armored and Mounted cannot enter."},
    peak: {name: "Mountain Peak", avoid: 40, defense: 8, text: "+40% Avoid, +8 Defense. Requires Flying or Mountain Stride."},
    river: {name: "River", text: "Infantry and Armored: +2 movement cost. Mounted cannot enter."},
    sea: {name: "Sea / Ocean", text: "Requires Flying or Water Stride."},
    forest: {name: "Forest", avoid: 15, text: "+15% Avoid. +2 movement cost without Forest Stride."},
    woods: {name: "Woods", avoid: 40, text: "+40% Avoid. Requires Flying or Forest Stride."},
    swamp: {name: "Swamp", avoid: 10, defense: -1, damage: 5, text: "+10% Avoid, −1 Defense. 5 damage at phase start (minimum 1 HP)."},
    ice: {name: "Ice", text: "+2 Move on ice: the first two ice squares per movement allowance cost no Move. Move straight while on ice."},
    settlement: {name: "Settlement", avoid: 10, text: "+10% Avoid."},
    pillar: {name: "Pillar", avoid: 20, defense: 1, text: "+20% Avoid, +1 Defense. +2 movement cost."},
    fort: {name: "Fort", avoid: 45, heal: 5, text: "+45% Avoid. Heal 5 HP at phase start."},
    throne: {name: "Throne / Gate", heal: 5, text: "Heal 5 HP at phase start. Place a Seize Event Tile here to use it as an objective."},
    lava: {name: "Lava / Acid", damage: 5, text: "5 damage at phase start (minimum 1 HP)."},
    wall: {name: "Wall", text: "Impassable to every unit, including Flying."},
    pit: {name: "Pit", text: "Only Flying units can enter."}
});

export function terrainTraits(actor, token) {
    const types = actor?.system?.unitTypes ?? [];
    const flags = token?.flags?.[SYSTEM_ID]?.terrainTraits ?? actor?.flags?.[SYSTEM_ID]?.terrainTraits ?? {};
    return {
        types: new Set((Array.isArray(types) ? types : Object.keys(types).filter(key => types[key])).map(t => t.toLowerCase())),
        forest: !!flags.forest || hasSkill(actor, "forest stride"),
        mountain: !!flags.mountain || hasSkill(actor, "mountain stride"),
        water: !!flags.water || hasSkill(actor, "water stride"),
        acrobat: hasSkill(actor, "acrobat"),
        waterbound: hasSkill(actor, "waterbound"),
        // Ultra Heavyweight ignores movement-reducing terrain; impassable terrain still blocks.
        steadfast: hasSkill(actor, "ultra heavyweight")
    };
}

export function terrainMovement(key, traits) {
    const t = traits.types;
    if (key === "wall") return {blocked: true, extra: 0, ice: false};
    if (traits.waterbound && !["river", "sea"].includes(key)) return {blocked: true, extra: 0, ice: false};
    if (t.has("flying")) return {blocked: false, extra: 0, ice: false};
    let blocked = false, extra = 0;
    switch (key) {
        case "desert": if (!t.has("magician")) extra = t.has("mounted") ? 3 : t.has("infantry") || t.has("armored") ? 1 : 0; break;
        case "mountain": blocked = t.has("armored") || t.has("mounted"); extra = t.has("infantry") ? 3 : 0; break;
        case "peak": blocked = !traits.mountain; break;
        case "river": blocked = t.has("mounted"); extra = t.has("infantry") || t.has("armored") ? 2 : 0; break;
        case "sea": blocked = !traits.water; break;
        case "forest": extra = traits.forest ? 0 : 2; break;
        case "woods": blocked = !traits.forest; break;
        case "pillar": extra = 2; break;
        case "pit": blocked = true; break;
    }
    return {blocked, extra: traits.acrobat || traits.steadfast ? 0 : extra, ice: key === "ice"};
}

/** Highest explicit priority wins overlaps; stable region ID breaks ties. */
export function terrainAt(scene, point) {
    const regions = Array.from(scene?.regions ?? []).filter(region => {
        const key = region.flags?.[SYSTEM_ID]?.terrain;
        return TERRAINS[key] && (region.testPoint?.(point) ?? region.object?.testPoint?.(point, point.elevation));
    }).sort((a, b) => (Number(b.flags?.[SYSTEM_ID]?.terrainPriority) || 0) -
        (Number(a.flags?.[SYSTEM_ID]?.terrainPriority) || 0) || String(a.id).localeCompare(String(b.id)));
    const region = regions[0];
    const key = region?.flags?.[SYSTEM_ID]?.terrain ?? "plain";
    return {key, ...TERRAINS[key], region, avoid: TERRAINS[key].avoid ?? 0, defense: TERRAINS[key].defense ?? 0};
}

export function tokenTerrain(token, scene = (token?.document ?? token)?.parent) {
    const doc = token?.document ?? token;
    // A rendered Token's parent is its PIXI container, not its Scene document.
    // Always get the Scene from the TokenDocument before testing Regions.
    const size = scene?.grid?.size ?? 100;
    return terrainAt(scene, {x: (doc?.x ?? 0) + (doc?.width ?? 1) * size / 2,
        y: (doc?.y ?? 0) + (doc?.height ?? 1) * size / 2, elevation: doc?.elevation ?? 0});
}

export function actorTerrain(actor) {
    const targeted = Array.from(globalThis.game?.user?.targets ?? []).find(token => token.actor === actor);
    return tokenTerrain(targeted ?? (actor?.isToken ? actor.token : null));
}

const appliedTerrain = new WeakMap();

/** A linked actor's sheet uses the single selected copy, or its only copy on the current scene. */
export function unitTerrain(actor, {ignoreScene = false} = {}) {
    if (actor?.isToken) return tokenTerrain(actor.token);
    const tokens = !ignoreScene && globalThis.canvas?.ready ? globalThis.canvas.tokens?.placeables ?? [] : [];
    const copies = tokens.filter(token => token.actor === actor);
    const selected = copies.filter(token => token.controlled);
    return tokenTerrain(selected.length === 1 ? selected[0] : copies.length === 1 ? copies[0] : null);
}

export const getAppliedTerrain = actor => appliedTerrain.get(actor) ?? {key: "plain", name: TERRAINS.plain.name, avoid: 0, defense: 0};

/** Apply to prepared values only. Refreshes subtract the previous modifier; fresh preparation starts from base stats. */
export function applyTerrainStats(actor, {fresh = false, ignoreScene = false} = {}) {
    if (actor?.type !== "character" || !actor.system.combat || !actor.system.attributes?.defense) return;
    const before = fresh ? {avoid: 0, defense: 0} : getAppliedTerrain(actor);
    const terrain = unitTerrain(actor, {ignoreScene});
    // Sleep/Petrification set Avoid to 0, so terrain cannot raise it.
    const avoid = actor.system.combat.zeroed?.includes("avoid") ? 0 : terrain.avoid;
    actor.system.combat.avoid = Number(actor.system.combat.avoid || 0) - before.avoid + avoid;
    actor.system.attributes.defense.value = Number(actor.system.attributes.defense.value || 0) - before.defense + terrain.defense;
    appliedTerrain.set(actor, {key: terrain.key, name: terrain.name, avoid, defense: terrain.defense});
    replaceBreakdownTerm(actor, "combat.avoid", "terrain", `Terrain (${terrain.name})`, avoid);
    replaceBreakdownTerm(actor, "attributes.defense", "terrain", `Terrain (${terrain.name})`, terrain.defense);
}

/** Rebase on the actual target token when multiple linked copies occupy different terrains. */
export function terrainCombatStats(actor, token) {
    const applied = getAppliedTerrain(actor);
    const terrain = token ? tokenTerrain(token) : actorTerrain(actor);
    const avoid = actor?.system?.combat?.zeroed?.includes("avoid") ? 0 : terrain.avoid;
    return {
        avoid: Number(actor?.system?.combat?.avoid || 0) - applied.avoid + avoid,
        defense: Number(actor?.system?.attributes?.defense?.value || 0) - applied.defense + terrain.defense
    };
}

export function refreshTerrainStats(scene = globalThis.canvas?.scene, {ignoreScene = false} = {}) {
    const actors = new Set(globalThis.game?.actors ?? []);
    for (const token of scene?.tokens ?? []) if (token.actor) actors.add(token.actor);
    for (const actor of actors) {
        applyTerrainStats(actor, {ignoreScene});
        if (actor.sheet?.rendered) actor.sheet.render(false);
    }
}

/** Incoming direction must be preserved at every ice cell, including its exit. */
export function terrainRouteState(cells, lookup, traits) {
    let extra = 0, iceSteps = 0;
    for (let n = 1; n < cells.length; n++) {
        if (cells[n].displaced) continue;
        const rule = terrainMovement(lookup(cells[n]).key, traits);
        if (rule.blocked) return {valid: false, extra: Infinity, iceSteps};
        extra += rule.extra;
        if (rule.ice) iceSteps++;
        if (n > 1 && !cells[n - 1].displaced && terrainMovement(lookup(cells[n - 1]).key, traits).ice) {
            const a = cells[n - 2], b = cells[n - 1], c = cells[n];
            if (Math.sign(b.i - a.i) !== Math.sign(c.i - b.i) || Math.sign(b.j - a.j) !== Math.sign(c.j - b.j)) {
                return {valid: false, extra: Infinity, iceSteps};
            }
        }
    }
    return {valid: true, extra: extra - Math.min(2, iceSteps), iceSteps};
}

export function terrainHP(hp, max, terrain) {
    if (!(hp > 0)) return hp;
    if (terrain.damage) return Math.max(1, hp - terrain.damage);
    if (terrain.heal && max > 0) return Math.max(hp, Math.min(max, hp + terrain.heal));
    return hp;
}
