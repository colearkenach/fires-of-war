import {battalionArea, battalionStats, areaCells, aimToward, unitsInArea, FACINGS} from "./battalions.mjs";
import {alliedTokens} from "../skills/skill-context.mjs";
import {tokenCells} from "../encounter/event-rules.mjs";

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));

/** Map placement for Battalion areas: the area follows the pointer's direction; click confirms, right-click or Esc cancels. */
export class BattalionTargeting {
    active = null;
    graphics = null;
    panel = null;
    pointer = null;
    frame = null;

    constructor() {
        this.onPointerMove = event => {
            if (!this.active) return;
            this.pointer = event.getLocalPosition(canvas.stage);
            this.active.keyboard = false;
            if (this.frame === null) this.frame = requestAnimationFrame(() => { this.frame = null; this.draw(); });
        };
        this.onKeyDown = event => {
            if (!this.active) return;
            if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); this.cancel(); }
            if (["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(event.key)) {
                event.preventDefault(); event.stopImmediatePropagation();
                this.active.facing = ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].indexOf(event.key);
                this.active.keyboard = true;
                this.draw();
            }
            if (event.key === "Enter") { event.preventDefault(); event.stopImmediatePropagation(); void this.confirm(); }
        };
        // Window capture runs before Foundry's canvas handlers, so a confirm click cannot deselect the commander first.
        this.onPointerDown = event => {
            if (!this.active || event.target !== canvas.app?.view) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.button === 2) return this.cancel();
            if (event.button === 0) void this.confirm();
        };
    }

    get grid() { return canvas.grid?.getOffset ? canvas.grid : canvas.grid?.grid; }

    /** Begin placement. Resolves with {facing, reach} or null when cancelled. */
    start(token, item) {
        this.cancel();
        const area = battalionArea(item);
        if (!area || !canvas.ready || canvas.scene?.grid?.type !== CONST.GRID_TYPES.SQUARE) return Promise.resolve(null);
        game.firesOfWar?.tacticalForecast?.cancelPlanning?.();
        return new Promise(resolve => {
            this.active = {token, item, area, facing: 0, reach: 0, resolve, attacks: battalionStats(token.actor, item).attacks};
            this.graphics = canvas.interface.addChild(new PIXI.Graphics());
            this.graphics.eventMode = "none";
            this.graphics.zIndex = 900;
            this.panel = document.createElement("aside");
            this.panel.id = "feue-battalion-targeting";
            this.panel.setAttribute("role", "status");
            document.body.append(this.panel);
            canvas.stage.on("pointermove", this.onPointerMove);
            window.addEventListener("pointerdown", this.onPointerDown, true);
            window.addEventListener("keydown", this.onKeyDown, true);
            this.draw();
        });
    }

    current() {
        const {token, area} = this.active;
        if (this.pointer && !this.active.keyboard) Object.assign(this.active, aimToward(token, this.pointer, this.grid, area));
        const cells = areaCells(token, area, this.active.facing, this.active.reach, this.grid);
        const units = unitsInArea(token, cells, this.grid);
        return {cells, enemies: units.filter(t => !alliedTokens(token, t)), allies: units.filter(t => alliedTokens(token, t))};
    }

    draw() {
        if (!this.active || !this.graphics) return;
        const {cells, enemies, allies} = this.current();
        const grid = this.grid, size = grid.size, g = this.graphics;
        const [fill, line] = this.active.attacks ? [0xd8473c, 0xffc2b0] : [0x3fae6a, 0xc6f5d0];
        g.clear();
        g.lineStyle(Math.max(2, size * 0.03), line, 0.9).beginFill(fill, 0.35);
        for (const cell of cells) {
            const {x, y} = grid.getTopLeftPoint(cell);
            g.drawRect(x + 2, y + 2, size - 4, size - 4);
        }
        g.endFill();
        const outline = (doc, color) => {
            for (const cell of tokenCells(doc, grid)) {
                const {x, y} = grid.getTopLeftPoint(cell);
                g.lineStyle(Math.max(3, size * 0.05), color, 1).drawRect(x + 4, y + 4, size - 8, size - 8);
            }
        };
        outline(this.active.token.document, 0xf1d786);
        for (const doc of enemies) outline(doc, 0xff5a4a);
        for (const doc of allies) outline(doc, 0x6ee08f);
        const {item, area} = this.active;
        const names = list => list.map(t => esc(t.name)).join(", ") || "none";
        this.panel.innerHTML = `<strong>${esc(item.name)}</strong> · ${esc(area.label)} · facing ${FACINGS[this.active.facing]}${area.reach ? ` · pushed ${this.active.reach}` : ""}
            <div>${this.active.attacks ? `Enemies: ${names(enemies)}` : `Allies: ${names(allies)}`}</div>
            <small>Aim with the pointer or arrow keys · Click or Enter to order · Right-click or Esc to cancel</small>`;
    }

    async confirm() {
        if (!this.active) return;
        const {facing, reach, resolve} = this.active;
        this.cleanup();
        resolve({facing, reach});
    }

    cancel() {
        if (!this.active) return;
        const {resolve} = this.active;
        this.cleanup();
        resolve(null);
    }

    cleanup() {
        canvas.stage?.off("pointermove", this.onPointerMove);
        window.removeEventListener("pointerdown", this.onPointerDown, true);
        window.removeEventListener("keydown", this.onKeyDown, true);
        if (this.frame !== null) cancelAnimationFrame(this.frame);
        this.frame = null;
        this.graphics?.destroy();
        this.panel?.remove();
        this.graphics = this.panel = this.active = this.pointer = null;
    }
}
