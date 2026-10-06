import {tokenInItemRange, tokenRangeDistance} from "../ui/character-action-hud.mjs";
import {unavailableUnit, sameAllegiance} from "../encounter/event-rules.mjs";
import {hasSkill, hpBelow, skillModifiers} from "../skills/skill-automation.mjs";
import {withUnitActionLock} from "../units/unit-actions.mjs";
import {registerCombatPresentation} from "./combat-presentation.mjs";
import {formatUses, hasInfiniteUses} from "../rules/feue.mjs";
import {effectiveAttackRange} from "../map/tactical-grid.mjs";
import {cannotCounter, isIncapacitated, activeStatuses} from "../rules/status-rules.mjs";
import {term, sectionsHtml, tooltipAttributes} from "../ui/stat-breakdown.mjs";
import {triangleOverride, captureMode, fateEnabled, fatePoints} from "../rules/alt-rules.mjs";
export {presentCombatText, defeatEnemyTokens} from "./combat-presentation.mjs";

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
}[c]));
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const kind = weapon => String(weapon?.system?.weaponType ?? "").trim().toLowerCase();
/** "auto" lets each side work out the Weapon Triangle from both weapons; manual values are mirrored for the defender. */
export const reverseTriangle = triangle => triangle === "advantage" ? "disadvantage" : triangle === "disadvantage" ? "advantage" : triangle === "auto" ? "auto" : "none";
/** Manual triangle choices are honoured only with the Weapon Triangle Override setting. */
export const forecastTriangle = choice => triangleOverride() && ["none", "advantage", "disadvantage"].includes(choice) ? choice : "auto";

/** Rebase equipped AS for sheet attacks made with a different weapon. */
export function weaponAttackSpeed(actor, weapon) {
    if (actor.system.combat?.zeroed?.includes?.("attackSpeed")) return 0;
    const equipped = actor.items.find(i => i.type === "weapon" && i.system?.equipped);
    const build = num(actor.system.attributes?.build?.value);
    const burden = item => Math.max(Math.max(0, num(item?.system?.weight) - (hasSkill(actor, "great haul") ? 4 : 0)) - build, 0);
    const mastery = item => num(actor.system.weaponMasteryBonuses?.[String(item?.system?.weaponType ?? "").toLowerCase()]?.attackSpeed);
    return num(actor.system.combat?.attackSpeed) + burden(equipped) - burden(weapon) - mastery(equipped) + mastery(weapon);
}

/** Telekinetic Rod: a staff used as a makeshift weapon (1 Mt, 65 Hit, 0 Crit, 1 Range, 3 Wt, Smash). */
export function makeshiftWeapon(actor, staff) {
    if (!staff || kind(staff) !== "staff" || !hasSkill(actor, "telekinetic rod")) return null;
    return {id: staff.id, name: `${staff.name} (Telekinetic Rod)`, type: "weapon", img: staff.img, makeshift: true, sourceItem: staff,
        system: {...staff.system, weaponType: "rod", might: 1, hit: 65, crit: 0, range: "1", weight: 3, rank: "", uses: null, properties: {smash: true}},
        update: async () => staff};
}

/** Skills declared before attacking. Overdraw is required when the target is only in reach thanks to it. */
export function battleDeclarations(actor, weapon, {sourceToken = null, targetToken = null, grid = null} = {}) {
    const options = [];
    if (hasSkill(actor, "cleave")) options.push({key: "cleave", label: "Cleave", summary: "−20 Hit. Each hit also deals ½ of its damage to every other enemy adjacent to you."});
    if (hasSkill(actor, "overdraw") && kind(weapon) === "bow") {
        const distance = sourceToken && targetToken && grid ? tokenRangeDistance(sourceToken, targetToken, grid) : null;
        const forced = distance !== null && !effectiveAttackRange(actor, weapon, {overdraw: false}).some(r => distance >= r.min && distance <= r.max);
        options.push({key: "overdraw", label: "Overdraw", summary: "+1 range, +4 damage, −10 Hit and −10 Crit.", forced});
    }
    if (hasSkill(actor, "lunge")) options.push({key: "lunge", label: "Lunge", summary: "If you deal damage, swap places with the target after combat."});
    const capture = captureMode(), target = targetToken?.document ?? targetToken, source = sourceToken?.document ?? sourceToken;
    if (capture !== "off" && target?.actor && source && target.id !== source.id && !sameAllegiance(source, target, globalThis.game?.combat)) {
        const carrying = !!source.flags?.["fires-of-war"]?.rescuedTokenId;
        if (capture === "subdue") options.push({key: "capture", label: "Subdue", summary: "If this combat reduces the target to 0 HP, it is Knocked Out instead of slain and stays where it is."});
        else if (!carrying) options.push({key: "capture", label: "Capture", summary: "If this combat reduces the target to 0 HP, it is Knocked Out and carried in your square instead of slain. If its Build is not below your Aid, you drop it at the end of your next phase."});
    }
    if (fateEnabled() && fatePoints(actor) > 0) options.push({key: "fate", label: `Fate Point (${fatePoints(actor)} left)`, summary: "Spend a Fate Point to reroll this unit's first missed attack roll in this combat. The new result must be taken."});
    return options;
}

/** Brave applies only when initiating; speed follow-ups also apply to retaliation. */
export function battleAttackOrder({attackerSpeed = 0, defenderSpeed = 0, brave = false, canRetaliate = false, hasTarget = true, attackerFollowup = true, defenderFollowup = true, defenderFirst = false, alacrity = false}) {
    const opening = brave ? ["attacker", "attacker"] : ["attacker"];
    const order = [...opening];
    const followup = hasTarget && attackerFollowup && attackerSpeed - defenderSpeed >= 5;
    if (alacrity && followup) order.push(...opening);
    if (canRetaliate) order.push("defender");
    if (!alacrity && followup) order.push(...opening);
    else if (canRetaliate && defenderFollowup && defenderSpeed - attackerSpeed >= 5) order.push("defender");
    if (canRetaliate && defenderFirst) {order.splice(order.indexOf("defender"), 1); order.unshift("defender");}
    return order;
}

const swordOrPistol = item => kind(item) === "sword" || kind(item) === "firearm" && /pistol/i.test(String(item?.name ?? ""));
const usable = item => hasInfiniteUses(item.system?.uses) || !(num(item.system?.uses?.max) > 0 && num(item.system?.uses?.value) <= 0);

export function createBattleForecast({actor, weapon, target = null, sourceToken = null, targetToken = null, grid = null, triangle = "auto", brave = false, noCounter = false, declared = {}}) {
    declared = {...declared};
    if (battleDeclarations(actor, weapon, {sourceToken, targetToken, grid}).some(option => option.key === "overdraw" && option.forced)) declared.overdraw = true;
    let defenderWeapon = target?.items.find(i => i.type === "weapon" && i.system?.equipped), swapFrom = null, swapped = false;
    // Sword & Pistol: when attacked, swap to the Sword or "Pistol" firearm that can counter.
    if (target && sourceToken && targetToken && grid && hasSkill(target, "sword & pistol") && (!defenderWeapon || swordOrPistol(defenderWeapon)) &&
        !(defenderWeapon && tokenInItemRange(targetToken, sourceToken, defenderWeapon, grid, {retaliation: true}))) {
        const alternative = target.items.find(i => i.type === "weapon" && i !== defenderWeapon && swordOrPistol(i) && usable(i) && tokenInItemRange(targetToken, sourceToken, i, grid, {retaliation: true}));
        if (alternative) { swapFrom = defenderWeapon ?? null; defenderWeapon = alternative; swapped = true; }
    }
    let retaliationReason = "";
    if (!target) retaliationReason = "Select a target to forecast retaliation.";
    else if (noCounter) retaliationReason = "Counterattacks are prevented this combat";
    else if (!defenderWeapon) retaliationReason = "No equipped weapon";
    else if (kind(defenderWeapon) === "staff") retaliationReason = "Staff cannot retaliate";
    else if (isIncapacitated(target)) retaliationReason = "Unit is incapacitated";
    else if (cannotCounter(target)) retaliationReason = `${activeStatuses(target).find(s => s.rule?.noCounter)?.name ?? "Status"} prevents counterattacks`;
    else if (target.sheet._computeAttackStats(defenderWeapon).props.slow || target.sheet._computeAttackStats(defenderWeapon).props.vehicle) retaliationReason = "Slow / Vehicle weapons cannot retaliate";
    else if (!sourceToken || !targetToken || !grid) retaliationReason = "Place both units on the map to check retaliation range";
    else if (unavailableUnit(sourceToken) || unavailableUnit(targetToken) || num(target.system.attributes?.hp?.value) <= 0) retaliationReason = "Unit cannot retaliate";
    else if (!tokenInItemRange(targetToken, sourceToken, defenderWeapon, grid, {retaliation: true})) retaliationReason = "Opponent outside equipped weapon range";
    const canRetaliate = !!target && !retaliationReason;
    const attackerStats = actor.sheet._computeAttackStats(weapon, triangle, target, {sourceToken, targetToken, initiating: true, brave, declared, targetWeapon: defenderWeapon ?? null, targetCanCounter: canRetaliate});
    const defenderStats = canRetaliate ? target.sheet._computeAttackStats(defenderWeapon, reverseTriangle(triangle), actor, {sourceToken: targetToken, targetToken: sourceToken, initiating: false, targetWeapon: weapon}) : null;
    const defenderDouble = defenderStats?.doubleSpeed ?? (target ? skillModifiers(target, {token: targetToken, weapon: defenderWeapon ?? null, foe: actor, foeToken: sourceToken, foeWeapon: weapon, incomingWeapon: weapon, initiating: false}).totals.doubleSpeed : 0);
    const attackerSpeed = weaponAttackSpeed(actor, weapon) + num(attackerStats.doubleSpeed);
    const defenderSpeed = target ? weaponAttackSpeed(target, defenderWeapon) + num(defenderDouble) : 0;
    const wary = hasSkill(actor, "wary fighter") || hasSkill(target, "wary fighter");
    const alacrity = hasSkill(actor, "alacrity") && hpBelow(actor, 50);
    const swiftCaster = hasSkill(target, "swift caster") && !["anima", "light", "dark", "stone", "spell"].includes(kind(weapon)) && !attackerStats.props.magical && !alacrity;
    const order = battleAttackOrder({attackerSpeed, defenderSpeed, brave: !!attackerStats.props.brave, canRetaliate, hasTarget: !!target,
        attackerFollowup: !wary && !attackerStats.props.unwieldy, defenderFollowup: !wary && !defenderStats?.props.unwieldy,
        defenderFirst: hasSkill(target, "vantage") && hpBelow(target, 50) || swiftCaster, alacrity});
    return {actor, weapon, target, sourceToken, targetToken, grid, triangle, retaliationReason, canRetaliate, order, declared, brave, noCounter,
        attacker: {actor, weapon, token: sourceToken, stats: attackerStats, speed: attackerSpeed, baseSpeed: weaponAttackSpeed(actor, weapon), count: order.filter(s => s === "attacker").length},
        defender: {actor: target, weapon: defenderWeapon, token: targetToken, swapFrom, swapped,
            stats: defenderStats, speed: defenderSpeed, baseSpeed: target ? weaponAttackSpeed(target, defenderWeapon) : 0,
            doubleSpeed: num(defenderDouble), count: order.filter(s => s === "defender").length}};
}

export function renderBattleOrder(order) {
    const counts = {attacker: 0, defender: 0};
    return order.map((side, index) => `<span class="feue-battle-step ${side}" title="${side === "attacker" ? "Attacker" : "Defender"} strike ${++counts[side]}">${side === "attacker" ? "A" : "D"}${counts[side]}</span>${index < order.length - 1 ? '<span class="feue-battle-next" aria-hidden="true">→</span>' : ""}`).join("");
}

const chance = value => Math.min(100, Math.max(0, Math.floor(num(value))));
/** Tooltip breakdowns for one side's forecast numbers. */
export function forecastTooltips(unit, other) {
    const stats = unit.stats;
    if (!stats) return {};
    const b = stats.breakdown ?? {}, foe = other.actor?.name ?? "Target";
    const damage = stats.props.shade ? sectionsHtml({title: "Damage", total: "½ HP", notes: ["Shade: halves the target's current HP."]})
        : sectionsHtml({title: "Damage per strike", total: stats.strikeDamage ?? stats.netDmg, sections: [
            {heading: "Attack", terms: b.damage?.terms ?? [], total: b.damage?.total},
            ...(stats.props.piercing ? [] : [{heading: `${foe} ${b.defense?.label ?? "DEF"}`, terms: b.defense?.terms ?? [], total: b.defense?.total, sign: "-"}]),
            {heading: "Damage taken / multipliers", terms: b.adjust?.terms ?? []}],
            notes: ["Critical hits triple damage before damage-taken adjustments.", stats.props.piercing ? "Piercing: ignores DEF/RES." : "", stats.props.deadly ? "Deadly: at least 1 damage." : ""]});
    const hit = sectionsHtml({title: "Hit chance", total: chance(stats.netHit), suffix: "%", sections: [
        {heading: "Hit rate", terms: b.hit?.terms ?? [], total: b.hit?.total},
        {heading: `${foe} Avoid`, terms: b.avoid?.terms ?? [], total: b.avoid?.total, sign: "-"}]});
    const crit = sectionsHtml({title: "Critical chance", total: chance(stats.props.shade ? 0 : stats.netCrit), suffix: "%", sections: [
        {heading: "Crit rate", terms: b.crit?.terms ?? [], total: b.crit?.total},
        {heading: `${foe} Dodge`, terms: b.dodge?.terms ?? [], total: b.dodge?.total, sign: "-"},
        {heading: "Target status", terms: stats.critTaken ? [term("Petrified target", stats.critTaken)] : []}],
        notes: [stats.props.shade ? "Shade attacks cannot critically hit." : ""]});
    const speedTerms = [...(unit.actor?.system?.breakdown?.["combat.attackSpeed"] ?? [term("Attack Speed", unit.baseSpeed ?? unit.speed, "base")])];
    const equippedAS = num(unit.actor?.system?.combat?.attackSpeed);
    if (unit.baseSpeed !== undefined && unit.baseSpeed !== equippedAS) speedTerms.push(term(`Using ${unit.weapon?.name ?? "this weapon"}`, unit.baseSpeed - equippedAS));
    const doubling = (unit.speed ?? 0) - (unit.baseSpeed ?? unit.speed ?? 0);
    const speed = sectionsHtml({title: "Attack Speed", total: unit.speed, sections: [
        {heading: "Attack Speed", terms: speedTerms, total: unit.baseSpeed ?? unit.speed},
        {heading: "Follow-up checks only", terms: doubling ? [term("Skills", doubling)] : []}],
        notes: ["A unit with 5 or more AS than its opponent strikes twice."]});
    return {damage, hit, crit, speed};
}

export function renderBattleForecast(forecast) {
    const side = (unit, role) => {
        const hp = unit.actor?.system.attributes?.hp ?? {};
        const current = Math.max(0, num(hp.value)), max = Math.max(0, num(hp.max));
        const stats = unit.stats;
        const other = role === "attacker" ? forecast.defender : forecast.attacker;
        const tips = forecastTooltips(unit, other);
        const damage = stats?.props.shade ? "½ HP" : stats ? Math.max(stats.strikeDamage ?? stats.netDmg, stats.props.deadly ? 1 : 0) : "—";
        const cell = (label, value, tip) => `<div${tip ? ` tabindex="0" ${tooltipAttributes(tip)}` : ""}><span>${label}</span><strong>${value}</strong></div>`;
        const skills = [...new Set(stats?.skillNotes ?? [])];
        return `<section class="feue-battle-unit ${role}" aria-label="${role}">
            <div class="feue-battle-role">${role}</div>
            <div class="feue-battle-portrait"><img src="${esc(unit.token?.document?.texture?.src || unit.actor?.img || "icons/svg/mystery-man.svg")}" alt="${esc(unit.actor?.name || "No target")}" /></div>
            <h2>${esc(unit.token?.name || unit.actor?.name || "No target selected")}</h2>
            <div class="feue-battle-weapon">${unit.weapon ? `<img src="${esc(unit.weapon.img || "icons/svg/sword.svg")}" alt="" />` : ""}<span>${esc(unit.weapon?.name || "No equipped weapon")}</span>${stats?.triHit ? `<b class="feue-triangle-badge ${stats.triHit > 0 ? "advantage" : "disadvantage"}" title="${esc(stats.triNote)}" aria-label="${esc(stats.triNote)}">${stats.triHit > 0 ? "▲" : "▼"}</b>` : ""}<small>${esc(formatUses(unit.weapon?.system?.uses))}</small></div>
            <div class="feue-battle-stats">${cell("DMG", `${damage}${unit.count > 1 ? ` <em>×${unit.count}</em>` : ""}`, tips.damage)}${cell("HIT", stats ? `${chance(stats.netHit)}%` : "—", tips.hit)}${cell("CRIT", stats ? `${chance(stats.props.shade ? 0 : stats.netCrit)}%` : "—", tips.crit)}${cell("AS", unit.actor ? esc(unit.speed) : "—", stats ? tips.speed : null)}</div>
            <div class="feue-battle-health"><span>HP</span><strong>${unit.actor ? `${current} / ${max}` : "—"}</strong></div>
            <div class="feue-battle-health-track" role="progressbar" aria-label="${role} HP" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${Math.min(current, max)}"><div style="width:${max > 0 ? Math.min(100, current / max * 100) : 0}%"></div></div>
            <div class="feue-battle-note">${role === "defender" && !unit.count ? esc(forecast.retaliationReason) : `${unit.count} ${role === "defender" ? "retaliation" : "attack"}${unit.count === 1 ? "" : "s"}${unit.speed - (role === "attacker" ? forecast.defender.speed : forecast.attacker.speed) >= 5 && forecast.target ? " · Speed follow-up" : ""}${role === "attacker" && stats?.props.brave ? " · Brave" : ""}`}</div>
            ${role === "defender" && unit.swapped ? `<div class="feue-battle-skills">Sword &amp; Pistol: swaps to ${esc(unit.weapon?.name)}</div>` : ""}
            ${skills.length ? `<div class="feue-battle-skills" title="Passive skills affecting this side">${skills.map(esc).join(" · ")}</div>` : ""}
            ${stats?.penalties.length ? `<div class="feue-battle-warning">${esc(stats.penalties.join(" · "))}</div>` : ""}
        </section>`;
    };
    const declared = Object.entries(forecast.declared ?? {}).filter(([, on]) => on).map(([key]) => key[0].toUpperCase() + key.slice(1));
    return `<div class="feue-battle-arena">${side(forecast.attacker, "attacker")}<div class="feue-battle-versus" aria-hidden="true">VS</div>${side(forecast.defender, "defender")}</div>
        <div class="feue-battle-order"><span>Attack order</span><div>${renderBattleOrder(forecast.order)}</div></div>${declared.length ? `<div class="feue-battle-declared">Declared: ${declared.map(esc).join(", ")}</div>` : ""}`;
}

// Resolve enemy inventory/effects through the active GM, as with other system actions.
const socket = "system.fires-of-war", pending = new Map(), handled = new Set();
export async function requestBattleAttack(forecast) {
    if (game.user.isGM || !forecast.target || !game.users.activeGM && forecast.target.isOwner) {
        return withUnitActionLock(() => forecast.actor.sheet._executeAttack(forecast.weapon, forecast.triangle, {forecast}));
    }
    if (!game.users.activeGM) throw Error("A GM must be online to resolve attacks against another owner's unit.");
    if (!forecast.sourceToken || !forecast.targetToken) throw Error("Place both units on the map for GM-resolved combat.");
    const requestId = foundry.utils.randomID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(Error("Battle resolution timed out. Check chat before retrying.")); }, 180000);
        pending.set(requestId, {resolve, reject, timer});
        game.socket.emit(socket, {action: "battleAttack", requestId, userId: game.user.id,
            sceneId: forecast.sourceToken.document.parent.id, sourceId: forecast.sourceToken.id,
            targetId: forecast.targetToken.id, weaponId: forecast.weapon.id, triangle: forecast.triangle,
            declared: forecast.declared ?? {}, makeshift: !!forecast.weapon.makeshift});
    });
}

export function registerBattleForecast() {
    registerCombatPresentation();
    // A running Foundry server caches system.json. Load the new CSS without needing a server restart.
    if (!document.getElementById("feue-battle-styles")) {
        const link = document.createElement("link");
        link.id = "feue-battle-styles";
        link.rel = "stylesheet";
        link.href = new URL("../../styles/battle-forecast.css", import.meta.url).href;
        document.head.append(link);
    }
    if (!document.getElementById("feue-combat-text-styles")) {
        const link = document.createElement("link");
        link.id = "feue-combat-text-styles";
        link.rel = "stylesheet";
        link.href = new URL("../../styles/combat-presentation.css", import.meta.url).href;
        document.head.append(link);
    }
    Hooks.once("ready", () => game.socket.on(socket, async payload => {
        if (payload?.action === "battleAttackResult" && payload.userId === game.user.id) {
            const request = pending.get(payload.requestId);
            if (!request) return;
            clearTimeout(request.timer); pending.delete(payload.requestId);
            return payload.error ? request.reject(Error(payload.error)) : request.resolve();
        }
        if (payload?.action !== "battleAttack" || game.users.activeGM?.id !== game.user.id) return;
        if (!payload.requestId || handled.has(payload.requestId)) return;
        handled.add(payload.requestId);
        if (handled.size > 500) handled.delete(handled.values().next().value);
        try {
            const user = game.users.get(payload.userId), scene = game.scenes.get(payload.sceneId);
            const source = scene?.tokens.get(payload.sourceId)?.object, target = scene?.tokens.get(payload.targetId)?.object;
            let weapon = source?.actor?.items.get(payload.weaponId);
            if (payload.makeshift) weapon = makeshiftWeapon(source?.actor, weapon);
            if (!user?.active || !source?.actor?.testUserPermission(user, "OWNER") || !weapon || weapon.type !== "weapon" ||
                source === target || !target?.actor || target.document.hidden && !user.isGM ||
                unavailableUnit(source) || unavailableUnit(target)) throw Error("This battle is no longer available.");
            const grid = canvas.grid?.getOffset ? canvas.grid : canvas.grid?.grid;
            if (scene.id !== canvas.scene?.id || !tokenInItemRange(source, target, weapon, grid)) throw Error("The target is outside weapon range.");
            const allowed = new Set(battleDeclarations(source.actor, weapon, {sourceToken: source, targetToken: target, grid}).map(option => option.key));
            const declared = Object.fromEntries(Object.entries(payload.declared ?? {}).filter(([key, on]) => allowed.has(key) && on === true));
            const forecast = createBattleForecast({actor: source.actor, weapon, target: target.actor, sourceToken: source, targetToken: target, grid,
                triangle: forecastTriangle(payload.triangle), declared});
            await withUnitActionLock(() => source.actor.sheet._executeAttack(weapon, forecast.triangle, {forecast, userId: user.id}));
            game.socket.emit(socket, {action: "battleAttackResult", requestId: payload.requestId, userId: user.id});
        } catch (error) {
            game.socket.emit(socket, {action: "battleAttackResult", requestId: payload.requestId, userId: payload.userId, error: error.message});
        }
    }));
}
