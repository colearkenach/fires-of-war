import {buildTacticalForecast, cellKey, getForecastStats, routeToCell} from "./tactical-grid.mjs";
import {terrainAt, terrainTraits, terrainMovement, terrainRouteState} from "./terrain.mjs";
import {unavailableUnit, sameAllegiance, solidTileCells} from "../encounter/event-rules.mjs";
import {unitActionReason} from "../units/unit-actions.mjs";
import {hasSkill} from "../skills/skill-automation.mjs";

/** The stored position. While a multi-waypoint move animates, Foundry v13 leaves the document's x/y at the
 * previous square until the animation ends, so later legs must be measured from the saved position. */
export const storedPosition = doc => ({x: doc?._source?.x ?? doc?.x, y: doc?._source?.y ?? doc?.y,
    elevation: doc?._source?.elevation ?? doc?.elevation ?? 0});

/** Longest detour (in squares) searched around barriers when movement is unrestricted. */
export const UNRESTRICTED_SEARCH = 250;

export function nativeCellPath(document, waypoints, grid) {
    const complete = document.getCompleteMovementPath?.(waypoints) ??
        (grid.getDirectPath ? grid.getDirectPath(waypoints).map(cell => grid.getTopLeftPoint(cell)) : waypoints);
    const cells = [];
    for (const waypoint of complete) {
        // Use the same snapping as TokenRuler's intermediate grid highlights.
        const snapped = document.getSnappedPosition?.(waypoint) ?? waypoint;
        const cell = grid.getOffset({x: snapped.x + 1, y: snapped.y + 1});
        // Rescue transport and GM displacements spend no terrain Move and reset
        // incoming Ice direction, while preserving the unit's earlier spending.
        if (waypoint.action === "displace") cell.displaced = true;
        if (!cells.length || cellKey(cells.at(-1)) !== cellKey(cell) || cell.displaced) cells.push(cell);
    }
    return cells;
}

/** Shared geometry for drawing and rejecting movement, independent of the visible overlay.
 * Outside a started encounter the unit is not limited by Move: walls, solid Tiles, impassable
 * terrain, other units and scene bounds still block it, but terrain costs and Ice do not apply. */
export function createMovementContext(token, board, {combat = null, origin: from = null} = {}) {
    const grid = board.grid?.getOffset ? board.grid : board.grid?.grid;
    const doc = token.document;
    const rect = board.dimensions.sceneRect;
    const at = from ?? storedPosition(doc);
    const origin = grid.getOffset({x: at.x + 1, y: at.y + 1});
    const stats = getForecastStats(token.actor);
    const inCombat = combat?.started && combat.combatants?.some(c => c.tokenId === doc.id &&
        (!c.sceneId || c.sceneId === doc.parent?.id));
    const history = inCombat ? doc.movementHistory ?? [] : [];
    const measure = points => {
        if (token.measureMovementPath) return token.measureMovementPath(points, {preview: true}).cost / (grid.distance || 1);
        if (doc.measureMovementPath) return doc.measureMovementPath(points).cost / (grid.distance || 1);
        if (grid.measurePath) return grid.measurePath(points.map(point => ({x: point.x + token.w / 2, y: point.y + token.h / 2}))).distance / (grid.distance || 1);
        return points.slice(1).reduce((cost, point, n) => cost +
            (Math.abs(point.x - points[n].x) + Math.abs(point.y - points[n].y)) / grid.size, 0);
    };
    const traits = terrainTraits(token.actor, doc);
    const terrainCache = new Map();
    const terrain = cell => {
        const key = cellKey(cell);
        if (!terrainCache.has(key)) {
            const point = grid.getTopLeftPoint(cell);
            terrainCache.set(key, terrainAt(doc.parent ?? board.scene, {x: point.x + grid.size / 2,
                y: point.y + grid.size / 2, elevation: at.elevation ?? doc.elevation ?? 0}));
        }
        return terrainCache.get(key);
    };
    const pastCells = history.length > 1 ? nativeCellPath(doc, history, grid) : [];
    const spent = history.length > 1 ? Math.max(0, measure(history) + terrainRouteState(pastCells, terrain, traits).extra) : 0;
    const actionReason = unitActionReason(token, {combat, movement: true});
    const unrestricted = !inCombat;
    // Open Field: +3 Move when the phase's movement starts on terrain without a movement penalty.
    const start = history.length ? history[0] : at;
    const startRule = terrainMovement(terrain(grid.getOffset({x: Number(start.x) + 1, y: Number(start.y) + 1})).key, traits);
    const openField = hasSkill(token.actor, "open field") && !startRule.blocked && !startRule.extra ? 3 : 0;
    const allowance = actionReason ? 0 : unrestricted ? Infinity : Math.max(0, stats.movement + openField - spent);
    const waypoint = cell => ({...grid.getTopLeftPoint(cell), elevation: at.elevation ?? doc.elevation ?? 0,
        width: doc.width, height: doc.height, shape: doc.shape, action: doc.movementAction,
        snapped: true, explicit: true, checkpoint: true});
    const center = cell => {
        const point = grid.getTopLeftPoint(cell);
        return {x: point.x + token.w / 2, y: point.y + token.h / 2};
    };
    const occupied = new Map();
    const solid = solidTileCells(doc.parent?.tiles ? doc.parent : board.scene, grid);
    for (const other of board.tokens.placeables) {
        if (other === token || other.document.id && other.document.id === doc.id || other.destroyed || unavailableUnit(other)) continue;
        const placed = storedPosition(other.document);
        const [i0, j0, i1, j1] = grid.getOffsetRange({x: placed.x, y: placed.y, width: other.w, height: other.h});
        const friendly = sameAllegiance(doc, other.document, combat);
        for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) {
            const key = cellKey({i, j});
            occupied.set(key, occupied.has(key) ? occupied.get(key) && friendly : friendly);
        }
    }
    const canOccupy = (cell, passing) => {
        const point = grid.getTopLeftPoint(cell);
        if (point.x < rect.x || point.y < rect.y || point.x + token.w > rect.right || point.y + token.h > rect.bottom) return false;
        const [i0, j0, i1, j1] = grid.getOffsetRange({...point, width: token.w, height: token.h});
        for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) {
            if (solid.has(cellKey({i, j}))) return false;
            if (terrainMovement(terrain({i, j}).key, traits).blocked) return false;
            const friendly = occupied.get(cellKey({i, j}));
            if (friendly !== undefined && (!passing || !friendly && !hasSkill(token.actor, "pass"))) return false;
        }
        return true;
    };
    const canTraverse = (from, to) => !token.checkCollision(center(to), {origin: center(from), type: "move", mode: "any"});
    const fullCells = cells => pastCells.length ? [...pastCells, ...cells.slice(1)] : cells;
    const costRoute = cells => {
        if (unrestricted) return Math.max(0, cells.length - 1);
        const state = terrainRouteState(fullCells(cells), terrain, traits);
        return state.valid ? Math.max(0, measure([...history, ...cells.map(waypoint)]) + state.extra) - spent : Infinity;
    };
    const validate = cells => {
        if (actionReason && cells.length > 1) return false;
        if (!cells.length || cellKey(cells[0]) !== cellKey(origin) || !canOccupy(cells.at(-1), false)) return false;
        if (cells.slice(1).some(cell => cell.displaced)) return false;
        for (let n = 1; n < cells.length; n++) {
            if (!canOccupy(cells[n], true) || !canTraverse(cells[n - 1], cells[n])) return false;
        }
        return costRoute(cells) <= allowance + 1e-6;
    };
    const searchKey = (cell, path) => {
        if (unrestricted) return cellKey(cell);
        const full = fullCells(path);
        const last = full.at(-1), previous = full.at(-2) ?? last;
        const state = terrainRouteState(full, terrain, traits);
        const terrainKey = `${cellKey(cell)}:${Math.sign(last.i - previous.i)},${Math.sign(last.j - previous.j)}:${Math.min(2, state.iceSteps)}`;
        if (![4, 5].includes(grid.diagonals)) return terrainKey;
        const diagonals = path.slice(1).filter((p, n) => p.i !== path[n].i && p.j !== path[n].j).length;
        return `${terrainKey}:${diagonals % 2}`;
    };
    const bounds = grid.getOffsetRange(rect);
    // The reachable-square search runs only when tiles or a route are needed; without a Move limit, only for detours.
    let forecast = null;
    const search = () => forecast ??= buildTacticalForecast({origin, ...stats, ...(unrestricted ? {ranges: []} : {}),
        movement: unrestricted ? (actionReason ? 0 : Math.min(UNRESTRICTED_SEARCH, (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]))) : allowance, bounds,
        canEnter: cell => canOccupy(cell, true), canStop: cell => canOccupy(cell, false), canTraverse,
        getNeighbors: grid.getAdjacentOffsets ? cell => grid.getAdjacentOffsets(cell) : undefined, costRoute, searchKey});
    const route = destination => {
        if (actionReason || unrestricted && !canOccupy(destination, false)) return [];
        if (!unrestricted && !search().movementCells.has(cellKey(destination))) return [];
        const direct = nativeCellPath(doc, [waypoint(origin), waypoint(destination)], grid);
        if (validate(direct)) return direct;
        return search().movementCells.has(cellKey(destination)) ? routeToCell(search(), destination) : [];
    };
    return {grid, origin, allowance, unrestricted, get forecast() { return search(); }, waypoint, validate, route, costRoute, actionReason, canOccupy, canTraverse};
}
