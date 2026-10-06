import {cellKey} from "./tactical-grid.mjs";

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));

/** Choose one highlighted square on the map (Drop, and similar placements).
 * Click a highlighted square or press Enter on the hovered one; right-click or Esc cancels. */
export class SquarePicker {
    active = null;
    graphics = null;
    panel = null;
    frame = null;

    constructor() {
        this.onPointerMove = event => {
            if (!this.active) return;
            this.active.hover = cellKey(this.grid.getOffset(event.getLocalPosition(canvas.stage)));
            if (this.frame === null) this.frame = requestAnimationFrame(() => { this.frame = null; this.draw(); });
        };
        this.onKeyDown = event => {
            if (!this.active) return;
            if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); this.finish(null); }
            if (event.key === "Enter" && this.active.cells.has(this.active.hover)) { event.preventDefault(); event.stopImmediatePropagation(); this.finish(this.active.hover); }
        };
        // Window capture runs before Foundry's canvas handlers, so the click cannot deselect the unit first.
        this.onPointerDown = event => {
            if (!this.active || event.target !== canvas.app?.view) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.button === 2) return this.finish(null);
            if (event.button !== 0) return;
            const rect = event.target.getBoundingClientRect(), screen = canvas.app.renderer.screen;
            const point = canvas.stage.toLocal(new PIXI.Point((event.clientX - rect.left) * screen.width / rect.width,
                (event.clientY - rect.top) * screen.height / rect.height));
            const key = cellKey(this.grid.getOffset(point));
            if (this.active.cells.has(key)) this.finish(key);
            else ui.notifications.warn(this.active.invalid ?? "Choose a highlighted square.");
        };
    }

    get grid() { return canvas.grid?.getOffset ? canvas.grid : canvas.grid?.grid; }

    /** cells: Map of cell key → top-left point. Resolves with the chosen point, or null when cancelled. */
    start({cells, title = "Choose a square", hint = "", invalid, color = 0x3fae6a, line = 0xc6f5d0} = {}) {
        this.finish(null);
        if (!canvas.ready || !cells?.size) return Promise.resolve(null);
        game.firesOfWar?.tacticalForecast?.cancelPlanning?.();
        return new Promise(resolve => {
            this.active = {cells, title, hint, invalid, color, line, resolve, hover: null};
            this.graphics = canvas.interface.addChild(new PIXI.Graphics());
            this.graphics.eventMode = "none";
            this.graphics.zIndex = 900;
            this.panel = document.createElement("aside");
            this.panel.id = "feue-square-picker";
            this.panel.setAttribute("role", "status");
            this.panel.innerHTML = `<strong>${esc(title)}</strong>${hint ? `<div>${esc(hint)}</div>` : ""}<small>Click a highlighted square · Right-click or Esc to cancel</small>`;
            document.body.append(this.panel);
            canvas.stage.on("pointermove", this.onPointerMove);
            window.addEventListener("pointerdown", this.onPointerDown, true);
            window.addEventListener("keydown", this.onKeyDown, true);
            this.draw();
        });
    }

    draw() {
        if (!this.active || !this.graphics) return;
        const {cells, hover, color, line} = this.active, grid = this.grid, size = grid.size, g = this.graphics;
        g.clear();
        for (const [key, point] of cells) {
            const hovered = key === hover;
            g.lineStyle(Math.max(2, size * (hovered ? 0.06 : 0.03)), hovered ? 0xfff5c7 : line, 1).beginFill(color, hovered ? 0.6 : 0.35);
            g.drawRect(point.x + 3, point.y + 3, size - 6, size - 6);
            g.endFill();
        }
    }

    finish(key) {
        if (!this.active) return;
        const {resolve, cells} = this.active;
        canvas.stage?.off("pointermove", this.onPointerMove);
        window.removeEventListener("pointerdown", this.onPointerDown, true);
        window.removeEventListener("keydown", this.onKeyDown, true);
        if (this.frame !== null) cancelAnimationFrame(this.frame);
        this.frame = null;
        this.graphics?.destroy();
        this.panel?.remove();
        this.graphics = this.panel = this.active = null;
        resolve(key ? cells.get(key) : null);
    }
}

export const squarePicker = new SquarePicker();
