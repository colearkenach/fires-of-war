import {SYSTEM_ID} from "../map/terrain.mjs";
import {esc, rootElement} from "../map/terrain-ui.mjs";
import {eventFlags, interactEnabled, unavailableUnit, isEscaped, interactionReason, nearbyInteractions, openCredential,
    dropPositions, dropReason, breakAttack} from "./event-rules.mjs";
import {allegiances} from "./encounter-rules.mjs";
import {seizeTile, escapeUnit, registerEventEncounter} from "./event-encounter.mjs";
import {reinforcementTurns} from "./reinforcement-rules.mjs";
import {inventoryItem, inventoryCopy, planChestReward, grantChestReward, withInventoryLock, transferConvoyItems} from "../units/convoy.mjs";
import {openConvoyInteraction} from "../units/convoy-ui.mjs";
import {assertUnitAction, completeMajorAction, withUnitActionLock, tradePartners, openTradeMenu, unitActionReason, convoyAccess} from "../units/unit-actions.mjs";
import {allegianceOf} from "./encounter-rules.mjs";
import {captureMode, perMapTracked} from "../rules/alt-rules.mjs";
import {knockOut, slayUnit, recordMapUse} from "../rules/fall-rules.mjs";
import {hasInfiniteUses} from "../rules/feue.mjs";
import {squarePicker} from "../map/square-picker.mjs";

const SOCKET = `system.${SYSTEM_ID}`;
const activeGM = () => game.users.activeGM?.id === game.user.id;
const pending = new Map(), queues = new Map();
const sceneCombat = scene => {
    const matches = c => c && (c.scene?.id === scene.id || c.sceneId === scene.id ||
        Array.from(c.combatants ?? []).some(unit => unit.sceneId === scene.id));
    return matches(game.combat) ? game.combat : Array.from(game.combats ?? []).find(c => c.active && matches(c));
};
export function interactionGrid(scene) {
    if (scene.grid.type !== CONST.GRID_TYPES.SQUARE) throw Error("Interactions require a square grid.");
    return canvas.ready && canvas.scene?.id === scene.id ? (canvas.grid?.getOffset ? canvas.grid : canvas.grid.grid) :
        new foundry.grid.SquareGrid(scene.grid);
}
function enqueue(sceneId, operation) {
    const result = (queues.get(sceneId) ?? Promise.resolve()).catch(() => {}).then(operation);
    queues.set(sceneId, result);
    void result.finally(() => { if (queues.get(sceneId) === result) queues.delete(sceneId); }).catch(() => {});
    return result;
}
const requireUpdated = result => { if (!result || Array.isArray(result) && !result.length) throw Error("The interaction update was rejected."); return result; };

/** Internal displacements must neither spend Move nor be constrained by the carried unit's range. */
async function updateTokens(scene, changes) {
    const movement = {};
    for (const change of changes) if ("x" in change || "y" in change || "elevation" in change) {
        const token = scene.tokens.get(change._id);
        movement[change._id] = {method: "api", waypoints: [{x: change.x ?? token.x, y: change.y ?? token.y,
            elevation: change.elevation ?? token.elevation, action: "displace"}],
            constrainOptions: {ignoreWalls: true, ignoreCost: true}};
    }
    const updated = requireUpdated(await scene.updateEmbeddedDocuments("Token", changes, {feueInteraction: true, animate: false, movement}));
    for (const change of changes) {
        const doc = updated.find(token => token.id === change._id);
        if (!doc || ["x", "y", "elevation"].some(key => key in change && doc[key] !== change[key])) throw Error("A token update was rejected.");
    }
    return updated;
}
async function clearRescuePenalty(source) {
    const elsewhere = Array.from(game.scenes).some(scene => Array.from(scene.tokens).some(token =>
        (token.id !== source.id || token.parent.id !== source.parent.id) && token.actor === source.actor && eventFlags(token).rescuedTokenId));
    if (!elsewhere && source.actor?.system.rescue?.active) requireUpdated(await source.actor.update({"system.rescue.active": false}, {feueInteraction: true}));
}

/** Set a carried unit down. A dropped captive is slain under the video-game Capture rule;
 * `force` skips square validation for a captive that is slain anyway. */
async function dropUnit(source, position, {force = false} = {}) {
    const scene = source.parent, target = scene.tokens.get(eventFlags(source).rescuedTokenId);
    if (!target || eventFlags(target).rescuedBy !== source.id) throw Error("The carried unit is no longer available.");
    const reason = force ? "" : dropReason(source, target, position, scene, interactionGrid(scene));
    if (reason) throw Error(reason);
    const before = {x: target.x, y: target.y, elevation: target.elevation, hidden: target.hidden,
        wasHidden: eventFlags(target).rescueWasHidden, captured: eventFlags(target).captured ?? null};
    try {
        await updateTokens(scene, [{_id: source.id, [`flags.${SYSTEM_ID}.rescuedTokenId`]: null},
            {_id: target.id, ...position, elevation: source.elevation, hidden: !!before.wasHidden,
                [`flags.${SYSTEM_ID}.rescuedBy`]: null, [`flags.${SYSTEM_ID}.rescueWasHidden`]: null, [`flags.${SYSTEM_ID}.captured`]: null}]);
    } catch (error) {
        try {
            await updateTokens(scene, [{_id: source.id, [`flags.${SYSTEM_ID}.rescuedTokenId`]: target.id},
                {_id: target.id, x: before.x, y: before.y, elevation: before.elevation, hidden: before.hidden,
                    [`flags.${SYSTEM_ID}.rescuedBy`]: source.id, [`flags.${SYSTEM_ID}.rescueWasHidden`]: before.wasHidden, [`flags.${SYSTEM_ID}.captured`]: before.captured}]);
        } catch (rollbackError) { console.error("FEUE | Drop rollback failed", rollbackError); }
        throw error;
    }
    await clearRescuePenalty(source);
    if (before.captured && captureMode() === "capture") await slayUnit(target);
    return target;
}

/** Capture (p. 14): a unit reduced to 0 HP by a declared Capture is Knocked Out and carried in the attacker's square.
 * Subdue, or a captor already carrying someone, leaves the unit Knocked Out where it fell. */
export async function captureUnit(source, target) {
    source = source?.document ?? source; target = target?.document ?? target;
    const mode = captureMode(), scene = source?.parent;
    if (mode === "off" || !source?.actor || !target?.actor || target.parent?.id !== scene?.id) return false;
    if (Number(target.actor.system.attributes?.hp?.value) > 0 || Number(source.actor.system.attributes?.hp?.value) <= 0) return false;
    await knockOut(target.actor);
    const combat = sceneCombat(scene), speaker = ChatMessage.getSpeaker({actor: source.actor, token: source});
    if (mode === "subdue" || eventFlags(source).rescuedTokenId || eventFlags(source).rescuedBy || unavailableUnit(target)) {
        await ChatMessage.create({speaker, content: `<p><b>${esc(source.name)}</b> ${mode === "subdue" ? "subdues" : "knocks out"} <b>${esc(target.name)}</b>, who is Knocked Out instead of slain.</p>`});
        return true;
    }
    const overweight = !(Number(source.actor.system.combat?.aid) > Number(target.actor.system.attributes?.build?.value));
    const wasActive = !!source.actor.system.rescue?.active;
    requireUpdated(await source.actor.update({"system.rescue.active": true}, {feueInteraction: true}));
    try {
        await updateTokens(scene, [{_id: source.id, [`flags.${SYSTEM_ID}.rescuedTokenId`]: target.id},
            {_id: target.id, x: source.x, y: source.y, elevation: source.elevation, hidden: true,
                [`flags.${SYSTEM_ID}.rescuedBy`]: source.id, [`flags.${SYSTEM_ID}.rescueWasHidden`]: !!target.hidden,
                [`flags.${SYSTEM_ID}.captured`]: {by: source.id, combat: combat?.id ?? null, round: combat?.started ? combat.round : 0, overweight}}]);
    } catch (error) {
        await source.actor.update({"system.rescue.active": wasActive}, {feueInteraction: true});
        throw error;
    }
    const heavy = overweight ? `<p>${esc(target.name)}'s Build is not below ${esc(source.name)}'s Aid: the captive will be dropped at the end of ${esc(source.name)}'s next phase.</p>` : "";
    await ChatMessage.create({speaker, content: `<p><b>${esc(source.name)}</b> captures <b>${esc(target.name)}</b>.</p>${heavy}${mode === "capture" ? "<p>A dropped captive is slain.</p>" : ""}`});
    return true;
}

/** Aid rules: an overweight captive is dropped at the end of its captor's next phase. */
export async function endPhaseCaptures(combat, unit) {
    if (!combat || !unit) return;
    const group = allegianceOf(unit, combat).id;
    for (const c of combat.combatants ?? []) {
        const source = c.token, scene = source?.parent;
        if (!source || allegianceOf(c, combat).id !== group) continue;
        const target = scene?.tokens.get(eventFlags(source).rescuedTokenId), captured = eventFlags(target).captured;
        if (!target || !captured?.overweight || !(Number(combat.round) > Number(captured.round))) continue;
        const positions = dropPositions(source, target, scene, interactionGrid(scene));
        const point = positions.values().next().value;
        if (!point && captureMode() !== "capture") {
            ui.notifications.warn(`${source.name} must drop ${target.name}, but no adjacent square is free.`);
            continue;
        }
        await dropUnit(source, point ?? {x: source.x, y: source.y}, {force: !point});
        await ChatMessage.create({speaker: ChatMessage.getSpeaker({actor: source.actor, token: source}),
            content: `<p><b>${esc(source.name)}</b> cannot keep carrying <b>${esc(target.name)}</b> and drops them${captureMode() === "capture" ? "; the captive is slain" : ""}.</p>`});
    }
}

/** Validated on the executing GM, using documents from the requested scene, never canvas selection. */
export function executeInteraction(request, user = game.user) {
    return withUnitActionLock(() => executeInteractionAction(request, user));
}
async function executeInteractionAction(request, user) {
    const scene = game.scenes.get(request.sceneId), source = scene?.tokens.get(request.sourceId);
    if (!user?.active || !source?.actor || !(user.isGM || source.actor.testUserPermission(user, "OWNER"))) throw Error("You do not own this unit.");
    if (!interactEnabled(source) || unavailableUnit(source) || source.actor.type !== "character") throw Error("This unit cannot interact.");
    assertUnitAction(source.actor, {sourceToken: source});
    const grid = interactionGrid(scene), combat = sceneCombat(scene);
    let target, credential, strike, reward, convoy;
    if (request.action === "drop") {
        if (!Number.isFinite(request.position?.x) || !Number.isFinite(request.position?.y)) throw Error("Choose a drop square.");
        const cell = grid.getOffset(request.position), point = grid.getTopLeftPoint(cell);
        if (point.x !== request.position.x || point.y !== request.position.y) throw Error("Choose a grid square.");
        target = await dropUnit(source, point);
    } else if (request.action === "slay") {
        // A captive can be slain as a Major Action, which also drops it; adjacent Knocked Out units can be slain too.
        target = scene.tokens.get(request.targetId);
        if (!target?.actor) throw Error("Choose a unit.");
        if (eventFlags(source).rescuedTokenId === target.id && eventFlags(target).captured) {
            const point = dropPositions(source, target, scene, grid).values().next().value;
            await dropUnit(source, point ?? {x: source.x, y: source.y}, {force: !point});
        } else {
            const reason = interactionReason(source, target, "slay", grid, combat);
            if (reason) throw Error(reason);
        }
        await slayUnit(target);
    } else if (request.action === "convoy") {
        // Any number of stores and takes, validated against the Convoy unit the request names.
        target = scene.tokens.get(request.targetId);
        const access = convoyAccess(source, scene, grid, combat).find(entry => entry.party.id === request.partyId && entry.carrier === target);
        if (!access) throw Error("Be a Convoy unit of this Party, or stand beside one, to reach its Convoy.");
        const ids = value => Array.isArray(value) ? value.map(String) : [];
        convoy = {party: access.party, carrier: target, ...await withInventoryLock(() =>
            transferConvoyItems(access.party, source.actor, {deposit: ids(request.deposit), withdraw: ids(request.withdraw)}))};
    } else {
        if (!["Token", "Tile"].includes(request.targetType)) throw Error("Choose a unit or Event Tile.");
        target = (request.targetType === "Token" ? scene.tokens : scene.tiles).get(request.targetId);
        const reason = interactionReason(source, target, request.action, grid, combat);
        if (reason) throw Error(reason);
        if (request.action === "open") {
            await withInventoryLock(async () => {
                const currentReason = interactionReason(source, target, request.action, grid, sceneCombat(scene));
                if (currentReason) throw Error(currentReason);
                const rewardPlan = planChestReward(source, target);
                const wallId = eventFlags(target).eventWall;
                const wall = wallId ? scene.walls.get(wallId) : null;
                if (wallId && !wall?.door) throw Error("The linked door wall is missing. Update the Event Tile configuration.");
                credential = openCredential(source, eventFlags(target).interactionType);
                const item = credential.item;
                const field = Number(item.system.uses?.max) > 0 ? "system.uses.value" : "system.quantity";
                const before = field === "system.uses.value" ? item.system.uses.value : item.system.quantity;
                const wasSolid = !!eventFlags(target).solid;
                if (credential.consume) requireUpdated(await item.update({[field]: Math.max(0, Number(before ?? 1) - 1)}));
                try {
                    reward = await grantChestReward(rewardPlan);
                    requireUpdated(await target.update({[`flags.${SYSTEM_ID}.opened`]: true, [`flags.${SYSTEM_ID}.solid`]: false}));
                    if (wall) requireUpdated(await wall.update({ds: CONST.WALL_DOOR_STATES.OPEN}));
                } catch (error) {
                    if (reward) await reward.rollback();
                    if (credential.consume) await item.update({[field]: before ?? 1});
                    try { await target.update({[`flags.${SYSTEM_ID}.opened`]: false, [`flags.${SYSTEM_ID}.solid`]: wasSolid}); }
                    catch (rollbackError) { console.error("FEUE | Tile rollback failed", rollbackError); }
                    throw error;
                }
            });
        } else if (request.action === "activate") {
            requireUpdated(await target.update({[`flags.${SYSTEM_ID}.activated`]: true}));
        } else if (request.action === "seize") {
            await seizeTile(source, target, combat);
        } else if (request.action === "escape") {
            await escapeUnit(source, target, combat, {interactionGrid, updateTokens, clearRescuePenalty});
        } else if (request.action === "break") {
            strike = breakAttack(source, target);
            const before = {hp: eventFlags(target).breakHP ?? eventFlags(target).breakMaxHP ?? 20, solid: !!eventFlags(target).solid};
            const wallId = eventFlags(target).eventWall, wall = wallId ? scene.walls.get(wallId) : null;
            if (wallId && !wall) throw Error("The linked destructible wall is missing.");
            // Infinite (0/0 or Remove Durability) weapons spend nothing; Per-Map Durability charges the weapon at the end of the map.
            const uses = strike.weapon?.system.uses, perMap = !strike.demolish && perMapTracked(strike.weapon) && combat?.started;
            const spend = !strike.demolish && !perMap && Number(uses?.max) > 0 && !hasInfiniteUses(uses), remainingUses = uses?.value;
            if (perMap) await recordMapUse(strike.weapon, {combat});
            if (spend) requireUpdated(await strike.weapon.update({"system.uses.value": Math.max(0, Number(remainingUses) - 1)}));
            try {
                requireUpdated(await target.update({[`flags.${SYSTEM_ID}.breakHP`]: strike.remaining,
                    ...(strike.broken ? {[`flags.${SYSTEM_ID}.solid`]: false} : {})}));
                if (strike.broken && wall) requireUpdated(await wall.update({move: 0, sight: 0, light: 0, sound: 0}));
            } catch (error) {
                if (spend) await strike.weapon.update({"system.uses.value": remainingUses});
                await target.update({[`flags.${SYSTEM_ID}.breakHP`]: before.hp, [`flags.${SYSTEM_ID}.solid`]: before.solid});
                throw error;
            }
        } else if (request.action === "rescue") {
            const wasActive = !!source.actor.system.rescue?.active;
            const before = {x: target.x, y: target.y, elevation: target.elevation, hidden: target.hidden};
            requireUpdated(await source.actor.update({"system.rescue.active": true}, {feueInteraction: true}));
            try {
                await updateTokens(scene, [{_id: source.id, [`flags.${SYSTEM_ID}.rescuedTokenId`]: target.id},
                    {_id: target.id, x: source.x, y: source.y, elevation: source.elevation, hidden: true,
                        [`flags.${SYSTEM_ID}.rescuedBy`]: source.id, [`flags.${SYSTEM_ID}.rescueWasHidden`]: !!target.hidden}]);
            } catch (error) {
                try {
                    await updateTokens(scene, [{_id: source.id, [`flags.${SYSTEM_ID}.rescuedTokenId`]: null},
                        {_id: target.id, ...before, [`flags.${SYSTEM_ID}.rescuedBy`]: null, [`flags.${SYSTEM_ID}.rescueWasHidden`]: null}]);
                } catch (rollbackError) { console.error("FEUE | Rescue rollback failed", rollbackError); }
                await source.actor.update({"system.rescue.active": wasActive}, {feueInteraction: true});
                throw error;
            }
        }
    }
    const targetName = eventFlags(target).eventName || target.name || "Event Tile";
    await completeMajorAction(source.actor, {sourceToken: source, attacked: request.action === "break"});
    const verbs = {talk: "talks to", open: "opens", activate: "activates", rescue: "rescues", drop: "drops", seize: "seizes", escape: "escapes through", break: "strikes", slay: "slays"};
    const convoyText = convoy ? `<p><b>${esc(source.name)}</b> uses the <b>${esc(convoy.party.name)}</b> Convoy${convoy.carrier.id === source.id ? "" : ` beside ${esc(convoy.carrier.name)}`}.</p>${
        convoy.stored.length ? `<p>Stored: ${convoy.stored.map(esc).join(", ")}</p>` : ""}${convoy.taken.length ? `<p>Took: ${convoy.taken.map(esc).join(", ")}</p>` : ""}` : "";
    try {
        await ChatMessage.create({speaker: ChatMessage.getSpeaker({actor: source.actor, token: source}),
            content: convoyText || `<p><b>${esc(source.name)}</b> ${verbs[request.action]} <b>${esc(targetName)}</b>${credential ? ` using ${esc(credential.item.name)}` : ""}.</p>${reward ? `<p>Received <b>${esc(reward.item.name)}</b>${reward.inConvoy ? ` → ${esc(reward.recipient.name)} Convoy (inventory full)` : ""}.</p>` : ""}${strike ? strike.demolish ? `<p>Demolish: the structure is destroyed (HP ${strike.hp} → 0).</p>` : `<p>Hit 100% · Crit 0% · ${strike.damage} damage (${strike.power} − ${strike.defense} DEF). HP ${strike.hp} → ${strike.remaining}${strike.broken ? " — Broken!" : ""}</p>` : ""}`});
    } catch (error) { console.error("FEUE | Interaction completed but chat message failed", error); }
    const context = {action: request.action, actor: source.actor, token: source.object ?? source,
        source, target, scene, user, strike, reward, convoy};
    Hooks.callAll("feueInteraction", context);
    // Only a GM-configured world macro may execute with GM authority.
    const flags = eventFlags(target);
    const approvedMacro = eventFlags(scene).eventMacros?.[target.documentName]?.[target.id];
    if (["talk", "open", "activate", "seize", "escape", "break"].includes(request.action) && flags.eventMacro && approvedMacro === flags.eventMacro) {
        const macro = game.macros.get(flags.eventMacro);
        if (macro) {
            try { await macro.execute(context); }
            catch (error) { console.error("FEUE | Interaction macro failed", error); ui.notifications.error("Interaction completed, but its event macro failed. See the console."); }
        }
    }
    return true;
}

export async function requestInteraction(request) {
    if (game.user.isGM) return enqueue(request.sceneId, () => executeInteraction(request));
    if (!game.users.activeGM) throw Error("An active GM is required to resolve interactions.");
    const requestId = foundry.utils.randomID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(Error("The GM did not respond. Check the scene before retrying.")); }, 20000);
        pending.set(requestId, {resolve, reject, timer});
        game.socket.emit(SOCKET, {action: "eventInteraction", requestId, userId: game.user.id, request});
    });
}

export function openInteractionMenu(token, {action = null} = {}) {
    const source = token?.document ?? token;
    if (!source?.actor?.isOwner || !interactEnabled(source) || unavailableUnit(source)) return ui.notifications.warn("This unit cannot interact.");
    try {
        const scene = source.parent, grid = interactionGrid(scene);
        game.firesOfWar.tacticalForecast?.cancelPlanning();
        const visible = target => game.user.isGM || !!target.object?.visible;
        const choices = nearbyInteractions(source, scene, grid, sceneCombat(scene), {visible});
        const carried = scene.tokens.get(eventFlags(source).rescuedTokenId);
        if (carried) {
            const positions = dropPositions(source, carried, scene, grid), captive = !!eventFlags(carried).captured;
            choices.push({action: "drop", name: `${carried.name}${captive ? " (captive)" : ""} — choose a square`, positions, carried, captive,
                reason: positions.size ? "" : "No legal drop square. Move to an open area first."});
            if (captive) choices.push({action: "slay", targetType: "Token", targetId: carried.id, name: `${carried.name} (captive)`, reason: ""});
        }
        // Trade with an adjacent ally (or the unit being carried) opens the Trade dialog for that partner.
        for (const partner of tradePartners(source, scene, grid, sceneCombat(scene))) {
            choices.push({action: "trade", targetType: "Token", targetId: partner.id, name: partner.name, reason: unitActionReason(source)});
        }
        // Convoy: the unit is a Convoy unit, or stands beside one of its Party.
        for (const {party, carrier} of convoyAccess(source, scene, grid, sceneCombat(scene))) {
            choices.push({action: "convoy", targetType: "Token", targetId: carrier.id, partyId: party.id, party, carrier,
                name: `${party.name}${carrier.id === source.id ? "" : ` (beside ${carrier.name})`}`, reason: unitActionReason(source)});
        }
        if (action === "rescue") choices.splice(0, choices.length, ...choices.filter(c => ["rescue", "drop", "slay"].includes(c.action)));
        // Drop highlights the legal adjacent squares on the map; click one to set the unit down.
        const pickDrop = async choice => {
            const position = await squarePicker.start({cells: choice.positions, title: `Drop ${choice.carried.name}`,
                hint: choice.captive && captureMode() === "capture" ? "A dropped captive is slain." : "Choose an adjacent square.",
                invalid: "Drop into a highlighted adjacent square."});
            if (position) await requestInteraction({sceneId: scene.id, sourceId: source.id, action: "drop", position});
        };
        if (action === "rescue" && choices.length === 1 && choices[0].action === "drop" && !choices[0].reason) {
            void pickDrop(choices[0]).catch(error => ui.notifications.warn(error.message));
            return null;
        }
        const labels = {talk: "Talk", open: "Open", activate: "Activate", rescue: "Rescue", drop: "Drop", seize: "Seize", escape: "Escape", break: "Break", slay: "Slay", trade: "Trade", convoy: "Convoy"};
        let dialog;
        dialog = new Dialog({title: `${source.name} — Interact`, content: `<div class="feue-interaction-menu"><p>Solid objects and units: adjacent. Other Tiles: stand on them.</p>${choices.length ? choices.map((choice, index) =>
            `<button type="button" data-interaction="${index}" ${choice.reason ? "disabled" : ""}><b>${labels[choice.action]}</b> — ${esc(choice.name)}</button>${choice.reason ? `<p class="hint">${esc(choice.reason)}</p>` : ""}`).join("") : "<p>No interactions in reach.</p>"}</div>`,
            buttons: {close: {label: "Close"}}, render: html => {
                rootElement(html).querySelectorAll("[data-interaction]").forEach(button => button.addEventListener("click", async () => {
                    if (button.disabled) return;
                    const choice = choices[Number(button.dataset.interaction)];
                    rootElement(html).querySelectorAll("[data-interaction]").forEach(b => { b.disabled = true; });
                    await dialog.close();
                    try {
                        if (choice.action === "drop") await pickDrop(choice);
                        else if (choice.action === "trade") openTradeMenu(source, {allyId: choice.targetId});
                        else if (choice.action === "convoy") openConvoyInteraction({source, party: choice.party, carrier: choice.carrier,
                            inCombat: !!sceneCombat(scene)?.started, submit: moves => requestInteraction({sceneId: scene.id, sourceId: source.id,
                                action: "convoy", targetType: "Token", targetId: choice.targetId, partyId: choice.partyId, ...moves})});
                        else await requestInteraction({sceneId: scene.id, sourceId: source.id, action: choice.action,
                            targetType: choice.targetType, targetId: choice.targetId});
                    } catch (error) { ui.notifications.warn(error.message); }
                }));
            }});
        dialog.render(true);
        return dialog;
    } catch (error) { ui.notifications.warn(error.message); }
}

function macroControl(doc) {
    if (!game.user.isGM) return "";
    const flags = eventFlags(doc);
    return `<div class="form-group"><label>Event macro</label><select name="flags.${SYSTEM_ID}.eventMacro"><option value="">None (chat and event hook only)</option>${Array.from(game.macros).map(m => `<option value="${esc(m.id)}" ${flags.eventMacro === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></div><p class="hint">Runs after Talk, Open, Activate, Seize, Escape, or Break. Macro variables: action, actor, token, source, target, scene, user, strike (Break only).</p>`;
}

/** Reconcile movement, manual sheet toggles, and deleted carrier/target documents. */
export async function reconcileRescues(scene) {
    if (!scene || !activeGM()) return;
    for (const source of scene.tokens) {
        const carriedId = eventFlags(source).rescuedTokenId;
        if (carriedId) {
            const target = scene.tokens.get(carriedId);
            if (!target || eventFlags(target).rescuedBy !== source.id) {
                await updateTokens(scene, [{_id: source.id, [`flags.${SYSTEM_ID}.rescuedTokenId`]: null}]);
                await clearRescuePenalty(source);
            } else if (!source.actor.system.rescue?.active) {
                const positions = dropPositions(source, target, scene, interactionGrid(scene));
                if (positions.size) await dropUnit(source, positions.values().next().value);
                else {
                    await source.actor.update({"system.rescue.active": true}, {feueInteraction: true});
                    ui.notifications.warn(`${source.name} cannot stop rescuing until an adjacent drop square is free.`);
                }
            } else if (target.x !== source.x || target.y !== source.y || target.elevation !== source.elevation || !target.hidden) {
                await updateTokens(scene, [{_id: target.id, x: source.x, y: source.y, elevation: source.elevation, hidden: true}]);
            }
        }
        const carrierId = eventFlags(source).rescuedBy;
        if (carrierId && eventFlags(scene.tokens.get(carrierId)).rescuedTokenId !== source.id) {
            await updateTokens(scene, [{_id: source.id, hidden: !!eventFlags(source).rescueWasHidden,
                [`flags.${SYSTEM_ID}.rescuedBy`]: null, [`flags.${SYSTEM_ID}.rescueWasHidden`]: null, [`flags.${SYSTEM_ID}.captured`]: null}]);
        }
    }
}

export function guardCarriedMovement(doc, changed, options = {}) {
    if (unavailableUnit(doc) && !(game.user.isGM && options.feueInteraction) &&
        (!game.user.isGM || !options.isUndo) && ["x", "y", "elevation"].some(key => key in changed)) {
        ui.notifications.warn(isEscaped(doc) ? "This unit has escaped the encounter." : "A rescued unit moves with its rescuer. Drop it first.");
        return false;
    }
}

export function eventTileError(flags, actors = game.actors) {
    const whole = (value, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(Number(value)) && Number(value) >= minimum && Number(value) <= maximum;
    if (["escape", "reinforcement"].includes(flags.interactionType) && flags.solid) return "Escape and Reinforcement Tiles must be non-solid.";
    if (flags.interactionType === "break") {
        if (!whole(flags.breakDefense ?? 0, 0) || !whole(flags.breakHP ?? flags.breakMaxHP ?? 20, 0) || !whole(flags.breakMaxHP ?? 20)) return "Break requires whole-number DEF and HP; maximum HP must be positive.";
        if (Number(flags.breakHP ?? flags.breakMaxHP ?? 20) > Number(flags.breakMaxHP ?? 20)) return "Current HP cannot exceed maximum HP.";
    }
    if (flags.interactionType === "chest" && flags.chestReward && !inventoryItem(flags.chestReward)) return "Chest rewards must be weapons or inventory items.";
    if (flags.interactionType === "reinforcement" && flags.reinforcementEnabled !== false) {
        if (actors?.get(flags.reinforcementActor)?.type !== "character") return "Choose a character Actor for reinforcements.";
        if (!whole(flags.reinforcementCount ?? 1, 1, 99)) return "Use between 1 and 99 units per wave.";
        if (flags.reinforcementMode === "every") {
            if (!whole(flags.reinforcementInterval ?? 3) || !whole(flags.reinforcementStart ?? flags.reinforcementInterval ?? 3)) return "Use positive whole numbers for the reinforcement interval and first round.";
        } else if (!reinforcementTurns(flags.reinforcementTurns ?? "3, 5")) return "Enter positive round numbers separated by commas (for example 3, 5).";
    }
    return "";
}

export function registerEventInteractions() {
    registerEventEncounter({enqueue, interactionGrid, updateTokens, clearRescuePenalty, sceneCombat});
    const validateTile = (doc, data) => {
        const flags = {...eventFlags(doc), ...(data.flags?.[SYSTEM_ID] ?? {})};
        for (const [key, value] of Object.entries(data)) if (key.startsWith(`flags.${SYSTEM_ID}.`)) flags[key.slice(`flags.${SYSTEM_ID}.`.length)] = value;
        const error = eventTileError(flags);
        if (error) { ui.notifications.warn(error); return false; }
        if (flags.interactionType === "break" && Number(flags.breakHP ?? flags.breakMaxHP ?? 20) === 0) {
            if (doc.id) data[`flags.${SYSTEM_ID}.solid`] = false;
            else doc.updateSource({[`flags.${SYSTEM_ID}.solid`]: false});
        }
    };
    Hooks.on("preUpdateTile", validateTile);
    Hooks.on("preCreateTile", validateTile);
    Hooks.once("ready", () => {
        Object.assign(game.firesOfWar ??= {}, {openInteractionMenu, requestInteraction, captureUnit, endPhaseCaptures});
        game.socket.on(SOCKET, payload => {
            if (payload?.action === "eventInteractionResult" && payload.userId === game.user.id) {
                const entry = pending.get(payload.requestId);
                if (!entry) return;
                clearTimeout(entry.timer); pending.delete(payload.requestId);
                if (payload.error) entry.reject(Error(payload.error)); else entry.resolve(true);
            } else if (payload?.action === "eventInteraction" && activeGM()) {
                void enqueue(payload.request?.sceneId, () => executeInteraction(payload.request, game.users.get(payload.userId)))
                    .then(() => game.socket.emit(SOCKET, {action: "eventInteractionResult", requestId: payload.requestId, userId: payload.userId}))
                    .catch(error => game.socket.emit(SOCKET, {action: "eventInteractionResult", requestId: payload.requestId, userId: payload.userId, error: error.message}));
            }
        });
        if (activeGM()) for (const scene of game.scenes) void enqueue(scene.id, () => reconcileRescues(scene)).catch(console.error);
    });
    Hooks.on("renderTokenConfig", (app, html) => {
        const root = rootElement(html), doc = app.document ?? app.object, flags = eventFlags(doc);
        const target = root?.querySelector(".feue-strides")?.parentElement ?? root?.querySelector('.tab[data-tab="character"]') ?? root?.querySelector("form") ?? root;
        if (!target || target.querySelector(".feue-interaction-config")) return;
        target.insertAdjacentHTML("beforeend", `<fieldset class="feue-interaction-config"><legend>Interaction</legend>
            <label><input type="checkbox" name="flags.${SYSTEM_ID}.interact" ${interactEnabled(doc) ? "checked" : ""}> Interact</label>
            <label><input type="checkbox" name="flags.${SYSTEM_ID}.talk" ${flags.talk !== false ? "checked" : ""}> Talk</label>
            <label><input type="checkbox" name="flags.${SYSTEM_ID}.rescuable" ${flags.rescuable !== false ? "checked" : ""}> Can be rescued</label>
            <p class="hint">Interact enables this unit's interactions and makes it an interaction target. Talk and Rescue are enabled by default.</p>${macroControl(doc)}</fieldset>`);
    });
    Hooks.on("renderTileConfig", (app, html) => {
        const root = rootElement(html), doc = app.document ?? app.object, flags = eventFlags(doc);
        const target = root?.querySelector('.tab[data-tab="position"]') ?? root?.querySelector('.tab[data-tab="basic"]') ?? root?.querySelector("form") ?? root;
        if (!target || target.querySelector(".feue-event-tile-config")) return;
        target.insertAdjacentHTML("beforeend", `<fieldset class="feue-event-tile-config"><legend>Event Tile</legend>
            <label><input type="checkbox" name="flags.${SYSTEM_ID}.interactable" ${flags.interactable ? "checked" : ""}> Interactable</label>
            <label><input type="checkbox" name="flags.${SYSTEM_ID}.solid" ${flags.solid ? "checked" : ""}> Solid (blocks movement)</label>
            <div class="form-group"><label>Event name</label><input type="text" name="flags.${SYSTEM_ID}.eventName" value="${esc(flags.eventName)}"></div>
            <div class="form-group"><label>Interaction</label><select name="flags.${SYSTEM_ID}.interactionType">${[["activate", "Activate"], ["door", "Open Door"], ["chest", "Open Chest"], ["seize", "Seize"], ["escape", "Escape"], ["break", "Break"], ["reinforcement", "Reinforcements"]].map(([key, label]) => `<option value="${key}" ${(flags.interactionType ?? "activate") === key ? "selected" : ""}>${label}</option>`).join("")}</select></div>
            <div data-event-types="door break"><div class="form-group"><label>Linked wall</label><select name="flags.${SYSTEM_ID}.eventWall"><option value="">None (Tile only)</option>${Array.from(doc.parent?.walls ?? []).map(w => `<option value="${esc(w.id)}" ${flags.eventWall === w.id ? "selected" : ""}>${w.door ? "Door" : "Wall"} ${esc(w.id)} (${w.c[0]}, ${w.c[1]})</option>`).join("")}</select></div><p class="hint">Open requires a door wall. Breaking clears the linked wall's movement, sight, light, and sound blocking.</p></div>
            <div data-event-types="door chest"><label><input type="checkbox" name="flags.${SYSTEM_ID}.opened" ${flags.opened ? "checked" : ""}> Opened (clear to reset)</label></div>
            <div data-event-types="chest" class="feue-chest-reward">
                <input type="hidden" name="flags.${SYSTEM_ID}.chestReward" data-dtype="JSON" value="${esc(JSON.stringify(flags.chestReward ?? null))}">
                <div class="form-group"><label>Chest reward</label><select class="feue-chest-item-picker"><option value="">Choose a world item</option>${Array.from(game.items ?? []).filter(inventoryItem).map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("")}</select></div>
                <p class="feue-chest-item-name">${esc(flags.chestReward?.name || "No item attached")}</p><button type="button" class="feue-chest-item-clear">Clear reward</button>
                <p class="hint">Drag a world, compendium, or carried weapon/item here to attach a copy. It is awarded once when opened. If the unit's five slots are full, it goes to the Party Convoy.</p>
                <div class="form-group"><label>Overflow Convoy</label><select name="flags.${SYSTEM_ID}.chestConvoyParty"><option value="">Automatic (opener's Party)</option>${Array.from(game.actors ?? []).filter(actor => actor.type === "party").map(party => `<option value="${esc(party.id)}" ${flags.chestConvoyParty === party.id ? "selected" : ""}>${esc(party.name)}</option>`).join("")}</select></div>
            </div>
            <div data-event-types="seize"><p class="hint">Set the encounter objective to Seize. Every Seize Tile must be secured using Interact.</p></div>
            <div data-event-types="escape"><p class="hint">Set the encounter objective to Escape. Reaching any non-solid Escape Tile automatically removes an eligible unit from play. Choose all units or one selected unit in Objectives.</p></div>
            <div data-event-types="break">${[["breakDefense", "DEF", 0, 0], ["breakHP", "Current HP", flags.breakMaxHP ?? 20, 0], ["breakMaxHP", "Maximum HP", 20, 1]].map(([key, label, fallback, min]) => `<div class="form-group"><label>${label}</label><input type="number" name="flags.${SYSTEM_ID}.${key}" min="${min}" step="1" value="${Number(flags[key] ?? fallback)}"></div>`).join("")}<p class="hint">An equipped weapon strikes against DEF with 100% hit and 0% critical chance, consuming one weapon use. At 0 HP this Tile stops being solid.</p></div>
            <div data-event-types="reinforcement">
                <label><input type="checkbox" name="flags.${SYSTEM_ID}.reinforcementEnabled" ${flags.reinforcementEnabled !== false ? "checked" : ""}> Reinforcements enabled</label>
                <div class="form-group"><label>Unit type</label><select name="flags.${SYSTEM_ID}.reinforcementActor"><option value="">Choose a character Actor</option>${Array.from(game.actors ?? []).filter(a => a.type === "character").map(a => `<option value="${esc(a.id)}" ${flags.reinforcementActor === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></div>
                <div class="form-group"><label>Allegiance</label><select name="flags.${SYSTEM_ID}.reinforcementAllegiance"><option value="">Automatic (disposition)</option>${allegiances(sceneCombat(doc.parent)).map(g => `<option value="${esc(g.id)}" ${flags.reinforcementAllegiance === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select></div>
                <div class="form-group"><label>Units per wave</label><input type="number" min="1" max="99" step="1" name="flags.${SYSTEM_ID}.reinforcementCount" value="${Number(flags.reinforcementCount ?? 1)}"></div>
                <div class="form-group"><label>Schedule</label><select name="flags.${SYSTEM_ID}.reinforcementMode"><option value="turns" ${flags.reinforcementMode !== "every" ? "selected" : ""}>Specific rounds</option><option value="every" ${flags.reinforcementMode === "every" ? "selected" : ""}>Every X rounds</option></select></div>
                <div data-reinforcement-mode="turns" class="form-group"><label>Rounds</label><input type="text" name="flags.${SYSTEM_ID}.reinforcementTurns" value="${esc(flags.reinforcementTurns ?? "3, 5")}" placeholder="3, 5"></div>
                <div data-reinforcement-mode="every">${[["reinforcementInterval", "Every X rounds", 3], ["reinforcementStart", "First round", flags.reinforcementInterval ?? 3]].map(([key, label, fallback]) => `<div class="form-group"><label>${label}</label><input type="number" min="1" step="1" name="flags.${SYSTEM_ID}.${key}" value="${Number(flags[key] ?? fallback)}"></div>`).join("")}</div>
                <p class="hint">Waves arrive at the start of encounter rounds. An occupied Tile skips that wave. Extra units use legal adjacent spaces; excess units are skipped. The Tile itself should be non-solid.</p>
            </div>
            <p class="hint">Solid Tiles require adjacency; other Tiles require standing on them. Open consumes one Key/Lockpick use and clears Solid. Activate can be repeated.</p>${macroControl(doc)}</fieldset>`);
        const field = target.querySelector(".feue-event-tile-config"), kind = field.querySelector(`[name="flags.${SYSTEM_ID}.interactionType"]`);
        const mode = field.querySelector(`[name="flags.${SYSTEM_ID}.reinforcementMode"]`);
        const refresh = () => {
            field.querySelectorAll("[data-event-types]").forEach(el => { el.hidden = !el.dataset.eventTypes.split(" ").includes(kind.value); });
            field.querySelectorAll("[data-reinforcement-mode]").forEach(el => { el.hidden = el.dataset.reinforcementMode !== mode.value; });
        };
        kind.addEventListener("change", () => {
            const solid = field.querySelector(`[name="flags.${SYSTEM_ID}.solid"]`);
            if (["escape", "reinforcement"].includes(kind.value)) solid.checked = false;
            if (kind.value === "break") solid.checked = true;
            refresh();
        });
        mode.addEventListener("change", refresh); refresh();
        const chest = field.querySelector(".feue-chest-reward");
        const attach = item => {
            const input = chest.querySelector(`[name="flags.${SYSTEM_ID}.chestReward"]`);
            input.value = JSON.stringify(item ? inventoryCopy(item) : null);
            chest.querySelector(".feue-chest-item-name").textContent = item?.name || "No item attached";
            input.dispatchEvent(new Event("change", {bubbles: true}));
        };
        chest.querySelector(".feue-chest-item-picker").addEventListener("change", event => {
            const item = game.items.get(event.target.value);
            if (item) attach(item);
        });
        chest.querySelector(".feue-chest-item-clear").addEventListener("click", () => attach(null));
        chest.addEventListener("dragover", event => { event.preventDefault(); });
        chest.addEventListener("drop", async event => {
            event.preventDefault(); event.stopPropagation();
            try {
                const data = JSON.parse(event.dataTransfer.getData("text/plain"));
                if (data.type !== "Item") throw Error("Attach a weapon or inventory item.");
                const item = await Item.implementation.fromDropData(data);
                if (!inventoryItem(item)) throw Error("Attach a weapon or inventory item.");
                attach(item);
            } catch (error) { ui.notifications.warn(error.message); }
        });
    });
    // Approval belongs to the Scene, whose flags players cannot write. A marker
    // on an owned Token would itself be editable by the owner and is not authority.
    for (const type of ["Token", "Tile"]) {
        const rememberMacro = (doc, userId) => {
            if (!activeGM() || !game.users.get(userId)?.isGM || doc.parent?.documentName !== "Scene") return;
            void enqueue(doc.parent.id, () => doc.parent.update({
                [`flags.${SYSTEM_ID}.eventMacros.${type}.${doc.id}`]: eventFlags(doc).eventMacro || null
            })).catch(console.error);
        };
        Hooks.on(`update${type}`, (doc, changed, options, userId) => {
            if (`flags.${SYSTEM_ID}.eventMacro` in changed || "eventMacro" in (changed.flags?.[SYSTEM_ID] ?? {})) rememberMacro(doc, userId);
        });
        Hooks.on(`create${type}`, (doc, options, userId) => { if (eventFlags(doc).eventMacro) rememberMacro(doc, userId); });
    }
    Hooks.on("preUpdateToken", guardCarriedMovement);
    Hooks.on("preMoveToken", (doc, movement, options) => guardCarriedMovement(doc, movement.destination, options));
    for (const hook of ["updateToken", "deleteToken"]) Hooks.on(hook, (doc, changed, options = {}) => {
        // deleteToken's second argument is options, unlike updateToken.
        if (!activeGM() || options.feueInteraction || hook === "deleteToken" && changed?.feueInteraction) return;
        void enqueue(doc.parent.id, async () => {
            if (hook === "deleteToken" && eventFlags(doc).rescuedTokenId) await clearRescuePenalty(doc);
            await reconcileRescues(doc.parent);
        }).catch(console.error);
    });
    Hooks.on("updateActor", (actor, changed, options) => {
        if (!activeGM() || options.feueInteraction) return;
        if (changed.system?.rescue === undefined && !("system.rescue.active" in changed)) return;
        for (const scene of game.scenes) if (Array.from(scene.tokens).some(token => token.actor === actor && eventFlags(token).rescuedTokenId)) {
            void enqueue(scene.id, () => reconcileRescues(scene)).catch(console.error);
        }
    });
}
