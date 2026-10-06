import {INVENTORY_LIMIT, inventoryItem, inventoryUsage, baseActorId, owns, partyInCombat, convoyAccessReason, requestConvoy, isConvoyUnit} from "./convoy.mjs";
import {esc, rootElement} from "../map/terrain-ui.mjs";
import {createEncounterDialogClass} from "../encounter/tactical-encounter.mjs";
import {hasInfiniteUses, formatUses} from "../rules/feue.mjs";

export function convoyUnits(party) {
    const members = new Set(party.system.memberIds ?? []), choices = new Map();
    const add = (actor, label) => {
        if (actor?.type !== "character" || !members.has(baseActorId(actor)) || !owns(game.user, actor)) return;
        const uuid = actor.uuid;
        if (uuid && !choices.has(uuid)) choices.set(uuid, {actor, uuid, label});
    };
    for (const combat of game.combats ?? []) if (combat.started) for (const unit of combat.combatants ?? []) add(unit.actor, `${unit.token?.name || unit.actor?.name} (combat unit)`);
    for (const id of members) { const actor = game.actors.get(id); add(actor, `${actor?.name} (character)`); }
    for (const scene of game.scenes ?? []) for (const token of scene.tokens ?? []) {
        if (!token.actorLink && (game.user.isGM || !token.hidden)) add(token.actor, `${token.name} — ${scene.name || "Scene"} (token)`);
    }
    return [...choices.values()].map(choice => ({...choice, reason: convoyAccessReason(party, choice.actor, "deposit"), inventory: inventoryUsage(choice.actor)}));
}

export function convoySheetData(party, selectedUuid) {
    const units = convoyUnits(party), selected = units.find(unit => unit.uuid === selectedUuid) ?? units.find(unit => !unit.reason) ?? units[0];
    const transferReason = selected?.reason || (!selected ? "Select an owned Party member to transfer items." : "");
    const manageReason = convoyAccessReason(party, selected?.actor, "add");
    return {units: units.map(({actor, ...unit}) => ({...unit, selected: selected?.uuid === unit.uuid})), selectedUuid: selected?.uuid ?? "",
        items: Array.from(party.items).filter(inventoryItem).sort((a, b) => a.name.localeCompare(b.name)).map(item => ({
            id: item.id, name: item.name, img: item.img, quantity: item.system.quantity ?? 1,
            uses: hasInfiniteUses(item.system.uses) || Number(item.system.uses?.max) > 0 ? formatUses(item.system.uses) : "",
            canWithdraw: !transferReason && !selected.inventory.full})),
        inCombat: partyInCombat(party), canTransfer: !transferReason, canDeposit: !transferReason && selected.inventory.used > 0,
        canManage: !manageReason, reason: transferReason, manageReason,
        inventory: selected?.inventory, selectedName: selected?.actor.name,
        carriers: (party.system.memberIds ?? []).map(id => game.actors.get(id)).filter(isConvoyUnit).map(actor => actor.name).join(", ")};
}

const usesLabel = item => hasInfiniteUses(item.system.uses) || Number(item.system.uses?.max) > 0 ? ` · ${formatUses(item.system.uses)}` : "";

/** Convoy Interact: stage any number of transfers, then confirm them together as one Major Action.
 * `submit({deposit, withdraw})` sends the item ids to the GM. */
export function openConvoyInteraction({source, party, carrier, inCombat, submit}) {
    const unit = source.actor, deposit = new Set(), withdraw = new Set();
    const carried = () => Array.from(unit.items).filter(inventoryItem), stock = () => Array.from(party.items).filter(inventoryItem).sort((a, b) => a.name.localeCompare(b.name));
    const used = () => carried().length - deposit.size + withdraw.size;
    const row = (item, move, staged, full = false) => `<li class="feue-convoy-row${staged ? " staged" : ""}">
        <img src="${esc(item.img)}" alt="" width="28" height="28"><span><strong>${esc(item.name)}</strong><small>${staged ? move === "deposit" ? "Storing" : "Taking" : `Qty ${esc(item.system.quantity ?? 1)}`}${esc(usesLabel(item))}${item.system.equipped ? " · equipped" : ""}</small></span>
        <button type="button" data-move="${move}" data-item="${esc(item.id)}" ${full ? "disabled title=\"Inventory full: store an item first\"" : ""}>${staged ? "Undo" : move === "deposit" ? "Store" : "Take"}</button></li>`;
    const lists = () => {
        const full = used() >= INVENTORY_LIMIT;
        const left = [...carried().filter(item => !deposit.has(item.id)).map(item => row(item, "deposit", false)),
            ...stock().filter(item => withdraw.has(item.id)).map(item => row(item, "withdraw", true))];
        const right = [...stock().filter(item => !withdraw.has(item.id)).map(item => row(item, "withdraw", false, full)),
            ...carried().filter(item => deposit.has(item.id)).map(item => row(item, "deposit", true))];
        return `<section><h4>${esc(unit.name)} <small>${used()} / ${INVENTORY_LIMIT}</small></h4><ul>${left.join("") || "<li class=\"empty\">No weapons or items.</li>"}</ul></section>
            <section><h4>${esc(party.name)} Convoy</h4><ul>${right.join("") || "<li class=\"empty\">Convoy is empty.</li>"}</ul></section>`;
    };
    const via = carrier.id === source.id ? "" : `, beside ${esc(carrier.name)}`;
    let root;
    const refresh = () => {
        root.querySelector(".feue-convoy-columns").innerHTML = lists();
        const confirm = root.closest(".app, .application")?.querySelector('[data-button="confirm"]');
        if (confirm) confirm.disabled = !deposit.size && !withdraw.size;
        if (dialog.rendered) dialog.setPosition({height: "auto"});
    };
    const dialog = new Dialog({title: `${source.name} — Convoy`,
        content: `<div class="feue-convoy-interact"><p class="hint">${esc(party.name)} Convoy${via}. Store or take any number of items, then confirm${inCombat ? `; confirming uses ${esc(source.name)}'s Major Action` : ""}. Equipment is unequipped when it moves.</p><div class="feue-convoy-columns">${lists()}</div></div>`,
        buttons: {confirm: {icon: '<i class="fas fa-check"></i>', label: "Confirm transfers", callback: () => {
            if (!deposit.size && !withdraw.size) return;
            void submit({deposit: [...deposit], withdraw: [...withdraw]}).catch(error => ui.notifications.warn(error.message));
        }}, cancel: {label: "Cancel"}},
        default: "confirm",
        render: html => {
            root = rootElement(html).querySelector(".feue-convoy-interact") ?? rootElement(html);
            root.addEventListener("click", event => {
                const button = event.target.closest("[data-move]");
                if (!button || button.disabled) return;
                const staged = button.dataset.move === "deposit" ? deposit : withdraw, id = button.dataset.item;
                if (staged.has(id)) staged.delete(id); else staged.add(id);
                refresh();
            });
            refresh();
        }}, {classes: ["dialog", "feue-convoy-dialog"], width: 560});
    dialog.render(true);
}

async function perform(request) {
    const result = await requestConvoy(request);
    ui.notifications.info(`${result.name} → ${result.destination}${result.inConvoy ? " Convoy" : ""}.`);
    return result;
}
export async function dropConvoyItem(party, item, selectedUuid) {
    if (!inventoryItem(item)) throw Error("Convoy accepts weapons and inventory items.");
    if (item.parent?.type === "character") return perform({action: "deposit", partyId: party.id, unitUuid: item.parent.uuid, itemId: item.id});
    if (item.parent) throw Error("Withdraw Convoy items to a unit; deposit items from a Party member.");
    return perform({action: "add", partyId: party.id, unitUuid: selectedUuid, itemUuid: item.uuid});
}

function itemChoiceDialog(party, unitUuid, action) {
    const TransferDialog = createEncounterDialogClass(Dialog);
    const unit = convoyUnits(party).find(choice => choice.uuid === unitUuid)?.actor;
    const entries = action === "deposit" ? Array.from(unit?.items ?? []).filter(inventoryItem) : Array.from(game.items ?? []).filter(inventoryItem);
    if (!entries.length) return ui.notifications.warn(action === "deposit" ? "This unit has no inventory items to deposit." : "No world items available. Drag an item from a compendium onto Convoy.");
    new TransferDialog({title: action === "deposit" ? `Deposit — ${unit.name}` : `Add to ${party.name} Convoy`,
        content: `<p>${action === "deposit" ? "Moves the selected item into Convoy, preserving its quantity and uses. Equipped items are unequipped." : "Adds a copy of a world item. Compendium items can also be dragged onto Convoy."}</p><select class="feue-convoy-item-choice">${entries.map(item => `<option value="${esc(item.id)}">${esc(item.name)}${item.system.equipped ? " (equipped)" : ""}${hasInfiniteUses(item.system.uses) || Number(item.system.uses?.max) > 0 ? ` · ${formatUses(item.system.uses)} uses` : ""}</option>`).join("")}</select>`,
        buttons: {transfer: {label: action === "deposit" ? "Deposit" : "Add", callback: async html => {
            const id = rootElement(html).querySelector(".feue-convoy-item-choice").value;
            const item = entries.find(item => item.id === id);
            await perform({action, partyId: party.id, unitUuid, itemId: id, itemUuid: item?.uuid});
        }}, cancel: {label: "Cancel"}}}).render(true);
}

/** Bind independently of Party ownership; transfers still require ownership of the selected member. */
export function bindConvoySheet(sheet, html) {
    const root = rootElement(html), party = sheet.actor, convoy = root?.querySelector(".party-convoy");
    if (!convoy) return;
    const selected = () => convoy.querySelector(".party-convoy-unit")?.value || "";
    const safely = operation => void operation().catch(error => ui.notifications.warn(error.message));
    convoy.querySelector(".party-convoy-unit")?.addEventListener("change", () => { sheet._convoyUnitUuid = selected(); sheet.render(false); });
    convoy.querySelector(".party-convoy-deposit")?.addEventListener("click", () => itemChoiceDialog(party, selected(), "deposit"));
    convoy.querySelector(".party-convoy-add")?.addEventListener("click", () => itemChoiceDialog(party, selected(), "add"));
    convoy.querySelectorAll("[data-convoy-item]").forEach(row => {
        const id = row.dataset.convoyItem;
        row.querySelector(".party-convoy-withdraw")?.addEventListener("click", () => safely(() => perform({action: "withdraw", partyId: party.id, unitUuid: selected(), itemId: id})));
        row.querySelector(".party-convoy-discard")?.addEventListener("click", () => {
            Dialog.confirm({title: "Discard Convoy Item", content: `<p>Discard <b>${esc(party.items.get(id)?.name)}</b> from Convoy?</p>`,
                yes: () => safely(() => perform({action: "discard", partyId: party.id, unitUuid: selected(), itemId: id}))});
        });
        row.querySelector(".party-convoy-details")?.addEventListener("click", () => party.items.get(id)?.sheet.render(true));
        row.draggable = true;
        row.addEventListener("dragstart", event => {
            const item = party.items.get(id);
            if (item) event.dataTransfer.setData("text/plain", JSON.stringify(item.toDragData()));
        });
    });
    convoy.addEventListener("dragover", event => event.preventDefault());
    convoy.addEventListener("drop", event => {
        event.preventDefault(); event.stopPropagation();
        safely(async () => {
            const data = JSON.parse(event.dataTransfer.getData("text/plain"));
            if (data.type !== "Item") throw Error("Drag a weapon or inventory item onto Convoy.");
            const item = await Item.implementation.fromDropData(data);
            await dropConvoyItem(party, item, selected());
        });
    });
}
