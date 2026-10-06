import {SYSTEM_ID, tokenTerrain, terrainHP, refreshTerrainStats} from "../map/terrain.mjs";
import {DEFAULT_ALLEGIANCES, OBJECTIVES, allegiances, allegianceOf, isSlain, hasEscaped, objectiveScene, escapeUnitIds, phaseStarts, evaluateObjective} from "./encounter-rules.mjs";
import {esc, rootElement, registerTerrainUI} from "../map/terrain-ui.mjs";
import {hasSkill, skillRule, skillEligible, skillActivationTarget} from "../skills/skill-automation.mjs";
import {activeStatuses} from "../rules/status-rules.mjs";
import {revivalSkillOpen} from "../rules/alt-rules.mjs";
import {aiBehaviorOptions, aiBehaviorHints, aiSettings} from "../ai/ai-planner.mjs";

const phaseUnits = (combat, unit = combat.combatant) => unit ? Array.from(combat.combatants).filter(c => !hasEscaped(c.token, combat) && allegianceOf(c, combat).id === allegianceOf(unit, combat).id) : [];
const activeGM = () => game.user.isActiveGM ?? (game.user.id === game.users.find(u => u.active && u.isGM)?.id);
const phaseStamp = (combat, round = combat.round, unit = combat.combatant) => `${round}:${unit ? allegianceOf(unit, combat).id : ""}`;

/** Foundry's legacy Dialog closes synchronously; keep validation and async saves inside the dialog. */
export function createEncounterDialogClass(Parent) {
    return class EncounterDialog extends Parent {
        async submit(button, event) {
            if (this._feueSaving) return;
            this._feueSaving = true;
            try {
                const html = this.options.jQuery ? this.element : this.element[0];
                if (await button.callback?.call(this, html, event) !== false) await this.close();
            } catch (error) {
                console.error("FEUE | Encounter setup failed", error);
                ui.notifications.error(`Could not save encounter: ${error.message}`);
            } finally { this._feueSaving = false; }
        }
    };
}

/** Initiative mirrors the phase order (Player 1, Neutral 2, Enemy 3, Other 4, then custom allegiances),
 * so trackers and modules show a fixed value instead of offering a roll. */
export function phaseInitiative(combatant, combat = combatant?.parent) {
    const index = allegiances(combat).findIndex(group => group.id === allegianceOf(combatant, combat).id);
    return Math.max(0, index) + 1;
}

export async function syncPhaseInitiative(combat) {
    if (!combat?.combatants || !activeGM()) return;
    const updates = Array.from(combat.combatants).map(c => ({_id: c.id, initiative: phaseInitiative(c, combat), current: c.initiative}))
        .filter(u => u.current !== u.initiative).map(({_id, initiative}) => ({_id, initiative}));
    if (updates.length) await combat.updateEmbeddedDocuments("Combatant", updates, {turnEvents: false});
}

export async function endUnitPhase(combat, unit) {
    // Capture: captors that cannot carry their captive drop it at the end of their next phase.
    await globalThis.game?.firesOfWar?.endPhaseCaptures?.(combat, unit);
    const handled = new Set();
    for (const c of phaseUnits(combat, unit)) {
        const actor = c.actor;
        if (!actor || handled.has(actor.uuid)) continue;
        handled.add(actor.uuid);
        const statuses = actor.system.statusEffects ?? [];
        if (!statuses.length) continue;
        // "recover" moves a timed value toward 0 each phase: Seal penalties recover, Pure Water's bonus decays.
        const remaining = statuses.map(effect => ({...effect, attributes: effect.recover ? Object.fromEntries(Object.entries(effect.attributes ?? {}).map(([key, value]) => [key, value < 0 ? Math.min(0, value + effect.recover) : Math.max(0, value - effect.recover)])) : effect.attributes,
            duration: effect.duration === -1 ? -1 : effect.duration - 1})).filter(effect => effect.duration === -1 || effect.duration > 0);
        await actor.update({"system.statusEffects": remaining});
    }
}

export async function startUnitPhase(combat, unit) {
    const handled = new Set();
    const updates = [];
    const notes = [];
    for (const c of phaseUnits(combat, unit)) {
        const update = {_id: c.id, [`flags.${SYSTEM_ID}.acted`]: false, [`flags.${SYSTEM_ID}.majorAction`]: false,
            [`flags.${SYSTEM_ID}.attacked`]: false, [`flags.${SYSTEM_ID}.waitBonus`]: false, [`flags.${SYSTEM_ID}.refreshed`]: false,
            [`flags.${SYSTEM_ID}.noMove`]: false, [`flags.${SYSTEM_ID}.freeAttack`]: false};
        updates.push(update);
        const actor = c.actor;
        if (!actor || isSlain(c) || handled.has(actor.uuid)) continue;
        handled.add(actor.uuid);
        // Effects lasting until the start of the unit's next phase (Bloodlust, Confusion, Guard Break) end now.
        const statuses = actor.system.statusEffects ?? [];
        const kept = statuses.filter(effect => effect?.expires !== "phaseStart");
        if (kept.length !== statuses.length) await actor.update({"system.statusEffects": kept});
        const hp = Number(actor.system.attributes?.hp?.value);
        const max = Number(actor.system.attributes?.hp?.max), terrain = tokenTerrain(c.token);
        let next = hasSkill(actor, "terrain resistance") && terrain.damage ? hp : terrainHP(hp, max, terrain);
        const weapon = actor.items?.find(i => i.type === "weapon" && i.system?.equipped);
        for (const item of actor.items ?? []) {
            const rule = item.type === "skill" && revivalSkillOpen(item) && skillRule(item);
            if (rule?.trigger !== "PhaseStart" || !(hp > 0) || !skillEligible(actor, rule, {weapon, round: combat.round, token: c.token})) continue;
            if (rule.healMaxFraction) next = Math.min(max, next + Math.floor(max * rule.healMaxFraction));
            if (rule.healStat) next = Math.min(max, next + Math.max(0, Number(actor.system.attributes?.[rule.healStat]?.value) || 0));
            if (rule.freeAttack) {
                const target = skillActivationTarget(actor, item, rule);
                const roll = (await new Roll("1d100").evaluate()).total;
                if (roll <= target) update[`flags.${SYSTEM_ID}.freeAttack`] = true;
                notes.push(`${c.name}: ${item.name} ${roll}/${target} — ${roll <= target ? "free attack ready" : "failed"}`);
            }
        }
        // Damage-over-time statuses: Poison (1d10÷2, min 1), Burning (3), Blood Sacrifice (1d10).
        if (hp > 0) for (const {name, rule} of activeStatuses(actor)) {
            if (!rule?.damage) continue;
            const damage = rule.damage === "poison" ? Math.max(1, Math.floor((await new Roll("1d10").evaluate()).total / 2)) :
                rule.damage === "1d10" ? (await new Roll("1d10").evaluate()).total : Number(rule.damage) || 0;
            next = Math.max(0, next - damage);
            notes.push(`${c.name}: ${name} −${damage} HP`);
        }
        if (next !== hp && Number.isFinite(next)) await actor.update({"system.attributes.hp.value": next});
    }
    if (updates.length) await combat.updateEmbeddedDocuments("Combatant", updates, {turnEvents: false});
    if (notes.length) await globalThis.ChatMessage?.create({content: `<div class="feue-phase-start"><b>Phase start</b><p>${notes.map(esc).join("<br>")}</p></div>`});
}

/** Phase navigation keeps all combatants in Foundry's tracker; any unit in the phase may act. */
export function createPhaseCombatClass(Parent) {
    return class FiresOfWarCombat extends Parent {
        _sortCombatants(a, b) {
            const groups = allegiances(a.parent);
            return groups.findIndex(g => g.id === allegianceOf(a).id) - groups.findIndex(g => g.id === allegianceOf(b).id) ||
                String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id));
        }
        async rollInitiative() { this.setupTurns(); return this; }
        async startCombat() {
            if (!game.user.isGM) return this;
            this._feueStartStamp = this._feueEndStamp = null;
            if (game.firesOfWar?._prepareEventEncounter) {
                await game.firesOfWar._prepareEventEncounter(this);
                this._feueEventStartPrepared = true;
            }
            await this.update({[`flags.${SYSTEM_ID}.objectiveComplete`]: false}, {turnEvents: false});
            this._playCombatSound?.("startEncounter");
            const data = {round: 1, turn: phaseStarts(this, {living: true})[0]?.index ?? null};
            Hooks.callAll("combatStart", this, data);
            delete this._feueEventStartPrepared;
            return this.update(data, {direction: 1});
        }
        async nextTurn() {
            if (!game.user.isGM) return this;
            if (evaluateObjective(this).complete) return ui.notifications.info("Victory! Edit the encounter objective to continue."), this;
            if (!this.started) return this.startCombat();
            const current = this.combatant && allegianceOf(this.combatant, this).id;
            const next = phaseStarts(this, {living: true}).find(p => p.index > (this.turn ?? -1) && p.id !== current);
            if (!next) return this.nextRound();
            const data = {round: this.round, turn: next.index}, options = {direction: 1,
                worldTime: {delta: this.getTimeDelta?.(this.round, this.turn, this.round, next.index) ?? 0}};
            Hooks.callAll("combatTurn", this, data, options);
            return this.update(data, options);
        }
        async nextRound() {
            if (!game.user.isGM || evaluateObjective(this).complete) return this;
            const data = {round: this.round + 1, turn: phaseStarts(this, {living: true})[0]?.index ?? null};
            const options = {direction: 1, worldTime: {delta: this.getTimeDelta?.(this.round, this.turn, data.round, data.turn) ?? 0}};
            Hooks.callAll("combatRound", this, data, options);
            return this.update(data, options);
        }
        async previousTurn() {
            if (!game.user.isGM || !this.started) return this;
            const current = this.combatant && allegianceOf(this.combatant, this).id;
            const previous = phaseStarts(this, {living: true}).filter(p => p.index < (this.turn ?? 0) && p.id !== current).at(-1);
            if (previous) return this.update({turn: previous.index}, {direction: -1});
            return this.update({round: Math.max(0, this.round - 1), turn: this.round > 1 ? phaseStarts(this, {living: true}).at(-1)?.index ?? null : null}, {direction: -1});
        }
        async _onStartTurn(unit, context = {round: this.round, skipped: false}) {
            await super._onStartTurn?.(unit, context);
            if (context.skipped || this._feueStartStamp === phaseStamp(this, context.round, unit)) return;
            this._feueStartStamp = phaseStamp(this, context.round, unit);
            await startUnitPhase(this, unit);
        }
        async _onEndTurn(unit, context = {round: this.previous?.round ?? this.round, skipped: false}) {
            await super._onEndTurn?.(unit, context);
            const stamp = phaseStamp(this, context.round, unit);
            if (!context.skipped && context.round <= this.round && stamp !== phaseStamp(this) && this._feueEndStamp !== stamp) {
                this._feueEndStamp = stamp;
                await endUnitPhase(this, unit);
            }
        }
        async _clearMovementHistoryOnStartTurn(unit, context = {}) {
            if (context.skipped) return;
            for (const c of phaseUnits(this, unit)) await c.token?.clearMovementHistory?.();
            // The phase is ready once its units are reset: the Combat AI may now play it.
            game.firesOfWar?.combatAI?.phaseStarted(this);
        }
    };
}

const objectiveQueue = new Map();
export function checkEncounterObjective(combat) {
    if (!combat || !activeGM()) return Promise.resolve();
    const prior = objectiveQueue.get(combat.id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(async () => {
        const result = evaluateObjective(combat);
        const before = !!combat.flags?.[SYSTEM_ID]?.objectiveComplete;
        const complete = combat.started && result.complete;
        if (before === complete) return;
        await combat.update({[`flags.${SYSTEM_ID}.objectiveComplete`]: complete}, {turnEvents: false});
        if (complete) await ChatMessage.create({content: `<div class="feue-victory"><h3>Victory!</h3><p>${esc(OBJECTIVES[combat.flags[SYSTEM_ID].objective.type])}: ${esc(result.text)}</p></div>`});
    });
    objectiveQueue.set(combat.id, next);
    next.finally(() => { if (objectiveQueue.get(combat.id) === next) objectiveQueue.delete(combat.id); }).catch(error => console.error("FEUE | Objective check failed", error));
    return next;
}

function factionRow(group) {
    return `<div class="feue-faction-row" data-id="${esc(group.id)}"><input class="feue-faction-name" aria-label="Allegiance name" value="${esc(group.name)}" required><select class="feue-faction-disposition" aria-label="Default disposition">${[["", "Manual assignment"], [1, "Friendly"], [0, "Neutral"], [-1, "Hostile"], [-2, "Secret"]].map(([v, label]) => `<option value="${v}" ${String(group.disposition ?? "") === String(v) ? "selected" : ""}>${label}</option>`).join("")}</select><label class="feue-faction-ai" title="The Combat AI plays this allegiance's phase"><input type="checkbox" ${group.ai ? "checked" : ""}> AI</label><button type="button" class="feue-faction-up" title="Move phase up">↑</button><button type="button" class="feue-faction-down" title="Move phase down">↓</button>${DEFAULT_ALLEGIANCES.some(g => g.id === group.id) ? "" : '<button type="button" class="feue-faction-remove" title="Remove allegiance">×</button>'}</div>`;
}

export function openEncounterSetup(combat = ui.combat?.viewed ?? game.combat) {
    if (!combat) return ui.notifications.warn("Create an encounter first.");
    const objective = combat.flags?.[SYSTEM_ID]?.objective ?? {};
    const status = evaluateObjective(combat);
    if (!game.user.isGM) return new Dialog({title: "Encounter Objectives", content: `<p><b>${esc(OBJECTIVES[objective.type] ?? "No objective set")}</b></p><p>${esc(status.text)}</p>${status.complete ? "<p>Victory!</p>" : ""}`, buttons: {close: {label: "Close"}}}).render(true);
    const groups = allegiances(combat), units = Array.from(combat.combatants), ai = aiSettings(combat);
    const EncounterDialog = createEncounterDialogClass(Dialog);
    new EncounterDialog({title: "Objectives & Allegiance Phases", content: `<div class="feue-encounter-setup">
        <h3>Encounter Objective</h3><div class="form-group"><label>Objective</label><select class="feue-objective-type"><option value="">None</option>${Object.entries(OBJECTIVES).map(([key, name]) => `<option value="${key}" ${objective.type === key ? "selected" : ""}>${name}</option>`).join("")}</select></div>
        <div class="feue-survive-options"><label>Full rounds to survive <input type="number" class="feue-objective-rounds" value="${Number(objective.rounds) || 6}" min="1" step="1"></label><p>Counts full rounds from ${objective.type === "survive" ? `round ${Number(objective.startRound) || 1}` : "the current round (or round 1 before starting)"}.</p></div>
        <div class="feue-boss-options"><p>Boss units (all selected units must reach 0 HP):</p>${units.map(unit => `<label class="feue-boss-choice"><input type="checkbox" value="${esc(unit.id)}" ${(objective.bosses ?? []).includes(unit.id) ? "checked" : ""}> ${esc(unit.name)}</label>`).join("") || "<p>Add units to the encounter to choose bosses.</p>"}</div>
        <div class="feue-tile-objective-options"><label>Objective allegiance <select class="feue-objective-allegiance" data-selected="${esc(objective.allegiance || "player")}"></select></label><p>Seize requires every interactable Seize Tile on this scene. Escape accepts any interactable Escape Tile.</p></div>
        <div class="feue-escape-options"><label>Required escape <select class="feue-escape-mode"><option value="all" ${objective.escapeMode !== "selected" ? "selected" : ""}>All units of the objective allegiance</option><option value="selected" ${objective.escapeMode === "selected" ? "selected" : ""}>One selected unit</option></select></label><label class="feue-escape-unit-choice">Selected unit <select class="feue-escape-unit"><option value="">Choose a unit</option>${units.map(unit => `<option value="${esc(unit.id)}" ${objective.escapeUnit === unit.id ? "selected" : ""}>${esc(unit.name)}</option>`).join("")}</select></label><p>Units escape automatically on reaching an exit, including any unit they are rescuing. Slain or deleted required units do not count as escaped.</p></div>
        <p class="feue-objective-preview">${esc(status.text)}</p>
        <h3>Allegiances / Phase Order</h3><p>Order is top to bottom. Matching dispositions use the first match; override individual units below to split factions sharing a disposition.</p><div class="feue-factions">${groups.map(factionRow).join("")}</div><button type="button" class="feue-add-faction">Add custom allegiance</button>
        <h3>Combat AI</h3><p>Tick <b>AI</b> on an allegiance to let the computer play its phase, for solo play or a GM who joins in as a player. It runs on the active GM's client, which must be viewing this scene. Player and Neutral units are allies; every other allegiance fights everyone else.</p>
        <div class="form-group"><label>Default behavior</label><select class="feue-ai-behavior">${aiBehaviorOptions(ai.behavior, {inherit: false})}</select></div>
        <p class="feue-ai-hints">${aiBehaviorHints()}</p>
        <label class="feue-ai-autoend"><input type="checkbox" ${ai.autoEnd ? "checked" : ""}> End the other phases automatically once every unit has acted</label>
        <h3>Unit Allegiances</h3><p>Each unit's allegiance and, when that allegiance is AI-controlled, its behavior.</p><div class="feue-unit-allegiances">${units.map(unit => `<label>${esc(unit.name)}<span class="feue-unit-selects"><select data-unit="${esc(unit.id)}" data-selected="${esc(unit.flags?.[SYSTEM_ID]?.allegiance ?? "")}"></select><select data-ai-unit="${esc(unit.id)}" aria-label="${esc(unit.name)} AI behavior" ${unit.token ? "" : "disabled"}>${aiBehaviorOptions(unit.token?.flags?.[SYSTEM_ID]?.aiBehavior ?? "")}</select></span></label>`).join("")}</div></div>`,
        buttons: {save: {label: "Save Encounter", callback: async html => {
            const root = rootElement(html);
            const factions = Array.from(root.querySelectorAll(".feue-faction-row")).map(row => ({id: row.dataset.id, name: row.querySelector("input").value.trim(), disposition: row.querySelector("select").value === "" ? null : Number(row.querySelector("select").value),
                ai: !!row.querySelector(".feue-faction-ai input")?.checked}));
            if (factions.some(g => !g.name)) return ui.notifications.warn("Every allegiance needs a name."), false;
            const type = root.querySelector(".feue-objective-type").value;
            const rounds = Number(root.querySelector(".feue-objective-rounds").value);
            const bosses = Array.from(root.querySelectorAll(".feue-boss-choice input:checked")).map(input => input.value);
            if (type === "survive" && (!Number.isSafeInteger(rounds) || rounds < 1)) return ui.notifications.warn("Use a positive whole number of rounds."), false;
            if (type === "boss" && !bosses.length) return ui.notifications.warn("Choose at least one boss."), false;
            const allegiance = root.querySelector(".feue-objective-allegiance").value;
            const escapeMode = root.querySelector(".feue-escape-mode").value, escapeUnit = root.querySelector(".feue-escape-unit").value;
            const tiles = [...new Set([...(objective.type === type ? objective.tiles ?? [] : []), ...Array.from(objectiveScene(combat)?.tiles ?? []).filter(tile => tile.flags?.[SYSTEM_ID]?.interactable && tile.flags[SYSTEM_ID].interactionType === type).map(tile => tile.id)])];
            if (["seize", "escape"].includes(type) && !tiles.length) return ui.notifications.warn(`Add at least one interactable ${type === "seize" ? "Seize" : "Escape"} Tile to the encounter scene.`), false;
            if (type === "escape" && escapeMode === "selected" && !units.some(unit => unit.id === escapeUnit)) return ui.notifications.warn("Choose the unit that must escape."), false;
            const currentId = combat.combatant?.id;
            const updates = Array.from(root.querySelectorAll("[data-unit]")).map(select => ({_id: select.dataset.unit, [`flags.${SYSTEM_ID}.allegiance`]: select.value}));
            const editedCombat = {flags: {[SYSTEM_ID]: {allegiances: factions}}, combatants: units.map(unit => ({id: unit.id, token: unit.token,
                flags: {[SYSTEM_ID]: {allegiance: updates.find(update => update._id === unit.id)?.[`flags.${SYSTEM_ID}.allegiance`]}}}))};
            const escapeUnits = escapeUnitIds(editedCombat, {escapeMode, escapeUnit, allegiance,
                escapeUnits: objective.type === "escape" && objective.escapeMode !== "selected" && escapeMode === "all" && (objective.allegiance || "player") === allegiance ? objective.escapeUnits ?? [] : []});
            if (type === "escape" && !escapeUnits.length) return ui.notifications.warn("Add a unit of the objective allegiance to the encounter."), false;
            if (updates.length) await combat.updateEmbeddedDocuments("Combatant", updates, {turnEvents: false});
            // AI behavior lives on the token, so it stays with the unit on the map.
            const behaviors = new Map();
            for (const select of root.querySelectorAll("[data-ai-unit]")) {
                const token = units.find(unit => unit.id === select.dataset.aiUnit)?.token;
                if (!token?.parent || (token.flags?.[SYSTEM_ID]?.aiBehavior ?? "") === select.value) continue;
                if (!behaviors.has(token.parent)) behaviors.set(token.parent, []);
                behaviors.get(token.parent).push({_id: token.id, [`flags.${SYSTEM_ID}.aiBehavior`]: select.value});
            }
            for (const [scene, tokenUpdates] of behaviors) await scene.updateEmbeddedDocuments("Token", tokenUpdates);
            await combat.update({[`flags.${SYSTEM_ID}.allegiances`]: factions, [`flags.${SYSTEM_ID}.ai`]: {behavior: root.querySelector(".feue-ai-behavior").value, autoEnd: root.querySelector(".feue-ai-autoend input").checked},
                [`flags.${SYSTEM_ID}.objective`]: {type, rounds, bosses, tiles, allegiance, escapeMode, escapeUnit, escapeUnits,
                startRound: objective.type === "survive" && type === "survive" ? objective.startRound ?? 1 : Math.max(1, combat.round)},
                ...(objective.type !== type ? {[`flags.${SYSTEM_ID}.eventProgress`]: {seized: [], escaped: []}} : {})}, {turnEvents: false});
            combat.setupTurns();
            if (currentId) await combat.update({turn: combat.turns.findIndex(unit => unit.id === currentId)}, {turnEvents: false});
            await checkEncounterObjective(combat);
            ui.combat.render();
        }}, cancel: {label: "Cancel"}}, default: "save",
        render: html => {
            const root = rootElement(html), container = root.querySelector(".feue-factions");
            const refresh = () => {
                const groups = Array.from(container.children).map(row => ({id: row.dataset.id, name: row.querySelector("input").value}));
                root.querySelectorAll("[data-unit]").forEach(select => {
                    const value = select.options.length ? select.value : select.dataset.selected;
                    select.innerHTML = '<option value="">Automatic (disposition)</option>' + groups.map(g => `<option value="${esc(g.id)}" ${value === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("");
                });
                const objectiveGroup = root.querySelector(".feue-objective-allegiance"), value = objectiveGroup.options.length ? objectiveGroup.value : objectiveGroup.dataset.selected;
                objectiveGroup.innerHTML = groups.map(g => `<option value="${esc(g.id)}" ${value === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("");
                const type = root.querySelector(".feue-objective-type").value;
                root.querySelector(".feue-survive-options").hidden = type !== "survive";
                root.querySelector(".feue-boss-options").hidden = type !== "boss";
                root.querySelector(".feue-tile-objective-options").hidden = !["seize", "escape"].includes(type);
                root.querySelector(".feue-escape-options").hidden = type !== "escape";
                root.querySelector(".feue-escape-unit-choice").hidden = root.querySelector(".feue-escape-mode").value !== "selected";
            };
            root.querySelector(".feue-add-faction").onclick = () => { container.insertAdjacentHTML("beforeend", factionRow({id: foundry.utils.randomID(), name: "New allegiance", disposition: null})); refresh(); };
            container.addEventListener("input", refresh);
            container.addEventListener("click", event => {
                const row = event.target.closest(".feue-faction-row");
                if (!row) return;
                if (event.target.closest(".feue-faction-remove")) row.remove();
                if (event.target.closest(".feue-faction-up") && row.previousElementSibling) container.insertBefore(row, row.previousElementSibling);
                if (event.target.closest(".feue-faction-down") && row.nextElementSibling) container.insertBefore(row.nextElementSibling, row);
                refresh();
            });
            root.querySelector(".feue-objective-type").onchange = refresh;
            root.querySelector(".feue-escape-mode").onchange = refresh;
            refresh();
        }
    }, {width: 620}).render(true);
}

function renderTracker(app, html) {
    const root = rootElement(html), combat = app.viewed;
    if (!root || !combat) return;
    root.querySelectorAll(".feue-phase-header, .feue-encounter-summary").forEach(el => el.remove());
    const status = evaluateObjective(combat), objective = combat.flags?.[SYSTEM_ID]?.objective;
    const summary = document.createElement("section");
    summary.className = "feue-encounter-summary";
    summary.innerHTML = `<button type="button" class="feue-objectives-button"><i class="fas fa-flag"></i> Objectives</button><strong>${esc(OBJECTIVES[objective?.type] ?? "No objective")}</strong><span>${status.complete && combat.started ? "Victory! " : ""}${esc(status.text)}</span>`;
    summary.querySelector("button").onclick = event => { event.stopPropagation(); openEncounterSetup(combat); };
    const list = root.querySelector(".combat-tracker, #combat-tracker");
    if (!list) return;
    list.before(summary);
    let last;
    for (const row of list.querySelectorAll("[data-combatant-id]")) {
        const unit = combat.combatants.get(row.dataset.combatantId);
        if (!unit) continue;
        const group = allegianceOf(unit, combat), current = combat.started && combat.combatant && allegianceOf(combat.combatant, combat).id === group.id;
        if (last !== group.id) {
            const header = document.createElement("li");
            header.className = `feue-phase-header ${current ? "feue-phase-current" : ""}`;
            header.textContent = `${group.name} Phase${group.ai ? " • AI" : ""}${current ? " • Active" : ""}`;
            row.before(header);
            last = group.id;
        }
        row.classList.toggle("feue-unit-slain", isSlain(unit));
        row.classList.toggle("feue-unit-escaped", hasEscaped(unit.token, combat));
        row.classList.toggle("feue-unit-acted", !!unit.flags?.[SYSTEM_ID]?.acted);
        const initiative = row.querySelector(".token-initiative");
        if (initiative) {
            initiative.innerHTML = "";
            if (hasEscaped(unit.token, combat)) initiative.textContent = "Escaped";
            else if (unit.isOwner && current && !isSlain(unit)) {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "feue-acted-button";
                button.textContent = unit.flags?.[SYSTEM_ID]?.acted ? "✓" : "Act";
                button.title = "Wait / reset unit actions (GM)";
                button.onclick = event => {
                    event.stopPropagation();
                    if (game.user.isGM && unit.flags?.[SYSTEM_ID]?.acted) return unit.update({[`flags.${SYSTEM_ID}.acted`]: false, [`flags.${SYSTEM_ID}.majorAction`]: false, [`flags.${SYSTEM_ID}.attacked`]: false});
                    game.firesOfWar.requestUnitCommand(unit.token, "wait").catch(error => ui.notifications.warn(error.message));
                };
                initiative.append(button);
            }
        }
    }
    root.querySelectorAll('[data-action="rollAll"], [data-action="rollNPC"], [data-control="rollAll"], [data-control="rollNPC"]').forEach(button => { button.hidden = true; });
    for (const action of ["nextTurn", "previousTurn"]) root.querySelectorAll(`[data-action="${action}"], [data-control="${action}"]`).forEach(button => {
        button.setAttribute("aria-label", action === "nextTurn" ? "Next Phase" : "Previous Phase");
        button.title = action === "nextTurn" ? "Next Phase" : "Previous Phase";
        if (!game.user.isGM) button.hidden = true;
    });
}

export function registerTacticalEncounter() {
    registerTerrainUI();
    for (const hook of ["canvasReady", "controlToken", "createToken", "updateToken", "deleteToken", "createRegion", "updateRegion", "deleteRegion"]) {
        Hooks.on(hook, document => refreshTerrainStats(document?.parent?.documentName === "Scene" ? document.parent : undefined));
    }
    Hooks.on("canvasTearDown", () => refreshTerrainStats(undefined, {ignoreScene: true}));
    Hooks.once("init", () => { CONFIG.Combat.documentClass = createPhaseCombatClass(CONFIG.Combat.documentClass); });
    Hooks.once("ready", () => { game.firesOfWar = Object.assign(game.firesOfWar ?? {}, {openEncounterSetup}); });
    Hooks.on("renderCombatTracker", renderTracker);
    Hooks.on("renderCombatantConfig", (app, html) => {
        const root = rootElement(html), doc = app.document ?? app.object;
        if (!root || root.querySelector(".feue-allegiance-config")) return;
        const field = document.createElement("div");
        field.className = "form-group feue-allegiance-config";
        field.innerHTML = `<label>Allegiance</label><select name="flags.${SYSTEM_ID}.allegiance"><option value="">Automatic (disposition)</option>${allegiances(doc.parent).map(g => `<option value="${esc(g.id)}" ${doc.flags?.[SYSTEM_ID]?.allegiance === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select>`;
        (root.querySelector("footer") ?? root.lastElementChild)?.before(field);
    });
    Hooks.on("updateCombat", (combat, changes) => {
        checkEncounterObjective(combat);
        if (changes.flags?.[SYSTEM_ID]?.allegiances || `flags.${SYSTEM_ID}.allegiances` in changes) void syncPhaseInitiative(combat).catch(console.error);
    });
    Hooks.on("preCreateCombatant", combatant => {
        try { if (combatant.initiative === null || combatant.initiative === undefined) combatant.updateSource({initiative: phaseInitiative(combatant)}); }
        catch (error) { console.warn("FEUE | Could not set phase initiative", error); }
    });
    // Allegiance can change through Objectives, Combatant configuration, or a token's disposition.
    for (const hook of ["createCombatant", "updateCombatant", "updateToken"]) Hooks.on(hook, () => {
        for (const combat of game.combats) void syncPhaseInitiative(combat).catch(console.error);
    });
    for (const hook of ["updateActor", "updateToken", "createCombatant", "updateCombatant", "deleteCombatant"]) Hooks.on(hook, () => {
        for (const combat of game.combats) {
            combat.setupTurns();
            checkEncounterObjective(combat);
        }
        ui.combat?.render();
    });
    Hooks.on("deleteCombat", combat => { objectiveQueue.delete(combat.id); });
}
