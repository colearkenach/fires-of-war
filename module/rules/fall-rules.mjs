/** What happens when a unit reaches 0 HP under the alternate rules, and the end-of-map bookkeeping:
 * Revival Stones, Fate Points, Forcibly Dismounted, Knocked Out captives and Per-Map Durability. */
import {SYSTEM, revivalState, enragedMultiplier, pendingRevival, fatePoints, fateNegatesLethal, fateRerollsSkills, fateMax, fateEnabled,
    perMapTracked, pendingMapLoss, usesAfterMap, perMapDurability, replaceableMounts, ridesMount, forcedDismountPending, isMountItem, mountLost} from "./alt-rules.mjs";
import {presentCombatText, defeatEnemyTokens} from "../combat/combat-presentation.mjs";
import {mountUnitFallen} from "../units/mounts.mjs";

const hp = actor => Number(actor?.system?.attributes?.hp?.value) || 0;
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));
const docOf = token => token?.document ?? token;
const activeGM = () => globalThis.game?.users?.activeGM?.id === globalThis.game?.user?.id;
const chat = content => globalThis.ChatMessage?.create({content});
/** The token a fall is shown on: the synthetic actor's own token, otherwise its only active copy. */
const actorToken = actor => actor?.isToken ? actor.token : actor?.getActiveTokens?.(false, true)?.[0] ?? null;
const resolving = new Set();

// ── Fate Points ──
export async function spendFatePoint(actor) {
    const value = fatePoints(actor);
    if (value <= 0) return false;
    await actor.update({"system.fatePoints.value": value - 1});
    return true;
}
/** "Negate an attack that would kill you": returns a note when a Fate Point was spent. */
export async function fateNegation(actor, damage, before) {
    if (!actor || !(before > 0) || damage < before || !fateNegatesLethal(actor) || !await spendFatePoint(actor)) return "";
    return `Fate Point: ${actor.name} negates a lethal attack (${fatePoints(actor)} left)`;
}
/** Rerolls a failed skill activation when the unit is set to spend Fate Points on skills. */
export async function fateSkillReroll(actor, skill, target, first) {
    if (first <= target || !fateRerollsSkills(actor) || !await spendFatePoint(actor)) return null;
    const roll = (await new Roll("1d100").evaluate()).total;
    await chat(`<p><b>${esc(actor.name)}</b> spends a Fate Point to reroll <b>${esc(skill.name)}</b>: ${first} → ${roll} vs ${target}% — ${roll <= target ? "activated" : "failed"} (${fatePoints(actor)} left).</p>`);
    return roll;
}
/** Start-of-session refresh: every character with Fate Points regains LUK ÷ 5. */
export async function refreshFatePoints(actors = Array.from(globalThis.game?.actors ?? []).filter(a => a.type === "character" && a.hasPlayerOwner)) {
    if (!fateEnabled()) return 0;
    let count = 0;
    for (const actor of actors) {
        if (actor.type !== "character") continue;
        await actor.update({"system.fatePoints.value": fateMax(actor), "system.fatePoints.max": fateMax(actor)});
        count++;
    }
    return count;
}

// ── Forcibly Dismounted (Replaceable Mounts) ──
export const canForceDismount = actor => replaceableMounts() && ridesMount(actor);
/** Thrown from the mount instead of dying: max HP is halved for the map and HP set to it. Returns the new HP and a note. */
export async function forcedDismount(actor, options = {}) {
    const max = Math.max(1, Math.floor((Number(actor.system.attributes?.hp?.max) || 0) / 2));
    const combat = globalThis.game?.combat;
    await actor.update({"system.attributes.hp.value": max, "system.mount.dismounted": true, "system.mount.lost": true,
        "system.mount.forced": combat?.id ?? true}, {...options, feueFall: true});
    const mounts = Array.from(actor.items ?? []).filter(item => isMountItem(item) && item.system.equipped);
    if (mounts.length) await actor.updateEmbeddedDocuments("Item", mounts.map(item => ({_id: item.id, "system.equipped": false, [`flags.${SYSTEM}.mountLost`]: true})));
    await presentCombatText(actorToken(actor), "skill", "Dismounted!");
    return {hp: max, note: `${actor.name} is thrown from ${mounts[0] ? mounts[0].name : "their mount"} instead of falling (max HP halved; equip a new mount to remount)`};
}

// ── Revival Stones ──
/** Spend one stone and heal to full; Enraged Revival raises max and current HP by the stones lost. */
export async function reviveUnit(actor) {
    if (!pendingRevival(actor) || resolving.has(actor.uuid)) return null;
    resolving.add(actor.uuid);
    try {
        const state = revivalState(actor), remaining = state.value - 1, lost = state.max - remaining;
        const base = Number(actor.system.attributes?.hp?.baseMax ?? actor.system.attributes?.hp?.max) || 1;
        const multiplier = state.enraged ? enragedMultiplier(lost, state.max) : 1;
        const restored = Math.max(1, Math.floor(base * multiplier));
        await actor.update({"system.revivalStones.value": remaining, "system.attributes.hp.value": restored}, {feueFall: true});
        if (actor.statuses?.has?.("dead")) await actor.toggleStatusEffect?.("dead", {active: false});
        await presentCombatText(actorToken(actor), "skill", "Revival Stone");
        await chat(`<div class="feue-revival"><p><b>${esc(actor.name)}</b> shatters a Revival Stone and rises again with ${restored} HP!</p><p>${remaining} Revival Stone${remaining === 1 ? "" : "s"} left${multiplier > 1 ? ` · Enraged: ×${multiplier} HP` : ""}.</p></div>`);
        return restored;
    } finally { resolving.delete(actor.uuid); }
}

// ── Capture, Subdue and Knocked Out ──
export async function knockOut(actor) {
    const statuses = (actor.system.statusEffects ?? []).filter(effect => String(effect?.name ?? effect).trim().toLowerCase() !== "knocked out");
    await actor.update({"system.statusEffects": [...statuses, {name: "Knocked Out", automationKey: "status-knocked out", duration: -1}]});
}
/** A captive or knocked-out unit is slain: Dead, hidden if it is an enemy, and defeated in the encounter. */
export async function slayUnit(token) {
    const doc = docOf(token), actor = doc?.actor;
    if (!actor) return;
    const statuses = actor.system.statusEffects ?? [];
    const remaining = statuses.filter(effect => String(effect?.name ?? effect).trim().toLowerCase() !== "knocked out");
    await actor.update({"system.attributes.hp.value": 0, ...(remaining.length !== statuses.length ? {"system.statusEffects": remaining} : {})}, {feueCombatPresentation: true});
    await defeatEnemyTokens(actor, [doc]);
    if (!actor.statuses?.has?.("dead")) await actor.toggleStatusEffect?.("dead", {active: true, overlay: true});
    for (const combat of globalThis.game?.combats ?? []) for (const unit of combat.combatants ?? []) {
        if (unit.tokenId === doc.id && !unit.defeated) await unit.update({defeated: true});
    }
}

/** End of an exchange (attack, Combat Art, spell): revive fallen units, then resolve a declared Capture or Subdue. */
export async function resolveExchangeFalls(units, {capture = null} = {}) {
    for (const [actor] of units) if (actor && pendingRevival(actor)) await reviveUnit(actor);
    if (!capture?.target) return;
    const target = docOf(capture.target), source = docOf(capture.source);
    if (!target?.actor || hp(target.actor) > 0) return;
    try {
        const captured = await globalThis.game?.firesOfWar?.captureUnit?.(source, target);
        if (!captured) await defeatEnemyTokens(target.actor, [target]);
    } catch (error) {
        console.error("FEUE | Capture failed", error);
        ui.notifications?.warn(`Capture failed: ${error.message}`);
        await defeatEnemyTokens(target.actor, [target]);
    }
}

// ── Per-Map Durability ──
/** Record that a weapon was used this map (and any Combat Art per-map cost) instead of spending Uses now. */
export async function recordMapUse(weapon, {combat = globalThis.game?.combat, arts = 0} = {}) {
    if (!perMapTracked(weapon) || !combat?.id) return false;
    const usage = weapon.flags?.[SYSTEM]?.mapUse;
    const current = usage?.combat === combat.id ? Math.trunc(Number(usage.arts) || 0) : null;
    if (current !== null && !arts) return true;
    await weapon.update({[`flags.${SYSTEM}.mapUse`]: {combat: combat.id, arts: (current ?? 0) + arts}});
    return true;
}
/** Combat Arts cannot push the weapon below 0 per-map durability by the end of the map. */
export function perMapArtReason(weapon, artUnits, combat = globalThis.game?.combat) {
    if (!perMapTracked(weapon)) return "";
    const pending = Math.max(1, pendingMapLoss(weapon, combat?.id)) + artUnits;
    return perMapDurability(weapon.system.uses) - pending < 0 ? `${weapon.name} would break before the end of the map (per-map durability ${perMapDurability(weapon.system.uses)}).` : "";
}

/** End of map: apply per-map durability, refresh Revival Stones and restore forced-dismount max HP. */
export async function endOfMap(combat) {
    const actors = new Map();
    for (const unit of combat.combatants ?? []) if (unit.actor) actors.set(unit.actor.uuid, unit.actor);
    const notes = [];
    for (const actor of actors.values()) {
        const weapons = Array.from(actor.items ?? []).filter(item => item.type === "weapon" && item.flags?.[SYSTEM]?.mapUse);
        for (const weapon of weapons) {
            const loss = weapon.flags[SYSTEM].mapUse.combat === combat.id ? pendingMapLoss(weapon, combat.id) : 0;
            const value = loss && perMapTracked(weapon) ? usesAfterMap(weapon.system.uses, loss) : weapon.system.uses?.value;
            await weapon.update({"system.uses.value": value, [`flags.${SYSTEM}.-=mapUse`]: null});
            if (loss) notes.push(`${actor.name}: ${weapon.name} −${loss} per-map durability (${perMapDurability({value})} left)`);
        }
        const changes = {};
        const stones = revivalState(actor);
        if (stones.max && stones.value < stones.max && hp(actor) > 0) {
            changes["system.revivalStones.value"] = stones.max;
            const base = Number(actor.system.attributes?.hp?.baseMax ?? actor.system.attributes?.hp?.max) || 0;
            if (base && hp(actor) > base) changes["system.attributes.hp.value"] = base;
        }
        if (actor.system.mount?.forced) changes["system.mount.forced"] = false;
        if (Object.keys(changes).length) await actor.update(changes, {feueFall: true});
    }
    if (notes.length) await chat(`<div class="feue-map-end"><b>End of map</b><p>${notes.map(esc).join("<br>")}</p></div>`);
}

/** Falls outside a combat exchange (Battalions, phase-start damage, manual HP edits) resolve as soon as HP reaches 0. */
async function resolveFall(actor) {
    if (hp(actor) > 0) return;
    if (forcedDismountPending(actor)) {
        const result = await forcedDismount(actor);
        await chat(`<p>${esc(result.note)}.</p>`);
    } else if (pendingRevival(actor)) await reviveUnit(actor);
}

export function registerFallRules() {
    Hooks.on("updateActor", (actor, changes, options = {}) => {
        const value = changes["system.attributes.hp.value"] ?? changes.system?.attributes?.hp?.value;
        if (value === undefined || Number(value) > 0 || !activeGM()) return;
        // A mount unit that falls is lost to its rider, however it fell.
        if (actor.getActiveTokens?.(false, true)?.some(token => token.flags?.[SYSTEM]?.mountOf)) void mountUnitFallen(actor).catch(error => console.error("FEUE | Mount loss failed", error));
        if (options.feueCombatPresentation || options.feueFall) return;
        void resolveFall(actor).catch(error => console.error("FEUE | Fall resolution failed", error));
    });
    Hooks.on("deleteCombat", combat => {
        if (!activeGM() || !combat.started) return;
        void endOfMap(combat).catch(error => console.error("FEUE | End of map failed", error));
    });
    // Buying (adding) or equipping a working mount lets a unit that lost its mount ride again.
    for (const hook of ["createItem", "updateItem"]) Hooks.on(hook, (item, changes = {}) => {
        const actor = item.parent;
        if (!activeGM() || !actor?.system?.mount?.lost || !isMountItem(item) || mountLost(item)) return;
        if (hook === "updateItem" && !item.system.equipped) return;
        void actor.update({"system.mount.lost": false}).catch(console.error);
    });
    Hooks.once("ready", () => Object.assign(game.firesOfWar ??= {}, {refreshFatePoints, reviveUnit, slayUnit}));
}
