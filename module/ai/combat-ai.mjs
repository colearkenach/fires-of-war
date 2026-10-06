/** Combat AI: the active GM's client plays the phases of allegiances marked "AI" in the encounter's Objectives.
 * Units move and act through the same rules as players: movement forecasts, Battle Forecasts, spells, Combat Arts
 * and healing are resolved by the system's own code, then each unit Waits and the phase ends. */
import {SYSTEM_ID, terrainAt, terrainTraits, terrainMovement} from "../map/terrain.mjs";
import {allegiances, allegianceOf, isSlain, hasEscaped, evaluateObjective, escapeUnitIds} from "../encounter/encounter-rules.mjs";
import {unavailableUnit, tokenCells, footprintDistance, solidTileCells, unitAllegiance} from "../encounter/event-rules.mjs";
import {rootElement} from "../map/terrain-ui.mjs";
import {hasSkill} from "../skills/skill-automation.mjs";
import {unitActionReason, requestUnitCommand, withUnitActionLock} from "../units/unit-actions.mjs";
import {createMovementContext} from "../map/tactical-movement.mjs";
import {cellKey, effectiveAttackRange, getForecastStats} from "../map/tactical-grid.mjs";
import {createBattleForecast, renderBattleForecast, weaponAttackSpeed} from "../combat/battle-forecast.mjs";
import {tokenInItemRange} from "../ui/character-action-hud.mjs";
import {isSilenced} from "../rules/status-rules.mjs";
import {combatArtReason, hasInfiniteUses} from "../rules/feue.mjs";
import {sameEquipSlot, artCostMode, perMapTracked, perMapArtCost} from "../rules/alt-rules.mjs";
import {perMapArtReason} from "../rules/fall-rules.mjs";
import {PHASE_BANNER_DURATION} from "../encounter/phase-banner.mjs";
import {aiBehaviorOptions, aiBehaviorHints, aiSettings, unitBehavior, strikeProfile, exchangeOutcome, scoreAttack, scoreHeal, targetPriority, coverValue,
    cellDistance, threatCount, diagonalStep, approachField, rangeGoals} from "./ai-planner.mjs";

const SOCKET = `system.${SYSTEM_ID}`;
const PACE = {slow: 1.6, normal: 1, fast: 0.45, instant: 0};
const num =value => Number.isFinite(Number(value)) ? Number(value) : 0;
const hpOf = actor => num(actor?.system?.attributes?.hp?.value);
const maxHpOf = actor => Math.max(1, num(actor?.system?.attributes?.hp?.max));
const kind = item => String(item?.system?.weaponType ?? "").trim().toLowerCase();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const gridOf = () => canvas.grid?.getOffset ? canvas.grid : canvas.grid?.grid;
const setting = (key, fallback) => { try { return game.settings.get(SYSTEM_ID, key) ?? fallback; } catch { return fallback; } };
const pace = () => PACE[setting("combatAISpeed", "normal")] ?? 1;
const beat = ms => ms * pace() > 0 ? sleep(ms * pace()) : Promise.resolve();
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));

/** Player and Neutral units fight on the same side; every other pairing must share an allegiance (as for skill auras). */
const allied = (a, b) => a === b || ["player", "npc"].includes(a) && ["player", "npc"].includes(b);
export const phaseStamp = combat => combat?.started && combat.combatant ? `${combat.id}:${combat.round}:${allegianceOf(combat.combatant, combat).id}` : "";
export const encounterUsesAI = combat => allegiances(combat).some(group => group.ai === true);
/** The current phase's allegiance when the AI plays it. */
export function aiPhaseGroup(combat) {
    if (!combat?.started || !combat.combatant) return null;
    const group = allegianceOf(combat.combatant, combat);
    return group?.ai === true ? group : null;
}

/** Living, visible participants placed on this scene's canvas. */
function liveUnits(combat, scene) {
    return Array.from(combat.combatants).filter(c => c.token?.parent?.id === scene.id && c.token.object && c.actor?.type === "character" &&
        !c.token.hidden && !isSlain(c) && hpOf(c.actor) > 0 && !hasEscaped(c.token, combat) && !unavailableUnit(c.token));
}

/** A unit of the current phase that still has something to do (needs a Wait at least). */
function canStillAct(unit, combat) {
    const doc = unit.token;
    if (!doc?.actor || doc.hidden || isSlain(unit) || hasEscaped(doc, combat) || unavailableUnit(doc)) return false;
    return !unitActionReason(doc, {combat, free: true});
}
const phaseUnits = combat => {
    const id = combat.combatant ? allegianceOf(combat.combatant, combat).id : null;
    return id ? Array.from(combat.combatants).filter(c => allegianceOf(c, combat).id === id) : [];
};

// ---------------------------------------------------------------- What a unit can do

const usable = item => hasInfiniteUses(item.system?.uses) || !(num(item.system?.uses?.max) > 0 && num(item.system?.uses?.value) <= 0);
/** Mirrors _executeAttackStrike: vehicles need Ballista Use / Cannon Use (Ballistician covers bows). */
function vehicleBlocked(actor, weapon) {
    const props = weapon.system?.properties;
    const vehicle = typeof props === "string" || Array.isArray(props) ? /\bvehicle\b/i.test(String(props)) : !!props?.vehicle;
    if (!vehicle) return false;
    const bow = kind(weapon) === "bow";
    return !(bow && hasSkill(actor, "ballistician")) && !hasSkill(actor, bow ? "ballista use" : "cannon use");
}
/** Staves heal Mt + MAG; status staves (no Mt, or a Hit roll below 100) are left to the GM. */
const healingStaff = item => item.type === "weapon" && kind(item) === "staff" && num(item.system?.might) > 0 && !(num(item.system?.hit) > 0 && num(item.system.hit) < 100);
/** White Magic spells are cast as healing by this system. */
const healingSpell = item => item.type === "spell" && item.system?.school === "White Magic" && num(item.system?.might) > 0;

/** Mirrors spellAdmixWeapon / spellHpCost in fires-of-war.js. */
function admixWeapon(actor, spell) {
    const weapon = actor?.items?.find(i => i.type === "weapon" && i.system?.equipped);
    if (!weapon || !spell) return null;
    const key = value => String(value ?? "").trim().toLowerCase();
    const wanted = key(spell.system?.admixWeapon) || key(spell.name);
    return key(weapon.name) === wanted || key(weapon.name).includes("spell admix") ? weapon : null;
}
function spellCost(actor, spell) {
    const base = Math.max(0, num(spell.system?.hpCost));
    const cost = admixWeapon(actor, spell) ? Math.max(Math.min(base, 1), base - 2) : base;
    return hasSkill(actor, "spell mastery") ? Math.floor(cost / 2) : cost;
}
const spellWeapon = spell => ({id: spell.id, name: spell.name, type: "weapon", img: spell.img,
    system: {...spell.system, weaponType: "spell", properties: {magical: true}, uses: null}});

/** How a Combat Art is paid for (Player's Choice pays durability), or null when it cannot be afforded. */
function artPayment(actor, art, weapon) {
    const cost = Math.max(0, num(art.system?.durabilityCost));
    const pay = cost <= 0 ? "durability" : artCostMode() === "hp" ? "hp" : "durability";
    if (pay === "hp") return cost < hpOf(actor) ? {pay, hp: cost, penalty: cost} : null;
    if (perMapTracked(weapon)) return perMapArtReason(weapon, perMapArtCost(cost)) ? null : {pay, penalty: cost * 0.3};
    // Never break the weapon with an art.
    if (cost && weapon.system?.uses && !hasInfiniteUses(weapon.system.uses) && cost >= num(weapon.system.uses.value)) return null;
    return {pay, penalty: cost * 0.3};
}

function attackMeans(actor) {
    const means = [], silenced = isSilenced(actor), hp = hpOf(actor);
    for (const item of actor.items) {
        if (item.type === "weapon" && kind(item) !== "staff" && usable(item) && !vehicleBlocked(actor, item)) {
            means.push({type: "attack", item, ranges: effectiveAttackRange(actor, item), penalty: 0});
        } else if (item.type === "spell" && item.system?.school !== "White Magic" && !silenced && num(item.system?.might) > 0) {
            const cost = spellCost(actor, item);
            if (cost < hp) means.push({type: "spell", item, ranges: effectiveAttackRange(actor, item), hpCost: cost, penalty: cost});
        } else if (item.type === "combatArt") {
            for (const weapon of actor.items) {
                if (weapon.type !== "weapon" || !usable(weapon) || vehicleBlocked(actor, weapon) || combatArtReason(actor, item, weapon)) continue;
                const payment = artPayment(actor, item, weapon);
                if (payment) means.push({type: "art", item, weapon, ranges: effectiveAttackRange(actor, weapon), hpCost: payment.hp ?? 0, payment: payment.pay, penalty: payment.penalty});
            }
        }
    }
    return means.filter(means => means.ranges.length);
}

function healMeans(actor) {
    if (isSilenced(actor)) return [];
    const value = num(actor.system.attributes?.[hasSkill(actor, "performance artist") ? "charm" : "magic"]?.value), hp = hpOf(actor);
    return actor.items.filter(item => healingStaff(item) && usable(item) || healingSpell(item)).map(item => {
        const spell = item.type === "spell", nonProf = !spell && actor.canUseWeapon?.(item) === false;
        const amount = Math.floor((num(item.system.might) + value + (!spell && hasSkill(actor, "healtouch") ? 5 : 0)) * (nonProf ? 0.5 : 1));
        const cost = spell ? spellCost(actor, item) : 0;
        return {type: "heal", item, ranges: effectiveAttackRange(actor, item), amount, hpCost: cost, penalty: cost};
    }).filter(means => means.ranges.length && means.amount > 0 && means.hpCost < hp);
}

// ---------------------------------------------------------------- Forecasting from other squares

const bound = (target, key) => {
    const value = Reflect.get(target, key, target);
    return typeof value === "function" && key !== "constructor" ? value.bind(target) : value;
};
/** The token as if it stood at `point`, so forecasts use that square's terrain, auras and retaliation range.
 * Only x/y move: `_source` is a frozen own property, which a Proxy must report unchanged. */
export function tokenAt(token, point) {
    const doc = token.document;
    const document = new Proxy(doc, {get: (target, key) => key === "x" ? point.x : key === "y" ? point.y : bound(target, key)});
    const center = {x: point.x + token.w / 2, y: point.y + token.h / 2};
    return new Proxy(token, {get: (target, key) => key === "document" ? document : key === "center" ? center :
        key === "x" ? point.x : key === "y" ? point.y : bound(target, key)});
}

function evaluateAttack(actor, means, target, source, grid) {
    try {
        const targetToken = target.token.object;
        if (means.type === "attack") {
            const forecast = createBattleForecast({actor, weapon: means.item, target: target.actor, sourceToken: source, targetToken, grid, triangle: "auto"});
            return exchangeOutcome({order: forecast.order, attacker: {hp: hpOf(actor), strike: strikeProfile(forecast.attacker.stats)},
                defender: {hp: hpOf(target.actor), strike: forecast.canRetaliate ? strikeProfile(forecast.defender.stats) : null}});
        }
        const stats = singleStrikeStats(actor, means, target.actor, source, targetToken);
        return exchangeOutcome({order: ["attacker"], attacker: {hp: hpOf(actor) - (means.hpCost ?? 0), strike: strikeProfile(stats)}, defender: {hp: hpOf(target.actor), strike: null}});
    } catch (error) {
        console.warn(`FEUE | Combat AI could not forecast ${means.item.name} against ${target.name}`, error);
        return null;
    }
}

/** Spells and Combat Arts strike once and cannot be countered, as in _castSpell and _executeCombatArt. */
function singleStrikeStats(actor, means, target, sourceToken, targetToken) {
    const base = {sourceToken, targetToken, initiating: true, targetCanCounter: false};
    if (means.type === "spell") {
        const admix = !!admixWeapon(actor, means.item);
        return actor.sheet._computeAttackStats(spellWeapon(means.item), "none", target, {...base, might: admix ? 2 : 0, hit: admix ? 10 : 0, crit: admix ? 5 : 0, source: "Admix"});
    }
    const art = means.item.system ?? {};
    return actor.sheet._computeAttackStats(means.weapon, "auto", target, {...base, might: num(art.might), hit: num(art.hit), crit: num(art.crit), source: means.item.name});
}

// ---------------------------------------------------------------- Planning

/** Per-phase caches shared by every unit: terrain, solid Tiles and wall collisions do not change while the AI plans. */
export function createRunCache(scene = canvas.scene, grid = gridOf()) {
    const terrain = new Map(), walls = new Map();
    return {
        scene, grid, rect: canvas.dimensions.sceneRect, bounds: grid.getOffsetRange(canvas.dimensions.sceneRect),
        solid: solidTileCells(scene, grid),
        terrain(cell, elevation = 0) {
            const key = `${cellKey(cell)}:${elevation}`;
            if (!terrain.has(key)) {
                const point = grid.getTopLeftPoint(cell);
                terrain.set(key, terrainAt(scene, {x: point.x + grid.size / 2, y: point.y + grid.size / 2, elevation}));
            }
            return terrain.get(key);
        },
        blocked(token, from, to) {
            const key = `${token.w}x${token.h}:${cellKey(from)}>${cellKey(to)}`;
            if (!walls.has(key)) {
                const center = cell => { const point = grid.getTopLeftPoint(cell); return {x: point.x + token.w / 2, y: point.y + token.h / 2}; };
                walls.set(key, !!token.checkCollision(center(to), {origin: center(from), type: "move", mode: "any"}));
            }
            return walls.get(key);
        }
    };
}

function threatOf(unit, grid) {
    const stats = getForecastStats(unit.actor);
    const range = Math.max(0, ...stats.ranges.map(r => r.max));
    return {cells: tokenCells(unit.token, grid), reach: range ? stats.movement + range : 0};
}

function objectiveUnitIds(combat) {
    const objective = combat.flags?.[SYSTEM_ID]?.objective;
    if (objective?.type === "boss") return new Set(objective.bosses ?? []);
    if (objective?.type === "escape") return new Set(escapeUnitIds(combat));
    return new Set();
}

/**
 * The best thing for one unit to do now: {type: "attack"|"spell"|"art"|"heal", cell, path, means, target}
 * for an action, {type: "move", cell, path} to advance, or {type: "wait"}.
 */
export function planUnit(token, combat, cache) {
    const actor = token.actor, doc = token.document, grid = cache.grid;
    const behavior = unitBehavior(doc, combat);
    const context = createMovementContext(token, canvas, {combat});
    const fixed = behavior === "stationary" || !!context.actionReason;
    const reachable = fixed ? [{...context.origin, cost: 0, path: [context.origin]}] : [...context.forecast.movementCells.values()];
    const side = unitAllegiance(doc, combat).id;
    const others = liveUnits(combat, doc.parent).filter(unit => unit.tokenId !== doc.id);
    const hostiles = others.filter(unit => !allied(allegianceOf(unit, combat).id, side));
    const friends = others.filter(unit => allied(allegianceOf(unit, combat).id, side));
    const threats = hostiles.map(unit => threatOf(unit, grid));
    const attacks = attackMeans(actor), heals = healMeans(actor);
    const important = objectiveUnitIds(combat);
    const targets = hostiles.map(unit => ({unit, cells: tokenCells(unit.token, grid), priority: targetPriority({healer: healMeans(unit.actor).length > 0,
        hp: hpOf(unit.actor), maxHp: maxHpOf(unit.actor), objective: important.has(unit.id)})}));
    const patients = friends.filter(unit => hpOf(unit.actor) < maxHpOf(unit.actor)).map(unit => ({unit, cells: tokenCells(unit.token, grid)}));
    const forecasts = new Map();
    let best = null;
    const consider = option => { if (Number.isFinite(option.score) && (!best || option.score > best.score)) best = option; };
    for (const cell of reachable) {
        const point = grid.getTopLeftPoint(cell), cells = tokenCells(doc, grid, point);
        const terrain = terrainAt(doc.parent, {x: point.x + token.w / 2, y: point.y + token.h / 2, elevation: doc.elevation ?? 0});
        const cover = coverValue(terrain), threat = threatCount(cell, threats);
        let source = null;
        for (const target of targets) {
            const distance = footprintDistance(cells, target.cells);
            for (const means of attacks) {
                if (!means.ranges.some(r => distance >= r.min && distance <= r.max)) continue;
                // Retaliation depends on distance, and the attacker's cover on terrain; auras are forecast from the first square tried.
                const key = `${means.type}:${means.item.id}:${means.weapon?.id ?? ""}|${target.unit.id}|${terrain.key}|${distance}`;
                if (!forecasts.has(key)) forecasts.set(key, evaluateAttack(actor, means, target.unit, source ??= tokenAt(token, point), grid));
                const outcome = forecasts.get(key);
                if (!outcome) continue;
                consider({type: means.type, cell, path: cell.path, means, target: target.unit, outcome,
                    score: scoreAttack({outcome, targetHp: hpOf(target.unit.actor), priority: target.priority, cover, threat: threat * 0.5, moveCost: cell.cost, cost: means.penalty})});
            }
        }
        for (const patient of patients) {
            const distance = footprintDistance(cells, patient.cells);
            for (const means of heals) {
                if (!means.ranges.some(r => distance >= r.min && distance <= r.max)) continue;
                consider({type: "heal", cell, path: cell.path, means, target: patient.unit,
                    score: scoreHeal({amount: means.amount, hp: hpOf(patient.unit.actor), maxHp: maxHpOf(patient.unit.actor), cover, threat, moveCost: cell.cost,
                        cost: means.penalty, minimumShare: attacks.length ? 0.25 : 0})});
            }
        }
    }
    if (best) return best;
    if (behavior !== "charge" || fixed) return {type: "wait"};
    return approach(token, combat, cache, {context, reachable, targets, friends, patients, attacks, heals, hostiles});
}

/** Charge: move toward the nearest square from which a target can be attacked (or an ally healed). */
function approach(token, combat, cache, {context, reachable, targets, friends, patients, attacks, heals, hostiles}) {
    const doc = token.document, grid = cache.grid, goals = [];
    if (attacks.length) {
        const ranges = attacks.flatMap(means => means.ranges);
        for (const target of targets) goals.push(...rangeGoals(target.cells, ranges, cache.bounds));
    } else if (heals.length) {
        // Healers follow the wounded, or else the ally nearest the enemy.
        const ranges = heals.flatMap(means => means.ranges);
        const front = friends.map(unit => ({unit, cells: tokenCells(unit.token, grid)})).sort((a, b) =>
            Math.min(...targets.map(t => footprintDistance(a.cells, t.cells))) - Math.min(...targets.map(t => footprintDistance(b.cells, t.cells))))[0];
        for (const ally of patients.length ? patients : front ? [front] : []) goals.push(...rangeGoals(ally.cells, ranges, cache.bounds));
    }
    if (!goals.length) return {type: "wait"};
    const traits = terrainTraits(token.actor, doc), pass = hasSkill(token.actor, "pass"), elevation = doc.elevation ?? 0;
    const enemyCells = new Set(hostiles.flatMap(unit => tokenCells(unit.token, grid).map(cellKey)));
    const enterCost = cell => {
        const point = grid.getTopLeftPoint(cell);
        if (point.x < cache.rect.x || point.y < cache.rect.y || point.x + token.w > cache.rect.right || point.y + token.h > cache.rect.bottom) return Infinity;
        const [i0, j0, i1, j1] = grid.getOffsetRange({...point, width: token.w, height: token.h});
        let extra = 0, enemy = false;
        for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) {
            const key = cellKey({i, j});
            if (cache.solid.has(key)) return Infinity;
            const rule = terrainMovement(cache.terrain({i, j}, elevation).key, traits);
            if (rule.blocked) return Infinity;
            extra = Math.max(extra, rule.extra);
            enemy ||= enemyCells.has(key);
        }
        // Enemy units will move, so they slow the route rather than closing it.
        return extra + (enemy && !pass ? 4 : 0);
    };
    const field = approachField({goals, bounds: cache.bounds, enterCost, traverse: (from, to) => !cache.blocked(token, from, to), diagonal: diagonalStep(grid.diagonals)});
    const remaining = cell => field.get(cellKey(cell)) ?? Infinity;
    const cover = cell => coverValue(cache.terrain(cell, elevation));
    let best = null;
    for (const cell of reachable) {
        const value = remaining(cell);
        if (!best || value < best.value - 1e-6 || Math.abs(value - best.value) <= 1e-6 && (cover(cell) > cover(best.cell) || cover(cell) === cover(best.cell) && cell.cost < best.cell.cost)) best = {cell, value};
    }
    // No route at all: close the straight-line distance instead.
    if (!best || !Number.isFinite(best.value)) {
        best = null;
        for (const cell of reachable) {
            const value = cellDistance(cell, goals);
            if (!best || value < best.value || value === best.value && cell.cost < best.cell.cost) best = {cell, value};
        }
    }
    if (!best || cellKey(best.cell) === cellKey(context.origin)) return {type: "wait"};
    return {type: "move", cell: best.cell, path: best.cell.path};
}

// ---------------------------------------------------------------- Presentation shared with every client

function displayFocus({sceneId, tokenId}) {
    if (!setting("combatAIFollow", true) || canvas.scene?.id !== sceneId) return;
    const token = canvas.tokens?.get(tokenId);
    // Keep the unit in the lower part of the screen, clear of the forecast panel at the top.
    const offset = window.innerHeight * 0.2 / (canvas.stage?.scale?.y || 1);
    if (token?.visible) void canvas.animatePan({x: token.center.x, y: token.center.y - offset, duration: 400});
}

function displayForecast({sceneId, html, title, duration}) {
    if (!setting("combatAIFollow", true) || canvas.scene?.id !== sceneId) return;
    document.getElementById("feue-ai-forecast")?.remove();
    const panel = document.createElement("aside");
    panel.id = "feue-ai-forecast";
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    panel.innerHTML = `<div class="feue-ai-forecast-title">${esc(title)}</div>${html}`;
    document.body.append(panel);
    setTimeout(() => panel.remove(), duration);
}

function broadcast(action, data) {
    const payload = {action, senderId: game.user.id, ...data};
    game.socket.emit(SOCKET, payload);
    if (action === "aiFocus") displayFocus(payload);
    if (action === "aiForecast") displayForecast(payload);
}

/** A Battle Forecast for a single uncounterable strike (spells and Combat Arts). */
function singleStrikeForecast(actor, means, target, sourceToken, targetToken) {
    const weapon = means.type === "spell" ? spellWeapon(means.item) : means.weapon;
    const stats = singleStrikeStats(actor, means, target, sourceToken, targetToken);
    const speed = weaponAttackSpeed(actor, weapon);
    return {target, order: ["attacker"], declared: {}, retaliationReason: means.type === "spell" ? "Spells cannot be countered" : `${means.item.name} cannot be countered`,
        attacker: {actor, weapon: {...weapon, name: means.type === "art" ? `${means.item.name} (${weapon.name})` : weapon.name}, token: sourceToken, stats, speed, baseSpeed: speed, count: 1},
        defender: {actor: target, weapon: target.items.find(i => i.type === "weapon" && i.system?.equipped), token: targetToken, stats: null, speed: 0, baseSpeed: 0, count: 0}};
}

// ---------------------------------------------------------------- Running a phase

export class CombatAI {
    run = null;
    /** Phases whose start-of-phase bookkeeping (action resets, movement history) has finished. */
    prepared = new Set();
    stopped = new Set();
    warned = new Set();
    timer = null;
    autoEndTimer = null;

    get active() { return !!game.user?.isActiveGM; }

    /** Called by the encounter once a phase has started and its units were reset. */
    phaseStarted(combat) {
        const stamp = phaseStamp(combat);
        if (!stamp) return;
        this.prepared.add(stamp);
        this.schedule(combat, PHASE_BANNER_DURATION * Math.max(0.5, pace()));
        this.queueAutoEnd(combat);
    }

    schedule(combat = game.combat, delay = 50) {
        if (!this.active) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.maybeRun(combat).catch(error => console.error("FEUE | Combat AI failed", error)), delay);
    }

    async maybeRun(combat) {
        if (!this.active || this.run || !combat?.started) return;
        const group = aiPhaseGroup(combat), stamp = phaseStamp(combat);
        if (!group || !this.prepared.has(stamp) || this.stopped.has(stamp) || evaluateObjective(combat).complete) return;
        const sceneId = combat.scene?.id ?? combat.combatant?.token?.parent?.id;
        if (combat !== game.combat || canvas.scene?.id !== sceneId || !canvas.ready) {
            if (!this.warned.has(stamp)) ui.notifications.warn(`Combat AI: view the encounter's scene so the ${group.name} phase can act.`);
            this.warned.add(stamp);
            return;
        }
        if (canvas.scene.grid.type !== CONST.GRID_TYPES.SQUARE) {
            if (!this.warned.has(stamp)) ui.notifications.warn("Combat AI needs a square grid scene.");
            this.warned.add(stamp);
            return;
        }
        this.run = {combat, stamp, group, sceneId, stop: false};
        ui.combat?.render();
        try { await this.runPhase(this.run); }
        finally { this.run = null; ui.combat?.render(); }
    }

    stop() {
        if (!this.run) return;
        this.run.stop = true;
        this.stopped.add(this.run.stamp);
        ui.notifications.info("Combat AI will stop after the current unit.");
    }

    resume(combat = game.combat) {
        const stamp = phaseStamp(combat);
        this.stopped.delete(stamp);
        this.warned.delete(stamp);
        this.prepared.add(stamp);
        this.schedule(combat);
    }

    current(run) {
        const combat = run.combat;
        return !run.stop && combat.started && game.combat === combat && phaseStamp(combat) === run.stamp && !!aiPhaseGroup(combat) &&
            canvas.scene?.id === run.sceneId && !evaluateObjective(combat).complete && this.active;
    }

    pending(run) {
        return phaseUnits(run.combat).filter(unit => unit.token?.object && canStillAct(unit, run.combat) && unitBehavior(unit.token, run.combat) !== "manual");
    }

    async runPhase(run) {
        const cache = createRunCache(canvas.scene, gridOf());
        const tried = new Set();
        while (this.current(run)) {
            while (game.paused && this.current(run)) await sleep(500);
            if (!this.current(run)) break;
            const unit = this.nextUnit(this.pending(run).filter(c => !tried.has(c.id)), run);
            if (!unit) break;
            tried.add(unit.id);
            let busy = true;
            try { busy = await this.actUnit(unit, run, cache); }
            catch (error) {
                console.error(`FEUE | Combat AI: ${unit.name} could not act`, error);
                ui.notifications.warn(`Combat AI: ${unit.name} could not act (${error.message}).`);
                await this.finish(unit.token, run).catch(() => {});
            }
            if (busy) await beat(450);
        }
        if (!this.current(run)) return;
        const manual = phaseUnits(run.combat).filter(unit => canStillAct(unit, run.combat) && unitBehavior(unit.token, run.combat) === "manual");
        if (manual.length) return ui.notifications.info(`Combat AI: the ${run.group.name} phase is done except ${manual.map(unit => unit.name).join(", ")} (Manual). The phase ends once they have acted.`);
        await beat(400);
        if (this.current(run)) await this.advance(run.combat, run.stamp);
    }

    /** Next phase, once: every caller names the phase it means to end. */
    advance(combat, stamp) {
        return withUnitActionLock(async () => { if (combat.started && phaseStamp(combat) === stamp) await combat.nextTurn(); });
    }

    /** Front-line units move first so they do not block the units behind them; pure healers go last. */
    nextUnit(pending, run) {
        if (!pending.length) return null;
        const grid = gridOf(), units = liveUnits(run.combat, canvas.scene);
        const rank = unit => {
            const side = allegianceOf(unit, run.combat).id, cells = tokenCells(unit.token, grid);
            const nearest = Math.min(Infinity, ...units.filter(other => !allied(allegianceOf(other, run.combat).id, side)).map(other => footprintDistance(cells, tokenCells(other.token, grid))));
            return (attackMeans(unit.actor).length ? 0 : 10000) + nearest;
        };
        return pending.map(unit => ({unit, rank: rank(unit)})).sort((a, b) => a.rank - b.rank || String(a.unit.name).localeCompare(String(b.unit.name)))[0].unit;
    }

    /** Plays one unit; returns whether it did anything visible. Idle units Wait without moving the camera. */
    async actUnit(unit, run, cache) {
        const doc = unit.token;
        let busy = false;
        // Opportunity Shot and similar effects can leave a Major Action after the first one.
        for (let step = 0; step < 3 && this.current(run); step++) {
            const token = doc.object;
            if (!token || hpOf(token.actor) <= 0 || unavailableUnit(doc) || unitActionReason(doc, {combat: run.combat})) break;
            const plan = planUnit(token, run.combat, cache);
            if (plan.type === "wait") break;
            if (!busy) {
                busy = true;
                broadcast("aiFocus", {sceneId: doc.parent.id, tokenId: doc.id});
                await beat(450);
            }
            const acted = await this.perform(token, plan, run);
            if (!acted || plan.type === "move") break;
        }
        await this.finish(doc, run);
        return busy;
    }

    /** Wait: ends the unit's turn unless it fell or already finished. */
    async finish(doc, run) {
        if (!doc?.actor || hpOf(doc.actor) <= 0 || unavailableUnit(doc) || !canStillAct(run.combat.combatants.find(c => c.tokenId === doc.id) ?? {}, run.combat)) return;
        await requestUnitCommand(doc, "wait");
    }

    async perform(token, plan, run) {
        if (plan.path?.length > 1 && !await this.move(token, plan.path, run)) return false;
        if (plan.type === "move" || !this.current(run)) return plan.type === "move";
        await beat(250);
        return this.act(token, plan, run);
    }

    async move(token, path, run) {
        const context = createMovementContext(token, canvas, {combat: run.combat});
        let cells = path;
        if (!context.validate(cells)) cells = context.route(path.at(-1));
        if (cells.length < 2 || !context.validate(cells)) return false;
        const doc = token.document, destination = context.grid.getTopLeftPoint(cells.at(-1));
        const moved = doc.move
            ? await doc.move(cells.slice(1).map(context.waypoint), {method: "api", showRuler: false, feueMovement: true})
            : await doc.update({...cells.slice(1).map(context.waypoint).at(-1)}, {feueMovement: true, feueWaypoints: cells.slice(1).map(context.waypoint)});
        await this.settle(doc, cells.length);
        return !!moved && Math.abs((doc._source?.x ?? doc.x) - destination.x) < 1 && Math.abs((doc._source?.y ?? doc.y) - destination.y) < 1;
    }

    /** Wait for the movement (including continued legs) and its animation, but never forever: a hidden tab does not animate. */
    async settle(doc, steps) {
        const deadline = Date.now() + 1500 + steps * 600;
        while (Date.now() < deadline) {
            const animation = doc.object?.movementAnimationPromise;
            if (animation) await Promise.race([animation, sleep(Math.max(0, deadline - Date.now()))]);
            if (!["pending", "paused"].includes(doc.movement?.state) && !doc.object?.movementAnimationPromise) return;
            await sleep(100);
        }
    }

    async equip(actor, item) {
        if (item.system?.equipped) return;
        const others = actor.items.filter(other => other.id !== item.id && other.system?.equipped && sameEquipSlot(other, item));
        await actor.updateEmbeddedDocuments("Item", [...others.map(other => ({_id: other.id, "system.equipped": false})), {_id: item.id, "system.equipped": true}]);
    }

    async act(token, plan, run) {
        const actor = token.actor, grid = gridOf(), scene = token.document.parent;
        const target = scene.tokens.get(plan.target.tokenId)?.object;
        const item = actor.items.get(plan.means.item.id), weapon = plan.means.weapon ? actor.items.get(plan.means.weapon.id) : null;
        if (!target?.actor || !item || plan.type === "art" && !weapon || unavailableUnit(target) || plan.type !== "heal" && hpOf(target.actor) <= 0) return false;
        const rangeItem = plan.type === "art" ? weapon : item;
        if (!tokenInItemRange(token, target, rangeItem, grid)) return false;
        const title = `${run.group.name} Phase — ${token.name}`;
        const show = forecast => {
            broadcast("aiForecast", {sceneId: scene.id, title, html: renderBattleForecast(forecast), duration: Math.max(900, 1600 * pace())});
            return beat(1500);
        };
        if (plan.type === "attack") {
            await this.equip(actor, item);
            const forecast = createBattleForecast({actor, weapon: item, target: target.actor, sourceToken: token, targetToken: target, grid, triangle: "auto"});
            await show(forecast);
            await withUnitActionLock(() => actor.sheet._executeAttack(item, "auto", {forecast}));
        } else if (plan.type === "spell") {
            await show(singleStrikeForecast(actor, plan.means, target.actor, token, target));
            const result = await actor.sheet._castSpell(item, {sourceToken: token, targetToken: target, relayed: true, userId: game.user.id});
            if (!result) return false;
        } else if (plan.type === "art") {
            await this.equip(actor, weapon);
            await show(singleStrikeForecast(actor, plan.means, target.actor, token, target));
            const result = await actor.sheet._executeCombatArt(item, weapon, {sourceToken: token, targetToken: target, relayed: true, userId: game.user.id, choice: {artCost: plan.means.payment}});
            if (!result) return false;
        } else if (plan.type === "heal") {
            const result = item.type === "spell"
                ? await actor.sheet._castSpell(item, {sourceToken: token, targetToken: target, relayed: true, userId: game.user.id})
                : await actor.sheet._resolveHealingAction(item, {sourceToken: token, targetToken: target, userId: game.user.id});
            if (!result) return false;
        }
        await beat(300);
        return true;
    }

    // ------------------------------------------------------------ Player-controlled phases

    /** With AI in the encounter, a phase ends itself once every unit has acted: player phases when the encounter
     * says so, and AI phases once the GM has finished their Manual units. */
    queueAutoEnd(combat) {
        if (!this.active || !combat?.started) return;
        clearTimeout(this.autoEndTimer);
        const stamp = phaseStamp(combat);
        this.autoEndTimer = setTimeout(() => {
            if (this.phaseComplete(combat)) void this.advance(combat, stamp).catch(error => console.error("FEUE | Could not end the phase", error));
        }, 1200);
    }

    phaseComplete(combat) {
        const stamp = phaseStamp(combat), ai = !!aiPhaseGroup(combat);
        if (!stamp || !this.prepared.has(stamp) || !encounterUsesAI(combat) || evaluateObjective(combat).complete) return false;
        if (ai ? this.run || this.stopped.has(stamp) : !aiSettings(combat).autoEnd) return false;
        const units = phaseUnits(combat);
        return units.length > 0 && !units.some(unit => canStillAct(unit, combat));
    }

    /** A player ends the phase of their own units (only in encounters with an AI allegiance). */
    async endPhaseFor(user, combatId, stamp) {
        const combat = game.combats.get(combatId);
        if (!combat?.started || phaseStamp(combat) !== stamp || aiPhaseGroup(combat) || !encounterUsesAI(combat)) return;
        if (!user?.isGM && !phaseUnits(combat).some(unit => unit.actor?.testUserPermission(user, "OWNER"))) return;
        await this.advance(combat, stamp);
    }
}

export function canEndPhase(combat, user = game.user) {
    return !!combat?.started && encounterUsesAI(combat) && !aiPhaseGroup(combat) && phaseUnits(combat).some(unit => unit.actor?.testUserPermission(user, "OWNER"));
}

// ---------------------------------------------------------------- Interface

function renderTrackerControls(controller, app, html) {
    const root = rootElement(html), combat = app.viewed;
    root?.querySelectorAll(".feue-ai-controls").forEach(element => element.remove());
    const summary = root?.querySelector(".feue-encounter-summary");
    if (!summary || !combat?.started || !encounterUsesAI(combat)) return;
    const group = aiPhaseGroup(combat), box = document.createElement("div");
    box.className = "feue-ai-controls";
    if (group) {
        const running = controller.run?.stamp === phaseStamp(combat);
        box.innerHTML = `<span><i class="fas fa-robot" aria-hidden="true"></i> ${running ? `AI is playing the ${esc(group.name)} phase` : `${esc(group.name)} phase: AI`}</span>` +
            (game.user.isGM ? `<button type="button" data-ai-command="${running ? "stop" : "run"}">${running ? "Stop AI" : "Run AI"}</button>` : "");
    } else if (!game.user.isGM && canEndPhase(combat)) {
        box.innerHTML = `<button type="button" data-ai-command="end"><i class="fas fa-forward" aria-hidden="true"></i> End ${esc(allegianceOf(combat.combatant, combat).name)} Phase</button>`;
    } else return;
    box.addEventListener("click", event => {
        const command = event.target.closest("[data-ai-command]")?.dataset.aiCommand;
        if (!command) return;
        event.stopPropagation();
        if (command === "stop") controller.stop();
        if (command === "run") controller.resume(combat);
        if (command === "end") {
            if (!game.users.activeGM) return ui.notifications.warn("An active GM is required to end the phase.");
            game.socket.emit(SOCKET, {action: "aiEndPhase", senderId: game.user.id, combatId: combat.id, stamp: phaseStamp(combat)});
        }
    });
    summary.append(box);
}

function renderTokenAIConfig(app, html) {
    const root = rootElement(html), doc = app.token ?? app.document ?? app.object;
    if (!root || root.querySelector(".feue-ai-config") || doc?.actor?.type && doc.actor.type !== "character") return;
    const anchor = root.querySelector(".feue-interaction-config") ?? root.querySelector(".feue-strides");
    const target = anchor?.parentElement ?? root.querySelector('.tab[data-tab="character"]') ?? root.querySelector('.tab[data-tab="identity"]') ?? root.querySelector("form") ?? root;
    target.insertAdjacentHTML("beforeend", `<fieldset class="feue-ai-config"><legend>Combat AI</legend>
        <div class="form-group"><label>Behavior</label><select name="flags.${SYSTEM_ID}.aiBehavior">${aiBehaviorOptions(doc?.flags?.[SYSTEM_ID]?.aiBehavior ?? "")}</select></div>
        <p class="hint">Used when this unit's allegiance is AI-controlled in an encounter (Objectives). ${aiBehaviorHints()}</p></fieldset>`);
}

export function registerCombatAI() {
    const controller = new CombatAI();
    if (!document.getElementById("feue-ai-styles")) {
        const link = document.createElement("link");
        link.id = "feue-ai-styles";
        link.rel = "stylesheet";
        link.href = new URL("../../styles/combat-ai.css", import.meta.url).href;
        document.head.append(link);
    }
    Hooks.once("init", () => {
        game.settings.register(SYSTEM_ID, "combatAISpeed", {name: "Combat AI Speed", scope: "world", config: true, type: String, default: "normal",
            choices: {slow: "Slow", normal: "Normal", fast: "Fast", instant: "Instant (no pauses)"},
            hint: "How long the Combat AI pauses between units and shows each Battle Forecast. Movement and combat animations still play."});
        game.settings.register(SYSTEM_ID, "combatAIFollow", {name: "Follow Combat AI", scope: "client", config: true, type: Boolean, default: true,
            hint: "Pan to each unit the Combat AI moves and briefly show its Battle Forecast."});
    });
    Hooks.once("ready", () => {
        game.firesOfWar = Object.assign(game.firesOfWar ?? {}, {combatAI: controller});
        // A reload resumes the current phase: its start-of-phase bookkeeping has already run.
        for (const combat of game.combats ?? []) if (combat.started) controller.prepared.add(phaseStamp(combat));
        game.socket.on(SOCKET, payload => {
            const sender = game.users.get(payload?.senderId);
            if (!sender?.active || payload.senderId === game.user.id) return;
            if (payload.action === "aiFocus" && sender.isGM) displayFocus(payload);
            if (payload.action === "aiForecast" && sender.isGM) displayForecast(payload);
            if (payload.action === "aiEndPhase" && controller.active) void controller.endPhaseFor(sender, payload.combatId, payload.stamp).catch(error => console.error("FEUE | Could not end the phase", error));
        });
        controller.schedule(game.combat, 1500);
    });
    Hooks.on("updateCombat", (combat, changes) => {
        // Turning AI on for the current phase (or a new GM taking over) starts it without waiting for the next phase.
        if (changes.flags?.[SYSTEM_ID]?.allegiances || `flags.${SYSTEM_ID}.allegiances` in changes) controller.schedule(combat, 300);
        if (changes.flags?.[SYSTEM_ID] || "turn" in changes || "round" in changes) ui.combat?.render();
    });
    Hooks.on("updateCombatant", combatant => { if (combatant.parent?.started) controller.queueAutoEnd(combatant.parent); });
    Hooks.on("canvasReady", () => controller.schedule(game.combat, 800));
    Hooks.on("pauseGame", paused => { if (!paused) controller.schedule(game.combat, 300); });
    Hooks.on("userConnected", () => controller.schedule(game.combat, 1000));
    Hooks.on("deleteCombat", combat => { for (const set of [controller.prepared, controller.stopped, controller.warned]) for (const stamp of set) if (stamp.startsWith(`${combat.id}:`)) set.delete(stamp); });
    Hooks.on("renderCombatTracker", (app, html) => renderTrackerControls(controller, app, html));
    Hooks.on("renderTokenConfig", renderTokenAIConfig);
    Hooks.on("renderPrototypeTokenConfig", renderTokenAIConfig);
    return controller;
}
