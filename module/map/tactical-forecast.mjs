import {cellKey} from "./tactical-grid.mjs";
import {createMovementContext, nativeCellPath} from "./tactical-movement.mjs";
import {unavailableUnit} from "../encounter/event-rules.mjs";
import {unitActionReason} from "../units/unit-actions.mjs";

/** Hover forecast, click-to-move planning, and native drag-path visualization. */
export class TacticalForecast {
    token = null;
    forecast = null;
    hud = null;
    tiles = null;
    arrow = null;
    stage = null;
    board = null;
    frame = null;
    routeFrame = null;
    destinationKey = null;
    pointer = null;
    hovered = null;
    planning = null;
    dragging = null;
    context = null;
    route = [];
    committing = false;

    constructor() {
        this.onPointerMove = event => {
            if (!this.context || this.dragging) return;
            this.pointer = event.getLocalPosition(canvas.stage);
            this.queueRoute();
        };
        this.onPointerLeave = () => {
            this.hovered = null;
            if (!this.dragging && !this.planning) this.refresh();
            else this.clearRoute();
        };
        this.onResize = () => this.positionHud();
        this.onKeyDown = event => {
            if (event.key !== "Escape" || !this.planning || this.dragging) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            this.cancelPlanning();
        };
        this.onPointerDown = event => {
            // PIXI installs a capture listener on the canvas before this system.
            // Intercept at window capture so its background click cannot release
            // the selected token and cancel planning before we commit the route.
            if (event.target !== this.board) return;
            if (!this.planning || this.dragging || this.committing) return;
            if (event.button === 2) {
                event.preventDefault();
                event.stopImmediatePropagation();
                this.cancelPlanning();
                return;
            }
            if (event.button !== 0) return;
            const rect = this.board.getBoundingClientRect();
            const screen = canvas.app.renderer.screen;
            const point = canvas.stage.toLocal(new PIXI.Point(
                (event.clientX - rect.left) * screen.width / rect.width,
                (event.clientY - rect.top) * screen.height / rect.height));
            const cell = this.grid.getOffset(point);
            // Clicking a token still selects it or begins Foundry's normal drag workflow.
            if (canvas.tokens.placeables.some(token => token.visible && !token.document.hidden &&
                point.x >= token.document.x && point.x < token.document.x + token.w &&
                point.y >= token.document.y && point.y < token.document.y + token.h)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            void this.commitDestination(cell);
        };
    }

    eligible(token) {
        return canvas.ready && token && !token.destroyed && token.actor?.type === "character" &&
            !unavailableUnit(token) && token.isOwner && (!token.document.hidden || game.user.isGM) && canvas.activeLayer === canvas.tokens;
    }

    hoverToken(token, hovered) {
        if (hovered) this.hovered = token;
        else if (this.hovered === token) this.hovered = null;
        this.queueRefresh();
    }

    beginPlanning(token) {
        if (!this.eligible(token) || !game.settings.get("fires-of-war", "tacticalForecast")) return;
        const reason = unitActionReason(token, {movement: true});
        if (reason) return ui.notifications.warn(reason);
        this.planning = token;
        this.refresh();
        token.renderFlags?.set({refreshRuler: true});
    }

    cancelPlanning() {
        this.planning = null;
        this.hovered = null;
        this.clear();
    }

    beginDrag(token) {
        this.planning = null;
        this.dragging = this.eligible(token) ? token : null;
        this.refresh();
    }

    endDrag(token) {
        if (this.dragging !== token) return;
        this.dragging = this.planning = this.hovered = null;
        this.clear();
    }

    queueRefresh() {
        if (this.frame !== null) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = null;
            this.refresh();
        });
    }

    get grid() {
        // v13 exposes BaseGrid directly; v12 keeps it inside the GridLayer.
        return canvas.grid?.getOffset ? canvas.grid : canvas.grid?.grid;
    }

    refresh() {
        const token = this.dragging ?? this.planning ?? this.hovered;
        if (!this.eligible(token) || !game.settings.get("fires-of-war", "tacticalForecast")) {
            this.clear();
            return;
        }
        if (this.token !== token) this.clearRoute();
        this.token = token;
        this.renderHud();
        this.clearGraphics();
        if (canvas.scene.grid.type !== CONST.GRID_TYPES.SQUARE) return;

        const grid = this.grid;
        this.context = createMovementContext(token, canvas, {combat: game.combat});
        // Outside an encounter there is no Move limit to show: only the planned route is drawn.
        this.forecast = this.context.unrestricted ? null : this.context.forecast;
        if (this.forecast) {
            const highlight = canvas.interface?.grid?.highlight ?? canvas.grid?.highlight;
            this.tiles = highlight.addChild(new PIXI.Graphics());
            this.tiles.eventMode = "none";
            this.tiles.zIndex = -1;
            const size = grid.size;
            const inset = Math.max(1, size * 0.025);
            for (const [cells, color, border] of [
                [this.forecast.attackCells, 0xe34d46, 0xffb39b],
                [this.forecast.movementCells, 0x368de8, 0xa9e8ff]
            ]) {
                this.tiles.lineStyle(Math.max(1, size * 0.018), border, 0.75);
                this.tiles.beginFill(color, 0.38);
                for (const cell of cells.values()) {
                    const {x, y} = grid.getTopLeftPoint(cell);
                    this.tiles.drawRect(x + inset, y + inset, size - inset * 2, size - inset * 2);
                }
                this.tiles.endFill();
            }
        }
        this.arrow = canvas.interface.addChild(new PIXI.Graphics());
        this.arrow.eventMode = "none";
        this.arrow.zIndex = 1000;
        this.attachPointer();
        this.destinationKey = null;
        if (this.dragging) this.syncDrag();
        else if (this.pointer && this.planning) this.drawRoute(this.pointer);
    }

    attachPointer() {
        if (this.stage === canvas.stage) return;
        this.detachPointer();
        this.stage = canvas.stage;
        this.stage.on("pointermove", this.onPointerMove);
        this.board = canvas.app.view;
        this.board.addEventListener("pointerleave", this.onPointerLeave);
        window.addEventListener("pointerdown", this.onPointerDown, true);
        window.addEventListener("keydown", this.onKeyDown, true);
    }

    detachPointer() {
        this.stage?.off("pointermove", this.onPointerMove);
        this.board?.removeEventListener("pointerleave", this.onPointerLeave);
        window.removeEventListener("pointerdown", this.onPointerDown, true);
        window.removeEventListener("keydown", this.onKeyDown, true);
        this.stage = this.board = null;
    }

    queueRoute() {
        if (this.routeFrame !== null) return;
        this.routeFrame = requestAnimationFrame(() => {
            this.routeFrame = null;
            if (this.pointer && this.planning) this.drawRoute(this.pointer);
        });
    }

    previewToken(preview) {
        if (preview._original === this.dragging || preview === this.dragging) this.syncDrag();
    }

    syncDrag() {
        const token = this.dragging;
        if (!token || !this.arrow) return;
        const planned = token._plannedMovement?.[game.user.id];
        const context = canvas.tokens._draggedToken?.mouseInteractionManager?.interactionData?.contexts?.[token.document.id];
        const waypoints = planned?.foundPath ?? context?.foundPath;
        if (!waypoints || planned?.searching || context?.searching || planned?.unreachableWaypoints?.length || context?.unreachableWaypoints?.length) {
            this.renderRoute([]);
            return;
        }
        const path = nativeCellPath(token.document, waypoints, this.grid);
        if (context?.destination && cellKey(path.at(-1)) !== cellKey(this.grid.getOffset({
            x: context.destination.x + 1, y: context.destination.y + 1}))) {
            this.renderRoute([]);
            return;
        }
        this.renderRoute(this.context.validate(path) ? path : []);
    }

    async commitDestination(destination) {
        const token = this.planning;
        if (!token || this.committing) return false;
        if (token.document.locked || (game.paused && !game.user.isGM)) {
            ui.notifications.warn("This unit cannot move while locked or while the game is paused.");
            return false;
        }
        const context = createMovementContext(token, canvas, {combat: game.combat});
        const path = context.route(destination);
        if (path.length < 2 || !context.validate(path)) {
            ui.notifications.warn(context.unrestricted ? "That square is blocked or cannot be reached." : "That square is outside this unit's remaining movement or is blocked.");
            return false;
        }
        this.renderRoute(path);
        this.committing = true;
        try {
            const waypoints = path.slice(1).map(context.waypoint);
            const moved = token.document.move
                ? await token.document.move(waypoints, {method: "api", showRuler: false, feueMovement: true})
                : await token.document.update({...waypoints.at(-1)}, {feueMovement: true, feueWaypoints: waypoints});
            if (moved) this.cancelPlanning();
            return !!moved;
        } catch (error) {
            console.error("FEUE | Movement failed", error);
            ui.notifications.error("The unit could not move. See the console for details.");
            return false;
        } finally {
            this.committing = false;
        }
    }

    drawRoute(point) {
        if (!this.arrow || !this.context) return;
        const destination = this.grid.getOffset(point);
        const key = cellKey(destination);
        if (key === this.destinationKey) return;
        this.destinationKey = key;
        this.arrow.clear();
        const path = this.context.route(destination);
        this.renderRoute(path);
    }

    renderRoute(path) {
        if (!this.arrow) return;
        this.arrow.clear();
        this.route = path;
        if (path.length < 2) return;
        const destination = path.at(-1);
        const points = path.map(cell => {
            const point = this.grid.getTopLeftPoint(cell);
            return {x: point.x + this.token.w / 2, y: point.y + this.token.h / 2};
        });
        const size = this.grid.size;
        const tip = points.at(-1);
        const previous = points.at(-2);
        const length = Math.hypot(tip.x - previous.x, tip.y - previous.y);
        const dx = (tip.x - previous.x) / length, dy = (tip.y - previous.y) / length;
        const neck = {x: tip.x - dx * size * 0.25, y: tip.y - dy * size * 0.25};
        const linePoints = [...points.slice(0, -1), neck];
        for (const [width, color] of [[size * 0.23, 0x1673a4], [size * 0.16, 0x87f0ff], [size * 0.06, 0xe2ffff]]) {
            this.arrow.lineStyle({width, color, alpha: 1, join: PIXI.LINE_JOIN.ROUND, cap: PIXI.LINE_CAP.ROUND});
            this.arrow.moveTo(linePoints[0].x, linePoints[0].y);
            for (const p of linePoints.slice(1)) this.arrow.lineTo(p.x, p.y);
        }
        this.arrow.lineStyle(size * 0.035, 0x1673a4, 1);
        this.arrow.beginFill(0x87f0ff).drawPolygon([
            tip.x + dx * size * 0.12, tip.y + dy * size * 0.12,
            neck.x - dy * size * 0.19, neck.y + dx * size * 0.19,
            neck.x + dy * size * 0.19, neck.y - dx * size * 0.19
        ]).endFill();
        // Cream corner brackets around the destination, like the GBA cursor.
        const {x, y} = this.grid.getTopLeftPoint(destination);
        for (const [width, color] of [[size * 0.08, 0x152943], [size * 0.04, 0xfff5c7]]) {
            this.arrow.lineStyle(width, color, 1);
            for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + size, y, -1, 1],
                [x, y + size, 1, -1], [x + size, y + size, -1, -1]]) {
                this.arrow.moveTo(cx + sx * size * 0.06, cy + sy * size * 0.22);
                this.arrow.lineTo(cx + sx * size * 0.06, cy + sy * size * 0.06);
                this.arrow.lineTo(cx + sx * size * 0.22, cy + sy * size * 0.06);
            }
        }
    }

    renderHud() {
        if (!this.hud) {
            this.hud = document.createElement("aside");
            this.hud.id = "feue-tactical-hud";
            this.hud.setAttribute("aria-label", "Selected character");
            this.hud.innerHTML = `<div class="feue-forecast-portrait"><img alt="" /></div>
                <div class="feue-forecast-unit"><div class="feue-forecast-name"></div>
                <div class="feue-forecast-hp"><span>HP</span><strong></strong></div>
                <div class="feue-forecast-hp-track" role="progressbar" aria-label="Hit points"><div></div></div></div>`;
            document.body.append(this.hud);
            window.addEventListener("resize", this.onResize);
        }
        const actor = this.token.actor;
        const hp = actor.system.attributes?.hp ?? {};
        const current = Number.isFinite(Number(hp.value)) ? Math.max(0, Number(hp.value)) : 0;
        const max = Number.isFinite(Number(hp.max)) ? Math.max(0, Number(hp.max)) : 0;
        const fraction = max > 0 ? Math.min(1, current / max) : 0;
        const image = this.hud.querySelector("img");
        const source = actor.img || this.token.document.texture.src || "icons/svg/mystery-man.svg";
        if (image.getAttribute("src") !== source) image.src = source;
        image.alt = `${actor.name} portrait`;
        this.hud.querySelector(".feue-forecast-name").textContent = this.token.name || actor.name;
        this.hud.querySelector("strong").textContent = `${current} / ${max}`;
        const bar = this.hud.querySelector("[role=progressbar]");
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", String(max));
        bar.setAttribute("aria-valuenow", String(Math.min(current, max)));
        bar.setAttribute("aria-valuetext", `${current} of ${max} hit points`);
        bar.firstElementChild.style.width = `${fraction * 100}%`;
        this.hud.dataset.health = fraction <= 0.25 ? "critical" : fraction <= 0.5 ? "low" : "healthy";
        this.hud.dataset.mode = this.dragging ? "dragging" : this.planning ? "moving" : "hover";
        this.positionHud();
    }

    positionHud() {
        if (!this.hud) return;
        const controls = document.querySelector("#scene-controls-controls, #controls")?.getBoundingClientRect();
        const navigation = document.querySelector("#scene-navigation .scene-navigation-menu, #navigation, #scene-navigation")?.getBoundingClientRect();
        const left = Math.max(16, controls?.right ? controls.right + 16 : 90);
        // Foundry's navigation container may fill the height of the viewport.
        const top = Math.max(20, Math.min(140, navigation?.bottom ? navigation.bottom + 16 : 72));
        this.hud.style.left = `${Math.min(left, Math.max(8, window.innerWidth - this.hud.offsetWidth - 16))}px`;
        this.hud.style.top = `${Math.min(top, Math.max(8, window.innerHeight - this.hud.offsetHeight - 16))}px`;
    }

    clearRoute() {
        if (this.routeFrame !== null) cancelAnimationFrame(this.routeFrame);
        this.routeFrame = null;
        this.pointer = this.destinationKey = null;
        this.route = [];
        if (this.arrow && !this.arrow.destroyed) this.arrow.clear();
    }

    clearGraphics() {
        for (const graphic of [this.tiles, this.arrow]) {
            if (graphic && !graphic.destroyed) {
                graphic.parent?.removeChild(graphic);
                graphic.destroy();
            }
        }
        this.tiles = this.arrow = this.forecast = this.context = null;
    }

    clear() {
        const previousToken = this.token;
        if (this.frame !== null) cancelAnimationFrame(this.frame);
        this.frame = null;
        this.clearRoute();
        this.detachPointer();
        this.clearGraphics();
        this.hud?.remove();
        window.removeEventListener("resize", this.onResize);
        this.hud = this.token = null;
        this.hovered = this.planning = this.dragging = null;
        if (previousToken && !previousToken.destroyed) previousToken.renderFlags?.set({refreshRuler: true});
    }
}

/** Validate the final native operation as well as drag previews (keyboard/API cannot bypass it). */
export function guardTacticalMovement(document, movement, options = {}) {
    if (game.user.isGM && options.feueInteraction) return;
    if (!game.settings.get("fires-of-war", "enforceTacticalMovement") || !canvas.ready ||
        canvas.scene.grid.type !== CONST.GRID_TYPES.SQUARE || document.actor?.type !== "character" ||
        !document.object || document.parent?.id !== canvas.scene.id ||
        ["undo", "paste", "config"].includes(movement.method) ||
        (game.user.isGM && movement.method === "api" && !options.feueMovement)) return;
    const token = document.object;
    // Each leg of a multi-waypoint move is validated from where that leg starts.
    const context = createMovementContext(token, canvas, {combat: game.combat, origin: movement.origin});
    const waypoints = [movement.origin, ...movement.passed.waypoints, ...movement.pending.waypoints];
    const cells = nativeCellPath(document, waypoints, context.grid);
    // A snapped preview must commit to that same square, even when Shift is held.
    if (!cells.length) return false;
    const end = context.grid.getTopLeftPoint(cells.at(-1));
    const destination = waypoints.at(-1);
    if (!context.validate(cells) || Math.abs(destination.x - end.x) > 1 || Math.abs(destination.y - end.y) > 1) {
        ui.notifications.warn(context.unrestricted ? "That route crosses a blocked square." : "Movement exceeds this unit's remaining range or crosses a blocked square.");
        return false;
    }
    if (game.settings.get("fires-of-war", "tacticalForecast")) movement.showRuler = false;
}

export function guardLegacyTacticalMovement(document, changed, options = {}) {
    // v13 has preMoveToken; v12 must reject coordinate updates before they are saved.
    if (document.move || !("x" in changed || "y" in changed)) return;
    const origin = {x: document.x, y: document.y};
    const destination = {x: changed.x ?? document.x, y: changed.y ?? document.y};
    return guardTacticalMovement(document, {origin, passed: {waypoints: options.feueWaypoints ?? [destination]},
        pending: {waypoints: []}, method: options.isUndo ? "undo" : options.feueMovement ? "api" : "dragging"}, options);
}

export function installTacticalTokenControls(controller) {
    const ParentToken = CONFIG.Token.objectClass;
    CONFIG.Token.objectClass = class FiresOfWarToken extends ParentToken {
        _onClickLeft2(event) {
            controller.cancelPlanning();
            return super._onClickLeft2(event);
        }

        _initializeDragLeft(event) {
            super._initializeDragLeft(event);
            controller.beginDrag(this);
        }

        _onDragLeftMove(event) {
            const result = super._onDragLeftMove(event);
            controller.syncDrag();
            return result;
        }

        _prepareDragLeftDropUpdates(event) {
            if (canvas.scene.grid.type === CONST.GRID_TYPES.SQUARE && game.settings.get("fires-of-war", "enforceTacticalMovement")) {
                for (const context of Object.values(event.interactionData.contexts ?? {})) {
                    if (context.token.actor?.type !== "character") continue;
                    const movement = createMovementContext(context.token, canvas, {combat: game.combat});
                    const cells = nativeCellPath(context.token.document, context.foundPath, movement.grid);
                    if (context.searching || context.unreachableWaypoints.length || !movement.validate(cells)) {
                        ui.notifications.warn("That route is outside this unit's remaining movement or is blocked.");
                        event.interactionData.clearPreviewContainer = true;
                        return null;
                    }
                }
            }
            const result = super._prepareDragLeftDropUpdates(event);
            if (game.settings.get("fires-of-war", "tacticalForecast") && Array.isArray(result?.[0])) {
                for (const move of Object.values(result[1]?.movement ?? {})) move.showRuler = false;
            }
            return result;
        }

        _finalizeDragLeft(event) {
            const result = super._finalizeDragLeft(event);
            controller.endDrag(this);
            return result;
        }
    };
    const ParentRuler = CONFIG.Token.rulerClass;
    if (ParentRuler) CONFIG.Token.rulerClass = class FiresOfWarTokenRuler extends ParentRuler {
        get feueActive() {
            return controller.token?.document.id === this.token.document.id && !!controller.arrow &&
                !!(controller.dragging || controller.planning);
        }
        _getSegmentStyle(waypoint) {
            return this.feueActive ? {width: 0} : super._getSegmentStyle(waypoint);
        }
        _getWaypointStyle(waypoint) {
            return this.feueActive ? {radius: 0} : super._getWaypointStyle(waypoint);
        }
        refresh(data) {
            const result = super.refresh(data);
            if (controller.dragging === this.token) controller.syncDrag();
            return result;
        }
    };
}

export function registerTacticalForecast() {
    const controller = new TacticalForecast();
    // Foundry may wrap system CSS inside a cascade layer, where nested @import is ignored.
    // Load this panel's stylesheet directly so an already-running world also gets it.
    if (!document.getElementById("feue-tactical-styles")) {
        const link = document.createElement("link");
        link.id = "feue-tactical-styles";
        link.rel = "stylesheet";
        link.href = new URL("../../styles/tactical-forecast.css", import.meta.url).href;
        document.head.append(link);
    }
    Hooks.once("init", () => {
        game.settings.register("fires-of-war", "tacticalForecast", {
            name: "Fires of War Movement Forecast",
            hint: "Show movement tiles and a character HUD on hover or while moving. Select a unit, choose Move in the bottom command bar, then a blue square to move; Escape or right-click cancels. Outside an encounter only the route is drawn.",
            scope: "client", config: true, type: Boolean, default: true,
            onChange: () => controller.queueRefresh()
        });
        game.settings.register("fires-of-war", "enforceTacticalMovement", {
            name: "Enforce Character Movement",
            hint: "In a started encounter, restrict participants to reachable squares; movement history counts against Base Movement and resets at the start of the unit's phase. Outside encounters only walls, solid Tiles, impassable terrain and other units block movement.",
            scope: "world", config: true, type: Boolean, default: true,
            onChange: () => controller.queueRefresh()
        });
        installTacticalTokenControls(controller);
    });
    Hooks.once("ready", () => {
        game.firesOfWar = Object.assign(game.firesOfWar || {}, {tacticalForecast: controller});
        controller.queueRefresh();
    });
    for (const hook of ["canvasReady", "controlToken", "activateCanvasLayer", "drawToken", "updateToken", "createToken", "deleteToken",
        "createWall", "updateWall", "deleteWall", "createRegion", "updateRegion", "deleteRegion", "createTile", "updateTile", "deleteTile", "sightRefresh", "updateScene", "updateCombat", "updateCombatant"]) {
        Hooks.on(hook, () => {
            if (controller.planning && !controller.planning.controlled) controller.planning = null;
            controller.queueRefresh();
        });
    }
    for (const hook of ["updateActor", "createItem", "updateItem", "deleteItem", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
        Hooks.on(hook, document => {
            const actor = document.documentName === "Actor" ? document : document.parent;
            if (actor === controller.token?.actor) controller.queueRefresh();
        });
    }
    Hooks.on("refreshToken", token => controller.previewToken(token));
    Hooks.on("hoverToken", (token, hovered) => controller.hoverToken(token, hovered));
    Hooks.on("preMoveToken", guardTacticalMovement);
    Hooks.on("preUpdateToken", guardLegacyTacticalMovement);
    Hooks.on("destroyToken", token => {
        if (token === controller.token) controller.clear();
        else if (token._original === controller.token) controller.clearRoute();
    });
    Hooks.on("canvasTearDown", () => controller.clear());
    Hooks.on("renderSceneNavigation", () => controller.positionHud());
    return controller;
}
