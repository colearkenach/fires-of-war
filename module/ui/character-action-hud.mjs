import {combatArtAllowsWeaponType, combatArtReason, hasInfiniteUses, formatUses} from "../rules/feue.mjs";
import {effectiveAttackRange} from "../map/tactical-grid.mjs";
import {combatStatDisplay} from "./stat-display.mjs";
import {tooltipAttributes} from "./stat-breakdown.mjs";
import {interactEnabled, unavailableUnit} from "../encounter/event-rules.mjs";
import {skillRule, skillAutomationInfo} from "../skills/skill-automation.mjs";
import {unitCommands, runUnitCommand, unitActionReason, unitCombatant, canCanto} from "../units/unit-actions.mjs";
import {allegianceOf} from "../encounter/encounter-rules.mjs";
import {createMovementContext} from "../map/tactical-movement.mjs";
import {activeSkillRule, activeSkillUsable} from "../skills/active-skills.mjs";
import {battalionUseReason, battalionTooltip, battalionArea} from "../combat/battalions.mjs";
import {BattalionTargeting} from "../combat/battalion-targeting.mjs";
import {sameEquipSlot, isMountItem, mountLost, revivalSkillNote, revivalSkillOpen} from "../rules/alt-rules.mjs";

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
}[c]));
const weaponType = item => String(item?.system?.weaponType ?? "").trim().toLowerCase();
const physicalWeapon = item => item && !["staff", "anima", "light", "dark"].includes(weaponType(item));
const stats = [
    ["damage", "Damage", ""], ["attackSpeed", "Attack Speed", ""],
    ["hitRate", "Base Hit Rate", "%"], ["critRate", "Crit Rate", "%"],
    ["avoid", "Avoid", "%"], ["dodge", "Dodge", "%"]
];

/** Major Action, Movement and Free Action state of an encounter participant, or null outside encounters. */
export function actionEconomy(token, {combat = globalThis.game?.combat, board = globalThis.canvas} = {}) {
    const unit = unitCombatant(token, combat);
    if (!unit) return null;
    const state = unit.flags?.["fires-of-war"] ?? {}, actor = token.actor ?? token.document?.actor;
    const group = allegianceOf(unit, combat);
    if (combat.combatant && allegianceOf(combat.combatant, combat).id !== group.id) {
        return {phase: false, note: `Waits for the ${group.name} Phase.`, major: false, move: false, free: false, moveLeft: 0};
    }
    const ended = !!state.acted;
    const major = !ended && !state.majorAction;
    const free = !ended;
    let moveLeft = 0;
    if (!ended && !state.noMove && (!state.majorAction || canCanto(actor)) && token.document && board?.grid) {
        try { moveLeft = createMovementContext(token, board, {combat}).allowance; } catch { moveLeft = 0; }
    }
    const canto = !!state.majorAction && moveLeft > 0;
    return {phase: true, major, move: moveLeft > 0, free, moveLeft, canto, freeAttack: !!state.freeAttack,
        note: ended ? "This unit has finished its turn." : ""};
}

function actionEconomyHtml(token) {
    const economy = token ? actionEconomy(token) : null;
    if (!economy) return "";
    const gem = (key, lit, label, title) => `<span class="feue-action-gem ${key}${lit ? " lit" : ""}" role="img" aria-label="${esc(title)}" title="${esc(title)}"><i class="fas fa-gem" aria-hidden="true"></i>${esc(label)}</span>`;
    const moveTitle = economy.move ? `Movement: ${economy.moveLeft} square${economy.moveLeft === 1 ? "" : "s"} left${economy.canto ? " (Canto)" : ""}` : "Movement: used";
    return `<div class="feue-action-economy" aria-label="Actions this phase">
        ${gem("major", economy.major, "Major", economy.major ? "Major Action: available" : economy.freeAttack ? "Major Action: used (free attack ready)" : "Major Action: used")}
        ${gem("move", economy.move, economy.move ? `Move ${economy.moveLeft}` : "Move", moveTitle)}
        ${gem("free", economy.free, "Free", economy.free ? "Free Actions: available (Equip, Mount / Dismount)" : "Free Actions: turn ended")}
        ${economy.note ? `<small>${esc(economy.note)}</small>` : ""}</div>`;
}

/** The displayed stats match Equipment, including the equipped weapon and skills active right now.
 * "Base" distinguishes Hit from the target-adjusted attack preview. Hover a stat for its breakdown. */
export function renderCharacterActions(actor, token = null) {
    const items = Array.from(actor.items);
    const equipped = items.find(item => item.type === "weapon" && item.system?.equipped);
    const groups = [
        ["inventory", "Inventory", items.filter(i => ["weapon", "item"].includes(i.type))],
        ["arts", "Combat Arts", items.filter(i => i.type === "combatArt" && !combatArtReason(actor, i, equipped))],
        ["skills", "Skills", items.filter(i => i.type === "skill")],
        ["spells", "Spells", items.filter(i => i.type === "spell")],
        ["battalions", "Battalion", items.filter(i => i.type === "battalion")]
    ];
    const display = combatStatDisplay(actor, token);
    const statHtml = stats.map(([key, label, suffix]) => `<div class="feue-action-stat" tabindex="0" ${tooltipAttributes(display[key].html)}><span>${label}</span><strong>${esc(display[key].value)}${suffix}</strong></div>`).join("");
    const bars = groups.map(([key, label, entries]) => {
        const buttons = entries.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name)).map(item => {
            const s = item.system ?? {};
            const equippable = item.type === "weapon" || (item.type === "item" && s.itemType === "equippable");
            const usesApplicable = item.type === "weapon" || item.type === "item" && s.itemType !== "miscellaneous";
            const infinite = usesApplicable && hasInfiniteUses(s.uses);
            const depleted = item.type === "item" && s.itemType !== "miscellaneous" && !equippable && s.uses && !infinite && s.uses.value <= 0;
            const incompatible = item.type === "combatArt" && (!physicalWeapon(equipped) || !combatArtAllowsWeaponType(s.weaponRestriction, weaponType(equipped)));
            const insufficient = item.type === "combatArt" && equipped?.system?.uses && !hasInfiniteUses(equipped.system.uses) && Number(equipped.system.uses.value) < Math.max(Number(s.durabilityCost || 0), 0);
            const passive = item.type === "item" && s.itemType === "miscellaneous" || item.type === "skill" && (activeSkillRule(item) ? !activeSkillUsable(item) : (!["Active", "Passive (Activated)"].includes(s.skillType) || s.activationTrigger === "Passive" || s.skillType === "Passive (Activated)" && !!skillRule(item)));
            const battalion = item.type === "battalion";
            const sealed = item.type === "skill" && !revivalSkillOpen(item) ? revivalSkillNote(item) : "";
            const unusable = battalion ? battalionUseReason(actor, item) : sealed;
            const action = equippable && !s.equipped ? "Equip" : passive ? "View" : item.type === "weapon" && weaponType(item) !== "staff" ? "Attack" : battalion ? "Order" : "Use";
            const blocked = token && action !== "View" ? unitActionReason(token, {free: action === "Equip" || item.type === "skill" && s.skillType === "Passive (Activated)"}) : "";
            const notes = [s.equipped ? "Equipped" : "", usesApplicable && (infinite || s.uses?.max > 0) ? `${formatUses(s.uses)} uses` : "",
                item.type === "spell" ? `${s.hpCost || 0} HP · Range ${s.range || "—"}` : "",
                item.type === "combatArt" ? `${s.durabilityCost || 0} durability · ${s.weaponRestriction || "Any weapon"}` : "",
                item.type === "skill" ? `${s.skillType} — ${skillAutomationInfo(item, activeSkillRule(item)).summary}` : "",
                battalion ? `${battalionArea(item)?.label ?? "No area"} · END ${s.endurance?.value ?? 0}/${s.endurance?.max ?? 0}` : "", unusable,
                incompatible ? "Equip a compatible physical weapon" : insufficient ? "Not enough weapon durability" : "", blocked].filter(Boolean);
            const title = `${action}: ${item.name}${notes.length ? ` — ${notes.join(" · ")}` : ""}. Right-click for details.`;
            const tip = battalion ? ` ${tooltipAttributes(battalionTooltip(actor, item))}` : ` title="${esc(title)}"`;
            return `<div class="feue-action-entry"><button type="button" class="feue-action-slot${s.equipped ? " equipped" : ""}${passive ? " passive" : ""}" data-item-id="${esc(item.id)}" aria-label="${esc(title)}"${tip}${depleted || incompatible || insufficient || blocked || unusable ? " disabled" : ""}>
                <img src="${esc(item.img || "icons/svg/item-bag.svg")}" alt="" /><span class="feue-action-name">${esc(item.name)}</span>
                ${s.equipped ? '<span class="feue-action-equipped" aria-hidden="true">◆</span>' : ""}
                ${usesApplicable && (infinite || s.uses?.max > 0) ? `<span class="feue-action-cost">${infinite ? "∞" : esc(s.uses.value)}</span>` : item.type === "spell" ? `<span class="feue-action-cost">${esc(s.hpCost || 0)} HP</span>` : battalion && Number(s.endurance?.max) > 0 ? `<span class="feue-action-cost" title="Endurance">${esc(s.endurance.value)}</span>` : ""}
            </button>${equippable ? `<button type="button" class="feue-action-equip" data-item-id="${esc(item.id)}" data-equipment-action="${s.equipped ? "unequip" : "equip"}" ${token && unitActionReason(token, {free: true}) ? "disabled" : ""} aria-label="${s.equipped ? "Unequip" : "Equip"} ${esc(item.name)}">${s.equipped ? "Unequip" : "Equip"}</button>` : ""}</div>`;
        }).join("");
        return `<section class="feue-action-bar" data-bar="${key}" aria-label="${label}"><h3>${label}</h3><div class="feue-action-slots">${buttons || '<span class="feue-action-empty">None</span>'}</div></section>`;
    }).join("");
    const interaction = token && interactEnabled(token) && !unavailableUnit(token)
        ? `<button type="button" class="feue-interact-button" data-feue-interact ${unitActionReason(token) ? "disabled" : ""}><i class="fas fa-hand" aria-hidden="true"></i> Interact</button>` : "";
    const commands = token ? `<div class="feue-unit-commands">${unitCommands(token).filter(c => c.id !== "interact").map(c => `<button type="button" data-unit-command="${c.id}" ${c.reason ? "disabled" : ""} title="${esc(c.reason)}">${c.label}</button>`).join("")}${actionEconomyHtml(token)}</div>` : "";
    return `${commands}${interaction}<div class="feue-action-stats" aria-label="Equipment combat stats">${statHtml}</div><div class="feue-action-bars">${bars}</div>`;
}

/** Square-grid range uses the same orthogonal distance as the attack forecast.
 * Measure between occupied squares so large units use their closest edges. */
export function tokenRangeDistance(source, target, grid) {
    if (!source || !target || !grid) return Infinity;
    if (grid.isSquare) {
        const bounds = token => grid.getOffsetRange({x: token.document.x, y: token.document.y, width: token.w, height: token.h});
        const [ai0, aj0, ai1, aj1] = bounds(source);
        const [bi0, bj0, bi1, bj1] = bounds(target);
        return Math.max(0, bi0 - ai1 + 1, ai0 - bi1 + 1) + Math.max(0, bj0 - aj1 + 1, aj0 - bj1 + 1);
    }
    const distance = grid.measurePath([source.center, target.center]).distance;
    return distance / (grid.distance || 1);
}

export function tokenInItemRange(source, target, item, grid, {retaliation = false, overdraw = true} = {}) {
    if (unavailableUnit(source) || unavailableUnit(target)) return false;
    const distance = tokenRangeDistance(source, target, grid);
    return effectiveAttackRange(source.actor, item, {retaliation, overdraw}).some(({min, max}) => distance >= min && distance <= max);
}

/** Route HUD buttons without creating or editing user macros. */
export async function activateCharacterAction(token, itemId, {execute, confirmEquip, warn, targets, grid, visibleTokens, equipmentAction}) {
    const actor = token.actor;
    if (!actor?.isOwner || actor.type !== "character") return warn("Select a character you own.");
    if (unavailableUnit(token)) return warn("This unit is being carried or has escaped.");
    const item = actor.items.get(itemId);
    if (!item) return warn("That item is no longer available.");
    const s = item.system ?? {};
    const equippable = item.type === "weapon" || (item.type === "item" && s.itemType === "equippable");
    if (equippable && (equipmentAction || !s.equipped)) {
        const reason = unitActionReason(token, {free: true});
        if (reason) return warn(reason);
    }
    if (equippable && equipmentAction === "unequip") {
        await actor.updateEmbeddedDocuments("Item", [{_id: item.id, "system.equipped": false}]);
        return;
    }
    if (equippable && equipmentAction === "equip" && s.equipped) return;
    if (equippable && !s.equipped) {
        if (!await confirmEquip(item)) return;
        if (!actor.isOwner || actor.items.get(itemId) !== item) return warn("That item is no longer available.");
        if (isMountItem(item) && mountLost(item)) return warn(`${item.name} was lost. Equip a new mount.`);
        const others = actor.items.filter(i => i.id !== item.id && i.system?.equipped && sameEquipSlot(i, item));
        await actor.updateEmbeddedDocuments("Item", [...others.map(i => ({_id: i.id, "system.equipped": false})), {_id: item.id, "system.equipped": true}]);
        return;
    }
    let action;
    let rangeItem = item;
    if (item.type === "weapon") action = weaponType(item) === "staff" ? "staff" : "attack";
    else if (item.type === "item") action = s.itemType === "miscellaneous" ? "details" : "item";
    else if (item.type === "combatArt") {
        rangeItem = actor.items.find(i => i.type === "weapon" && i.system?.equipped);
        const reason = combatArtReason(actor, item, rangeItem);
        if (reason) return warn(reason);
        action = "art";
    } else if (item.type === "spell") action = s.school === "White Magic" ? "heal" : "spell";
    else if (item.type === "battalion") {
        const reason = battalionUseReason(actor, item);
        if (reason) return warn(reason);
        return execute("battalion", item, {sourceToken: token});
    }
    else if (item.type === "skill") action = activeSkillRule(item) ? activeSkillUsable(item) ? "skill" : "details" : s.skillType === "Active" ? "skill" : s.skillType === "Passive (Activated)" && !skillRule(item) ? "activation" : "details";
    else return;
    const validateTarget = target => {
        if (!actor.isOwner || actor.items.get(itemId) !== item || token.destroyed) { warn("That action is no longer available."); return false; }
        if (!target?.actor || target.destroyed || !target.visible || (target.document.hidden && !game.user.isGM)) { warn("Choose a visible target token."); return false; }
        if (!tokenInItemRange(token, target, rangeItem, grid)) { warn(`${target.name} is outside ${rangeItem.name}'s range (${rangeItem.system.range || "unset"}).`); return false; }
        return true;
    };
    if (["attack", "art", "spell"].includes(action)) {
        const selected = targets();
        if (selected.length !== 1) return warn("Target exactly one unit before using this action.");
        if (selected[0] === token) return warn("Choose another unit to attack.");
        if (!validateTarget(selected[0])) return;
    }
    // Healing dialogs receive Token objects rather than world actor IDs, preserving synthetic actors.
    const targetTokens = ["staff", "heal"].includes(action)
        ? visibleTokens.filter(t => t.actor?.type === "character" && tokenInItemRange(token, t, item, grid)) : null;
    if (targetTokens && !targetTokens.length) return warn("No visible units are in range.");
    return execute(action, item, {weapon: rangeItem, sourceToken: token, targetTokens, validateTarget: () => {
        const selected = targets();
        return selected.length === 1 && selected[0] !== token ? validateTarget(selected[0]) : (warn("Target exactly one other unit."), false);
    }, validateHealingTarget: validateTarget});
}

export class CharacterActionHud {
    element = null;
    token = null;
    frame = null;
    busy = false;
    constructor(execute) {
        this.execute = execute;
        this.onResize = () => this.position();
    }
    eligible(token) {
        return token?.controlled && !token.destroyed && token.actor?.type === "character" && token.isOwner &&
            !unavailableUnit(token) && (!token.document.hidden || game.user.isGM);
    }
    select(token, controlled) {
        if (controlled && this.eligible(token)) this.token = token;
        this.queueRefresh();
    }
    queueRefresh() {
        if (this.frame !== null) return;
        this.frame = requestAnimationFrame(() => { this.frame = null; this.refresh(); });
    }
    refresh() {
        if (!canvas.ready || !game.settings.get("fires-of-war", "characterActionHud")) return this.clear();
        document.body.classList.add("feue-replace-hotbar");
        if (canvas.activeLayer !== canvas.tokens) return this.clear({restoreHotbar: false});
        if (!this.eligible(this.token)) this.token = canvas.tokens.controlled.find(t => this.eligible(t));
        if (!this.token) return this.clear({restoreHotbar: false});
        if (!this.element) {
            this.element = document.createElement("aside");
            this.element.id = "feue-character-actions";
            this.element.addEventListener("click", event => void this.click(event));
            this.element.addEventListener("contextmenu", event => {
                const button = event.target.closest("[data-item-id]");
                if (!button) return;
                event.preventDefault();
                this.token?.actor.items.get(button.dataset.itemId)?.sheet.render(true);
            });
            document.body.append(this.element);
            window.addEventListener("resize", this.onResize);
            this.observer = new ResizeObserver(this.onResize);
            this.observeLayout();
        }
        this.element.setAttribute("aria-label", `${this.token.name} actions`);
        // Preserve keyboard focus and horizontal scrolling during live updates.
        const focused = this.element.contains(document.activeElement) ? {id: document.activeElement.dataset.itemId, equipment: document.activeElement.classList.contains("feue-action-equip")} : null;
        const scrolls = Array.from(this.element.querySelectorAll(".feue-action-slots"), el => el.scrollLeft);
        this.element.innerHTML = renderCharacterActions(this.token.actor, this.token);
        this.element.querySelectorAll(".feue-action-slots").forEach((el, i) => { el.scrollLeft = scrolls[i] || 0; });
        if (focused) Array.from(this.element.querySelectorAll("button")).find(b => b.dataset.itemId === focused.id && b.classList.contains("feue-action-equip") === focused.equipment)?.focus({preventScroll: true});
        this.position();
    }
    observeLayout() {
        if (!this.observer) return;
        this.observer.disconnect();
        for (const el of document.querySelectorAll("#hotbar, #players, #players-active, #players-inactive, #sidebar, #chat-notifications, #ui-left, #ui-bottom")) this.observer.observe(el);
    }
    position() {
        if (!this.element) return;
        const rect = selector => Array.from(document.querySelectorAll(selector)).map(el => el.getBoundingClientRect()).filter(r => r.width && r.height);
        const right = Math.min(window.innerWidth - 16, ...rect("#sidebar, #chat-notifications").filter(r => r.left > window.innerWidth / 2).map(r => r.left - 12));
        const left = Math.max(16, ...rect("#players, #players-active, #players-inactive").filter(r => r.bottom > window.innerHeight / 2).map(r => r.right + 12));
        const available = Math.max(180, right - left);
        this.element.style.width = `${Math.min(1040, available)}px`;
        this.element.style.left = `${Math.max(8, left + (available - this.element.offsetWidth) / 2)}px`;
        this.element.style.bottom = "16px";
    }
    async click(event) {
        const command = event.target.closest("[data-unit-command]");
        if (command && !command.disabled && this.eligible(this.token)) {
            event.preventDefault();
            try {await runUnitCommand(this.token, command.dataset.unitCommand);} catch (error) {ui.notifications.error(error.message);}
            return;
        }
        if (event.target.closest("[data-feue-interact]") && this.eligible(this.token)) {
            event.preventDefault();
            return game.firesOfWar.openInteractionMenu(this.token);
        }
        const button = event.target.closest("button[data-item-id]");
        if (!button || button.disabled || this.busy || !this.eligible(this.token)) return;
        event.preventDefault();
        this.busy = true;
        const token = this.token;
        try {
            await activateCharacterAction(token, button.dataset.itemId, {
                execute: (action, item, options) => this.execute(token.actor, action, item, options),
                equipmentAction: button.dataset.equipmentAction,
                confirmEquip: item => Dialog.confirm({title: `Equip ${item.name}?`, content: `<p>Equip <b>${esc(item.name)}</b>? This replaces the currently equipped ${item.type === "weapon" ? "weapon" : "item"}.</p>`, defaultYes: false}),
                warn: message => ui.notifications.warn(message),
                targets: () => Array.from(game.user.targets || []),
                grid: canvas.grid?.getOffset ? canvas.grid : canvas.grid?.grid,
                visibleTokens: canvas.tokens.placeables.filter(t => t.visible && (!t.document.hidden || game.user.isGM))
            });
        } catch (error) {
            console.error("FEUE | Character HUD action failed", error);
            ui.notifications.error("Unable to use this action. See the console for details.");
        } finally { this.busy = false; this.queueRefresh(); }
    }
    clear({restoreHotbar = true} = {}) {
        if (restoreHotbar) document.body.classList.remove("feue-replace-hotbar");
        if (this.frame !== null) cancelAnimationFrame(this.frame);
        this.frame = null;
        this.element?.remove();
        this.element = this.token = null;
        this.observer?.disconnect();
        this.observer = null;
        window.removeEventListener("resize", this.onResize);
    }
}

export function registerCharacterActionHud(execute) {
    const hud = new CharacterActionHud(execute);
    Hooks.once("init", () => game.settings.register("fires-of-war", "characterActionHud", {
        name: "Character Action Bars", hint: "Replace Foundry's macro hotbar with Inventory, Combat Arts, Skills, Spells, and Equipment stats for the selected character.",
        scope: "client", config: true, type: Boolean, default: true, onChange: () => hud.queueRefresh()
    }));
    Hooks.once("ready", () => {
        game.firesOfWar = Object.assign(game.firesOfWar || {}, {characterActionHud: hud, battalionTargeting: new BattalionTargeting()});
        hud.queueRefresh();
    });
    Hooks.on("controlToken", (token, controlled) => hud.select(token, controlled));
    for (const hook of ["canvasReady", "activateCanvasLayer", "updateActor", "createItem", "updateItem", "deleteItem", "updateToken", "deleteToken", "createRegion", "updateRegion", "deleteRegion", "createTile", "updateTile", "deleteTile", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect", "updateUser", "updateCombat", "updateCombatant"]) Hooks.on(hook, () => hud.queueRefresh());
    for (const hook of ["renderHotbar", "renderPlayers", "renderSidebar", "collapseSidebar"]) Hooks.on(hook, () => { hud.observeLayout(); hud.position(); });
    Hooks.on("canvasTearDown", () => { hud.clear(); game.firesOfWar?.battalionTargeting?.cancel(); });
    return hud;
}
