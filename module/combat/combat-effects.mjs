import {hasSkill, triggerSkills, isMagicWeapon, weaponKey} from "../skills/skill-automation.mjs";
import {unitsWithin, tokenDocument, currentPhase} from "../skills/skill-context.mjs";
import {unitCombatant} from "../units/unit-actions.mjs";
import {createMovementContext} from "../map/tactical-movement.mjs";
import {statusImmune, ignoresStatPenalties, ignoresMoveReduction, statusRule, statusKey, RANDOM_STATUSES, STATUS_RULES} from "../rules/status-rules.mjs";
import {defeatEnemyTokens} from "./combat-presentation.mjs";
import {pendingRevival, hasKnockedOut} from "../rules/alt-rules.mjs";
import {fateNegation, canForceDismount, forcedDismount} from "../rules/fall-rules.mjs";

const SYSTEM = "fires-of-war";
const hp = actor => Number(actor?.system?.attributes?.hp?.value) || 0;
const maxHP = actor => Number(actor?.system?.attributes?.hp?.max) || 0;
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));
const automaticDamage = () => !!globalThis.game?.settings?.get("fires-of-war", "automaticCombatDamage");
/** Healing never revives the slain; a Knocked Out unit can be healed and wakes after one turn. */
export async function healActor(actor, amount) {
    const knockedOut = hp(actor) <= 0 && hasKnockedOut(actor) && !actor?.statuses?.has?.("dead");
    if (!actor || hp(actor) <= 0 && !knockedOut) return 0;
    const healed = Math.max(0, Math.min(maxHP(actor) - hp(actor), Math.floor(amount)));
    if (healed) await actor.update({"system.attributes.hp.value": hp(actor) + healed,
        ...(knockedOut ? {"system.statusEffects": (actor.system.statusEffects ?? []).map(effect =>
            String(effect?.name ?? effect).trim().toLowerCase() === "knocked out" ? {...effect, duration: 1} : effect)} : {})});
    return healed;
}

/** Battalions take half the HP damage their commander takes (rounded down, minimum 1). */
export async function damageBattalions(actor, damage) {
    if (!(damage > 0)) return;
    const loss = Math.max(1, Math.floor(damage / 2));
    for (const item of Array.from(actor?.items ?? []).filter(i => i.type === "battalion" && Number(i.system?.endurance?.max) > 0 && Number(i.system.endurance.value) > 0)) {
        await item.update?.({"system.endurance.value": Math.max(0, Number(item.system.endurance.value) - loss)});
    }
}

/** Penalties a unit ignores are dropped before an effect is stored (Goddess, Headlong Rush, Ultra Heavyweight). */
function acceptedAttributes(actor, attributes = {}) {
    return Object.fromEntries(Object.entries(attributes).filter(([key, value]) => !(value < 0 && (ignoresStatPenalties(actor) || key === "move" && ignoresMoveReduction(actor)))));
}

/** Add or refresh a timed effect. Returns false when the unit is immune. */
export async function addTimedEffect(actor, effect, {stack = false, cap = Infinity} = {}) {
    if (!actor || statusImmune(actor, effect.name)) return false;
    const attributes = acceptedAttributes(actor, effect.attributes);
    if (effect.attributes && Object.keys(effect.attributes).length && !Object.keys(attributes).length && !statusRule(effect) && !effect.combat) return false;
    const statuses = structuredClone(actor.system.statusEffects ?? []);
    const current = statuses.find(s => effect.automationKey ? s.automationKey === effect.automationKey : statusKey(s) === statusKey(effect));
    if (current) {
        current.attributes ??= {};
        for (const [key, value] of Object.entries(attributes)) current.attributes[key] = stack ? Math.max(-cap, (current.attributes[key] ?? 0) + value) : value;
        current.duration = effect.duration;
        if (effect.combat) current.combat = effect.combat;
        if (effect.expires) current.expires = effect.expires;
    } else statuses.push({...effect, attributes});
    await actor.update({"system.statusEffects": statuses});
    return true;
}

/** Apply a rulebook status with its default duration, honouring immunities. */
export async function inflictStatus(actor, name, duration) {
    const rule = STATUS_RULES[statusKey(name)];
    return addTimedEffect(actor, {name, automationKey: `status-${statusKey(name)}`, duration: duration ?? rule?.duration ?? 1,
        ...(rule?.expiresAtPhaseStart ? {expires: "phaseStart"} : {})});
}
export async function removeStatuses(actor, predicate) {
    const statuses = actor?.system?.statusEffects ?? [];
    const remaining = statuses.filter(effect => !predicate(effect));
    if (remaining.length !== statuses.length) await actor.update({"system.statusEffects": remaining});
    return statuses.length - remaining.length;
}

const liveEffect = effect => effect?.duration === -1 || Number(effect?.duration) > 0;
/** Timed stat changes (Rally, Seal, Crippling, Bloodlust...) with one tooltip term per effect. */
export function timedEffectTerms(actor) {
    const terms = [];
    for (const effect of actor?.system?.statusEffects ?? []) if (liveEffect(effect)) {
        for (const [key, value] of Object.entries(acceptedAttributes(actor, effect.attributes ?? {}))) if (Number(value)) terms.push({path: key === "move" ? "movement" : `attributes.${key}`, key, label: effect.name, value: Number(value)});
        for (const [key, value] of Object.entries(effect.combat ?? {})) if (Number(value)) terms.push({path: `effects.${key}`, key, label: effect.name, value: Number(value)});
    }
    return terms;
}
export function timedEffectBonuses(actor) {
    const result = {};
    for (const t of timedEffectTerms(actor)) if (!t.path.startsWith("effects.")) result[t.key] = (result[t.key] ?? 0) + t.value;
    return result;
}
export function timedCombatBonuses(actor) {
    const result = {};
    for (const t of timedEffectTerms(actor)) if (t.path.startsWith("effects.")) result[t.key] = (result[t.key] ?? 0) + t.value;
    return result;
}

/** Move a token with the GM's movement-rule bypass (forced movement, swaps and repositioning skills). */
export async function displaceTokens(changes) {
    const docs = changes.map(change => ({doc: tokenDocument(change.token), change})).filter(entry => entry.doc);
    if (!docs.length) return;
    const scene = docs[0].doc.parent;
    const movement = Object.fromEntries(docs.map(({doc, change}) => [doc.id, {method: "api", waypoints: [{x: change.x, y: change.y, elevation: doc.elevation ?? 0, action: "displace"}],
        constrainOptions: {ignoreWalls: true, ignoreCost: true}}]));
    if (scene?.updateEmbeddedDocuments) await scene.updateEmbeddedDocuments("Token", docs.map(({doc, change}) => ({_id: doc.id, x: change.x, y: change.y})), {feueInteraction: true, animate: false, movement});
    else for (const {doc, change} of docs) await doc.update({x: change.x, y: change.y}, {feueInteraction: true, movement});
}

async function pushTarget(sourceToken, targetToken, squares) {
    if (!sourceToken || !targetToken || !globalThis.canvas?.ready) return 0;
    if ((sourceToken.document ?? sourceToken).parent?.id !== canvas.scene?.id) return 0;
    const target = targetToken.object ?? targetToken, source = sourceToken.object ?? sourceToken;
    if (!target.document || !source.document || hasSkill(target.actor, "ultra heavyweight")) return 0;
    const grid = canvas.grid?.getOffset ? canvas.grid : canvas.grid.grid;
    if (!grid.isSquare) return 0;
    let moved = 0;
    for (let n = 0; n < squares; n++) {
        const context = createMovementContext(target, canvas, {combat: null});
        const a = grid.getOffset({x: source.document.x + 1, y: source.document.y + 1});
        const b = context.origin, di = b.i - a.i, dj = b.j - a.j;
        const next = {i: b.i + (Math.abs(di) >= Math.abs(dj) ? Math.sign(di) : 0), j: b.j + (Math.abs(di) < Math.abs(dj) ? Math.sign(dj) : 0)};
        if (!context.canOccupy(next, false) || !context.canTraverse(b, next)) break;
        const position = grid.getTopLeftPoint(next);
        await target.document.update(position, {feueInteraction: true, movement: {[target.id]: {method: "api", waypoints: [{...position, elevation: target.document.elevation, action: "displace"}], constrainOptions: {ignoreCost: true}}}});
        moved++;
    }
    return moved;
}

/** Party gold awards from Plunder: the GM updates the Party directly, players relay through the system socket. */
export async function awardPartyGold(actor, amount) {
    const id = actor?.token?.actorId ?? actor?.id;
    const party = Array.from(globalThis.game?.actors ?? []).find(a => a.type === "party" && (a.system?.memberIds ?? []).includes(id));
    if (!party) return null;
    if (game.user.isGM) await party.update({"system.gold": Number(party.system.gold || 0) + amount});
    else game.socket?.emit(`system.${SYSTEM}`, {action: "adjustGold", partyId: party.id, delta: amount, userId: game.user.id});
    return party;
}

/** Fixed damage to other units (Cleave, Grisly Wound, Spinning Axe). Returns chat notes. */
async function chipUnits(tokens, amount, label, {minimum = 0} = {}) {
    const notes = [];
    if (!automaticDamage()) return notes;
    for (const doc of tokens) {
        const actor = doc.actor, before = hp(actor), damage = Math.floor(typeof amount === "function" ? amount(actor) : amount);
        if (!actor || before <= 0 || damage <= 0) continue;
        const after = Math.max(Math.min(before, minimum), before - damage);
        if (after === before) continue;
        await actor.update({"system.attributes.hp.value": after});
        notes.push(`${label}: ${doc.name} −${before - after}`);
        await defeatEnemyTokens(actor, [doc]);
    }
    return notes;
}

/** Mantle, Undeath and Mighty King of Legend can turn a hit into 0 damage. */
async function damageImmunity(target, weapon, props, damage) {
    if (!target || damage <= 0) return "";
    const legendary = !!props.legendary || weaponKey(weapon) === "spell" && String(weapon?.system?.rank ?? "").toUpperCase() === "S";
    if (hasSkill(target, "mantle") && !legendary) return "Mantle";
    const darkMagic = weaponKey(weapon) === "dark" || weaponKey(weapon) === "spell" && /dark/i.test(String(weapon?.system?.school ?? ""));
    if (hasSkill(target, "undeath") && darkMagic) return "Undeath";
    if (hasSkill(target, "mighty king of legend")) {
        const round = globalThis.game?.combat?.started ? Number(game.combat.round) || 1 : 0;
        const key = `${globalThis.game?.combat?.id ?? "none"}:${round}`;
        if (target.flags?.[SYSTEM]?.mightyKing !== key) {
            await target.update({[`flags.${SYSTEM}.mightyKing`]: key});
            return "Mighty King of Legend";
        }
    }
    return "";
}

/** Resolve one hit in order: defensive skills, immunities, curse, damage, healing, status, displacement. */
export async function resolveWeaponEffects(sheet, stats, hit, crit, target, {weapon, sourceToken, targetToken, initiating = true, attackEffects = {}, beforeDamage} = {}) {
    const actor = sheet.actor, props = stats.props;
    const result = {finalDamage: 0, shadeNote: "", absorbNote: "", cursedNote: "", effectNote: "", backfire: false, killed: false};
    if (!hit) return result;
    const context = {weapon, target: actor, initiating: !initiating, token: targetToken};
    const defense = target ? await triggerSkills(target, "Defense", context, (item, tn) => target.sheet._rollSkillActivation(item, {targetOverride: tn, silent: true})) : {damageMultiplier: 1, damageReduction: 0, notes: []};
    const activations = defense.notes.map(name => ({actor: target, name}));
    const notes = [];
    let damage = props.shade && target ? hp(target) - (hp(target) <= 1 ? 0 : Math.max(1, Math.floor(hp(target) / 2))) :
        Math.floor(Math.max(props.deadly ? 1 : 0, stats.netDmg * (crit ? 3 : 1)) * (attackEffects.damageMultiplier ?? 1) * (stats.damageMultiplier ?? 1));
    if (!props.shade) {
        damage = Math.max(0, damage + Number(stats.damageAdjust || 0) - Number(defense.damageReduction || 0));
        damage = Math.floor(damage * (defense.damageMultiplier ?? 1) * (stats.takenMultiplier ?? 1));
    }
    if (crit && damage > 0 && target) {
        const lethal = await triggerSkills(actor, "Critical", {weapon, target, initiating, token: sourceToken}, (item, tn) => sheet._rollSkillActivation(item, {targetOverride: tn, silent: true}));
        activations.push(...lethal.notes.map(name => ({actor, name})));
        if (lethal.lethal) damage = hp(target);
    }
    const immunity = await damageImmunity(target, weapon, props, damage);
    if (immunity) { damage = 0; notes.push(`${immunity}: no damage`); }
    if (props.cursed) {
        const threshold = Math.max(0, 31 - Number(actor.system.attributes?.luck?.value || 0));
        const roll = await new Roll("1d100").evaluate();
        result.backfire = roll.total <= threshold;
        result.cursedNote = `<p><b>Cursed:</b> ${roll.total} / ${threshold} — ${result.backfire ? "damage redirected to wielder" : "resisted"}</p>`;
    }
    const recipient = result.backfire ? actor : target;
    const before = hp(recipient);
    const automatic = automaticDamage();
    if (recipient && damage >= before && before > 1) {
        const miracle = await triggerSkills(recipient, "Lethal", {weapon, target: actor, initiating: !initiating, token: result.backfire ? sourceToken : targetToken}, (item, tn) => recipient.sheet._rollSkillActivation(item, {targetOverride: tn, silent: true}));
        activations.push(...miracle.notes.map(name => ({actor: recipient, name})));
        if (miracle.notes.length) damage = before - 1;
    }
    await beforeDamage?.(activations);
    const updateOptions = beforeDamage ? {feueCombatPresentation: true} : {};
    if (recipient && (automatic || result.backfire || props.shade)) {
        const fate = await fateNegation(recipient, damage, before);
        if (fate) { damage = 0; notes.push(fate); }
        let after = Math.max(0, before - damage);
        // Quintessence: the first fall in an encounter resets HP to full from the second bar.
        const encounter = globalThis.game?.combat?.id ?? "none";
        if (after === 0 && before > 0 && hasSkill(recipient, "quintessence") && recipient.flags?.[SYSTEM]?.quintessence !== encounter) {
            after = maxHP(recipient);
            await recipient.update({[`flags.${SYSTEM}.quintessence`]: encounter}, updateOptions);
            notes.push(`Quintessence: ${recipient.name} rises again`);
        }
        // Replaceable Mounts: a mounted unit is thrown from its mount instead of falling.
        if (after === 0 && before > 0 && canForceDismount(recipient)) {
            const fall = await forcedDismount(recipient, updateOptions);
            after = fall.hp;
            notes.push(fall.note);
        }
        await recipient.update({"system.attributes.hp.value": after}, updateOptions);
        if (damage > 0) await removeStatuses(recipient, effect => statusRule(effect)?.wakeOnDamage);
        if (before - after > 0) await damageBattalions(recipient, before - after);
    }
    result.damageTaken = damage;
    result.finalDamage = result.backfire ? 0 : damage;
    // A unit with a Revival Stone left is not killed; it revives when the combat ends.
    result.killed = !!target && !result.backfire && before > 0 && hp(target) === 0 && !pendingRevival(target);
    if (props.shade && !result.backfire && target) result.shadeNote = `<p><b>Shade:</b> ${esc(target.name)} HP ${before} → ${hp(target)}</p>`;
    const dealt = target ? Math.min(before, damage) : damage;
    if (!result.backfire && dealt > 0 && !props.shade && (props.absorb || attackEffects.healingFraction)) {
        const amount = props.absorb ? dealt : Math.max(1, Math.floor(dealt * attackEffects.healingFraction));
        if (target && hasSkill(target, "undeath") && (props.absorb || attackEffects.absorb)) {
            await actor.update({"system.attributes.hp.value": Math.max(0, hp(actor) - amount)}, updateOptions);
            result.absorbNote = `<p><b>Undeath:</b> ${esc(actor.name)} takes ${amount} damage instead of healing</p>`;
        } else {
            const healed = await healActor(actor, amount);
            result.absorbNote = `<p><b>${props.absorb ? "Absorb" : "Sol"}:</b> heals ${healed} HP</p>`;
        }
    }
    notes.push(...activations.map(activation => activation.name));
    if (!result.backfire && target && hp(target) > 0) {
        for (const [property, name] of [["poison", "Poison"], ["petrify", "Petrification"]]) if (props[property]) {
            if (await addTimedEffect(target, {name, automationKey: property, duration: 3, attributes: {}})) notes.push(`${name} (3 turns)`);
            else notes.push(`${target.name} is immune to ${name}`);
        }
        if (props.crippling && dealt > 0) {
            const cap = {E: 1, D: 2, Prf: 2, C: 3, B: 4, A: 6, S: 10}[weapon?.system?.rank] ?? 1;
            const attributes = {strength: -1, defense: -1};
            if (hasSkill(actor, "crippling knife") && weaponKey(weapon) === "knife") Object.assign(attributes, {skill: -1, speed: -1});
            if (await addTimedEffect(target, {name: "Crippling", automationKey: "crippling", duration: 1, attributes}, {stack: true, cap})) notes.push(`Crippling (up to −${cap}, 1 turn)`);
        }
        for (const name of attackEffects.inflict ?? []) {
            const status = name === "random" ? RANDOM_STATUSES[(await new Roll("1d4").evaluate()).total - 1] ?? RANDOM_STATUSES[0] : name;
            notes.push(await inflictStatus(target, status) ? `${status} inflicted` : `${target.name} is immune to ${status}`);
        }
        if (dealt > 0) {
            const onHit = await triggerSkills(actor, "Hit", {weapon, target, initiating, token: sourceToken}, (item, tn) => sheet._rollSkillActivation(item, {targetOverride: tn, silent: true}));
            for (const seal of onHit.seals) {
                const value = seal.key === "move" ? -3 : -6;
                if (await addTimedEffect(target, {name: seal.name, automationKey: `seal-${seal.key}`, duration: 3, recover: seal.key === "move" ? 1 : 2, attributes: {[seal.key]: value}})) notes.push(seal.name);
            }
            if (onHit.halveResistance) {
                const res = Number(target.system.attributes?.resistance?.value) || 0;
                if (await addTimedEffect(target, {name: "Soul Rend", automationKey: "soul-rend", duration: 1, attributes: {resistance: -(res - Math.floor(res / 2))}})) notes.push(`Soul Rend: RES halved`);
            }
            if (onHit.gold) {
                const party = await awardPartyGold(actor, onHit.gold);
                notes.push(`Plunder: +${onHit.gold} gold${party ? ` → ${party.name}` : ""}`);
            }
        }
        if (dealt > 0 && (props.smash || weaponKey(weapon) === "axe" && hasSkill(actor, "axe slam"))) {
            const pushed = await pushTarget(sourceToken, targetToken, Number(!!props.smash) + Number(weaponKey(weapon) === "axe" && hasSkill(actor, "axe slam")));
            notes.push(hasSkill(target, "ultra heavyweight") ? "Smash: Ultra Heavyweight resists" : `Smash: pushed ${pushed} square(s)`);
        }
        const magic = isMagicWeapon(weapon) || props.magical;
        const counter = magic ? "magic counter" : "counter";
        if (dealt > 0 && damage < before && hasSkill(target, counter) && sourceToken && targetToken) {
            const a = sourceToken.document ?? sourceToken, b = targetToken.document ?? targetToken, size = a.parent?.grid?.size ?? 100;
            const distance = (Math.abs(a.x - b.x) + Math.abs(a.y - b.y)) / size;
            if (distance <= (magic ? 2 : 1)) {const reflected = Math.floor(dealt / 2); if (automatic) await actor.update({"system.attributes.hp.value": Math.max(0, hp(actor) - reflected)}, updateOptions); result.reflectedDamage = reflected; notes.push(`${counter}: ${reflected} reflected damage`);}
        }
    }
    if (!result.backfire && dealt > 0 && attackEffects.cleave && sourceToken) {
        const splash = unitsWithin(sourceToken, 1, {relation: "enemies"}).filter(doc => doc.id !== tokenDocument(targetToken)?.id);
        notes.push(...await chipUnits(splash, Math.floor(dealt / 2), "Cleave"));
    }
    result.effectNote = notes.length ? `<p><b>Effects:</b> ${notes.map(esc).join(" · ")}</p>` : "";
    return result;
}

/** After-combat skills: chip damage, kill rewards, Vendetta history and statuses that end once attacked. */
export async function finishCombatEffects(actor, target, results, {sourceToken, targetToken, initiating = true} = {}) {
    if (!target) return [];
    const notes = [];
    const hit = results.some(r => r.actor === actor && r.hit && !r.backfire);
    if (hit && hasSkill(actor, "poison strike") && hp(target) > 1 && automaticDamage()) {
        const after = Math.max(1, hp(target) - Math.floor(maxHP(target) * 0.2));
        if (after !== hp(target)) { await target.update({"system.attributes.hp.value": after}); notes.push(`Poison Strike: ${target.name} → ${after} HP`); }
    }
    if (hasSkill(actor, "grisly wound") && sourceToken && hp(actor) > 0) {
        const others = unitsWithin(sourceToken, 1, {relation: "enemies"}).filter(doc => doc.id !== tokenDocument(targetToken)?.id);
        notes.push(...await chipUnits(others, foe => maxHP(foe) * 0.2, "Grisly Wound", {minimum: 1}));
    }
    const killedWith = results.find(r => r.actor === actor && r.killed);
    if (hp(target) === 0 && killedWith) {
        if (initiating && hasSkill(actor, "lifetaker")) await healActor(actor, maxHP(actor) * 0.5);
        if (hasSkill(actor, "galeforce")) {
            const unit = unitCombatant(sourceToken);
            if (unit && !unit.flags?.["fires-of-war"]?.refreshed) {
                await unit.update({"flags.fires-of-war.acted": false, "flags.fires-of-war.majorAction": false, "flags.fires-of-war.attacked": false, "flags.fires-of-war.refreshed": true});
                await unit.clearMovementHistory?.();
            }
        }
        const ownPhase = sourceToken ? currentPhase(sourceToken) : null;
        if (hasSkill(actor, "bloodlust") && (ownPhase ? ownPhase === "own" : initiating)) {
            if (await addTimedEffect(actor, {name: "Bloodlust", automationKey: "bloodlust", duration: -1, expires: "phaseStart", attributes: {strength: 2, defense: 2}})) notes.push("Bloodlust: +2 STR/DEF");
        }
        if (hasSkill(actor, "spinning axe") && weaponKey(killedWith.weapon) === "axe" && sourceToken) {
            notes.push(...await chipUnits(unitsWithin(sourceToken, 1, {relation: "enemies"}), foe => maxHP(foe) * 0.1, "Spinning Axe"));
        }
    }
    if (initiating) {
        // Vendetta counts engagements for both participants, once per combat.
        for (const [token, other, unitActor] of [[sourceToken, targetToken, actor], [targetToken, sourceToken, target]]) {
            const unit = unitCombatant(token), otherId = tokenDocument(other)?.id;
            if (!unit || !otherId || !hasSkill(unitActor, "vendetta")) continue;
            await unit.update({[`flags.${SYSTEM}.vendetta.${otherId}`]: Number(unit.flags?.[SYSTEM]?.vendetta?.[otherId] ?? 0) + 1});
        }
        // Confusion and Guard Break end once the unit has been attacked.
        await removeStatuses(target, effect => statusRule(effect)?.endsWhenAttacked);
    }
    if (notes.length) await globalThis.ChatMessage?.create({speaker: ChatMessage.getSpeaker({actor}), content: `<p><b>Effects:</b> ${notes.map(esc).join(" · ")}</p>`});
    return notes;
}
