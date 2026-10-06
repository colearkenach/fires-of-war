/** Pure forecast search. Foundry supplies neighbors and movement costs at runtime. */
import {hasSkill, canonicalSkillName} from "../skills/skill-names.mjs";
export const cellKey = ({i, j}) => `${i},${j}`;

export function parseAttackRange(value) {
    const ranges = [];
    for (const part of String(value ?? "").split(/[,;/]/)) {
        const match = part.trim().match(/^(\d+)(?:\s*[-–—]\s*(\d+))?$/);
        if (!match) continue;
        const min = Number(match[1]);
        const max = Number(match[2] ?? match[1]);
        if (Number.isSafeInteger(min) && Number.isSafeInteger(max) && min > 0 && max >= min) {
            ranges.push({min, max});
        }
    }
    return ranges;
}

export function getForecastStats(actor) {
    const move = Number(actor?.system?.movement?.base);
    const weapon = actor?.items?.find(item => item.type === "weapon" && item.system?.equipped);
    // Remove Durability marks prepared weapon uses as infinite.
    const broken = weapon?.system?.uses?.infinite !== true && Number(weapon?.system?.uses?.max) > 0 && Number(weapon.system.uses.value) <= 0;
    const attacking = weapon && String(weapon.system.weaponType ?? "").trim().toLowerCase() !== "staff" && !broken;
    return {
        movement: Number.isFinite(move) ? Math.max(0, Math.floor(move)) : 0,
        ranges: attacking ? effectiveAttackRange(actor, weapon) : [],
        weapon: attacking ? weapon : null
    };
}
/**
 * Weapon range with skills: Bow/Firearm Range +X (highest applies), Overdraw (+1 when initiating with a Bow),
 * Rifled Barrel (Ballistae ±1) and Close Range / Close Counter. Pass overdraw: false for the unmodified range.
 */
export function effectiveAttackRange(actor, weapon, {retaliation = false, overdraw = true} = {}) {
    const type = String(weapon?.system?.weaponType ?? "").toLowerCase();
    let bonus = 0;
    if (["bow", "firearm"].includes(type)) for (const skill of actor?.items ?? []) {
        const match = skill.type === "skill" && canonicalSkillName(skill.name).match(new RegExp(`^${type} range \\+(\\d+)$`));
        if (match && skill.system?.automation?.mode !== "off") bonus = Math.max(bonus, Number(match[1]));
    }
    if (type === "bow" && !retaliation && overdraw && hasSkill(actor, "overdraw")) bonus += 1;
    const properties = weapon?.system?.properties;
    const vehicle = typeof properties === "string" || Array.isArray(properties) ? /\bvehicle\b/i.test(String(properties)) : !!properties?.vehicle;
    const barrel = type === "bow" && vehicle && hasSkill(actor, "rifled barrel") ? 1 : 0;
    const ranges = parseAttackRange(weapon?.system?.range).map(r => ({min: Math.max(1, r.min - barrel), max: r.max + bonus + barrel}));
    if (type === "bow" && hasSkill(actor, retaliation ? "close counter" : "close range")) ranges.push({min: 1, max: 1});
    return ranges;
}

/**
 * A bounded Dijkstra search handles Foundry's fractional/alternating diagonal costs.
 * Friendly occupied cells may be crossed, but only valid destinations project attack reach.
 * Bounds use exclusive upper limits, matching Foundry's getOffsetRange.
 */
export function buildTacticalForecast({origin, movement, ranges = [], bounds,
    canEnter = () => true, canStop = () => true, canTraverse = () => true,
    getNeighbors = cell => [[0, 1], [1, 0], [0, -1], [-1, 0]].map(([di, dj]) => ({i: cell.i + di, j: cell.j + dj})),
    costRoute = path => path.length - 1, searchKey = cellKey}) {
    const [i0, j0, i1, j1] = bounds;
    const inside = ({i, j}) => i >= i0 && j >= j0 && i < i1 && j < j1;
    const nodes = new Map();
    const movementCells = new Map();
    const attackCells = new Map();
    if (!inside(origin)) return {nodes, movementCells, attackCells};
    const start = {...origin, cost: 0, parent: null, path: [{...origin}]};
    nodes.set(cellKey(origin), start);
    const queue = [start];
    const best = new Map([[searchKey(origin, start.path), 0]]);
    const budget = Number.isFinite(movement) ? Math.max(0, movement) : 0;
    while (queue.length) {
        queue.sort((a, b) => b.cost - a.cost);
        const node = queue.pop();
        if (node.cost > best.get(searchKey(node, node.path))) continue;
        const nodeKey = cellKey(node);
        if (!nodes.has(nodeKey) || node.cost < nodes.get(nodeKey).cost) nodes.set(nodeKey, node);
        if ((node.cost === 0 || canStop(node)) &&
            (!movementCells.has(nodeKey) || node.cost < movementCells.get(nodeKey).cost)) movementCells.set(nodeKey, node);
        for (const neighbor of getNeighbors(node)) {
            const next = {...neighbor, parent: nodeKey, path: [...node.path, {i: neighbor.i, j: neighbor.j}]};
            const key = cellKey(next);
            if (!inside(next) || !canEnter(next) || !canTraverse(node, next)) continue;
            next.cost = costRoute(next.path);
            if (!Number.isFinite(next.cost) || next.cost > budget + 1e-6) continue;
            const stateKey = searchKey(next, next.path);
            if (best.has(stateKey) && best.get(stateKey) <= next.cost + 1e-6) continue;
            best.set(stateKey, next.cost);
            if (!nodes.has(key) || next.cost < nodes.get(key).cost) nodes.set(key, next);
            queue.push(next);
        }
    }
    // Union of weapon reach from every legal destination, with blue taking precedence.
    const maxRange = Math.min(Math.max(0, ...ranges.map(range => range.max)), (i1 - i0) + (j1 - j0));
    for (const source of movementCells.values()) {
        for (let i = Math.max(i0, source.i - maxRange); i < Math.min(i1, source.i + maxRange + 1); i++) {
            const vertical = Math.abs(i - source.i);
            const horizontal = maxRange - vertical;
            for (let j = Math.max(j0, source.j - horizontal); j < Math.min(j1, source.j + horizontal + 1); j++) {
                const distance = vertical + Math.abs(j - source.j);
                if (!ranges.some(range => distance >= range.min && distance <= range.max)) continue;
                const cell = {i, j};
                const key = cellKey(cell);
                if (!movementCells.has(key)) attackCells.set(key, cell);
            }
        }
    }
    return {nodes, movementCells, attackCells};
}

export function routeToCell(forecast, destination) {
    const key = cellKey(destination);
    if (!forecast.movementCells.has(key)) return [];
    if (forecast.movementCells.get(key).path) return forecast.movementCells.get(key).path.map(cell => ({...cell}));
    const path = [];
    let node = forecast.nodes.get(key);
    while (node) {
        path.push({i: node.i, j: node.j});
        node = node.parent === null ? null : forecast.nodes.get(node.parent);
    }
    return path.reverse();
}
