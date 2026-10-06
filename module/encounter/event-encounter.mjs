import {SYSTEM_ID} from "../map/terrain.mjs";
import {eventFlags, unavailableUnit, objectiveInteractionReason, tokenCells, tileCells, footprintDistance} from "./event-rules.mjs";
import {objectiveScene, objectiveTileIds, escapeUnitIds, allegianceOf, evaluateObjective} from "./encounter-rules.mjs";
import {checkEncounterObjective} from "./tactical-encounter.mjs";
import {reinforcementDue, reinforcementPositions} from "./reinforcement-rules.mjs";
import {nativeCellPath} from "../map/tactical-movement.mjs";
import {esc} from "../map/terrain-ui.mjs";

const activeGM = () => game.users.activeGM?.id === game.user.id;
const saved = result => { if (!result) throw Error("The encounter update was rejected."); return result; };

export async function seizeTile(source, tile, combat) {
    const reason = objectiveInteractionReason(source, tile, "seize", combat);
    if (reason) throw Error(reason);
    const ids = new Set(eventFlags(combat).eventProgress?.seized ?? []);
    ids.add(tile.id);
    await saved(await combat.update({[`flags.${SYSTEM_ID}.eventProgress.seized`]: [...ids]}));
    await checkEncounterObjective(combat);
}

/** Remember new requirements so deleting a Tile or participant never grants victory. */
export async function captureEventRequirements(combat, extraUnit = null) {
    const objective = eventFlags(combat).objective;
    if (!["seize", "escape"].includes(objective?.type)) return;
    const data = {}, tiles = objectiveTileIds(combat, objective.type);
    if (JSON.stringify(tiles) !== JSON.stringify(objective.tiles)) data[`flags.${SYSTEM_ID}.objective.tiles`] = tiles;
    if (objective.type === "escape" && objective.escapeMode !== "selected") {
        const ids = new Set(escapeUnitIds(combat));
        if (extraUnit && allegianceOf(extraUnit, combat).id === (objective.allegiance || "player")) ids.add(extraUnit.id);
        if (JSON.stringify([...ids]) !== JSON.stringify(objective.escapeUnits)) data[`flags.${SYSTEM_ID}.objective.escapeUnits`] = [...ids];
    }
    if (Object.keys(data).length) await saved(await combat.update(data, {turnEvents: false}));
}

export async function escapeUnit(source, tile, combat, services, arrival = source) {
    if (unavailableUnit(source)) throw Error("This unit has already escaped or is being carried.");
    const reason = objectiveInteractionReason(source, tile, "escape", combat);
    if (reason) throw Error(reason);
    if (eventFlags(tile).solid || footprintDistance(tokenCells(source, services.interactionGrid(source.parent), arrival), tileCells(tile, services.interactionGrid(source.parent))) !== 0) throw Error("Stand on a non-solid Escape Tile.");
    const carried = source.parent.tokens.get(eventFlags(source).rescuedTokenId);
    const tokens = [source];
    if (carried && eventFlags(carried).rescuedBy === source.id) tokens.push(carried);
    const before = tokens.map(token => ({_id: token.id, x: token.x, y: token.y, elevation: token.elevation, hidden: token.hidden,
        [`flags.${SYSTEM_ID}.escapedCombat`]: eventFlags(token).escapedCombat ?? null,
        [`flags.${SYSTEM_ID}.escapedTile`]: eventFlags(token).escapedTile ?? null,
        [`flags.${SYSTEM_ID}.escapeWasHidden`]: eventFlags(token).escapeWasHidden ?? null,
        [`flags.${SYSTEM_ID}.rescueWasHidden`]: eventFlags(token).rescueWasHidden ?? null,
        [`flags.${SYSTEM_ID}.rescuedBy`]: eventFlags(token).rescuedBy ?? null,
        [`flags.${SYSTEM_ID}.rescuedTokenId`]: eventFlags(token).rescuedTokenId ?? null}));
    const changes = tokens.map(token => ({_id: token.id, x: arrival.x, y: arrival.y, elevation: source.elevation, hidden: true,
        [`flags.${SYSTEM_ID}.escapedCombat`]: combat.id, [`flags.${SYSTEM_ID}.escapedTile`]: tile.id,
        [`flags.${SYSTEM_ID}.escapeWasHidden`]: token === carried ? !!eventFlags(token).rescueWasHidden : !!token.hidden,
        [`flags.${SYSTEM_ID}.rescuedBy`]: null, [`flags.${SYSTEM_ID}.rescuedTokenId`]: null, [`flags.${SYSTEM_ID}.rescueWasHidden`]: null}));
    const escaped = new Set(eventFlags(combat).eventProgress?.escaped ?? []);
    const wasRescuing = !!source.actor.system.rescue?.active;
    for (const unit of combat.combatants ?? []) if (tokens.some(token => unit.tokenId === token.id && (!unit.sceneId || unit.sceneId === source.parent.id))) escaped.add(unit.id);
    try {
        await services.updateTokens(source.parent, changes);
        if (carried) await services.clearRescuePenalty(source);
        await saved(await combat.update({[`flags.${SYSTEM_ID}.eventProgress.escaped`]: [...escaped]}));
    } catch (error) {
        await services.updateTokens(source.parent, before);
        if (carried) await source.actor.update({"system.rescue.active": wasRescuing}, {feueInteraction: true});
        throw error;
    }
    combat.setupTurns?.();
    await checkEncounterObjective(combat);
    return tokens;
}

export async function scanEscapeTiles(scene, combat, services, arrivals = new Map()) {
    if (!combat?.started || eventFlags(combat).objective?.type !== "escape" || evaluateObjective(combat).complete) return;
    const grid = services.interactionGrid(scene), exits = new Set(objectiveTileIds(combat, "escape"));
    const tiles = Array.from(scene.tiles ?? []).filter(tile => exits.has(tile.id) && eventFlags(tile).interactable &&
        eventFlags(tile).interactionType === "escape" && !eventFlags(tile).solid && !tile.hidden);
    for (const source of scene.tokens) {
        if (source.actor?.type !== "character" || source.hidden || unavailableUnit(source) || evaluateObjective(combat).complete) continue;
        let tile, arrival;
        for (const point of [...(arrivals.get(source.id) ?? []), source]) {
            tile = tiles.find(tile => !objectiveInteractionReason(source, tile, "escape", combat) &&
                footprintDistance(tokenCells(source, grid, point), tileCells(tile, grid)) === 0);
            if (tile) { arrival = point; break; }
        }
        if (!tile) continue;
        const tokens = await escapeUnit(source, tile, combat, services, arrival);
        try { await ChatMessage.create({speaker: ChatMessage.getSpeaker({actor: source.actor, token: source}),
            content: `<p><b>${tokens.map(t => esc(t.name)).join(" and ")}</b> escaped through <b>${esc(eventFlags(tile).eventName || "Escape Tile")}</b>.</p>`}); }
        catch (error) { console.error("FEUE | Escape completed but chat failed", error); }
        const context = {action: "escape", actor: source.actor, token: source.object ?? source, source, target: tile, scene, user: game.user};
        Hooks.callAll("feueInteraction", context);
        const macroId = eventFlags(tile).eventMacro;
        if (macroId && eventFlags(scene).eventMacros?.Tile?.[tile.id] === macroId) {
            try { await game.macros.get(macroId)?.execute(context); }
            catch (error) { console.error("FEUE | Escape macro failed", error); ui.notifications.error("Escape completed, but its event macro failed. See the console."); }
        }
    }
}

export async function restoreEscapedUnits(combat, services) {
    for (const scene of game.scenes ?? []) {
        const changes = Array.from(scene.tokens).filter(token => eventFlags(token).escapedCombat === combat.id).map(token =>
            ({_id: token.id, hidden: !!eventFlags(token).escapeWasHidden, [`flags.${SYSTEM_ID}.escapedCombat`]: null,
                [`flags.${SYSTEM_ID}.escapedTile`]: null, [`flags.${SYSTEM_ID}.escapeWasHidden`]: null}));
        if (changes.length) await services.updateTokens(scene, changes);
    }
}

export async function resetEventEncounter(combat, services) {
    await restoreEscapedUnits(combat, services);
    const objective = eventFlags(combat).objective ?? {}, scene = objectiveScene(combat);
    const data = {[`flags.${SYSTEM_ID}.eventProgress`]: {seized: [], escaped: []}, [`flags.${SYSTEM_ID}.reinforcementHistory`]: null};
    if (["seize", "escape"].includes(objective.type)) {
        data[`flags.${SYSTEM_ID}.objective.tiles`] = Array.from(scene?.tiles ?? []).filter(tile => eventFlags(tile).interactable && eventFlags(tile).interactionType === objective.type).map(tile => tile.id);
        if (objective.type === "escape") data[`flags.${SYSTEM_ID}.objective.escapeUnits`] = escapeUnitIds(combat, {...objective, escapeUnits: []});
    }
    await saved(await combat.update(data, {turnEvents: false, feueEventReset: true}));
}

/** One active GM and persisted per-round claims prevent duplicate waves after hooks, reloads, or rewinds. */
export async function runReinforcements(combat, services) {
    const scene = objectiveScene(combat), round = combat.round;
    if (!scene || !combat.started || evaluateObjective(combat).complete) return [];
    const grid = services.interactionGrid(scene), spawned = [];
    for (const tile of scene.tiles ?? []) {
        if (!reinforcementDue(tile, round) || eventFlags(combat).reinforcementHistory?.[tile.id]?.[round]) continue;
        const historyKey = `flags.${SYSTEM_ID}.reinforcementHistory.${tile.id}.${round}`;
        await saved(await combat.update({[historyKey]: {status: "processing", tokenIds: []}}, {turnEvents: false}));
        const flags = eventFlags(tile), actor = game.actors.get(flags.reinforcementActor);
        let created = [], combatants = [];
        try {
            if (actor?.type !== "character") throw Error("Choose an existing character Actor for the reinforcement type.");
            const elevation = Number(tile.elevation ?? 0);
            const template = await actor.getTokenDocument({actorLink: false, hidden: false, elevation}, {parent: scene});
            const prototype = {width: template.width, height: template.height, elevation, actor, flags: template.flags};
            const count = Math.max(1, Math.min(99, Math.trunc(Number(flags.reinforcementCount ?? 1) || 1)));
            const positions = reinforcementPositions(tile, prototype, scene, grid, count);
            if (!positions.length) {
                await saved(await combat.update({[historyKey]: {status: "blocked", tokenIds: []}}, {turnEvents: false}));
                continue;
            }
            const data = positions.map(point => {
                const data = template.toObject();
                delete data._id; delete data._movementHistory;
                data.x = point.x; data.y = point.y; data.actorLink = false; data.hidden = false; data.elevation = elevation;
                const tokenFlags = data.flags ??= {}; const system = tokenFlags[SYSTEM_ID] ??= {};
                for (const key of ["rescuedBy", "rescuedTokenId", "rescueWasHidden", "escapedCombat", "escapedTile", "escapeWasHidden"]) delete system[key];
                if (flags.reinforcementAllegiance) system.allegiance = flags.reinforcementAllegiance;
                system.reinforcementOrigin = {combatId: combat.id, tileId: tile.id, round};
                data.delta ??= {}; data.delta.system ??= {}; data.delta.system.rescue = {active: false};
                const hp = Number(actor.system.attributes?.hp?.max);
                if (hp > 0) { data.delta.system.attributes ??= {}; data.delta.system.attributes.hp = {value: hp}; }
                return data;
            });
            const anchorId = combat.combatant?.id;
            created = await scene.createEmbeddedDocuments("Token", data, {feueReinforcement: true});
            if (created.length !== data.length) throw Error("A reinforcement token creation was rejected.");
            combatants = await combat.createEmbeddedDocuments("Combatant", created.map(token => ({tokenId: token.id, sceneId: scene.id,
                actorId: actor.id, flags: {[SYSTEM_ID]: {allegiance: flags.reinforcementAllegiance || ""}}})), {turnEvents: false, feueReinforcement: true});
            if (combatants.length !== created.length) throw Error("A reinforcement combatant creation was rejected.");
            combat.setupTurns?.();
            const index = anchorId ? combat.turns?.findIndex(unit => unit.id === anchorId) : -1;
            if (index >= 0 && index !== combat.turn) await combat.update({turn: index}, {turnEvents: false});
            await saved(await combat.update({[historyKey]: {status: "spawned", tokenIds: created.map(token => token.id)}}, {turnEvents: false}));
            await captureEventRequirements(combat);
            spawned.push(...created);
            try { await ChatMessage.create({content: `<p><b>${esc(flags.eventName || "Reinforcements")}</b>: ${created.length} ${esc(actor.name)} unit(s) arrived on round ${round}${positions.length < count ? `; ${count - positions.length} lacked a legal adjacent space` : ""}.</p>`}); }
            catch (error) { console.error("FEUE | Reinforcements spawned but chat failed", error); }
        } catch (error) {
            if (combatants.length) await combat.deleteEmbeddedDocuments("Combatant", combatants.map(c => c.id), {turnEvents: false, feueReinforcement: true});
            if (created.length) await scene.deleteEmbeddedDocuments("Token", created.map(t => t.id), {feueReinforcement: true});
            await combat.update({[historyKey]: {status: "failed", tokenIds: [], error: error.message}}, {turnEvents: false});
            console.error("FEUE | Reinforcement wave failed", error);
            ui.notifications.error(`Reinforcements: ${error.message}`);
        }
    }
    return spawned;
}

export function registerEventEncounter(services) {
    const schedule = (scene, operation) => { if (activeGM() && scene?.tokens && scene?.tiles) void services.enqueue(scene.id, operation).catch(error => console.error("FEUE | Event encounter failed", error)); };
    const combatFor = scene => services.sceneCombat(scene);
    Hooks.on("combatStart", combat => { if (!combat._feueEventStartPrepared) schedule(objectiveScene(combat), () => resetEventEncounter(combat, services)); });
    Hooks.on("updateCombat", (combat, changed, options) => {
        const scene = objectiveScene(combat);
        if (!scene || options?.feueEventReset) return;
        if ("round" in changed) schedule(scene, async () => { await runReinforcements(combat, services); await scanEscapeTiles(scene, combat, services); });
        else if (changed.flags?.[SYSTEM_ID]?.objective || `flags.${SYSTEM_ID}.objective` in changed) schedule(scene, () => scanEscapeTiles(scene, combat, services));
    });
    for (const hook of ["updateToken", "createToken", "updateTile", "createTile"]) Hooks.on(hook, (doc, changed, options = {}) => {
        if (options.feueInteraction || options.feueReinforcement || hook.startsWith("create") && (changed?.feueInteraction || changed?.feueReinforcement)) return;
        schedule(doc.parent, async () => {
            const combat = combatFor(doc.parent);
            if (hook.endsWith("Tile") && combat) { await captureEventRequirements(combat); await runReinforcements(combat, services); }
            const arrivals = new Map(), movement = options._movement?.[doc.id];
            if (hook === "updateToken" && movement?.passed?.waypoints?.length && eventFlags(combat).objective?.type === "escape") {
                const grid = services.interactionGrid(doc.parent);
                const cells = nativeCellPath(doc, [movement.origin, ...movement.passed.waypoints], grid);
                arrivals.set(doc.id, cells.filter(cell => !cell.displaced).map(cell => grid.getTopLeftPoint(cell)));
            }
            await scanEscapeTiles(doc.parent, combat, services, arrivals);
            if (combat) await checkEncounterObjective(combat);
        });
    });
    Hooks.on("deleteTile", tile => { const combat = combatFor(tile.parent); if (combat) void checkEncounterObjective(combat); });
    for (const hook of ["createCombatant", "updateCombatant", "deleteCombatant"]) Hooks.on(hook, (unit, changed, options = {}) => {
        if (options.feueReinforcement || hook !== "updateCombatant" && changed?.feueReinforcement) return;
        const combat = unit.parent;
        schedule(objectiveScene(combat), async () => { await captureEventRequirements(combat, unit); await checkEncounterObjective(combat); });
    });
    Hooks.on("deleteCombat", combat => schedule(objectiveScene(combat), () => restoreEscapedUnits(combat, services)));
    Hooks.once("ready", () => {
        Object.assign(game.firesOfWar ??= {}, {_prepareEventEncounter: combat => {
            const scene = objectiveScene(combat);
            return activeGM() && scene ? services.enqueue(scene.id, () => resetEventEncounter(combat, services)) : Promise.resolve();
        }});
        for (const combat of game.combats ?? []) schedule(objectiveScene(combat), async () => {
            await captureEventRequirements(combat);
            await runReinforcements(combat, services); await scanEscapeTiles(objectiveScene(combat), combat, services);
        });
    });
}
