import {SYSTEM_ID} from "../map/terrain.mjs";
import {eventFlags, unavailableUnit} from "../encounter/event-rules.mjs";
import {isMonsterWeapon} from "../rules/monster-classes.mjs";

export const INVENTORY_LIMIT = 5;
export const inventoryItem = item => ["weapon", "item"].includes(item?.type);
export const vehicleItem = item => {
    const properties = item?.system?.properties;
    return typeof properties === "string" || Array.isArray(properties) ? /\bvehicle\b/i.test(String(properties)) : !!properties?.vehicle;
};
export const inventoryUsage = actor => {
    const used = Array.from(actor?.items ?? []).filter(inventoryItem).length;
    return {used, max: INVENTORY_LIMIT, full: used >= INVENTORY_LIMIT};
};
export const baseActorId = actor => actor?.token?.actorId ?? actor?.id;
/** The Convoy checkbox on a character: in combat, it and adjacent allies reach the Party Convoy through Interact. */
export const isConvoyUnit = actor => actor?.type === "character" && !!actor.system?.convoyUnit;
export const partiesOf = actor => Array.from(globalThis.game?.actors ?? []).filter(party => party.type === "party" && (party.system.memberIds ?? []).includes(baseActorId(actor)));
export const owns = (user, actor) => !!user?.isGM || !!actor?.testUserPermission?.(user, "OWNER");

/** Chest awards and Convoy transfers share one queue on the executing GM. */
let inventoryQueue = Promise.resolve();
export function withInventoryLock(operation) {
    const result = inventoryQueue.catch(() => {}).then(operation);
    inventoryQueue = result.catch(() => {});
    return result;
}

export function inventoryCopy(item) {
    const data = structuredClone(item.toObject ? item.toObject() : item);
    if (!inventoryItem(data)) throw Error("Convoy and chest rewards accept weapons and inventory items.");
    if (vehicleItem(data)) throw Error("Vehicle weapons are map emplacements and cannot be picked up or transferred.");
    if (isMonsterWeapon(data)) throw Error("Monster Weapons cannot be traded or looted.");
    delete data._id; delete data.id; delete data.folder; delete data.pack;
    data.system ??= {}; data.system.equipped = false;
    if (data.flags?.[SYSTEM_ID]) delete data.flags[SYSTEM_ID].stockQuantity;
    return data;
}

export function partyInCombat(party, combats = globalThis.game?.combats ?? []) {
    const members = new Set(party?.system?.memberIds ?? []);
    return Array.from(combats).some(combat => combat.started && Array.from(combat.combatants ?? []).some(unit =>
        members.has(unit.token?.actorId ?? baseActorId(unit.actor))));
}

export function convoyAccessReason(party, unit, action, user = game.user) {
    if (party?.type !== "party") return "Choose a Party with a Convoy.";
    if (!user?.active) return "This user is no longer active.";
    if (["deposit", "withdraw"].includes(action)) {
        if (unit?.type !== "character" || !(party.system.memberIds ?? []).includes(baseActorId(unit))) return "Choose a character belonging to this Party.";
        if (!owns(user, unit)) return "You do not own this unit.";
    } else if (!owns(user, party)) return "Only Party owners or the GM can add or discard Convoy stock.";
    if (unit?.isToken && unavailableUnit(unit.token)) return "This unit is being carried or has escaped.";
    if (partyInCombat(party)) {
        if (["deposit", "withdraw"].includes(action) && unit?.type === "character" && !unit.isToken) {
            const copies = Array.from(game.combats ?? []).filter(combat => combat.started).flatMap(combat => Array.from(combat.combatants ?? []))
                .filter(combatant => (combatant.token?.actorId ?? baseActorId(combatant.actor)) === unit.id);
            if (copies.length && !copies.some(combatant => combatant.actor?.uuid === unit.uuid)) return "Choose this unit's combat token to use its inventory.";
            if (copies.length && copies.every(combatant => unavailableUnit(combatant.token))) return "This unit is being carried or has escaped.";
        }
        // Players reach the Convoy through Interact, which spends the Major Action; the GM can still manage stock here.
        if (!user.isGM) return "During combat, use Interact as a Convoy unit, or beside one, to reach the Convoy.";
    }
    return "";
}

/** Convoy Interact: store and take any number of items as one transfer. Runs on the GM inside withInventoryLock. */
export async function transferConvoyItems(party, unit, {deposit = [], withdraw = []} = {}) {
    if (new Set(deposit).size !== deposit.length || new Set(withdraw).size !== withdraw.length) throw Error("Each item can only move once.");
    const stored = deposit.map(id => unit.items.get(id)), taken = withdraw.map(id => party.items.get(id));
    if (!stored.length && !taken.length) throw Error("Choose items to store or take.");
    if (![...stored, ...taken].every(inventoryItem)) throw Error("An inventory item is no longer available.");
    if (inventoryUsage(unit).used - stored.length + taken.length > INVENTORY_LIMIT) throw Error(`${unit.name} can carry at most ${INVENTORY_LIMIT} weapons and items.`);
    const toConvoy = stored.map(inventoryCopy), toUnit = taken.map(inventoryCopy);
    const options = {feueConvoy: true, feueConvoyUnit: unit.uuid};
    const originals = [...stored, ...taken].map(item => ({actor: item.parent, data: item.toObject()})), created = [];
    try {
        if (toConvoy.length) created.push(...(await party.createEmbeddedDocuments("Item", toConvoy, options) ?? []));
        if (toUnit.length) created.push(...(await unit.createEmbeddedDocuments("Item", toUnit, options) ?? []));
        if (created.length !== toConvoy.length + toUnit.length) throw Error("Item creation was rejected.");
        if (stored.length) await unit.deleteEmbeddedDocuments("Item", deposit, options);
        if (taken.length) await party.deleteEmbeddedDocuments("Item", withdraw, options);
        if (originals.some(({actor, data}) => actor.items.get(data._id))) throw Error("Item removal was rejected.");
    } catch (error) {
        for (const item of created) if (item.parent?.items.get(item.id)) await item.parent.deleteEmbeddedDocuments("Item", [item.id], options).catch(console.error);
        for (const {actor, data} of originals) if (!actor.items.get(data._id)) await actor.createEmbeddedDocuments("Item", [data], {...options, keepId: true}).catch(console.error);
        throw error;
    }
    return {stored: stored.map(item => item.name), taken: taken.map(item => item.name)};
}

export function rewardParty(source, preferredId) {
    if (preferredId) {
        const party = game.actors.get(preferredId);
        if (party?.type !== "party") throw Error("The chest's overflow Party is missing. Update the Event Tile configuration.");
        return party;
    }
    const matches = Array.from(game.actors ?? []).filter(actor => actor.type === "party" && (actor.system.memberIds ?? []).includes(baseActorId(source.actor)));
    if (matches.length > 1) throw Error("This unit belongs to multiple Parties. Choose the chest's overflow Party.");
    if (!matches.length) throw Error("Inventory is full. Add this unit to a Party or choose an overflow Party on the chest.");
    return matches[0];
}

export function planChestReward(source, tile) {
    const flags = eventFlags(tile);
    if (flags.interactionType !== "chest" || !flags.chestReward) return null;
    const data = inventoryCopy(flags.chestReward), inConvoy = inventoryUsage(source.actor).full;
    return {data, recipient: inConvoy ? rewardParty(source, flags.chestConvoyParty) : source.actor, inConvoy};
}

async function createOne(actor, data, options) {
    const created = await actor.createEmbeddedDocuments("Item", [data], options);
    if (!created || created.length !== 1) {
        if (created?.length) await actor.deleteEmbeddedDocuments("Item", created.map(item => item.id), options);
        throw Error("Item creation was rejected.");
    }
    return created[0];
}
async function deleteOne(actor, id, options) {
    await actor.deleteEmbeddedDocuments("Item", [id], options);
    if (actor.items.get(id)) throw Error("Item removal was rejected.");
}

export async function grantChestReward(plan) {
    if (!plan) return null;
    const options = {feueChestReward: true};
    const item = await createOne(plan.recipient, plan.data, options);
    return {item, recipient: plan.recipient, inConvoy: plan.inConvoy,
        rollback: () => deleteOne(plan.recipient, item.id, options)};
}

const resolveActor = async uuid => {
    const actor = uuid ? await fromUuid(uuid) : null;
    if (actor && actor.documentName !== "Actor") throw Error("Choose a character Actor.");
    return actor;
};

/** Never accept item data from a player; resolve stock and source documents on the GM. */
export async function executeConvoy(request, user = game.user) {
    if (!game.user.isGM) throw Error("Convoy changes must be resolved by a GM.");
    return withInventoryLock(async () => {
        const party = game.actors.get(request.partyId), unit = await resolveActor(request.unitUuid);
        if (!["add", "deposit", "withdraw", "discard"].includes(request.action)) throw Error("Choose a Convoy action.");
        const reason = convoyAccessReason(party, unit, request.action, user);
        if (reason) throw Error(reason);
        const options = {feueConvoy: true, feueConvoyUnit: unit?.uuid ?? null};
        if (request.action === "discard") {
            const item = party.items.get(request.itemId);
            if (!inventoryItem(item)) throw Error("That Convoy item is no longer available.");
            await deleteOne(party, item.id, options);
            return {name: item.name, destination: "discarded"};
        }
        let source, item, destination;
        if (request.action === "add") {
            item = await fromUuid(request.itemUuid);
            if (!item || item.documentName !== "Item" || item.parent || !inventoryItem(item)) throw Error("Add a world or compendium weapon/item. Deposit carried items using their unit.");
            if (!user.isGM && !item.testUserPermission?.(user, "OBSERVER")) throw Error("You cannot access that item.");
            destination = party;
        } else {
            source = request.action === "deposit" ? unit : party;
            destination = request.action === "deposit" ? party : unit;
            item = source.items.get(request.itemId);
            if (!inventoryItem(item)) throw Error("That inventory item is no longer available.");
            if (destination === unit && inventoryUsage(unit).full) throw Error(`${unit.name}'s inventory is full (${INVENTORY_LIMIT} slots).`);
        }
        const created = await createOne(destination, inventoryCopy(item), options);
        if (source) {
            try { await deleteOne(source, item.id, options); }
            catch (error) { await deleteOne(destination, created.id, options); throw error; }
        }
        return {name: created.name, destination: destination.name, inConvoy: destination === party};
    });
}

const SOCKET = `system.${SYSTEM_ID}`, pending = new Map();
const activeGM = () => game.users.activeGM?.id === game.user.id;
export async function requestConvoy(request) {
    if (game.user.isGM) return executeConvoy(request);
    if (!game.users.activeGM) throw Error("An active GM is required for Convoy transfers.");
    const requestId = foundry.utils.randomID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(Error("The GM did not respond. Check the inventories before retrying.")); }, 20000);
        pending.set(requestId, {resolve, reject, timer});
        game.socket.emit(SOCKET, {action: "convoyRequest", requestId, userId: game.user.id, request});
    });
}

/** Generic Party item writes cannot bypass the combat restriction by using the normal item sheet/drop flow.
 * The GM always passes, which covers chest overflow and Convoy Interact transfers resolved on the GM. */
export function guardConvoyItem(item, data, options = {}) {
    const party = item.parent;
    if (party?.type !== "party" || !inventoryItem(item) || !partyInCombat(party) || game.user.isGM) return;
    const unit = options.feueConvoyUnit ? fromUuidSync(options.feueConvoyUnit) : null;
    const reason = convoyAccessReason(party, unit, "add", game.user);
    if (reason) { ui.notifications.warn(reason); return false; }
}

export function registerConvoy() {
    Hooks.once("ready", () => {
        Object.assign(game.firesOfWar ??= {}, {requestConvoy});
        game.socket.on(SOCKET, payload => {
            if (payload?.action === "convoyResult" && payload.userId === game.user.id) {
                const entry = pending.get(payload.requestId);
                if (!entry) return;
                clearTimeout(entry.timer); pending.delete(payload.requestId);
                if (payload.error) entry.reject(Error(payload.error)); else entry.resolve(payload.result);
            } else if (payload?.action === "convoyRequest" && activeGM()) {
                void executeConvoy(payload.request, game.users.get(payload.userId))
                    .then(result => game.socket.emit(SOCKET, {action: "convoyResult", requestId: payload.requestId, userId: payload.userId, result}))
                    .catch(error => game.socket.emit(SOCKET, {action: "convoyResult", requestId: payload.requestId, userId: payload.userId, error: error.message}));
            }
        });
    });
    Hooks.on("preCreateItem", guardConvoyItem);
    Hooks.on("preUpdateItem", guardConvoyItem);
    Hooks.on("preDeleteItem", (item, options) => guardConvoyItem(item, {}, options));
    for (const hook of ["updateCombat", "createCombatant", "deleteCombatant", "updateCombatant", "deleteCombat", "createItem", "updateItem", "deleteItem", "updateActor"]) Hooks.on(hook, () => {
        for (const actor of game.actors ?? []) if (actor.type === "party" && actor.sheet?.rendered) actor.sheet.render(false);
    });
}
