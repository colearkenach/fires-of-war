/** Pure Combat AI rules: behaviours, encounter settings, exchange odds, option scores and the approach field.
 * Nothing here touches Foundry documents, so it can be tested on its own. */

const SYSTEM = "fires-of-war";

export const AI_BEHAVIORS = Object.freeze({
    charge: {label: "Charge", hint: "Attacks the best target it can reach this phase; otherwise advances toward the nearest enemy."},
    hold: {label: "Hold", hint: "Moves only to attack or heal a unit it can reach this phase; otherwise stays where it is."},
    stationary: {label: "Stationary", hint: "Never moves. Attacks or heals units in range of its own square, like a boss on a throne."},
    manual: {label: "Manual", hint: "The AI skips this unit, so the GM moves it."}
});

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));
/** <option> list for behaviour selectors; `inherit` adds the "Encounter default" entry (stored as ""). */
export function aiBehaviorOptions(selected = "", {inherit = true} = {}) {
    return `${inherit ? `<option value="">Encounter default</option>` : ""}${Object.entries(AI_BEHAVIORS).filter(([key]) => inherit || key !== "manual")
        .map(([key, behavior]) => `<option value="${key}" ${selected === key ? "selected" : ""} title="${esc(behavior.hint)}">${esc(behavior.label)}</option>`).join("")}`;
}
export const aiBehaviorHints = () => Object.values(AI_BEHAVIORS).map(behavior => `<b>${esc(behavior.label)}</b>: ${esc(behavior.hint)}`).join(" ");

/** Encounter-wide AI options. Allegiances opt in individually with `ai: true` on their saved entry. */
export function aiSettings(combat) {
    const saved = combat?.flags?.[SYSTEM]?.ai ?? {};
    return {behavior: AI_BEHAVIORS[saved.behavior] && saved.behavior !== "manual" ? saved.behavior : "charge", autoEnd: saved.autoEnd !== false};
}

/** A unit's own behaviour ("" uses the encounter default). */
export function unitBehavior(token, combat) {
    const own = (token?.document ?? token)?.flags?.[SYSTEM]?.aiBehavior;
    return AI_BEHAVIORS[own] ? own : aiSettings(combat).behavior;
}

const chance = value => Math.min(1, Math.max(0, Math.floor(Number(value) || 0) / 100));

/** One strike's odds and damage, mirroring _computeAttackStats and resolveWeaponEffects
 * (critical hits triple damage before damage-taken adjustments; Shade halves current HP). */
export function strikeProfile(stats) {
    if (!stats) return null;
    const props = stats.props ?? {};
    const scale = netDamage => Math.floor(Math.max(0, Math.floor(Math.max(props.deadly ? 1 : 0, netDamage) * (stats.damageMultiplier ?? 1)) +
        Number(stats.damageAdjust || 0)) * (stats.takenMultiplier ?? 1));
    return {hit: chance(stats.netHit), crit: props.shade ? 0 : chance(stats.netCrit), damage: scale(Number(stats.netDmg) || 0),
        critDamage: scale((Number(stats.netDmg) || 0) * 3), shade: !!props.shade};
}

const shadeDamage = hp => hp - (hp <= 1 ? 0 : Math.max(1, Math.floor(hp / 2)));

/**
 * Probability distribution of an exchange. `order` lists "attacker"/"defender" strikes; a side without a
 * strike profile skips its turns. Returns the chance that the defender falls (kill) or the attacker falls
 * (death), and the expected HP each side loses.
 */
export function exchangeOutcome({order, attacker, defender}) {
    let states = new Map([[`${attacker.hp},${defender.hp}`, {a: attacker.hp, d: defender.hp, p: 1}]]);
    for (const side of order ?? []) {
        const strike = side === "attacker" ? attacker.strike : defender.strike;
        if (!strike) continue;
        const next = new Map();
        const add = (a, d, p) => {
            if (p <= 0) return;
            const key = `${a},${d}`, state = next.get(key);
            if (state) state.p += p; else next.set(key, {a, d, p});
        };
        for (const {a, d, p} of states.values()) {
            if (a <= 0 || d <= 0) { add(a, d, p); continue; }
            const hp = side === "attacker" ? d : a;
            const normal = strike.shade ? shadeDamage(hp) : strike.damage, critical = strike.shade ? shadeDamage(hp) : strike.critDamage;
            const apply = damage => side === "attacker" ? [a, Math.max(0, d - damage)] : [Math.max(0, a - damage), d];
            add(a, d, p * (1 - strike.hit));
            add(...apply(normal), p * strike.hit * (1 - strike.crit));
            add(...apply(critical), p * strike.hit * strike.crit);
        }
        states = next;
    }
    const result = {kill: 0, death: 0, dealt: 0, taken: 0};
    for (const {a, d, p} of states.values()) {
        if (d <= 0) result.kill += p;
        if (a <= 0) result.death += p;
        result.dealt += p * (defender.hp - d);
        result.taken += p * (attacker.hp - a);
    }
    return result;
}

/** Higher is better. Kills come first, then damage (raw and as a share of the target's HP), while
 * retaliation, the chance of falling and the action's own cost weigh against it. */
export function scoreAttack({outcome, targetHp, priority = 0, cover = 0, threat = 0, moveCost = 0, cost = 0}) {
    if (!(outcome.dealt > 0) && !(outcome.kill > 0)) return -Infinity;
    return outcome.kill * 60 + outcome.dealt * 1.5 + outcome.dealt / Math.max(1, targetHp) * 25 -
        outcome.taken * 0.75 - outcome.death * 45 + priority + cover * 0.5 - threat - moveCost * 0.05 - cost;
}

/** Healing worth a turn: the restored HP, more for badly hurt allies; healers prefer squares fewer enemies reach. */
export function scoreHeal({amount, hp, maxHp, cover = 0, threat = 0, moveCost = 0, cost = 0, minimumShare = 0}) {
    const missing = Math.max(0, maxHp - hp), restored = Math.min(Math.max(0, amount), missing);
    if (restored <= 0 || maxHp <= 0 || missing / maxHp < minimumShare) return -Infinity;
    return restored * 1.5 + missing / maxHp * 40 + (hp / maxHp <= 0.5 ? 10 : 0) + cover * 0.3 - threat * 4 - moveCost * 0.05 - cost;
}

/** Bonus for attacking units that matter: healers, low HP, and the encounter's bosses or required units. */
export function targetPriority({healer = false, hp = 0, maxHp = 1, objective = false}) {
    return (healer ? 6 : 0) + (maxHp > 0 && hp / maxHp <= 0.35 ? 4 : 0) + (objective ? 8 : 0);
}

/** Terrain cover for a destination square: Avoid counts a tenth as much as DEF. */
export const coverValue = terrain => (Number(terrain?.avoid) || 0) / 10 + (Number(terrain?.defense) || 0);

/** Squares between a cell and a footprint of cells (orthogonal, as attack ranges are measured). */
export function cellDistance(cell, footprint) {
    let best = Infinity;
    for (const other of footprint) best = Math.min(best, Math.abs(cell.i - other.i) + Math.abs(cell.j - other.j));
    return best;
}

/** How many hostile units could reach and attack this cell next phase (movement + longest range, as the crow walks). */
export function threatCount(cell, hostiles) {
    return hostiles.filter(unit => cellDistance(cell, unit.cells) <= unit.reach).length;
}

/** Cost of a diagonal step for Foundry's grid diagonal rules (null: diagonals are not allowed). */
export function diagonalStep(rule) {
    return {0: 1, 1: Math.SQRT2, 2: 1.5, 3: 2, 4: 1.5, 5: 1.5}[rule] ?? null;
}

class MinHeap {
    items = [];
    get size() { return this.items.length; }
    push(item) {
        const items = this.items;
        items.push(item);
        for (let n = items.length - 1; n > 0;) {
            const parent = (n - 1) >> 1;
            if (items[parent].cost <= items[n].cost) break;
            [items[parent], items[n]] = [items[n], items[parent]];
            n = parent;
        }
    }
    pop() {
        const items = this.items, top = items[0], last = items.pop();
        if (items.length) {
            items[0] = last;
            for (let n = 0; ;) {
                const left = n * 2 + 1, right = left + 1;
                let small = n;
                if (left < items.length && items[left].cost < items[small].cost) small = left;
                if (right < items.length && items[right].cost < items[small].cost) small = right;
                if (small === n) break;
                [items[small], items[n]] = [items[n], items[small]];
                n = small;
            }
        }
        return top;
    }
}

/**
 * Remaining movement cost from every square to the nearest goal square, searched backwards from the goals.
 * `enterCost(cell)` is the extra cost of entering a square (Infinity when the unit cannot stand or pass there),
 * `traverse(from, to)` rejects steps through walls, and `diagonal` is the diagonal step cost or null.
 * Bounds are [i0, j0, i1, j1) like Foundry's getOffsetRange.
 */
export function approachField({goals, bounds, enterCost, traverse = () => true, diagonal = null}) {
    const [i0, j0, i1, j1] = bounds;
    const inside = ({i, j}) => i >= i0 && j >= j0 && i < i1 && j < j1;
    const key = ({i, j}) => `${i},${j}`;
    const distance = new Map(), heap = new MinHeap();
    const steps = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1]];
    if (diagonal) steps.push([1, 1, diagonal], [1, -1, diagonal], [-1, 1, diagonal], [-1, -1, diagonal]);
    for (const goal of goals) {
        if (!inside(goal) || !Number.isFinite(enterCost(goal)) || distance.has(key(goal))) continue;
        distance.set(key(goal), 0);
        heap.push({i: goal.i, j: goal.j, cost: 0});
    }
    while (heap.size) {
        const node = heap.pop();
        if (node.cost > distance.get(key(node))) continue;
        // Moving from `from` into `node` costs the step plus the terrain cost of entering `node`.
        const entering = enterCost(node);
        for (const [di, dj, step] of steps) {
            const from = {i: node.i + di, j: node.j + dj};
            if (!inside(from) || !Number.isFinite(enterCost(from)) || !traverse(from, node)) continue;
            const cost = node.cost + step + entering;
            if (cost >= (distance.get(key(from)) ?? Infinity)) continue;
            distance.set(key(from), cost);
            heap.push({...from, cost});
        }
    }
    return distance;
}

/** Cells from which a target footprint lies within one of the ranges. */
export function rangeGoals(footprint, ranges, bounds) {
    const max = Math.max(0, ...ranges.map(range => range.max));
    const [i0, j0, i1, j1] = bounds, goals = new Map();
    for (const cell of footprint) {
        for (let i = Math.max(i0, cell.i - max); i < Math.min(i1, cell.i + max + 1); i++) {
            const span = max - Math.abs(i - cell.i);
            for (let j = Math.max(j0, cell.j - span); j < Math.min(j1, cell.j + span + 1); j++) {
                const distance = cellDistance({i, j}, footprint);
                if (ranges.some(range => distance >= range.min && distance <= range.max)) goals.set(`${i},${j}`, {i, j});
            }
        }
    }
    return [...goals.values()];
}
