import {SYSTEM_ID, terrainAt, terrainMovement, terrainTraits} from "../map/terrain.mjs";
import {allegianceOf, hasEscaped, escapeUnitIds, objectiveTileIds, isSlain} from "./encounter-rules.mjs";
import {cellKey} from "../map/tactical-grid.mjs";
import {hasInfiniteUses} from "../rules/feue.mjs";
import {hasSkill} from "../skills/skill-names.mjs";
import {hasKnockedOut} from "../rules/alt-rules.mjs";

export const eventFlags = document => (document?.document ?? document)?.flags?.[SYSTEM_ID] ?? {};
const docOf = value => value?.document ?? value;
const itemsOf = token => Array.from(docOf(token)?.actor?.items ?? []);
const normalize = value => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Use the encounter's explicit assignments, including factions sharing a disposition. */
export function unitAllegiance(token, combat = null) {
    const doc = docOf(token);
    const combatant = Array.from(combat?.combatants ?? []).find(c => c.tokenId === doc.id &&
        (!c.sceneId || c.sceneId === doc.parent?.id));
    return allegianceOf(combatant ?? {token: doc, flags: {}, parent: combat}, combat);
}

export const sameAllegiance = (a, b, combat) => unitAllegiance(a, combat).id === unitAllegiance(b, combat).id;
export const interactEnabled = token => eventFlags(token).interact !== false;
export const isCarried = token => !!eventFlags(token).rescuedBy;
export const isEscaped = token => hasEscaped(docOf(token));
export const unavailableUnit = token => isCarried(token) || isEscaped(token);

export function objectiveInteractionReason(source, target, action, combat) {
    const objective = combat?.flags?.[SYSTEM_ID]?.objective;
    if (!combat?.started || objective?.type !== action) return `An active ${action === "seize" ? "Seize" : "Escape"} objective is required.`;
    const unit = Array.from(combat.combatants ?? []).find(c => c.tokenId === source.id && (!c.sceneId || c.sceneId === source.parent.id));
    if (!unit || isSlain(unit)) return "This unit must be a living encounter participant.";
    if (!objectiveTileIds(combat, action).includes(target.id)) return "This Tile is not part of the encounter objective.";
    if (action === "seize") {
        if (allegianceOf(unit, combat).id !== (objective.allegiance || "player")) return "This unit's allegiance cannot Seize this objective.";
        return combat.flags?.[SYSTEM_ID]?.eventProgress?.seized?.includes(target.id) ? "Already seized." : "";
    }
    return escapeUnitIds(combat).includes(unit.id) || allegianceOf(unit, combat).id === (objective.allegiance || "player") ? "" : "This unit is not eligible to escape.";
}

export function breakWeapon(source) {
    return itemsOf(source).find(item => item.type === "weapon" && item.system?.equipped && normalize(item.system.weaponType) !== "staff" &&
        (hasInfiniteUses(item.system.uses) || !(Number(item.system.uses?.max) > 0 && Number(item.system.uses.value) <= 0)));
}

export function breakAttack(source, tile) {
    const doc = docOf(source), weapon = breakWeapon(doc), flags = eventFlags(tile);
    // Demolish destroys the structure outright, with or without a weapon.
    if (hasSkill(doc.actor, "demolish")) {
        const hp = Math.max(0, Number(flags.breakHP ?? flags.breakMaxHP ?? 20) || 0);
        return {weapon: null, power: hp, defense: Math.max(0, Number(flags.breakDefense) || 0), hp, damage: hp, remaining: 0, broken: true, demolish: true};
    }
    if (!weapon) throw Error("Equip an unbroken attacking weapon to Break this object.");
    const type = normalize(weapon.system.weaponType), properties = weapon.system.properties ?? {};
    const stat = properties.puncture ? 0 : Number(properties.magical || ["anima", "light", "dark"].includes(type) ? doc.actor.system.attributes?.magic?.value :
        properties.mechanical || type === "firearm" ? doc.actor.system.attributes?.speed?.value : doc.actor.system.attributes?.strength?.value) || 0;
    const prepared = doc.actor.sheet?._computeAttackStats?.(weapon, "none");
    const power = Math.max(0, Math.floor(prepared?.rawDmg ?? (Number(weapon.system.might) || 0) + stat));
    const defense = Math.max(0, Number(flags.breakDefense) || 0), hp = Math.max(0, Number(flags.breakHP ?? flags.breakMaxHP ?? 20) || 0);
    const damage = Math.max(0, power - defense), remaining = Math.max(0, hp - damage);
    return {weapon, power, defense, hp, damage, remaining, broken: remaining === 0};
}

/** Footprint cells. Defaults to the saved position, which leads the document's x/y while a move animates. */
export function tokenCells(token, grid, position = null) {
    const doc = docOf(token);
    position ??= {x: doc?._source?.x ?? doc?.x, y: doc?._source?.y ?? doc?.y};
    const [i0, j0, i1, j1] = grid.getOffsetRange({x: position.x, y: position.y,
        width: doc.width * grid.size, height: doc.height * grid.size});
    const cells = [];
    for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) cells.push({i, j});
    return cells;
}

/** A rotated Tile blocks every square its rectangle overlaps (edge contact is not overlap). */
export function tileCells(tile, grid) {
    const doc = docOf(tile), width = Math.abs(doc.width), height = Math.abs(doc.height);
    const angle = Number(doc.rotation || 0) * Math.PI / 180;
    const u = {x: Math.cos(angle), y: Math.sin(angle)}, v = {x: -u.y, y: u.x};
    const center = {x: doc.x + width / 2, y: doc.y + height / 2};
    const hx = (width * Math.abs(u.x) + height * Math.abs(v.x)) / 2;
    const hy = (width * Math.abs(u.y) + height * Math.abs(v.y)) / 2;
    const [i0, j0, i1, j1] = grid.getOffsetRange({x: center.x - hx, y: center.y - hy, width: hx * 2, height: hy * 2});
    const cells = [], half = grid.size / 2;
    for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) {
        const point = grid.getTopLeftPoint({i, j});
        const delta = {x: point.x + half - center.x, y: point.y + half - center.y};
        if ([{x: 1, y: 0}, {x: 0, y: 1}, u, v].every(axis =>
            Math.abs(delta.x * axis.x + delta.y * axis.y) <
            width / 2 * Math.abs(u.x * axis.x + u.y * axis.y) +
            height / 2 * Math.abs(v.x * axis.x + v.y * axis.y) +
            half * (Math.abs(axis.x) + Math.abs(axis.y)) - 1e-6)) cells.push({i, j});
    }
    return cells;
}

export function solidTileCells(scene, grid) {
    return new Set(Array.from(scene?.tiles ?? []).filter(tile => eventFlags(tile).solid)
        .flatMap(tile => tileCells(tile, grid)).map(cellKey));
}

export function footprintDistance(a, b) {
    let distance = Infinity;
    for (const x of a) for (const y of b) distance = Math.min(distance, Math.abs(x.i - y.i) + Math.abs(x.j - y.j));
    return distance;
}

export function openCredential(token, kind) {
    const items = itemsOf(token);
    const skill = items.find(item => item.type === "skill" && normalize(item.name) === "locktouch");
    if (skill) return {item: skill, consume: false};
    // Lockpicks require the Lockpick Usage skill (Items table: "Only used with Lockpick Use skill").
    for (const name of [kind === "door" ? "door key" : "chest key", ...(hasSkill(docOf(token)?.actor, "lockpick usage") ? ["lockpick"] : [])]) {
        const item = items.find(item => item.type === "item" && normalize(item.name) === name &&
            Number(item.system?.quantity ?? 1) > 0 &&
            (Number(item.system?.uses?.max) > 0 ? Number(item.system.uses.value) > 0 : true));
        if (item) return {item, consume: !hasInfiniteUses(item.system.uses)};
    }
    return null;
}

export function interactionReason(source, target, action, grid, combat = null) {
    source = docOf(source); target = docOf(target);
    if (source?.actor?.type !== "character" || !interactEnabled(source) || unavailableUnit(source)) return "This unit cannot interact.";
    if (!target || target === source || target.id === source.id && target.documentName === source.documentName) return "Choose another object.";
    if (target.parent?.id !== source.parent?.id) return "The target is in another scene.";
    if (target.hidden) return "The target is hidden.";
    const unit = target.actor?.type === "character", flags = eventFlags(target);
    const distance = footprintDistance(tokenCells(source, grid), unit ? tokenCells(target, grid) : tileCells(target, grid));
    if (unit) {
        if (!interactEnabled(target) || unavailableUnit(target)) return "This unit cannot be interacted with.";
        if (distance !== 1 || Number(source.elevation ?? 0) !== Number(target.elevation ?? 0)) return "Stand adjacent to the unit.";
        if (action === "talk") return flags.talk === false ? "Talk is disabled for this unit." : "";
        if (action === "slay") {
            if (!(Number(target.actor.system.attributes?.hp?.value) <= 0 && hasKnockedOut(target.actor))) return "Only Knocked Out units can be slain.";
            return sameAllegiance(source, target, combat) ? "You cannot slay an ally." : "";
        }
        if (action !== "rescue") return "That interaction requires an Event Tile.";
        if (flags.rescuable === false) return "Rescue is disabled for this unit.";
        if (Array.from(target.actor.items ?? []).some(item => item.type === "battalion")) return "Units with a Battalion cannot be rescued.";
        const group = unitAllegiance(target, combat);
        const neutral = Number(group.disposition ?? target.disposition) === 0;
        if (!sameAllegiance(source, target, combat) && !neutral) return "Only allies or neutral units can be rescued.";
        if (eventFlags(source).rescuedTokenId || flags.rescuedTokenId || target.actor.system.rescue?.active) return "A unit already carrying someone cannot be rescued or carry another unit.";
        if (!(Number(source.actor.system.combat?.aid) > Number(target.actor.system.attributes?.build?.value))) return "Rescue requires Aid greater than the target's Build.";
        return "";
    }
    if (!flags.interactable) return "This Tile is not interactable.";
    if (distance !== (flags.solid ? 1 : 0)) return flags.solid ? "Stand adjacent to the solid Tile." : "Stand on the Tile.";
    const kind = flags.interactionType ?? "activate";
    if (["seize", "escape"].includes(action) && kind === action) return objectiveInteractionReason(source, target, action, combat);
    if (action === "break" && kind === "break") {
        if (!(Number(flags.breakHP ?? flags.breakMaxHP ?? 20) > 0)) return "Already broken.";
        return breakWeapon(source) || hasSkill(source.actor, "demolish") ? "" : "Equip an unbroken attacking weapon to Break this object.";
    }
    if (action === "open" && ["door", "chest"].includes(kind)) {
        if (flags.opened) return "Already opened.";
        return openCredential(source, kind) ? "" : `Requires a ${kind === "door" ? "Door Key" : "Chest Key"}, a Lockpick with Lockpick Usage, or the Locktouch skill.`;
    }
    return action === "activate" && kind === "activate" ? "" : "That interaction does not apply to this Tile.";
}

export function nearbyInteractions(source, scene, grid, combat = null, {visible = () => true} = {}) {
    source = docOf(source);
    if (!interactEnabled(source) || unavailableUnit(source)) return [];
    const sourceCells = tokenCells(source, grid), choices = [];
    for (const target of scene.tokens ?? []) {
        if (target.id === source.id || target.actor?.type !== "character" || target.hidden || !visible(target) || unavailableUnit(target) || !interactEnabled(target)) continue;
        if (footprintDistance(sourceCells, tokenCells(target, grid)) !== 1) continue;
        const knockedOut = Number(target.actor.system.attributes?.hp?.value) <= 0 && hasKnockedOut(target.actor);
        for (const action of knockedOut ? ["rescue", "slay"] : ["talk", "rescue"]) {
            if (action !== "slay" && eventFlags(target)[action === "talk" ? "talk" : "rescuable"] === false) continue;
            choices.push({action, targetType: "Token", targetId: target.id, name: target.name,
                reason: interactionReason(source, target, action, grid, combat)});
        }
    }
    for (const target of scene.tiles ?? []) {
        const flags = eventFlags(target);
        if (!flags.interactable || target.hidden || !visible(target) || footprintDistance(sourceCells, tileCells(target, grid)) !== (flags.solid ? 1 : 0)) continue;
        if (flags.interactionType === "reinforcement") continue;
        const action = ["door", "chest"].includes(flags.interactionType) ? "open" : ["seize", "escape", "break"].includes(flags.interactionType) ? flags.interactionType : "activate";
        const name = flags.eventName || target.name || "Event Tile";
        choices.push({action, targetType: "Tile", targetId: target.id, name: action === "break" ? `${name} (HP ${flags.breakHP ?? flags.breakMaxHP ?? 20}/${flags.breakMaxHP ?? 20}, DEF ${flags.breakDefense ?? 0})` : name,
            reason: interactionReason(source, target, action, grid, combat)});
    }
    return choices;
}

const rescueBase = new WeakMap();
export const getRescueBase = actor => rescueBase.get(actor);
export function rescueMovementHalved(actor) {
    return !!actor.system.rescue?.active && !terrainTraits(actor).types.has("mounted") && !terrainTraits(actor).types.has("flying");
}

/** Called once per fresh preparation, before attack speed and Avoid are calculated. */
export function applyRescueStats(actor) {
    const speed = actor.system.attributes.speed, movement = actor.system.movement;
    rescueBase.set(actor, {speed: {...speed}, movement: {...movement}});
    if (!actor.system.rescue?.active) return;
    speed.value = Math.floor(speed.value / 2);
    speed.max = Math.floor(speed.max / 2);
    if (rescueMovementHalved(actor)) {
        movement.base = Math.floor(movement.base / 2);
        movement.current = Math.floor(movement.current / 2);
    }
}

/** Drop checks work even when the active GM is viewing a different scene. */
export function placementReason(target, position, scene, grid, {elevation = target.elevation ?? 0, reserved = new Set()} = {}) {
    const cells = tokenCells(target, grid, position);
    const rect = scene.dimensions?.sceneRect ?? {x: 0, y: 0, right: scene.width, bottom: scene.height};
    if (position.x < rect.x || position.y < rect.y || position.x + target.width * grid.size > rect.right ||
        position.y + target.height * grid.size > rect.bottom) return "That square is outside the scene.";
    const solid = solidTileCells(scene, grid), traits = terrainTraits(target.actor, target);
    for (const cell of cells) {
        if (reserved.has(cellKey(cell))) return "That square is occupied.";
        if (solid.has(cellKey(cell))) return "A solid Tile blocks that square.";
        const point = grid.getTopLeftPoint(cell);
        if (terrainMovement(terrainAt(scene, {x: point.x + grid.size / 2, y: point.y + grid.size / 2,
            elevation}).key, traits).blocked) return "That terrain is impassable.";
        if (Array.from(scene.tokens ?? []).some(other => other.id !== target.id && !unavailableUnit(other) &&
            tokenCells(other, grid).some(c => cellKey(c) === cellKey(cell)))) return "That square is occupied.";
    }
    return "";
}

export function wallBlocks(scene, a, b) {
    for (const wall of scene.walls ?? []) {
        if (!wall.move || wall.door && wall.ds === 1) continue;
        const [x1, y1, x2, y2] = wall.c;
        const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
        const c = {x: x1, y: y1}, d = {x: x2, y: y2};
        if (cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0 &&
            Math.max(a.x, b.x) >= Math.min(x1, x2) && Math.max(x1, x2) >= Math.min(a.x, b.x) &&
            Math.max(a.y, b.y) >= Math.min(y1, y2) && Math.max(y1, y2) >= Math.min(a.y, b.y)) return true;
    }
    return false;
}

export function dropReason(source, target, position, scene, grid) {
    if (footprintDistance(tokenCells(source, grid), tokenCells(target, grid, position)) !== 1) return "Drop into an adjacent square.";
    const reason = placementReason(target, position, scene, grid, {elevation: source.elevation ?? 0});
    if (reason) return reason;
    const a = {x: source.x + source.width * grid.size / 2, y: source.y + source.height * grid.size / 2};
    const b = {x: position.x + target.width * grid.size / 2, y: position.y + target.height * grid.size / 2};
    return wallBlocks(scene, a, b) ? "A wall blocks that square." : "";
}

export function dropPositions(source, target, scene, grid) {
    const positions = new Map();
    // All four edges, including targets or carriers with larger footprints.
    const [i0, j0, i1, j1] = grid.getOffsetRange({x: source.x, y: source.y, width: source.width * grid.size, height: source.height * grid.size});
    const tw = Math.ceil(target.width), th = Math.ceil(target.height);
    for (let i = i0 - th; i <= i1; i++) for (let j = j0 - tw; j <= j1; j++) {
        const cell = {i, j}, point = grid.getTopLeftPoint(cell);
        if (!dropReason(source, target, point, scene, grid)) positions.set(cellKey(cell), point);
    }
    return positions;
}
