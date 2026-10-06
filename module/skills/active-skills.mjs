import {skillName, hasSkill, TOME_TYPES} from "./skill-automation.mjs";
import {assertUnitAction, actorActionToken, adjacentAllies, unitCombatant, completeMajorAction, relaySheetAction} from "../units/unit-actions.mjs";
import {addTimedEffect, healActor, inflictStatus, displaceTokens} from "../combat/combat-effects.mjs";
import {unitsWithin, skillTokenDistance, alliedTokens, activeSkillUnit, sceneTokens} from "./skill-context.mjs";
import {placementReason, dropPositions, tokenCells, footprintDistance, unavailableUnit} from "../encounter/event-rules.mjs";
import {inventoryCopy, inventoryUsage} from "../units/convoy.mjs";
import {hasInfiniteUses} from "../rules/feue.mjs";
import {makeshiftWeapon} from "../combat/battle-forecast.mjs";
import {defeatEnemyTokens} from "../combat/combat-presentation.mjs";
import {revivalSkillOpen} from "../rules/alt-rules.mjs";

const SYSTEM = "fires-of-war";
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));
const docOf = token => token?.document ?? token;
const ALL_STATS = ["strength", "magic", "skill", "speed", "defense", "resistance", "luck", "charm"];
const hp = actor => Number(actor?.system?.attributes?.hp?.value) || 0;

/** Active skill definitions. `target` selects candidates; `kind` selects the resolver. */
export function activeSkillRule(item) {
    if (item?.system?.automation?.mode === "off" || !revivalSkillOpen(item)) return null;
    const name = skillName(item);
    if (["dance", "master dance"].includes(name)) return {kind: "refresh", target: name === "master dance" ? "adjacentAllies" : "adjacentAlly", refresh: true, all: name === "master dance",
        summary: name === "master dance" ? "Major Action: refresh every adjacent ally (once per ally per turn)." : "Major Action: refresh an adjacent ally so it can act again (once per turn)."};
    if (name === "tactical advice") return {kind: "buff", target: "adjacentAlly", combat: {hitRate: 10, avoid: 10}, duration: 1, summary: "Major Action: an adjacent ally gains +10 Hit and +10 Avoid for 1 turn."};
    if (name === "inspiration") return {kind: "buff", target: "adjacentAlly", combat: {damage: 4, damageReduction: 4}, duration: 1, summary: "Major Action: an adjacent ally deals +4 damage and takes −4 damage for 1 turn."};
    const rally = name.match(/^rally (strength|magic|skill|speed|defense|resistance|luck|charm|movement|spectrum)$/);
    if (rally) return {kind: "buff", target: "adjacentAlly", duration: 3,
        attributes: rally[1] === "spectrum" ? Object.fromEntries(ALL_STATS.map(k => [k, 2])) : {[rally[1] === "movement" ? "move" : rally[1]]: rally[1] === "movement" ? 1 : 4},
        summary: `Major Action: an adjacent ally gains ${rally[1] === "spectrum" ? "+2 to every stat except HP, BLD and Move" : rally[1] === "movement" ? "+1 Move" : `+4 ${rally[1].toUpperCase().slice(0, 3)}`} for 3 turns (refreshes, does not stack).`};
    if (name === "grand rally") return {kind: "buff", target: "alliesWithin", radius: 5, duration: 3, attributes: {...Object.fromEntries(ALL_STATS.map(k => [k, 4])), move: 1}, combat: {avoid: 10, dodge: 10},
        summary: "Major Action: allies within 5 gain +4 to all stats, +1 Move, +10 Avoid and +10 Dodge for 3 turns."};
    if (name === "hex") return {kind: "hex", target: "enemy", range: [1, 4], summary: "Major Action: an enemy within 1–4 suffers −20 Avoid and −20 Dodge and gains Blood Sacrifice for 5 turns."};
    if (name === "pivot") return {kind: "pivot", target: "adjacentAlly", summary: "Major Action: move to the opposite side of an adjacent ally."};
    if (name === "steal") return {kind: "steal", target: "adjacentEnemy", summary: "Major Action: take a non-weapon, unequipped item from an adjacent enemy."};
    if (name === "transmute") return {kind: "transmute", target: "self", summary: "Major Action: move Tome uses at 2:1 (2 uses spent restore 1)."};
    if (name === "teleport") return {kind: "teleport", target: "anyAlly", summary: "Major Action: move to a free square adjacent to any ally."};
    if (name === "heavy is the crown") return {kind: "sacrifice", target: "ally", range: [1, 10], summary: "Major Action: an ally within 1–10 dies and this unit recovers HP equal to that ally's HP."};
    if (name === "perfect balance") return {kind: "balance", target: "self", summary: "Major Action (once every 5 turns): every allied unit's HP becomes 50% of its maximum."};
    if (name === "authority") return {kind: "authority", target: "alliesWithin", radius: 3, summary: "Major Action: allies within 3 may take another Major Action now, but cannot move."};
    if (name === "telekinetic rod") return {kind: "makeshift", target: "self", summary: "Attack with the equipped Staff as a weapon: 1 Mt, 65 Hit, 0 Crit, 1 Range, 3 Wt, Smash."};
    if (name === "demolish") return {kind: "interact", action: "break", summary: "Opens Interact: Break instantly destroys an adjacent structure, with or without a weapon."};
    if (name === "locktouch") return {kind: "interact", action: "open", summary: "Opens Interact: open doors and chests without a key."};
    if (["cleave", "overdraw", "lunge"].includes(name)) return {kind: "declare", summary: {cleave: "Declared in the Battle Forecast: −20 Hit; hits also deal ½ damage to other enemies adjacent to you.",
        overdraw: "Declared in the Battle Forecast with a Bow: +1 range, +4 damage, −10 Hit and Crit (automatic when the target is only in Overdraw range).",
        lunge: "Declared in the Battle Forecast: after dealing damage, swap places with the target."}[name]};
    if (["refresh", "special dance"].includes(name)) return {kind: "rider", summary: name === "refresh" ? "When this unit uses Dance, the ally also recovers 20% max HP." : "When this unit uses Dance, the ally gains +1 to all stats (except HP, Move, BLD) for 1 turn."};
    return null;
}
/** Declared and rider skills are described rather than pressed. */
export const activeSkillUsable = item => !["declare", "rider"].includes(activeSkillRule(item)?.kind);

const LABELS = {strength: "STR", magic: "MAG", skill: "SKL", speed: "SPD", defense: "DEF", resistance: "RES", luck: "LUK", charm: "CHA", move: "Move",
    hitRate: "Hit", avoid: "Avoid", dodge: "Dodge", critRate: "Crit", damage: "damage dealt", damageReduction: "damage taken"};
function buffText(rule) {
    return [...Object.entries(rule.attributes ?? {}), ...Object.entries(rule.combat ?? {})]
        .map(([key, value]) => `${key === "damageReduction" ? "−" : value < 0 ? "−" : "+"}${Math.abs(value)} ${LABELS[key] ?? key}`).join(", ");
}
function gridOf() { return globalThis.canvas?.grid?.getOffset ? canvas.grid : globalThis.canvas?.grid?.grid; }
function candidates(rule, source) {
    const grid = gridOf(), scene = source.parent;
    const living = sceneTokens(source).filter(t => t.id !== source.id && t.actor?.type === "character" && activeSkillUnit(t));
    switch (rule.target) {
        case "adjacentAlly": case "adjacentAllies": return adjacentAllies(source, scene, grid);
        case "alliesWithin": return unitsWithin(source, rule.radius, {relation: "allies"});
        case "anyAlly": return living.filter(t => alliedTokens(source, t));
        case "ally": return living.filter(t => alliedTokens(source, t) && inRange(source, t, rule.range));
        case "enemy": return living.filter(t => !alliedTokens(source, t) && inRange(source, t, rule.range));
        case "adjacentEnemy": return living.filter(t => !alliedTokens(source, t) && footprintDistance(tokenCells(source, grid), tokenCells(t, grid)) === 1);
        default: return [];
    }
}
const inRange = (a, b, [min, max] = [1, 1]) => { const d = skillTokenDistance(a, b); return d >= min && d <= max; };
const singleTarget = rule => ["adjacentAlly", "anyAlly", "ally", "enemy", "adjacentEnemy"].includes(rule.target);
const stealable = actor => Array.from(actor?.items ?? []).filter(i => i.type === "item" && !i.system?.equipped);
const tomes = actor => Array.from(actor?.items ?? []).filter(i => i.type === "weapon" && TOME_TYPES.includes(String(i.system?.weaponType).toLowerCase()) && i.system?.uses && !hasInfiniteUses(i.system.uses));

/** Choice dialog for target/item selection; resolves by calling the sheet again with the chosen options. */
function chooseAndUse(sheet, item, rule, source, options, targets) {
    const option = (value, label) => `<option value="${esc(value)}">${esc(label)}</option>`;
    let content = targets.length ? `<div class="form-group"><label>Target</label><select id="skill-target">${targets.map(t => option(t.id, t.name)).join("")}</select></div>` : "";
    if (rule.kind === "steal") content += `<div class="form-group"><label>Item</label><select id="skill-choice"></select></div>`;
    if (rule.kind === "transmute") {
        const list = tomes(sheet.actor);
        content += `<div class="form-group"><label>Take uses from</label><select id="skill-from">${list.map(t => option(t.id, `${t.name} (${t.system.uses.value}/${t.system.uses.max})`)).join("")}</select></div>
            <div class="form-group"><label>Restore</label><select id="skill-to">${list.map(t => option(t.id, `${t.name} (${t.system.uses.value}/${t.system.uses.max})`)).join("")}</select></div>
            <div class="form-group"><label>Uses to restore</label><input type="number" id="skill-amount" value="1" min="1" step="1"/></div><p class="hint">Each restored use spends 2 uses.</p>`;
    }
    const fillItems = html => {
        const target = targets.find(t => t.id === html.find("#skill-target").val());
        html.find("#skill-choice").html(stealable(target?.actor).map(i => option(i.id, i.name)).join("") || option("", "Nothing to steal"));
    };
    new Dialog({title: `${item.name}`, content: `<form>${content}</form>`,
        buttons: {use: {label: "Use", callback: async html => {
            const targetToken = targets.find(t => t.id === html.find("#skill-target").val());
            const choice = rule.kind === "steal" ? {itemId: html.find("#skill-choice").val()} :
                rule.kind === "transmute" ? {from: html.find("#skill-from").val(), to: html.find("#skill-to").val(), amount: Number(html.find("#skill-amount").val()) || 1} : undefined;
            try { await sheet._useSkill(item, {...options, actionLocked: false, sourceToken: source, targetToken, choice}); }
            catch (error) { ui.notifications.error(error.message); }
        }}, cancel: {label: "Cancel"}},
        render: html => { if (rule.kind === "steal") { fillItems(html); html.find("#skill-target").change(() => fillItems(html)); } }
    }).render(true);
}

export async function useActiveSkill(sheet, item, options = {}) {
    const rule = activeSkillRule(item);
    if (!rule) return false;
    const actor = sheet.actor;
    if (rule.kind === "declare" || rule.kind === "rider") { globalThis.ui?.notifications?.info(rule.summary); return true; }
    const source = actorActionToken(actor, options.sourceToken);
    if (rule.kind === "interact") {
        if (!source) throw Error("Place and select this unit on the map to use this skill.");
        game.firesOfWar?.openInteractionMenu?.(source.object ?? source, {action: rule.action});
        return true;
    }
    if (rule.kind === "makeshift") {
        const staff = actor.items.find(i => i.type === "weapon" && i.system?.equipped && String(i.system.weaponType).toLowerCase() === "staff");
        if (!staff) throw Error("Equip a Staff to use Telekinetic Rod.");
        await sheet._promptWeaponAttack(makeshiftWeapon(actor, staff), {sourceToken: source?.object ?? source});
        return true;
    }
    if (!source || !globalThis.canvas?.ready) throw Error("Place and select this unit on the map to use this skill.");
    assertUnitAction(actor, {sourceToken: source});
    const targets = candidates(rule, source);
    if (rule.target !== "self" && !targets.length) throw Error(rule.target.startsWith("adjacent") ? "No eligible adjacent unit." : "No eligible unit in range.");
    const needsChoice = singleTarget(rule) || ["steal", "transmute"].includes(rule.kind);
    if (needsChoice && !options.relayed && !(options.targetToken || rule.target === "self") || rule.kind === "transmute" && !options.choice && !options.relayed) {
        chooseAndUse(sheet, item, rule, source, options, rule.target === "self" ? [] : targets);
        return true;
    }
    const relay = relaySheetAction(actor, "skill", item, {...options, sourceToken: source});
    if (relay) { await relay; return true; }
    const selected = docOf(options.targetToken);
    const chosen = singleTarget(rule) ? targets.filter(t => t.id === selected?.id) : targets;
    if (singleTarget(rule) && !chosen.length) throw Error("The chosen unit is no longer a valid target.");
    const summary = await resolveActiveSkill(sheet, item, rule, source, chosen, options);
    await completeMajorAction(actor, {sourceToken: source});
    await ChatMessage.create({user: options.userId ?? game.user.id, speaker: ChatMessage.getSpeaker({actor}),
        content: `<div class="feue-skill-use"><h3>${esc(actor.name)} uses ${esc(item.name)}</h3><p>${summary}</p></div>`});
    return true;
}

async function resolveActiveSkill(sheet, item, rule, source, targets, options) {
    const actor = sheet.actor, names = targets.map(t => esc(t.name)).join(", ");
    switch (rule.kind) {
        case "refresh": {
            const refreshable = targets.filter(t => { const unit = unitCombatant(t); return unit && !unit.flags?.[SYSTEM]?.refreshed; });
            if (!refreshable.length) throw Error("This ally has already been refreshed this turn, or is outside combat.");
            for (const target of refreshable) {
                const unit = unitCombatant(target);
                await unit.update({[`flags.${SYSTEM}.acted`]: false, [`flags.${SYSTEM}.majorAction`]: false, [`flags.${SYSTEM}.attacked`]: false, [`flags.${SYSTEM}.refreshed`]: true});
                await unit.clearMovementHistory?.();
                if (hasSkill(actor, "refresh")) await healActor(target.actor, Number(target.actor.system.attributes.hp.max) * 0.2);
                if (hasSkill(actor, "special dance")) await addTimedEffect(target.actor, {name: "Special Dance", automationKey: "special-dance", duration: 1,
                    attributes: Object.fromEntries(ALL_STATS.map(k => [k, 1]))});
            }
            return `Refreshes ${refreshable.map(t => esc(t.name)).join(", ")}.`;
        }
        case "buff":
            for (const target of targets) await addTimedEffect(target.actor, {name: item.name, automationKey: skillName(item), duration: rule.duration, attributes: rule.attributes ?? {}, combat: rule.combat ?? {}});
            return `${names}: ${esc(buffText(rule))} for ${rule.duration} turn${rule.duration === 1 ? "" : "s"}.`;
        case "hex": {
            const [target] = targets;
            await addTimedEffect(target.actor, {name: "Hex", automationKey: "hex", duration: 5, combat: {avoid: -20, dodge: -20}});
            const sacrificed = await inflictStatus(target.actor, "Blood Sacrifice", 5);
            return `${names}: −20 Avoid and Dodge for 5 turns${sacrificed ? " and Blood Sacrifice" : " (immune to Blood Sacrifice)"}.`;
        }
        case "pivot": {
            const [ally] = targets, grid = gridOf();
            const a = grid.getOffset({x: source.x + 1, y: source.y + 1}), b = grid.getOffset({x: ally.x + 1, y: ally.y + 1});
            const point = grid.getTopLeftPoint({i: 2 * b.i - a.i, j: 2 * b.j - a.j});
            const reason = placementReason(source, point, source.parent, grid);
            if (reason) throw Error(`Pivot: ${reason}`);
            await displaceTokens([{token: source, x: point.x, y: point.y}]);
            return `Pivots around ${names}.`;
        }
        case "teleport": {
            const [ally] = targets, grid = gridOf();
            const [point] = dropPositions(ally, source, source.parent, grid).values();
            if (!point) throw Error("No free square next to that ally.");
            await displaceTokens([{token: source, x: point.x, y: point.y}]);
            return `Teleports next to ${names}.`;
        }
        case "steal": {
            const [target] = targets, stolen = target.actor.items.get(options.choice?.itemId);
            if (!stolen || !stealable(target.actor).includes(stolen)) throw Error("Choose an unequipped, non-weapon item.");
            if (inventoryUsage(actor).full) throw Error("Your inventory is full.");
            const [created] = await actor.createEmbeddedDocuments("Item", [inventoryCopy(stolen)]);
            if (!created) throw Error("The stolen item could not be added.");
            await target.actor.deleteEmbeddedDocuments("Item", [stolen.id]);
            return `Steals <b>${esc(stolen.name)}</b> from ${names}.`;
        }
        case "transmute": {
            const from = actor.items.get(options.choice?.from), to = actor.items.get(options.choice?.to), list = tomes(actor);
            if (!list.includes(from) || !list.includes(to) || from === to) throw Error("Choose two different Tomes with limited uses.");
            const amount = Math.min(Math.max(1, Math.floor(options.choice.amount || 1)), Math.floor(Number(from.system.uses.value) / 2), Number(to.system.uses.max) - Number(to.system.uses.value));
            if (amount < 1) throw Error("Not enough uses to transfer, or the receiving Tome is full.");
            await from.update({"system.uses.value": Number(from.system.uses.value) - amount * 2});
            await to.update({"system.uses.value": Number(to.system.uses.value) + amount});
            return `Moves ${amount * 2} use(s) of ${esc(from.name)} into ${amount} use(s) of ${esc(to.name)}.`;
        }
        case "sacrifice": {
            const [ally] = targets, before = hp(ally.actor);
            await ally.actor.update({"system.attributes.hp.value": 0});
            await defeatEnemyTokens(ally.actor, [ally]);
            const healed = await healActor(actor, before);
            return `${names} falls; ${esc(actor.name)} recovers ${healed} HP.`;
        }
        case "balance": {
            const combat = globalThis.game?.combat, round = combat?.started ? Number(combat.round) || 1 : 0;
            const last = actor.flags?.[SYSTEM]?.perfectBalance;
            if (combat?.started && last?.combat === combat.id && round - last.round < 5) throw Error(`Perfect Balance is available again on turn ${last.round + 5}.`);
            const allies = [source, ...sceneTokens(source).filter(t => t.id !== source.id && t.actor && activeSkillUnit(t) && alliedTokens(source, t))];
            for (const ally of allies) await ally.actor.update({"system.attributes.hp.value": Math.max(1, Math.floor(Number(ally.actor.system.attributes.hp.max) / 2))});
            if (combat?.started) await actor.update({[`flags.${SYSTEM}.perfectBalance`]: {combat: combat.id, round}});
            return `Sets ${allies.length} allied unit(s) to half HP.`;
        }
        case "authority": {
            const refreshed = [];
            for (const target of targets) {
                const unit = unitCombatant(target);
                if (!unit || unavailableUnit(target)) continue;
                await unit.update({[`flags.${SYSTEM}.acted`]: false, [`flags.${SYSTEM}.majorAction`]: false, [`flags.${SYSTEM}.attacked`]: false, [`flags.${SYSTEM}.noMove`]: true});
                refreshed.push(target.name);
            }
            if (!refreshed.length) throw Error("No allied encounter units within 3 squares.");
            return `${refreshed.map(esc).join(", ")} may take a Major Action now (no movement).`;
        }
    }
    return "";
}
