import {SYSTEM_ID} from "../map/terrain.mjs";
import {pendingRevival, forcedDismountPending} from "../rules/alt-rules.mjs";

export const DEFAULT_ALLEGIANCES = Object.freeze([
    {id: "player", name: "Player", disposition: 1},
    {id: "npc", name: "Neutral", disposition: 0},
    {id: "enemy", name: "Enemy", disposition: -1},
    {id: "other", name: "Other", disposition: null}
]);
export const OBJECTIVES = {rout: "Rout the Enemy", boss: "Defeat the Boss(es)", survive: "Defend / Survive", seize: "Seize", escape: "Escape"};
export const hasEscaped = (token, combat = null) => !!token?.flags?.[SYSTEM_ID]?.escapedCombat &&
    (!combat || token.flags[SYSTEM_ID].escapedCombat === combat.id);

export function objectiveScene(combat) {
    if (combat?.scene?.tiles) return combat.scene;
    const id = combat?.scene?.id ?? combat?.sceneId ?? combat?.scene;
    return globalThis.game?.scenes?.get?.(id) ?? Array.from(combat?.combatants ?? []).find(c => c.token?.parent?.tiles)?.token.parent;
}

export function objectiveTileIds(combat, type, objective = combat.flags?.[SYSTEM_ID]?.objective) {
    return [...new Set([...(Array.isArray(objective?.tiles) ? objective.tiles : []),
        ...Array.from(objectiveScene(combat)?.tiles ?? []).filter(tile => tile.flags?.[SYSTEM_ID]?.interactable &&
            tile.flags[SYSTEM_ID].interactionType === type).map(tile => tile.id)])];
}

export function escapeUnitIds(combat, objective = combat.flags?.[SYSTEM_ID]?.objective) {
    if (objective?.escapeMode === "selected") return objective.escapeUnit ? [objective.escapeUnit] : [];
    const ids = new Set(objective?.escapeUnits ?? []);
    for (const unit of combat.combatants ?? []) if (allegianceOf(unit, combat).id === (objective?.allegiance || "player")) ids.add(unit.id);
    return [...ids];
}

export function allegiances(combat) {
    const saved = combat?.flags?.[SYSTEM_ID]?.allegiances;
    return Array.isArray(saved) && saved.length ? saved : DEFAULT_ALLEGIANCES;
}

export function allegianceOf(combatant, combat = combatant.parent) {
    const groups = allegiances(combat);
    const override = combatant.flags?.[SYSTEM_ID]?.allegiance ?? combatant.token?.flags?.[SYSTEM_ID]?.allegiance;
    return groups.find(group => group.id === override) ?? groups.find(group => group.disposition !== null &&
        Number(group.disposition) === Number(combatant.token?.disposition ?? 0)) ?? groups.find(group => group.id === "other") ?? groups.at(-1);
}

/** 0 HP is defeat, unless the unit is about to spend a Revival Stone or be thrown from its mount. */
export function isSlain(combatant) {
    const hp = combatant.actor?.system?.attributes?.hp?.value;
    return hp !== null && hp !== undefined && Number.isFinite(Number(hp)) && Number(hp) <= 0 &&
        !pendingRevival(combatant.actor) && !forcedDismountPending(combatant.actor);
}

export function phaseStarts(combat, {living = false} = {}) {
    const seen = new Set();
    return (combat.turns ?? []).flatMap((unit, index) => {
        const id = allegianceOf(unit, combat).id;
        if (seen.has(id) || (living && (isSlain(unit) || unit.isDefeated || hasEscaped(unit.token, combat)))) return [];
        seen.add(id);
        return [{id, index}];
    });
}

export function evaluateObjective(combat, objective = combat.flags?.[SYSTEM_ID]?.objective) {
    if (!objective?.type) return {complete: false, text: "No objective set"};
    const units = Array.from(combat.combatants ?? []);
    if (objective.type === "rout") {
        const enemies = units.filter(unit => allegianceOf(unit, combat).id === "enemy" || Number(unit.token?.disposition) === -1);
        const remaining = enemies.filter(unit => !isSlain(unit)).length;
        return {complete: enemies.length > 0 && remaining === 0, text: enemies.length ? `${remaining} hostile unit(s) remaining` : "Add hostile units to track Rout"};
    }
    if (objective.type === "boss") {
        const ids = Array.isArray(objective.bosses) ? objective.bosses : [];
        const bosses = ids.map(id => units.find(unit => unit.id === id));
        const remaining = bosses.filter(unit => !unit || !isSlain(unit)).length;
        return {complete: ids.length > 0 && remaining === 0, text: ids.length ? `${remaining} boss(es) remaining` : "Choose the boss units"};
    }
    if (objective.type === "survive") {
        const target = Math.max(1, Math.trunc(Number(objective.rounds) || 1));
        // Round 1 has completed zero full rounds; victory begins at round target + 1.
        const completed = Math.max(0, (combat.round ?? 0) - Math.max(1, Number(objective.startRound) || 1));
        const remaining = Math.max(0, target - completed);
        return {complete: remaining === 0, text: `${remaining} full round(s) remaining (${Math.min(completed, target)}/${target})`};
    }
    if (objective.type === "seize") {
        const tiles = objectiveTileIds(combat, "seize", objective);
        const seized = new Set(combat.flags?.[SYSTEM_ID]?.eventProgress?.seized ?? []);
        const remaining = tiles.filter(id => !seized.has(id)).length;
        return {complete: tiles.length > 0 && remaining === 0,
            text: tiles.length ? `${tiles.length - remaining}/${tiles.length} Seize tiles secured` : "Add interactable Seize tiles to the encounter scene"};
    }
    if (objective.type === "escape") {
        const tiles = objectiveTileIds(combat, "escape", objective), required = escapeUnitIds(combat, objective);
        const escaped = new Set(combat.flags?.[SYSTEM_ID]?.eventProgress?.escaped ?? []);
        const remaining = required.filter(id => !escaped.has(id)).length;
        return {complete: tiles.length > 0 && required.length > 0 && remaining === 0,
            text: !tiles.length ? "Add interactable Escape tiles to the encounter scene" : !required.length ? "Choose units to escape" :
                `${required.length - remaining}/${required.length} required unit(s) escaped`};
    }
    return {complete: false, text: "No objective set"};
}
