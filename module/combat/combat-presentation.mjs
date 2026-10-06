import {allegianceOf} from "../encounter/encounter-rules.mjs";
import {deathDeferred} from "../rules/alt-rules.mjs";

const SYSTEM = "fires-of-war", socket = `system.${SYSTEM}`;
export const COMBAT_TEXT_DURATION = {skill: 900, hit: 650, crit: 850, miss: 900, damage: 1100};
const docOf = token => token?.document ?? token;

/** Local, screen-sized text boxes that remain anchored while the map pans or zooms. */
export function displayCombatText({sceneId, tokenId, kind, text}) {
    const map = globalThis.canvas;
    const token = map?.scene?.id === sceneId ? map.tokens?.get(tokenId) : null;
    if (!map?.ready || !token?.visible || !globalThis.document || !COMBAT_TEXT_DURATION[kind]) return false;
    const element = document.createElement("div");
    element.className = `feue-combat-text ${kind}`;
    element.textContent = String(text).slice(0, 160);
    element.setAttribute("role", "status");
    element.style.setProperty("--feue-combat-duration", `${COMBAT_TEXT_DURATION[kind]}ms`);
    document.body.append(element);
    let frame, finished = false;
    const remove = () => {
        if (finished) return;
        finished = true;
        cancelAnimationFrame(frame);
        element.remove();
    };
    const position = () => {
        if (map.scene?.id !== sceneId || !map.ready || token.destroyed || !token.visible) return remove();
        const point = map.clientCoordinatesFromCanvas({x: token.center.x, y: token.document.y});
        element.style.left = `${point.x}px`;
        element.style.top = `${point.y - 12}px`;
        frame = requestAnimationFrame(position);
    };
    position();
    setTimeout(remove, COMBAT_TEXT_DURATION[kind]);
    return true;
}

/** Broadcast each beat separately; the resolving client controls the combat's pacing. */
export async function presentCombatText(token, kind, text) {
    const doc = docOf(token);
    if (!doc?.id || !doc.parent?.id || !globalThis.game?.socket || !COMBAT_TEXT_DURATION[kind]) return;
    const payload = {action: "combatText", senderId: game.user.id, sceneId: doc.parent.id, tokenId: doc.id, kind, text: String(text).slice(0, 160)};
    game.socket.emit(socket, payload);
    displayCombatText(payload);
    await new Promise(resolve => setTimeout(resolve, COMBAT_TEXT_DURATION[kind]));
}

export function enemyToken(token) {
    const doc = docOf(token);
    if (!doc) return false;
    const unit = Array.from(globalThis.game?.combat?.combatants ?? []).find(c => c.tokenId === doc.id &&
        (c.token?.parent?.id ?? c.parent?.scene?.id) === doc.parent?.id);
    const allegiance = unit ? allegianceOf(unit).id : doc.flags?.[SYSTEM]?.allegiance;
    return allegiance === "enemy" || Number(doc.disposition) === -1;
}

/** Apply Foundry's native Dead status and hidden state without ever toggling them off. */
export async function defeatEnemyTokens(actor, tokens) {
    const hp = actor?.system?.attributes?.hp?.value;
    if (!actor || actor.type !== "character" || hp === null || hp === undefined || !Number.isFinite(Number(hp)) || Number(hp) > 0) return;
    // Revival Stones, Forcibly Dismounted and Knocked Out (Capture/Subdue) units are not slain.
    if (deathDeferred(actor)) return;
    tokens ??= actor.isToken ? [actor.token] : actor.getDependentTokens?.({linked: true}) ?? [];
    const enemies = Array.from(tokens).filter(enemyToken);
    if (!enemies.length) return;
    await actor.toggleStatusEffect("dead", {active: true, overlay: true});
    for (const token of enemies) {
        const doc = docOf(token);
        if (!doc.hidden) await doc.update({hidden: true});
        for (const combat of globalThis.game?.combats ?? []) {
            for (const unit of combat.combatants ?? []) if (unit.tokenId === doc.id &&
                (unit.token?.parent?.id ?? combat.scene?.id) === doc.parent?.id && !unit.defeated) await unit.update({defeated: true});
        }
    }
}

export function registerCombatPresentation() {
    Hooks.once("ready", () => game.socket.on(socket, payload => {
        if (payload?.action !== "combatText" || payload.senderId === game.user.id) return;
        const sender = game.users.get(payload.senderId);
        const token = game.scenes.get(payload.sceneId)?.tokens.get(payload.tokenId);
        // A GM normally resolves combat; owner-only rolls without a GM are also supported.
        if (!sender?.active || !token || !(sender.isGM || !game.users.activeGM && token.actor?.testUserPermission(sender, "OWNER"))) return;
        displayCombatText(payload);
    }));
    Hooks.on("updateActor", (actor, changes, options = {}, userId) => {
        const value = changes["system.attributes.hp.value"] ?? changes.system?.attributes?.hp?.value;
        if (value === undefined || Number(value) > 0 || options.feueCombatPresentation) return;
        const authority = game.users.activeGM?.id ?? userId;
        if (game.user.id !== authority) return;
        void defeatEnemyTokens(actor).catch(error => {
            console.error("Fires of War enemy defeat failed", error);
            ui.notifications.error(`Could not mark ${actor.name} Dead: ${error.message}`);
        });
    });
}
