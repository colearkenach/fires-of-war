import {SYSTEM_ID, TERRAINS, terrainAt} from "./terrain.mjs";

export const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));
export const rootElement = html => html?.querySelector ? html : html?.[0];

export function registerTerrainUI() {
    Hooks.on("renderRegionConfig", (app, html) => {
        const root = rootElement(html), doc = app.document ?? app.object;
        const target = root?.querySelector('.tab[data-tab="identity"]') ?? root?.querySelector("form") ?? root;
        if (!target || target.querySelector(".feue-terrain-config")) return;
        const flags = doc.flags?.[SYSTEM_ID] ?? {};
        target.insertAdjacentHTML("beforeend", `<fieldset class="feue-terrain-config"><legend>Fires of War Terrain</legend>
            <div class="form-group"><label>Terrain</label><select name="flags.${SYSTEM_ID}.terrain">
            <option value="">No terrain (ordinary Region)</option>${Object.entries(TERRAINS).map(([key, t]) => `<option value="${key}" ${flags.terrain === key ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
            <div class="form-group"><label>Overlap priority</label><input type="number" name="flags.${SYSTEM_ID}.terrainPriority" value="${Number(flags.terrainPriority) || 0}" step="1"></div>
            <p class="hint">Highest priority wins where terrain Regions overlap. Unpainted squares are Plain. Terrain uses each grid square's center and the token's elevation.</p><p class="feue-terrain-description"></p></fieldset>`);
        const select = target.querySelector(`[name="flags.${SYSTEM_ID}.terrain"]`);
        const describe = () => { target.querySelector(".feue-terrain-description").textContent = TERRAINS[select.value]?.text ?? "This Region does not change terrain."; };
        select.addEventListener("change", describe);
        describe();
    });
    Hooks.on("renderTokenConfig", (app, html) => {
        const root = rootElement(html), doc = app.document ?? app.object;
        const target = root?.querySelector('.tab[data-tab="character"]') ?? root?.querySelector('.tab[data-tab="identity"]') ?? root?.querySelector("form") ?? root;
        if (!target || target.querySelector(".feue-strides")) return;
        const traits = doc.flags?.[SYSTEM_ID]?.terrainTraits ?? {};
        target.insertAdjacentHTML("beforeend", `<fieldset class="feue-strides"><legend>Terrain Strides</legend>${["forest", "mountain", "water"].map(key => `<label><input type="checkbox" name="flags.${SYSTEM_ID}.terrainTraits.${key}" ${traits[key] ? "checked" : ""}> ${key[0].toUpperCase() + key.slice(1)} Stride</label>`).join("")}<p class="hint">Skills named Forest Stride, Mountain Stride, or Water Stride also grant these exceptions.</p></fieldset>`);
    });
    // Outdoor Fighter and other map-environment skills read this Scene setting (default Outdoor).
    Hooks.on("renderSceneConfig", (app, html) => {
        const root = rootElement(html), doc = app.document ?? app.object;
        const target = root?.querySelector('.tab[data-tab="basics"]') ?? root?.querySelector('.tab[data-tab="basic"]') ?? root?.querySelector("form") ?? root;
        if (!target || target.querySelector(".feue-scene-environment")) return;
        const indoor = doc.flags?.[SYSTEM_ID]?.environment === "indoor";
        target.insertAdjacentHTML("beforeend", `<fieldset class="feue-scene-environment"><legend>Fires of War Map</legend>
            <div class="form-group"><label>Environment</label><select name="flags.${SYSTEM_ID}.environment">
            <option value="outdoor" ${indoor ? "" : "selected"}>Outdoor</option><option value="indoor" ${indoor ? "selected" : ""}>Indoor</option></select></div>
            <p class="hint">Skills such as Outdoor Fighter only apply on outdoor maps.</p></fieldset>`);
    });
    let stage, element, pointer;
    const clear = () => { stage?.off("pointermove", move); stage?.off("pointerleave", hide); stage = null; element?.remove(); element = null; pointer = null; };
    const hide = () => { if (element) element.hidden = true; pointer = null; };
    const refresh = () => {
        if (!pointer || !canvas.ready || !element) return;
        const grid = canvas.grid?.getOffset ? canvas.grid : canvas.grid?.grid;
        const rect = canvas.dimensions.sceneRect;
        if (pointer.x < rect.x || pointer.y < rect.y || pointer.x >= rect.right || pointer.y >= rect.bottom) return hide();
        let point = pointer;
        if (canvas.scene.grid.type === CONST.GRID_TYPES.SQUARE) {
            point = grid.getTopLeftPoint(grid.getOffset(pointer));
            point = {x: point.x + grid.size / 2, y: point.y + grid.size / 2};
        }
        const token = canvas.tokens?.controlled?.at(-1);
        const terrain = terrainAt(canvas.scene, {...point, elevation: token?.document.elevation ?? 0});
        element.innerHTML = `<strong>${esc(terrain.name)}</strong><div class="feue-terrain-numbers"><span>DEF ${terrain.defense >= 0 ? "+" : ""}${terrain.defense}</span><span>AVO +${terrain.avoid}%</span></div><p>${esc(terrain.text)}</p>`;
        element.hidden = false;
    };
    function move(event) { pointer = event.getLocalPosition(canvas.stage); refresh(); }
    Hooks.on("canvasReady", () => {
        clear();
        stage = canvas.stage;
        element = document.createElement("aside");
        element.id = "feue-terrain-tooltip";
        element.hidden = true;
        element.setAttribute("aria-label", "Terrain under pointer");
        document.body.append(element);
        stage.on("pointermove", move);
        stage.on("pointerleave", hide);
    });
    for (const hook of ["createRegion", "updateRegion", "deleteRegion", "controlToken"]) Hooks.on(hook, refresh);
    Hooks.on("canvasTearDown", clear);
}
