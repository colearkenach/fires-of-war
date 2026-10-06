import {weaponRankIndex, normalizeWeaponRank} from "../rules/feue.mjs";
import {tokenCells} from "../encounter/event-rules.mjs";
import {cellKey, parseAttackRange} from "../map/tactical-grid.mjs";
import {terrainCombatStats} from "../map/terrain.mjs";
import {alliedTokens, activeSkillUnit, sceneTokens} from "../skills/skill-context.mjs";
import {actorActionToken, completeMajorAction} from "../units/unit-actions.mjs";
import {healActor, addTimedEffect, displaceTokens, damageBattalions} from "./combat-effects.mjs";
import {statusStatModifiers} from "../rules/status-rules.mjs";
import {presentCombatText, defeatEnemyTokens} from "./combat-presentation.mjs";
import {term, sumTerms, sectionsHtml} from "../ui/stat-breakdown.mjs";

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));
const docOf = token => token?.document ?? token;
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const automaticDamage = () => !!globalThis.game?.settings?.get("fires-of-war", "automaticCombatDamage");

/**
 * Areas are lists of [dx, dy] offsets from the commander's square while facing up (−y is forward).
 * Rulebook shapes (Battalions, p. 118) sit directly in front of the commander.
 */
const row = (width, depth) => Array.from({length: depth}, (_, d) => Array.from({length: width}, (_, w) => [w - (width - 1) / 2, -(d + 1)])).flat();
export const AREA_PRESETS = Object.freeze({
    "3x1": {label: "3x1 (row of 3)", cells: row(3, 1)},
    "3x2": {label: "3x2", cells: row(3, 2)},
    "3x3": {label: "3x3", cells: row(3, 3)},
    "2L": {label: "2L (line of 2)", cells: row(1, 2)},
    "3L": {label: "3L (line of 3)", cells: row(1, 3)},
    "4L": {label: "4L (line of 4)", cells: row(1, 4)}
});
/** The custom-area editor grid: 11 × 11 squares, commander near the bottom by default. */
export const EDITOR_SIZE = 11;
export const DEFAULT_ORIGIN = Object.freeze([5, 9]);

export function normalizeShape(value) {
    const text = String(value ?? "").trim().replace(/\s+/g, "");
    if (!text || ["–", "-", "—", "none", "self"].includes(text.toLowerCase())) return "";
    if (text.toLowerCase() === "custom") return "custom";
    const preset = Object.keys(AREA_PRESETS).find(key => key.toLowerCase() === text.toLowerCase());
    return preset ?? text;
}
const parseCell = value => String(value).split(",").map(Number);

/** {key, label, cells: [[dx, dy]], reach} or null when the Battalion only affects its commander. */
export function battalionArea(item) {
    const shape = normalizeShape(item?.system?.range);
    const reach = Math.max(0, Math.floor(num(item?.system?.area?.reach)));
    if (!shape) return null;
    if (shape === "custom") {
        const area = item.system.area ?? {};
        const [ox, oy] = area.origin ? parseCell(area.origin) : DEFAULT_ORIGIN;
        const cells = (area.cells ?? []).map(parseCell).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && !(x === ox && y === oy)).map(([x, y]) => [x - ox, y - oy]);
        return cells.length ? {key: "custom", label: "Custom area", cells, reach} : null;
    }
    if (AREA_PRESETS[shape]) return {key: shape, label: AREA_PRESETS[shape].label, cells: AREA_PRESETS[shape].cells, reach};
    // Legacy numeric ranges become a straight line at those distances.
    const distances = parseAttackRange(shape).flatMap(({min, max}) => Array.from({length: max - min + 1}, (_, i) => min + i));
    return distances.length ? {key: shape, label: `Range ${shape}`, cells: distances.map(d => [0, -d]), reach} : null;
}

/** Editor cells ("x,y" strings) and origin for the item sheet, for presets and custom areas alike. */
export function editorArea(item) {
    const shape = normalizeShape(item?.system?.range);
    if (shape === "custom") return {cells: new Set(item.system.area?.cells ?? []), origin: item.system.area?.origin ?? DEFAULT_ORIGIN.join(",")};
    const area = battalionArea(item), [ox, oy] = DEFAULT_ORIGIN;
    return {cells: new Set((area?.cells ?? []).map(([dx, dy]) => `${ox + dx},${oy + dy}`)), origin: DEFAULT_ORIGIN.join(",")};
}

export const FACINGS = Object.freeze(["up", "right", "down", "left"]);
const rotate = ([dx, dy], facing) => [[dx, dy], [-dy, dx], [-dx, -dy], [dy, -dx]][facing] ?? [dx, dy];

/** The commander square an area attaches to: the middle of the footprint edge it faces. */
export function anchorCell(token, facing, grid) {
    const cells = tokenCells(docOf(token), grid);
    const is = cells.map(c => c.i), js = cells.map(c => c.j);
    const [i0, i1, j0, j1] = [Math.min(...is), Math.max(...is), Math.min(...js), Math.max(...js)];
    const mi = i0 + Math.floor((i1 - i0) / 2), mj = j0 + Math.floor((j1 - j0) / 2);
    return [{i: i0, j: mj}, {i: mi, j: j1}, {i: i1, j: mj}, {i: mi, j: j0}][facing] ?? {i: i0, j: mj};
}

/** Grid cells covered by an area for a facing (0 up, 1 right, 2 down, 3 left) and an optional forward push. */
export function areaCells(token, area, facing, reach, grid) {
    const anchor = anchorCell(token, facing, grid), [fx, fy] = rotate([0, -1], facing);
    const push = Math.min(Math.max(0, Math.floor(num(reach))), area?.reach ?? 0);
    return (area?.cells ?? []).map(cell => {
        const [dx, dy] = rotate(cell, facing);
        return {i: anchor.i + dy + fy * push, j: anchor.j + dx + fx * push};
    });
}

/** Facing and push toward a canvas point, relative to the commander's centre. */
export function aimToward(token, point, grid, area) {
    const doc = docOf(token), size = grid.size;
    const cx = doc.x + doc.width * size / 2, cy = doc.y + doc.height * size / 2;
    const dx = point.x - cx, dy = point.y - cy;
    const facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
    const half = (facing % 2 ? doc.width : doc.height) / 2;
    const along = Math.abs(facing % 2 ? dx : dy) / size - half;
    return {facing, reach: Math.min(area?.reach ?? 0, Math.max(0, Math.floor(along - 0.5)))};
}

/** Living, visible units whose footprint overlaps the area. */
export function unitsInArea(source, cells, grid, tokens = null) {
    const keys = new Set(cells.map(cellKey)), doc = docOf(source);
    return sceneTokens(doc, tokens).filter(t => t.id !== doc.id && t.actor?.type !== "party" && activeSkillUnit(t) &&
        tokenCells(t, grid).some(cell => keys.has(cellKey(cell))));
}

// ---------------------------------------------------------------------------
// Specials and statistics
// ---------------------------------------------------------------------------
const UNIT_TYPES = ["Infantry", "Mounted", "Flying", "Dragon", "Armored", "Magician", "Beast", "Mechanical", "Monster", "Puppet"];
const BUFF_KEYS = {mov: "move", move: "move", movement: "move", str: "strength", mag: "magic", skl: "skill", spd: "speed", def: "defense", res: "resistance",
    lck: "luck", luk: "luck", cha: "charm", bld: "build", avo: "avoid", avoid: "avoid", hit: "hitRate", crit: "critRate", dodge: "dodge"};
const COMBAT_KEYS = new Set(["avoid", "hitRate", "critRate", "dodge"]);

/** Parse the Properties text used by the rulebook and compendium ("Slayer (Flying)", "Grant allies in range +4 DEF for 1 turn"...). */
export function battalionSpecial(item) {
    const text = String(item?.system?.properties ?? "");
    const result = {slayer: [], heal: 0, healSelf: 0, buff: null, swap: /swap places/i.test(text), magical: /\bmagical\b/i.test(text)};
    const slayer = text.match(/slayer\s*\(([^)]+)\)/i);
    if (slayer) result.slayer = slayer[1].split(/,|\/|\band\b/i).map(t => t.trim().toLowerCase().replace(/s$/, ""))
        .map(t => UNIT_TYPES.find(type => type.toLowerCase() === t)).filter(Boolean);
    result.heal = num(text.match(/heal (?:allies )?in (?:the )?(?:area|range) for (\d+)/i)?.[1]);
    result.healSelf = num(text.match(/heal self for (\d+)/i)?.[1]);
    const buff = text.match(/grant allies in (?:the )?(?:range|area)\s+(.+?)\s+for\s+(\d+)\s+turns?/i);
    if (buff) {
        const attributes = {}, combat = {};
        let value = 0;
        for (const part of buff[1].split(/,|\band\b/i).map(p => p.trim()).filter(Boolean)) {
            const match = part.match(/^([+-]\d+)\s*(.+)$/);
            if (match) value = Number(match[1]);
            const key = BUFF_KEYS[(match ? match[2] : part).trim().toLowerCase()];
            if (key && value) (COMBAT_KEYS.has(key) ? combat : attributes)[key] = value;
        }
        result.buff = {attributes, combat, duration: Number(buff[2])};
    }
    return result;
}

const endurance = item => item?.system?.endurance ?? {};
export const battalionOperational = item => !(num(endurance(item).max) > 0 && num(endurance(item).value) <= 0);

/** Why the commander cannot use this Battalion right now ("" when it can). */
export function battalionUseReason(actor, item) {
    if (!battalionOperational(item)) return `${item.name} has no Endurance remaining.`;
    const required = normalizeWeaponRank(item.system?.rank);
    const rank = normalizeWeaponRank(actor?.system?.battalionRank) || "E";
    if (required && weaponRankIndex(rank) < weaponRankIndex(required)) return `${item.name} requires Battalion Rank ${required} (current ${rank}).`;
    return "";
}

/** Battalions use Charm in place of Skill and Strength: Hit = Hit + CHA + LUK÷4, Crit = Crit + CHA÷2, Damage = Mt + CHA. */
export function battalionStats(actor, item) {
    const cha = num(actor?.system?.attributes?.charm?.value), luk = num(actor?.system?.attributes?.luck?.value);
    const attacks = num(item?.system?.might) > 0 || num(item?.system?.hit) > 0;
    const hit = [term(`${item.name} Hit`, num(item.system?.hit), "base"), term("CHA", cha), term("LUK ÷ 4", Math.floor(luk / 4))];
    const crit = [term(`${item.name} Crit`, num(item.system?.crit), "base"), term("CHA ÷ 2", Math.floor(cha / 2))];
    const damage = [term(`${item.name} Mt`, num(item.system?.might), "base"), term("CHA", cha)];
    return {attacks, hit: sumTerms(hit), crit: sumTerms(crit), damage: sumTerms(damage), terms: {hit, crit, damage}};
}

export function battalionTooltip(actor, item) {
    const stats = battalionStats(actor, item), area = battalionArea(item), special = battalionSpecial(item);
    const notes = [area ? `Area: ${area.label}${area.reach ? `, can be pushed ${area.reach} square(s) forward` : ""}` : "No area: affects its commander only.",
        special.slayer.length ? `Slayer: ${special.slayer.join(", ")}` : "", special.heal ? `Heals allies in the area for ${special.heal} HP.` : "",
        special.healSelf ? `Heals its commander for ${special.healSelf} HP.` : "", special.buff ? `Buffs allies in the area for ${special.buff.duration} turn(s).` : "",
        special.swap ? "Swaps places with an enemy it hits." : "", `Endurance ${num(endurance(item).value)}/${num(endurance(item).max)} (takes half the damage its commander takes).`];
    return sectionsHtml({title: item.name, total: stats.attacks ? `${stats.damage} Dmg` : "Support", sections: stats.attacks ? [
        {heading: "Hit rate", terms: stats.terms.hit, total: stats.hit, suffix: "%"},
        {heading: "Crit rate", terms: stats.terms.crit, total: stats.crit, suffix: "%"},
        {heading: "Damage", terms: stats.terms.damage, total: stats.damage}] : [], notes});
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------
const gridFor = scene => {
    const board = globalThis.canvas;
    if (!board?.ready || board.scene?.id !== scene?.id) return null;
    return board.grid?.getOffset ? board.grid : board.grid?.grid;
};
const unitTypes = actor => {
    const types = actor?.system?.unitTypes ?? [];
    return new Set(Array.isArray(types) ? types : Object.keys(types).filter(key => types[key]));
};

async function strike(actor, item, stats, special, targetDoc) {
    const target = targetDoc.actor, terrain = terrainCombatStats(target, targetDoc);
    const roll = async () => (await new Roll("1d100").evaluate()).total;
    const hitChance = Math.max(0, Math.min(100, stats.hit - terrain.avoid));
    const hitRoll = await roll(), hit = hitRoll <= hitChance;
    const critChance = Math.max(0, stats.crit - num(target.system?.combat?.dodge) + statusStatModifiers(target).critTaken);
    const crit = hit && critChance > 0 && await roll() <= critChance;
    const defense = special.magical ? num(target.system?.attributes?.resistance?.value) : terrain.defense;
    const slayer = special.slayer.some(type => unitTypes(target).has(type)) ? 2 : 1;
    const damage = hit ? Math.max(0, stats.damage - defense) * slayer * (crit ? 3 : 1) : 0;
    await presentCombatText(targetDoc, hit ? crit ? "crit" : "hit" : "miss", hit ? crit ? "CRIT" : "HIT" : "MISS");
    const before = num(target.system?.attributes?.hp?.value);
    if (hit && damage > 0 && automaticDamage()) {
        await target.update({"system.attributes.hp.value": Math.max(0, before - damage)});
        await damageBattalions(target, damage);
    }
    if (hit) await presentCombatText(targetDoc, "damage", `${damage} DAMAGE`);
    await defeatEnemyTokens(target, [targetDoc]);
    return {token: targetDoc, actor: target, hit, crit, damage, hitRoll, hitChance, critChance, defense, slayer, killed: before > 0 && num(target.system?.attributes?.hp?.value) <= 0};
}

/**
 * Resolve a Battalion order. options.choice = {facing, reach} selects the area; without a choice the order
 * strikes options.targetToken (or the user's target), as older sheets did.
 */
export async function resolveBattalion(sheet, item, options = {}) {
    const actor = sheet.actor;
    const reason = battalionUseReason(actor, item);
    if (reason) throw Error(reason);
    const source = actorActionToken(actor, options.sourceToken);
    const area = battalionArea(item), special = battalionSpecial(item), stats = battalionStats(actor, item);
    let enemies = [], allies = [];
    if (area && options.choice) {
        if (!source) throw Error("Place and select this unit on the map to order its Battalion.");
        const grid = gridFor(source.parent);
        if (!grid) throw Error("The scene must be viewed to resolve this Battalion's area.");
        const facing = Number(options.choice.facing);
        if (![0, 1, 2, 3].includes(facing)) throw Error("Choose a direction for the Battalion.");
        const units = unitsInArea(source, areaCells(source, area, facing, options.choice.reach, grid), grid);
        enemies = units.filter(t => !alliedTokens(source, t));
        allies = units.filter(t => alliedTokens(source, t));
    } else if (stats.attacks) {
        const target = docOf(options.targetToken) ?? docOf(Array.from(globalThis.game?.user?.targets ?? [])[0]);
        if (target?.actor) enemies = [target];
    }
    const results = [];
    if (stats.attacks) for (const target of enemies) {
        if (num(actor.system.attributes?.hp?.value) <= 0) break;
        results.push(await strike(actor, item, stats, special, target));
    }
    const notes = [];
    if (special.heal) for (const ally of allies) { const healed = await healActor(ally.actor, special.heal); notes.push(`${ally.name} +${healed} HP`); }
    if (special.buff) for (const ally of allies) {
        await addTimedEffect(ally.actor, {name: item.name, automationKey: `battalion-${item.name}`.toLowerCase(), duration: special.buff.duration, attributes: special.buff.attributes, combat: special.buff.combat});
        notes.push(`${ally.name} buffed`);
    }
    if (special.healSelf) notes.push(`${actor.name} +${await healActor(actor, special.healSelf)} HP`);
    const swapWith = special.swap && source ? results.find(r => r.hit && num(r.actor.system.attributes?.hp?.value) > 0) : null;
    if (swapWith) {
        try { await displaceTokens([{token: source, x: swapWith.token.x, y: swapWith.token.y}, {token: swapWith.token, x: source.x, y: source.y}]); notes.push(`Swapped places with ${swapWith.token.name}`); }
        catch (error) { console.error("FEUE | Battalion swap failed", error); notes.push("Swap needs an active GM"); }
    }
    await completeMajorAction(actor, {...options, sourceToken: source ?? options.sourceToken, attacked: results.length > 0});
    const rows = results.map(r => `<tr><td>${esc(r.token.name)}</td><td>${r.hitRoll} / ${r.hitChance}%</td><td>${r.hit ? r.crit ? "<b>CRIT</b>" : "HIT" : "MISS"}</td><td>${r.hit ? `${r.damage}${r.slayer > 1 ? " (Slayer)" : ""}` : "—"}</td></tr>`).join("");
    const empty = area && options.choice && !enemies.length && !allies.length ? "<p>No units in the area.</p>" : "";
    await globalThis.ChatMessage?.create({user: options.userId ?? globalThis.game?.user?.id, speaker: ChatMessage.getSpeaker({actor}),
        content: `<div class="feue-attack-roll feue-battalion-roll"><h3>${esc(actor.name)} orders ${esc(item.name)}!</h3>${area ? `<p><b>Area:</b> ${esc(area.label)}</p>` : ""}${stats.attacks ? `<p><b>Hit</b> ${stats.hit}% · <b>Crit</b> ${stats.crit}% · <b>Mt</b> ${stats.damage}</p>` : ""}${rows ? `<table class="feue-battalion-results"><tr><th>Target</th><th>Roll</th><th>Result</th><th>Damage</th></tr>${rows}</table>` : ""}${notes.length ? `<p><b>Effects:</b> ${notes.map(esc).join(" · ")}</p>` : ""}${empty}</div>`});
    return results;
}
