import {allegianceOf} from "../encounter/encounter-rules.mjs";
import {SYSTEM_ID, tokenTerrain} from "../map/terrain.mjs";

export const tokenDocument = token => token?.document ?? token;
export function skillTokenDistance(a, b) {
    a = tokenDocument(a); b = tokenDocument(b);
    if (!a || !b || a.parent?.id !== b.parent?.id) return Infinity;
    const grid = globalThis.canvas?.scene?.id === a.parent?.id ? globalThis.canvas?.grid : null;
    if (grid?.isSquare === false && grid.measurePath) {
        const center = token => ({x: Number(token.x) + Number(token.width ?? 1) * Number(token.parent.grid.size) / 2, y: Number(token.y) + Number(token.height ?? 1) * Number(token.parent.grid.size) / 2});
        return grid.measurePath([center(a), center(b)]).distance / (grid.distance || 1);
    }
    const size = Number(a.parent?.grid?.size) || 100;
    const gap = (start, length, other, otherLength) => Math.max(0, other - (start + length - size), start - (other + otherLength - size)) / size;
    return gap(Number(a.x), Number(a.width ?? 1) * size, Number(b.x), Number(b.width ?? 1) * size) +
        gap(Number(a.y), Number(a.height ?? 1) * size, Number(b.y), Number(b.height ?? 1) * size);
}

export function skillTokenAllegiance(token) {
    const doc = tokenDocument(token), combat = globalThis.game?.combat;
    const unit = Array.from(combat?.combatants ?? []).find(c => {
        const sceneId = c.token?.parent?.id ?? c.sceneId ?? combat.scene?.id;
        return c.tokenId === doc?.id && (!sceneId || sceneId === doc?.parent?.id);
    });
    return allegianceOf(unit ?? {token: doc, flags: {}, parent: combat}, combat).id;
}

/** Player and NPC units fight on the same side; every other pairing must share an allegiance. */
export function alliedTokens(a, b) {
    const x = skillTokenAllegiance(a), y = skillTokenAllegiance(b);
    return x === y || [x, y].every(id => ["player", "npc"].includes(id));
}

/** Units on the map that can project or receive skill effects: alive, visible, not carried or escaped. */
export function activeSkillUnit(token) {
    const doc = tokenDocument(token), actor = doc?.actor;
    return !!actor && !doc.hidden && Number(actor.system?.attributes?.hp?.value ?? 0) > 0 &&
        !doc.flags?.[SYSTEM_ID]?.rescuedBy && !doc.flags?.[SYSTEM_ID]?.escapedCombat;
}

export function sceneTokens(token, tokens = null) {
    const doc = tokenDocument(token);
    if (tokens) return Array.from(tokens, tokenDocument).filter(Boolean);
    const scene = doc?.parent;
    if (scene?.tokens) return Array.from(scene.tokens, tokenDocument);
    const placeables = globalThis.canvas?.scene?.id === scene?.id ? globalThis.canvas?.tokens?.placeables : null;
    return Array.from(placeables ?? [], tokenDocument).filter(Boolean);
}

/** Other active units within `radius` squares; relation is "allies", "enemies" or "all". */
export function unitsWithin(token, radius, {relation = "all", tokens = null} = {}) {
    const doc = tokenDocument(token);
    if (!doc) return [];
    return sceneTokens(doc, tokens).filter(other => other && other.id !== doc.id && activeSkillUnit(other) &&
        skillTokenDistance(doc, other) <= radius && (relation === "all" || alliedTokens(doc, other) === (relation === "allies")));
}

export const currentRound = () => {
    const combat = globalThis.game?.combat;
    return combat?.started ? Math.max(1, Number(combat.round) || 1) : 1;
};

/** "own" during this unit's allegiance phase, "other" during another phase, null outside an encounter. */
export function currentPhase(token) {
    const combat = globalThis.game?.combat, doc = tokenDocument(token);
    if (!combat?.started || !combat.combatant || !doc) return null;
    return allegianceOf(combat.combatant, combat).id === skillTokenAllegiance(doc) ? "own" : "other";
}

export function unitCombatantOf(token) {
    const combat = globalThis.game?.combat, doc = tokenDocument(token);
    return combat?.started && doc ? Array.from(combat.combatants ?? []).find(c => c.tokenId === doc.id && (!c.sceneId || c.sceneId === doc.parent?.id)) ?? null : null;
}

/** Scenes default to outdoor maps; the Scene configuration can mark a map Indoor. */
export function sceneEnvironment(token) {
    const scene = tokenDocument(token)?.parent ?? globalThis.canvas?.scene;
    return scene?.flags?.[SYSTEM_ID]?.environment === "indoor" ? "indoor" : "outdoor";
}

export function terrainOf(token) {
    const doc = tokenDocument(token);
    return doc?.parent ? tokenTerrain(doc) : null;
}
