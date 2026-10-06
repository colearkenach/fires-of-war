import {SYSTEM_ID} from "../map/terrain.mjs";
import {unavailableUnit, sameAllegiance, tokenCells, footprintDistance, eventFlags, interactEnabled} from "../encounter/event-rules.mjs";
import {allegianceOf} from "../encounter/encounter-rules.mjs";
import {hasSkill, registerSkillRule, triggerSkills} from "../skills/skill-automation.mjs";
import {inventoryCopy, inventoryUsage, withInventoryLock, vehicleItem, isConvoyUnit, partiesOf} from "./convoy.mjs";
import {effectiveAttackRange} from "../map/tactical-grid.mjs";
import {incapacitatingStatus} from "../rules/status-rules.mjs";
import {replaceableMounts} from "../rules/alt-rules.mjs";
import {releaseMountUnit, recallMountUnit} from "./mounts.mjs";

const docOf = token => token?.document ?? token;
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));
export function unitCombatant(token, combat = globalThis.game?.combat) {
    const doc = docOf(token);
    return combat?.started && doc ? Array.from(combat.combatants ?? []).find(c => c.tokenId === doc.id && (!c.sceneId || c.sceneId === doc.parent?.id)) : null;
}
export function actorActionToken(actor, token = null) {
    if (token) return docOf(token);
    if (actor?.isToken) return actor.token;
    const copies = (globalThis.canvas?.tokens?.placeables ?? []).filter(t => t.actor === actor);
    const selected = copies.filter(t => t.controlled);
    return docOf(selected.length === 1 ? selected[0] : copies.length === 1 ? copies[0] : null);
}
export function unitActionReason(token, {combat = globalThis.game?.combat, movement = false, free = false} = {}) {
    const doc = docOf(token), actor = doc?.actor;
    if (unavailableUnit(doc)) return "This unit is being carried or has escaped.";
    if (actor && Number(actor.system.attributes?.hp?.value) <= 0) return "This unit has no HP.";
    const incapacitated = incapacitatingStatus(actor);
    if (incapacitated) return `This unit is incapacitated (${incapacitated}).`;
    const unit = unitCombatant(doc, combat);
    if (!unit) return "";
    if (combat.combatant && allegianceOf(unit, combat).id !== allegianceOf(combat.combatant, combat).id) return "Wait for this unit's allegiance phase.";
    const state = unit.flags?.[SYSTEM_ID] ?? {};
    if (state.acted) return "This unit has already Waited or finished its turn.";
    if (movement && state.noMove) return "Authority's extra action does not allow movement.";
    if (state.majorAction && !free && (!movement || !canCanto(actor))) return movement ? "Movement ends after a Major Action unless the unit has Canto." : "This unit has already used its Major Action.";
    return "";
}
export function canCanto(actor) {
    const types = actor?.system?.unitTypes ?? [];
    return hasSkill(actor, "canto") || !actor?.system?.mount?.dismounted && ["Mounted", "Flying"].some(t => Array.isArray(types) ? types.includes(t) : types[t]) ||
        Array.from(actor?.items ?? []).some(i => i.type === "item" && i.system?.equipped && String(i.name).trim().toLowerCase() === "fetters of dromi");
}
export function assertUnitAction(actor, options = {}) {
    const token = actorActionToken(actor, options.sourceToken);
    // Linked copies must be identified rather than spending another token's action.
    if (!token && globalThis.game?.combat?.started && Array.from(game.combat.combatants ?? []).some(c => c.actor === actor)) throw Error("Select exactly one token for this character before acting.");
    const reason = unitActionReason(token, options);
    if (reason) throw Error(reason);
    return token;
}
export function validateUnitTarget(actor, item, {sourceToken, targetToken, allowSelf = false} = {}) {
    const source = actorActionToken(actor, sourceToken), target = docOf(targetToken);
    if (!source || !target) return;
    if (!target.actor || source.id === target.id && !allowSelf || target.parent?.id !== source.parent?.id || unavailableUnit(target) || Number(target.actor.system.attributes?.hp?.value) <= 0) throw Error("Choose an available target unit.");
    const grid = globalThis.canvas?.grid?.getOffset ? canvas.grid : globalThis.canvas?.grid?.grid;
    if (!grid) return;
    let distance;
    if (grid.isSquare) distance = footprintDistance(tokenCells(source, grid), tokenCells(target, grid));
    else {
        const center = doc => ({x: doc.x + doc.width * grid.size / 2, y: doc.y + doc.height * grid.size / 2});
        distance = grid.measurePath([center(source), center(target)]).distance / (grid.distance || 1);
    }
    if (source.id !== target.id && !effectiveAttackRange(actor, item).some(r => distance >= r.min && distance <= r.max)) throw Error("The target is outside range.");
}
export async function completeMajorAction(actor, {sourceToken, attacked = false} = {}) {
    const token = actorActionToken(actor, sourceToken), unit = unitCombatant(token);
    if (!unit) return;
    // Opportunity Shot: one attack this phase does not spend the Major Action.
    if (attacked && unit.flags?.[SYSTEM_ID]?.freeAttack) {
        const result = await unit.update({[`flags.${SYSTEM_ID}.freeAttack`]: false, [`flags.${SYSTEM_ID}.attacked`]: true});
        if (!result) throw Error("Could not save this unit's action state.");
        return;
    }
    const changes = {[`flags.${SYSTEM_ID}.majorAction`]: true};
    if (attacked) changes[`flags.${SYSTEM_ID}.attacked`] = true;
    if (!canCanto(actor)) changes[`flags.${SYSTEM_ID}.acted`] = true;
    const result = await unit.update(changes);
    if (!result) throw Error("Could not save this unit's action state.");
}
export function applyMountProfile(actor) {
    if (!actor.system.mount?.dismounted) return;
    const types = actor.system.unitTypes ?? [];
    actor.system.unitTypes = (Array.isArray(types) ? types : Object.keys(types).filter(k => types[k])).filter(t => !["Mounted", "Flying", "Dragon"].includes(t));
    if (!actor.system.unitTypes.includes("Infantry")) actor.system.unitTypes.push("Infantry");
}
export async function toggleMount(actor, {sourceToken} = {}) {
    const token = assertUnitAction(actor, {sourceToken, free: true});
    const dismounted = !!actor.system.mount?.dismounted;
    const rawTypes = actor._source?.system?.unitTypes ?? actor.system.unitTypes ?? [];
    const types = Array.isArray(rawTypes) ? rawTypes : Object.keys(rawTypes).filter(k => rawTypes[k]);
    if (!dismounted && !["Mounted", "Flying"].some(t => types.includes(t))) throw Error("This unit has no mount.");
    if (dismounted && unitCombatant(token)?.flags?.[SYSTEM_ID]?.attacked) throw Error("You cannot Mount after attacking this turn.");
    // Replaceable Mounts: a lost mount must be replaced; a mount unit must be beside its rider to remount.
    if (dismounted && replaceableMounts() && actor.system.mount?.lost) throw Error("This unit's mount was lost. Equip a new mount to remount.");
    if (dismounted && replaceableMounts() && token) await recallMountUnit(token);
    const result = await actor.update({"system.mount.dismounted": !dismounted});
    if (!result) throw Error("The mount update was rejected.");
    if (!dismounted && token) {
        try { await releaseMountUnit(token, actor); }
        catch (error) { globalThis.ui?.notifications?.warn(`${actor.name} dismounts, but ${error.message}`); }
    }
    return !dismounted;
}
export function adjacentAllies(source, scene, grid, combat = globalThis.game?.combat) {
    source = docOf(source);
    return Array.from(scene?.tokens ?? []).filter(t => t.id !== source.id && t.actor?.type === "character" && !t.hidden && !unavailableUnit(t) &&
        Number(t.actor.system.attributes?.hp?.value) > 0 && sameAllegiance(source, t, combat) && footprintDistance(tokenCells(source, grid), tokenCells(t, grid)) === 1);
}

/** Trade partners: adjacent allies, plus the unit being carried (a rescued ally or a captive). */
export function tradePartners(source, scene, grid, combat = globalThis.game?.combat) {
    source = docOf(source);
    const carried = scene?.tokens?.get?.(eventFlags(source).rescuedTokenId);
    const partners = adjacentAllies(source, scene, grid, combat);
    return carried?.actor && eventFlags(carried).rescuedBy === source.id ? [...partners, carried] : partners;
}

/** Convoy Interact: a Convoy unit reaches its Party's Convoy, and so does any Party member beside it.
 * One entry per Party, preferring the unit itself as the carrier. */
export function convoyAccess(source, scene, grid, combat = globalThis.game?.combat) {
    source = docOf(source);
    if (source?.actor?.type !== "character") return [];
    const carriers = [source, ...tradePartners(source, scene, grid, combat).filter(interactEnabled)].filter(token => isConvoyUnit(token.actor));
    const access = new Map(), memberOf = new Set(partiesOf(source.actor).map(party => party.id));
    for (const carrier of carriers) for (const party of partiesOf(carrier.actor)) {
        if (memberOf.has(party.id) && !access.has(party.id)) access.set(party.id, {party, carrier});
    }
    return [...access.values()];
}

export async function tradeItems(source, target, giveId, receiveId, {user = globalThis.game?.user, grid, combat = globalThis.game?.combat} = {}) {
    source = docOf(source); target = docOf(target);
    return withInventoryLock(async () => {
        if (!user?.active || !(user.isGM || source?.actor?.testUserPermission(user, "OWNER"))) throw Error("You do not own this unit.");
        const reason = unitActionReason(source, {combat});
        if (reason) throw Error(reason);
        if (!tradePartners(source, source.parent, grid, combat).includes(target)) throw Error("Trade requires an adjacent ally or the unit you are carrying.");
        // Another player's inventory requires their ownership or GM consent; a captor may take a captive's items.
        const captive = eventFlags(target).captured?.by === source.id;
        if (receiveId && !(user.isGM || captive || target.actor.testUserPermission(user, "OWNER"))) throw Error("You must own the ally to take its items; the GM can exchange allied inventories.");
        const give = source.actor.items.get(giveId), receive = target.actor.items.get(receiveId);
        if (giveId && !["weapon", "item"].includes(give?.type) || receiveId && !["weapon", "item"].includes(receive?.type) || !give && !receive) throw Error("Choose available inventory items.");
        if (vehicleItem(give) || vehicleItem(receive)) throw Error("Vehicle weapons cannot be picked up or traded.");
        if (inventoryUsage(source.actor).used - Number(!!give) + Number(!!receive) > 5 || inventoryUsage(target.actor).used - Number(!!receive) + Number(!!give) > 5) throw Error("The recipient has no free inventory slot. Select an item to exchange.");
        if (source.actor === target.actor) throw Error("These linked tokens share the same inventory.");
        const originals = [give, receive].filter(Boolean).map(i => ({actor: i.parent, data: i.toObject()}));
        const created = [];
        try {
            if (give) created.push(...await target.actor.createEmbeddedDocuments("Item", [inventoryCopy(give)]));
            if (receive) created.push(...await source.actor.createEmbeddedDocuments("Item", [inventoryCopy(receive)]));
            if (created.length !== Number(!!give) + Number(!!receive)) throw Error("An inventory update was rejected.");
            if (give && !(await source.actor.deleteEmbeddedDocuments("Item", [give.id]))?.length) throw Error("The item could not be removed.");
            if (receive && !(await target.actor.deleteEmbeddedDocuments("Item", [receive.id]))?.length) throw Error("The item could not be removed.");
        } catch (error) {
            for (const item of created) await item.delete();
            for (const original of originals) if (!original.actor.items.get(original.data._id)) await original.actor.createEmbeddedDocuments("Item", [original.data], {keepId: true});
            throw error;
        }
        await completeMajorAction(source.actor, {sourceToken: source});
    });
}

const socket = `system.${SYSTEM_ID}`, pending = new Map(), handled = new Set();
let actionQueue = Promise.resolve();
export function withUnitActionLock(operation) {
    const result = actionQueue.catch(() => {}).then(operation); actionQueue = result.catch(() => {}); return result;
}
export async function executeUnitCommand(request, user = game.user) {
    const scene = game.scenes.get(request.sceneId), source = scene?.tokens.get(request.sourceId);
    if (!user?.active || !source?.actor || !(user.isGM || source.actor.testUserPermission(user, "OWNER"))) throw Error("You do not own this unit.");
    const reason = unitActionReason(source, {free: ["mount", "wait"].includes(request.command)});
    if (reason) throw Error(reason);
    if (request.command === "wait") {
        const unit = unitCombatant(source);
        if (!unit) throw Error("Wait requires an active encounter.");
        const moved = (source.movementHistory?.length ?? 0) > 1;
        if (!unit.flags?.[SYSTEM_ID]?.majorAction && !moved) await unit.setFlag(SYSTEM_ID, "waitBonus", true);
        await unit.update({[`flags.${SYSTEM_ID}.majorAction`]: true, [`flags.${SYSTEM_ID}.acted`]: true});
    } else if (request.command === "mount") await toggleMount(source.actor, {sourceToken: source});
    else if (request.command === "trade") {
        if (canvas.scene?.id !== scene.id) throw Error("The GM must view this scene to resolve Trade.");
        await tradeItems(source, scene.tokens.get(request.targetId), request.giveId, request.receiveId, {user, grid: canvas.grid?.getOffset ? canvas.grid : canvas.grid.grid});
    } else if (request.command === "sheetAction") {
        const item = source.actor.items.get(request.itemId), target = request.targetId ? scene.tokens.get(request.targetId) : null;
        if (!item || !["art", "spell", "item", "healing", "skill", "battalion"].includes(request.kind)) throw Error("This action is no longer available.");
        const expected = {art: "combatArt", spell: "spell", item: "item", skill: "skill", battalion: "battalion"}[request.kind];
        if (expected && item.type !== expected || request.kind === "healing" && !["weapon", "spell"].includes(item.type)) throw Error("Invalid action item.");
        const weapon = source.actor.items.get(request.weaponId);
        if (request.kind === "art" && (!weapon || weapon.type !== "weapon" || !weapon.system.equipped)) throw Error("Equip a compatible weapon.");
        if (["art", "spell", "healing"].includes(request.kind)) {
            if (!target?.actor || target.hidden && !user.isGM || unavailableUnit(target)) throw Error("Choose an available target.");
            if (canvas.scene?.id !== scene.id) throw Error("The GM must view the scene to resolve this action.");
            validateUnitTarget(source.actor, request.kind === "art" ? weapon : item, {sourceToken: source, targetToken: target, allowSelf: request.kind === "healing"});
        }
        if (request.kind === "battalion" && request.targetId && (!target?.actor || target.hidden && !user.isGM || unavailableUnit(target))) throw Error("Choose an available target.");
        const options = {sourceToken: source.object ?? source, targetToken: target?.object ?? target, userId: user.id, relayed: true, actionLocked: true, choice: request.choice};
        if (request.kind === "art") await source.actor.sheet._executeCombatArt(item, weapon, options);
        if (request.kind === "spell") await source.actor.sheet._castSpell(item, options);
        if (request.kind === "item") await source.actor.sheet._useItem(item, {...options, consume: item.system.itemType !== "equippable"});
        if (request.kind === "healing") await source.actor.sheet._resolveHealingAction(item, options);
        if (request.kind === "skill") await source.actor.sheet._useSkill(item, options);
        if (request.kind === "battalion") await source.actor.sheet._executeBattalion(item, options);
    } else throw Error("Unknown unit command.");
}
export function relaySheetAction(actor, kind, item, options = {}) {
    const token = actorActionToken(actor, options.sourceToken);
    if (options.relayed || !token || !globalThis.game?.users?.activeGM || game.user.isGM) return null;
    const target = options.targetToken ?? Array.from(game.user.targets ?? [])[0];
    return requestUnitCommand(token, "sheetAction", {kind, itemId: item.id, weaponId: options.weapon?.id, targetId: (target?.document ?? target)?.id,
        ...(options.choice ? {choice: JSON.parse(JSON.stringify(options.choice))} : {})});
}
export async function requestUnitCommand(token, command, extra = {}) {
    const doc = docOf(token), request = {sceneId: doc.parent.id, sourceId: doc.id, command, ...extra};
    if (game.user.isGM) return withUnitActionLock(() => executeUnitCommand(request));
    if (!game.users.activeGM) throw Error("An active GM is required for unit commands.");
    const requestId = foundry.utils.randomID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {pending.delete(requestId); reject(Error("Unit command timed out. Check the unit before retrying."));}, 180000);
        pending.set(requestId, {resolve, reject, timer});
        game.socket.emit(socket, {action: "unitCommand", requestId, userId: game.user.id, request});
    });
}

export function openTradeMenu(token, {allyId = null} = {}) {
    const source = docOf(token), grid = canvas.grid?.getOffset ? canvas.grid : canvas.grid.grid;
    const partners = tradePartners(source, source.parent, grid);
    // A partner chosen from Interact is listed first so its inventory is shown.
    const allies = [...partners.filter(t => t.id === allyId), ...partners.filter(t => t.id !== allyId)];
    const options = actor => `<option value="">Nothing</option>${actor.items.filter(i => ["weapon", "item"].includes(i.type)).map(i => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join("")}`;
    if (!allies.length) return ui.notifications.warn("No adjacent allies to trade with.");
    const label = t => `${t.name}${eventFlags(t).captured ? " (captive)" : eventFlags(t).rescuedBy === source.id ? " (carried)" : ""}`;
    new Dialog({title: `${source.name} — Trade`, content: `<form><div class="form-group"><label>Ally</label><select id="trade-ally">${allies.map(t => `<option value="${esc(t.id)}">${esc(label(t))}</option>`).join("")}</select></div><div class="form-group"><label>Give</label><select id="trade-give">${options(source.actor)}</select></div><div class="form-group"><label>Receive</label><select id="trade-receive">${options(allies[0].actor)}</select></div></form>`,
        buttons: {trade: {label: "Trade", callback: async html => {try { await requestUnitCommand(source, "trade", {targetId: html.find("#trade-ally").val(), giveId: html.find("#trade-give").val(), receiveId: html.find("#trade-receive").val()});} catch (error) {ui.notifications.error(error.message);}}}, cancel: {label: "Cancel"}},
        render: html => html.find("#trade-ally").change(event => html.find("#trade-receive").html(options(allies.find(t => t.id === event.target.value).actor)))
    }).render(true);
}
export function unitCommands(token) {
    const doc = docOf(token), actor = doc?.actor;
    if (!actor) return [];
    const reason = unitActionReason(token), moveReason = unitActionReason(token, {movement: true});
    const grid = globalThis.canvas?.grid?.getOffset ? canvas.grid : globalThis.canvas?.grid?.grid;
    const allies = grid && grid.isSquare !== false ? tradePartners(doc, doc.parent, grid) : [];
    const raw = actor._source?.system?.unitTypes ?? actor.system.unitTypes ?? [];
    const mount = actor.system.mount?.dismounted || ["Mounted", "Flying"].some(t => Array.isArray(raw) ? raw.includes(t) : raw[t]);
    return [{id: "move", label: "Move", reason: moveReason}, ...(allies.length ? [{id: "trade", label: "Trade", reason}] : []),
        ...(allies.length || doc.flags?.[SYSTEM_ID]?.rescuedTokenId ? [{id: "rescue", label: "Rescue / Drop", reason}] : []),
        {id: "interact", label: "Interact", reason}, ...(mount ? [{id: "mount", label: actor.system.mount?.dismounted ? "Mount" : "Dismount", reason: unitActionReason(token, {free: true}) || (actor.system.mount?.dismounted && unitCombatant(token)?.flags?.[SYSTEM_ID]?.attacked ? "Cannot Mount after attacking." : "") ||
            (actor.system.mount?.dismounted && replaceableMounts() && actor.system.mount?.lost ? "Mount lost: equip a new mount to remount." : "")}] : []),
        {id: "wait", label: "Wait", reason: unitActionReason(token, {free: true}) || (!unitCombatant(token) ? "Requires an active encounter." : "")}];
}
export function runUnitCommand(token, command) {
    if (command === "move") {const reason = unitActionReason(token, {movement: true}); if (reason) throw Error(reason); return game.firesOfWar.tacticalForecast.beginPlanning(token);}
    if (command === "trade") return openTradeMenu(token);
    if (["rescue", "interact"].includes(command)) return game.firesOfWar.openInteractionMenu(token, {action: command === "rescue" ? "rescue" : null});
    return requestUnitCommand(token, command);
}
export function openUnitMenu(token) {
    if (!token?.isOwner || unavailableUnit(token)) return;
    game.firesOfWar.tacticalForecast?.cancelPlanning();
    const commands = unitCommands(token);
    const dialog = new Dialog({title: `${token.name} — Commands`, content: `<div class="feue-unit-menu">${commands.map(c => `<button type="button" data-unit-command="${c.id}" ${c.reason ? "disabled" : ""} title="${esc(c.reason)}">${c.label}</button>`).join("")}</div>`, buttons: {close: {label: "Close"}},
        render: html => html.find("[data-unit-command]").click(async event => {try {dialog.close(); await runUnitCommand(token, event.currentTarget.dataset.unitCommand);} catch (error) {ui.notifications.error(error.message);}})});
    dialog.render(true);
}
export function registerUnitActions() {
    Hooks.once("ready", () => {
        Object.assign(game.firesOfWar ??= {}, {openUnitMenu, runUnitCommand, requestUnitCommand, registerSkillRule, triggerSkills});
        game.socket.on(socket, payload => {
            if (payload?.action === "unitCommandResult" && payload.userId === game.user.id) {
                const request = pending.get(payload.requestId); if (!request) return;
                clearTimeout(request.timer); pending.delete(payload.requestId);
                return payload.error ? request.reject(Error(payload.error)) : request.resolve();
            }
            if (payload?.action !== "unitCommand" || game.users.activeGM?.id !== game.user.id || !payload.requestId || handled.has(payload.requestId)) return;
            handled.add(payload.requestId); if (handled.size > 500) handled.delete(handled.values().next().value);
            void withUnitActionLock(() => executeUnitCommand(payload.request, game.users.get(payload.userId))).then(() =>
                game.socket.emit(socket, {action: "unitCommandResult", requestId: payload.requestId, userId: payload.userId})).catch(error =>
                game.socket.emit(socket, {action: "unitCommandResult", requestId: payload.requestId, userId: payload.userId, error: error.message}));
        });
    });
    for (const hook of ["updateCombatant", "updateCombat"]) Hooks.on(hook, () => {
        game.firesOfWar?.characterActionHud?.queueRefresh(); game.firesOfWar?.tacticalForecast?.queueRefresh();
    });
}
