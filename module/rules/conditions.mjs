/** The sheet's Conditions and the token status icons are one list. Every live rulebook condition in system.statusEffects
 * has a matching status ActiveEffect (its token icon), and the Token HUD adds or removes conditions with their rulebook
 * durations instead of bare icons. Dead stays Foundry's own status effect; the sheet lists it as a permanent condition. */
import {STATUS_RULES, DEAD_STATUS, statusKey, statusImmune, activeStatuses, activeConditionIds, conditionName, conditionStatusId, conditionForStatus,
    conditionStatusEffects} from "./status-rules.mjs";

const SYSTEM = "fires-of-war";
const SYNC = {feueConditionSync: true};
const MIGRATION_VERSION = 1;
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));
let coreStatusIds = new Set();

/** The condition status id of an effect that is a condition icon (a single-status effect). */
function iconStatus(effect) {
    if (effect?.statuses?.size !== 1) return null;
    const [id] = effect.statuses;
    return conditionForStatus(id) ? id : null;
}
const effectActor = effect => effect?.parent instanceof Actor ? effect.parent : effect?.parent?.syntheticActor ?? null;
const durationText = duration => duration === -1 || duration === undefined || Number.isNaN(duration) ? "until removed" : `${duration} turn${duration === 1 ? "" : "s"}`;

export function conditionEntry(key, duration) {
    const rule = STATUS_RULES[key];
    return {name: conditionName(key), automationKey: `status-${key}`, duration: duration ?? rule.duration, ...(rule.expiresAtPhaseStart ? {expires: "phaseStart"} : {})};
}

/** Give a unit a rulebook condition with its default (or the given) duration, replacing an earlier copy. False when immune. */
export async function setCondition(actor, name, duration) {
    const key = statusKey(name);
    if (!STATUS_RULES[key] || statusImmune(actor, key)) return false;
    const kept = (actor.system.statusEffects ?? []).filter(effect => statusKey(effect) !== key);
    await actor.update({"system.statusEffects": [...kept, conditionEntry(key, duration)]});
    return true;
}
export async function clearCondition(actor, name) {
    const key = statusKey(name), statuses = actor.system.statusEffects ?? [];
    const kept = statuses.filter(effect => statusKey(effect) !== key);
    if (kept.length !== statuses.length) await actor.update({"system.statusEffects": kept});
}

/** Token HUD and macros: toggling a condition's icon adds or removes the condition itself. */
export async function toggleCondition(actor, name, {active} = {}) {
    const key = statusKey(name), id = conditionStatusId(key), has = activeConditionIds(actor).has(id);
    active ??= !has;
    if (active === has) return has;
    if (!active) await clearCondition(actor, key);
    else if (!await setCondition(actor, key)) {
        globalThis.ui?.notifications?.warn(`${actor.name} is immune to ${conditionName(key)}.`);
        return false;
    }
    await syncConditionIcons(actor);
    return active ? actor.effects.find(effect => iconStatus(effect) === id) ?? true : false;
}

const queues = new Map();
/** Create or delete condition icons until they match the unit's live conditions. Calls for one actor run in order. */
export function syncConditionIcons(actor) {
    if (!actor?.uuid) return Promise.resolve();
    const run = (queues.get(actor.uuid) ?? Promise.resolve()).then(() => reconcile(actor))
        .catch(error => console.error(`FEUE | Could not update ${actor.name}'s condition icons`, error));
    queues.set(actor.uuid, run);
    void run.then(() => { if (queues.get(actor.uuid) === run) queues.delete(actor.uuid); });
    return run;
}
async function reconcile(actor) {
    const wanted = activeConditionIds(actor), seen = new Set(), stale = [];
    for (const effect of actor.effects ?? []) {
        const id = iconStatus(effect);
        if (!id) continue;
        if (wanted.has(id) && !seen.has(id)) seen.add(id);
        else stale.push(effect.id);
    }
    const missing = [...wanted].filter(id => !seen.has(id));
    if (stale.length) await actor.deleteEmbeddedDocuments("ActiveEffect", stale, SYNC);
    if (!missing.length) return;
    const ActiveEffect = getDocumentClass("ActiveEffect");
    const effects = await Promise.all(missing.map(async id => (await ActiveEffect.fromStatusEffect(id)).toObject()));
    await actor.createEmbeddedDocuments("ActiveEffect", effects, SYNC);
}

/** Token HUD tooltips show each condition's rulebook effect and how long it lasts (or has left). */
function describeHudConditions(hud, element) {
    const root = element instanceof HTMLElement ? element : element?.[0], actor = hud.actor ?? hud.object?.actor;
    if (!root || !actor) return;
    const left = new Map(activeStatuses(actor).filter(s => s.rule).map(s => [conditionStatusId(s.effect), Number(s.effect?.duration ?? -1)]));
    for (const icon of root.querySelectorAll(".effect-control[data-status-id]")) {
        const id = icon.dataset.statusId, key = conditionForStatus(id);
        if (!key) continue;
        const rule = STATUS_RULES[key];
        const duration = left.has(id) ? `${durationText(left.get(id))}${left.get(id) === -1 ? "" : " left"}` : `lasts ${durationText(rule.duration)}`;
        icon.dataset.tooltipHtml = `<strong>${esc(conditionName(key))}</strong> · ${esc(duration)}<br>${esc(rule.summary)}`;
        delete icon.dataset.tooltipText;
    }
}

/** One-time update of existing worlds: old icons for statuses that match a condition become that condition;
 * icons for Foundry's other default statuses (no longer on the Token HUD) are removed. Then every unit's icons are synced. */
async function migrateActor(actor) {
    const current = activeConditionIds(actor), adopted = [], legacy = [];
    for (const effect of actor.effects ?? []) {
        if (effect.statuses?.size !== 1 || effect.changes?.length) continue;
        const [id] = effect.statuses, key = conditionForStatus(id);
        if (key) { if (!current.has(id) && !adopted.includes(key) && !statusImmune(actor, key)) adopted.push(key); }
        else if (coreStatusIds.has(id) && !CONFIG.statusEffects.some(status => status.id === id)) legacy.push(effect.id);
    }
    if (legacy.length) await actor.deleteEmbeddedDocuments("ActiveEffect", legacy, SYNC);
    if (adopted.length) {
        const kept = (actor.system.statusEffects ?? []).filter(effect => !adopted.includes(statusKey(effect)));
        await actor.update({"system.statusEffects": [...kept, ...adopted.map(key => conditionEntry(key))]});
    }
    await syncConditionIcons(actor);
}
async function migrateWorld() {
    if (Number(game.settings.get(SYSTEM, "conditionIconsVersion")) >= MIGRATION_VERSION) return;
    const characters = actors => Array.from(actors).filter(actor => actor?.type === "character");
    const unlinked = Array.from(game.scenes ?? []).flatMap(scene => Array.from(scene.tokens ?? []).filter(token => !token.actorLink).map(token => token.actor));
    // Base actors first, so unlinked tokens already inherit their updated icons.
    for (const actor of [...characters(game.actors ?? []), ...characters(unlinked)]) {
        try { await migrateActor(actor); }
        catch (error) { console.error(`FEUE | Could not migrate ${actor.name}'s status icons`, error); }
    }
    await game.settings.set(SYSTEM, "conditionIconsVersion", MIGRATION_VERSION);
}

export function registerConditions() {
    Hooks.once("init", () => {
        game.settings.register(SYSTEM, "conditionIconsVersion", {scope: "world", config: false, type: Number, default: 0});
        coreStatusIds = new Set(CONFIG.statusEffects.map(status => status.id));
        const dead = CONFIG.statusEffects.find(status => status.id === DEAD_STATUS) ?? {id: DEAD_STATUS, name: "EFFECT.StatusDead", img: "icons/svg/skull.svg"};
        CONFIG.statusEffects = [dead, ...conditionStatusEffects()];
    });
    Hooks.once("ready", () => {
        if (game.user.isActiveGM) void migrateWorld().catch(error => console.error("FEUE | Status icon migration failed", error));
    });
    Hooks.on("updateActor", (actor, changed, options, userId) => {
        if (userId === game.user.id && foundry.utils.hasProperty(changed, "system.statusEffects")) void syncConditionIcons(actor);
    });
    // Condition icons added or removed some other way (dropped effects, other modules) still edit the Conditions list.
    Hooks.on("createActiveEffect", (effect, options, userId) => {
        const id = iconStatus(effect), actor = effectActor(effect);
        if (userId !== game.user.id || options.feueConditionSync || !id || actor?.type !== "character" || activeConditionIds(actor).has(id)) return;
        void setCondition(actor, conditionForStatus(id)).then(applied => applied || syncConditionIcons(actor));
    });
    Hooks.on("deleteActiveEffect", (effect, options, userId) => {
        const id = iconStatus(effect), actor = effectActor(effect);
        if (userId !== game.user.id || options.feueConditionSync || !id || actor?.type !== "character" || !activeConditionIds(actor).has(id)) return;
        void clearCondition(actor, conditionForStatus(id));
    });
    Hooks.on("renderTokenHUD", describeHudConditions);
}
