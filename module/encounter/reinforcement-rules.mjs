import {eventFlags, tileCells, tokenCells, footprintDistance, unavailableUnit, placementReason, wallBlocks} from "./event-rules.mjs";
import {cellKey} from "../map/tactical-grid.mjs";

export function reinforcementTurns(value) {
    const parts = String(value ?? "").split(/[,\s]+/).filter(Boolean);
    if (!parts.length || parts.some(part => !/^\d+$/.test(part) || !Number.isSafeInteger(Number(part)) || Number(part) < 1)) return null;
    return [...new Set(parts.map(Number))].sort((a, b) => a - b);
}

export function reinforcementDue(tile, round) {
    const flags = eventFlags(tile);
    if (flags.interactionType !== "reinforcement" || flags.reinforcementEnabled === false || !Number.isSafeInteger(round) || round < 1) return false;
    if (flags.reinforcementMode === "every") {
        const interval = Number(flags.reinforcementInterval ?? 3), start = Number(flags.reinforcementStart ?? interval);
        return Number.isSafeInteger(interval) && interval > 0 && Number.isSafeInteger(start) && start > 0 && round >= start && (round - start) % interval === 0;
    }
    return (reinforcementTurns(flags.reinforcementTurns ?? "3, 5") ?? []).includes(round);
}

/** One unit at the Tile's center square, extras one orthogonal space from its footprint. */
export function reinforcementPositions(tile, token, scene, grid, count = 1) {
    const tileFootprint = tileCells(tile, grid);
    if (Array.from(scene.tokens ?? []).some(other => !unavailableUnit(other) &&
        footprintDistance(tileFootprint, tokenCells(other, grid)) === 0)) return [];
    const anchor = grid.getTopLeftPoint(grid.getOffset({x: tile.x + tile.width / 2, y: tile.y + tile.height / 2}));
    const elevation = Number(token.elevation ?? tile.elevation ?? 0);
    if (placementReason(token, anchor, scene, grid, {elevation})) return [];
    const base = {...token, ...anchor}, firstCells = tokenCells(base, grid), reserved = new Set(firstCells.map(cellKey));
    const positions = [anchor];
    const [i0, j0, i1, j1] = grid.getOffsetRange({x: base.x, y: base.y, width: base.width * grid.size, height: base.height * grid.size});
    const center = point => ({x: point.x + token.width * grid.size / 2, y: point.y + token.height * grid.size / 2});
    const candidates = [];
    for (let i = i0 - Math.ceil(token.height); i <= i1; i++) for (let j = j0 - Math.ceil(token.width); j <= j1; j++) {
        const point = grid.getTopLeftPoint({i, j});
        if (footprintDistance(firstCells, tokenCells(token, grid, point)) === 1) candidates.push(point);
    }
    candidates.sort((a, b) => Math.abs(a.x - anchor.x) + Math.abs(a.y - anchor.y) - Math.abs(b.x - anchor.x) - Math.abs(b.y - anchor.y) || a.y - b.y || a.x - b.x);
    for (const point of candidates) {
        if (positions.length >= count) break;
        if (placementReason(token, point, scene, grid, {elevation, reserved}) || wallBlocks(scene, center(anchor), center(point))) continue;
        positions.push(point);
        for (const cell of tokenCells(token, grid, point)) reserved.add(cellKey(cell));
    }
    return positions.slice(0, Math.max(0, Math.trunc(count)));
}
