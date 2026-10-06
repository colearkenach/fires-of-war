/** Replaceable Mounts (p. 178): when a rider dismounts, a mount linked to an Actor becomes a separate unit beside it,
 * and remounting requires that unit to be adjacent. If the mount unit dies, the mount is lost. */
import {SYSTEM, replaceableMounts, isMountItem} from "../rules/alt-rules.mjs";
import {placementReason, wallBlocks, tokenCells, footprintDistance, eventFlags} from "../encounter/event-rules.mjs";

const docOf = token => token?.document ?? token;
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));
const gridOf = scene => globalThis.canvas?.scene?.id === scene.id && canvas.grid?.getOffset ? canvas.grid : new foundry.grid.SquareGrid(scene.grid);
export const equippedMount = actor => Array.from(actor?.items ?? []).find(item => isMountItem(item) && item.system.equipped) ?? null;
export const mountUnitActor = actor => {
    const id = equippedMount(actor)?.system?.mountActor;
    const mount = id ? globalThis.game?.actors?.get(id) : null;
    return mount?.type === "character" ? mount : null;
};

/** First free square orthogonally adjacent to the rider (walls, solid Tiles, terrain and units respected). */
export function mountSquare(rider, mountActor, scene, grid) {
    const size = grid.size, probe = {id: null, width: 1, height: 1, elevation: rider.elevation ?? 0, actor: mountActor, flags: {}};
    const [i0, j0, i1, j1] = grid.getOffsetRange({x: rider.x, y: rider.y, width: rider.width * size, height: rider.height * size});
    const candidates = [];
    for (let i = i0; i < i1; i++) candidates.push({i, j: j0 - 1}, {i, j: j1});
    for (let j = j0; j < j1; j++) candidates.push({i: i0 - 1, j}, {i: i1, j});
    const center = point => ({x: point.x + size / 2, y: point.y + size / 2});
    for (const cell of candidates) {
        const point = grid.getTopLeftPoint(cell);
        if (placementReason(probe, point, scene, grid)) continue;
        if (wallBlocks(scene, {x: rider.x + rider.width * size / 2, y: rider.y + rider.height * size / 2}, center(point))) continue;
        return point;
    }
    return null;
}

/** Dismount: place the mount's own token next to the rider and add it to the rider's encounter and allegiance. */
export async function releaseMountUnit(rider, actor) {
    rider = docOf(rider);
    const mountActor = replaceableMounts() ? mountUnitActor(actor) : null;
    if (!mountActor || !rider?.parent) return null;
    const scene = rider.parent, grid = gridOf(scene);
    const point = mountSquare(rider, mountActor, scene, grid);
    if (!point) throw Error("There is no free adjacent square for the mount to stand on.");
    const data = (await mountActor.getTokenDocument({...point, elevation: rider.elevation ?? 0, disposition: rider.disposition, hidden: rider.hidden,
        actorLink: false, flags: {[SYSTEM]: {mountOf: rider.id}}})).toObject();
    const [token] = await scene.createEmbeddedDocuments("Token", [data]);
    if (!token) throw Error("The mount unit could not be placed.");
    await rider.update({[`flags.${SYSTEM}.mountTokenId`]: token.id});
    const combat = Array.from(globalThis.game?.combats ?? []).find(c => Array.from(c.combatants ?? []).some(unit => unit.tokenId === rider.id && (!unit.sceneId || unit.sceneId === scene.id)));
    const riderUnit = combat?.combatants.find(unit => unit.tokenId === rider.id);
    if (combat) await combat.createEmbeddedDocuments("Combatant", [{tokenId: token.id, sceneId: scene.id, actorId: mountActor.id,
        flags: {[SYSTEM]: {allegiance: riderUnit?.flags?.[SYSTEM]?.allegiance ?? ""}}}]);
    return token;
}

/** Mount again: the mount unit must stand next to its rider; its token leaves the map. */
export async function recallMountUnit(rider) {
    rider = docOf(rider);
    const id = eventFlags(rider).mountTokenId;
    if (!id) return true;
    const scene = rider.parent, mount = scene?.tokens.get(id);
    if (!mount) { await rider.update({[`flags.${SYSTEM}.-=mountTokenId`]: null}); return true; }
    if (Number(mount.actor?.system?.attributes?.hp?.value) <= 0) throw Error("The mount has fallen; equip a new mount to remount.");
    const grid = gridOf(scene);
    if (footprintDistance(tokenCells(rider, grid), tokenCells(mount, grid)) !== 1) throw Error(`${mount.name} must be adjacent to remount.`);
    for (const combat of globalThis.game?.combats ?? []) {
        const ids = Array.from(combat.combatants ?? []).filter(unit => unit.tokenId === mount.id).map(unit => unit.id);
        if (ids.length) await combat.deleteEmbeddedDocuments("Combatant", ids);
    }
    await mount.delete();
    await rider.update({[`flags.${SYSTEM}.-=mountTokenId`]: null});
    return true;
}

/** A fallen mount unit is lost: its rider cannot remount until a new mount is equipped. */
export async function mountUnitFallen(actor) {
    for (const token of actor?.getActiveTokens?.(false, true) ?? []) {
        const riderId = eventFlags(token).mountOf, rider = riderId ? token.parent?.tokens.get(riderId) : null;
        if (!rider?.actor) continue;
        const item = equippedMount(rider.actor);
        if (item) await item.update({"system.equipped": false, [`flags.${SYSTEM}.mountLost`]: true});
        await rider.actor.update({"system.mount.lost": true});
        await rider.update({[`flags.${SYSTEM}.-=mountTokenId`]: null});
        await globalThis.ChatMessage?.create({content: `<p><b>${esc(rider.name)}</b>'s mount has fallen. A replacement must be bought before remounting.</p>`});
    }
}
