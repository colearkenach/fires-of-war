/** Small map badges on character tokens: unit type(s) at the bottom-left corner and the equipped weapon at the bottom-right.
 * Icons default to the system's glyphs and can be replaced in Configure Settings → Token Indicator Icons. */
import {WEAPON_TRIANGLES} from "../rules/alt-rules.mjs";
import {unitAllegiance} from "../encounter/event-rules.mjs";

const SYSTEM = "fires-of-war";
const ICON_ROOT = `systems/${SYSTEM}/icons`;
export const UNIT_TYPES = Object.freeze(["Infantry", "Mounted", "Flying", "Dragon", "Armored", "Magician", "Beast", "Mechanical", "Monster"]);
export const WEAPON_TYPES = Object.freeze({sword: "Sword", lance: "Lance", axe: "Axe", bow: "Bow", firearm: "Firearm", knife: "Knife", unarmed: "Unarmed",
    anima: "Anima", light: "Light", dark: "Dark", staff: "Staff", monster: "Monster", stone: "Stone"});
export const DEFAULT_ICONS = Object.freeze({
    unitTypes: Object.freeze(Object.fromEntries(UNIT_TYPES.map(type => [type, `${ICON_ROOT}/unit-types/${type.toLowerCase()}.svg`]))),
    weapons: Object.freeze(Object.fromEntries(Object.keys(WEAPON_TYPES).map(type => [type, `${ICON_ROOT}/weapons/${type}.svg`])))
});
// Ring colours follow the rulebook's triangle diagram: Physical red, Special green, Magic purple.
const RINGS = {physical: 0xd0503f, special: 0x3fa36b, magic: 0x9a5cc6, other: 0xb9b3a0, unit: 0xf1d786};
const setting = (key, fallback) => { try { return game.settings.get(SYSTEM, key) ?? fallback; } catch { return fallback; } };

/** Configured icons merged over the defaults; blank entries hide that badge. */
export function indicatorIcons(saved = setting("tokenIndicatorIcons", {})) {
    return {unitTypes: {...DEFAULT_ICONS.unitTypes, ...(saved?.unitTypes ?? {})}, weapons: {...DEFAULT_ICONS.weapons, ...(saved?.weapons ?? {})}};
}

/** What a token shows: prepared unit types (so Dismount shows Infantry) and the equipped weapon's type. */
export function indicatorSpec(actor, icons = indicatorIcons()) {
    const raw = actor?.system?.unitTypes ?? [];
    const owned = new Set(Array.isArray(raw) ? raw : Object.keys(raw).filter(key => raw[key]));
    const types = UNIT_TYPES.filter(type => owned.has(type) && icons.unitTypes[type]).slice(0, 3).map(type => ({key: type, src: icons.unitTypes[type]}));
    const equipped = Array.from(actor?.items ?? []).find(item => item.type === "weapon" && item.system?.equipped);
    const kind = String(equipped?.system?.weaponType ?? "").trim().toLowerCase();
    const group = Object.entries(WEAPON_TRIANGLES).find(([, cycle]) => cycle.includes(kind))?.[0] ?? "other";
    const weapon = WEAPON_TYPES[kind] && icons.weapons[kind] ? {key: kind, src: icons.weapons[kind], ring: RINGS[group], name: equipped.name} : null;
    return {types, weapon};
}

// ---------- Fires of War HP bars ----------
/** Fill colours by allegiance, as in the games: blue allies, green neutrals, red enemies; other factions gold. */
export const HP_BAR_COLORS = Object.freeze({
    player: {fill: 0x3d8bf2, light: 0xa9d4ff}, npc: {fill: 0x37b86a, light: 0xa8f0c0},
    enemy: {fill: 0xe0453a, light: 0xffb0a6}, other: {fill: 0xe0b23a, light: 0xffe7a0}
});
export const hpBarHeight = token => Math.round(10 * (Number(token?.document?.height) >= 2 ? 1.4 : 1) * (globalThis.canvas?.dimensions?.uiScale ?? 1));
const firesOfWarBars = () => !!setting("feHpBars", true);
function barColors(token) {
    let id = "other";
    try { id = unitAllegiance(token.document, game.combat).id; } catch { /* no allegiance data */ }
    return HP_BAR_COLORS[id] ?? HP_BAR_COLORS.other;
}

/** A framed, segmented HP gauge: dark track, allegiance-coloured fill with a highlight, a tick per HP (or per 5/10 for large pools). */
export function drawFiresOfWarBar(token, number, bar, data) {
    const value = Math.max(0, Number(data.value) || 0), max = Math.max(1, Number(data.max) || 1);
    const pct = Math.min(1, value / max), s = canvas.dimensions.uiScale ?? 1;
    const width = token.document.getSize?.().width ?? token.w, height = hpBarHeight(token);
    const inset = Math.max(1, Math.round(1.5 * s)), inner = width - inset * 2, innerHeight = height - inset * 2;
    const {fill, light} = barColors(token);
    bar.clear();
    bar.lineStyle(0).beginFill(0x0b1020, 0.95).drawRoundedRect(0, 0, width, height, 2 * s).endFill();
    bar.beginFill(0x283052, 1).drawRect(inset, inset, inner, innerHeight).endFill();
    if (pct > 0) {
        bar.beginFill(fill, 1).drawRect(inset, inset, inner * pct, innerHeight).endFill();
        bar.beginFill(light, 0.85).drawRect(inset, inset, inner * pct, Math.max(1, innerHeight * 0.35)).endFill();
    }
    const step = max <= 40 ? 1 : max <= 100 ? 5 : 10;
    if (inner * step / max >= 3) {
        for (let hp = step; hp < max; hp += step) {
            const x = inset + inner * hp / max;
            bar.lineStyle(1, 0x0b1020, hp % (step * 5) === 0 ? 0.75 : 0.35).moveTo(x, inset).lineTo(x, inset + innerHeight);
        }
    }
    bar.lineStyle(Math.max(1, 0.75 * s), 0xf2e8bc, 0.9).drawRoundedRect(0, 0, width, height, 2 * s);
    bar.position.set(0, number === 0 ? token.h - height : 0);
    return true;
}

export function installFiresOfWarBars() {
    const Parent = CONFIG.Token.objectClass;
    CONFIG.Token.objectClass = class FiresOfWarBarToken extends Parent {
        _drawBar(number, bar, data) {
            if (data?.attribute !== "attributes.hp" || !firesOfWarBars() || this.actor?.type !== "character") return super._drawBar(number, bar, data);
            return drawFiresOfWarBar(this, number, bar, data);
        }
    };
}

export class TokenIndicators {
    enabled() { return !!setting("tokenIndicators", true); }

    /** Rebuild only when what the badges show changes; reposition on every refresh. */
    refresh(token) {
        if (!token || token.destroyed || token.isPreview) return;
        const current = token._feueIndicators;
        if (!this.enabled() || token.actor?.type !== "character" || !token.document) {
            if (current) this.remove(token);
            return;
        }
        const spec = indicatorSpec(token.actor);
        const signature = JSON.stringify([spec.types.map(t => t.src), spec.weapon?.src, spec.weapon?.ring, token.w, token.h]);
        if (current?.signature === signature && !current.container.destroyed) return;
        this.remove(token);
        if (!spec.types.length && !spec.weapon) return;
        const container = new PIXI.Container();
        container.eventMode = "none";
        token._feueIndicators = {container, signature};
        token.addChild(container);
        void this.build(token, container, spec).catch(error => console.warn("FEUE | Token indicator icons failed to load", error));
    }

    async build(token, container, spec) {
        const load = foundry.canvas?.loadTexture ?? globalThis.loadTexture;
        const size = Math.max(14, Math.round(Math.min(token.w, token.h) * 0.26));
        const badge = async (src, ring, x, y, title) => {
            const texture = await load(src).catch(() => null);
            if (container.destroyed) return;
            const group = new PIXI.Container();
            group.position.set(x, y);
            const disc = new PIXI.Graphics();
            disc.lineStyle(Math.max(1.5, size * 0.09), ring, 1).beginFill(0x152943, 0.92).drawCircle(0, 0, size / 2).endFill();
            group.addChild(disc);
            if (texture) {
                const sprite = new PIXI.Sprite(texture);
                sprite.anchor.set(0.5);
                sprite.width = sprite.height = size * 0.66;
                group.addChild(sprite);
            }
            group.name = title;
            container.addChild(group);
        };
        // Badges sit in the bottom corners just above the HP bar, so they never hide part of it.
        const inset = size * 0.38, y = token.h - hpBarHeight(token) - size * 0.36;
        await Promise.all([
            ...spec.types.map((type, n) => badge(type.src, RINGS.unit, inset + n * size * 0.86, y, type.key)),
            ...(spec.weapon ? [badge(spec.weapon.src, spec.weapon.ring, token.w - inset, y, spec.weapon.key)] : [])
        ]);
    }

    remove(token) {
        const current = token._feueIndicators;
        token._feueIndicators = null;
        if (current?.container && !current.container.destroyed) {
            current.container.parent?.removeChild(current.container);
            current.container.destroy({children: true});
        }
    }

    refreshActor(actor) {
        for (const token of actor?.getActiveTokens?.(false, false) ?? []) this.refresh(token);
    }

    refreshAll() {
        for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
            if (token._feueIndicators) this.remove(token);
            this.refresh(token);
        }
    }
}

/** Configure Settings → Token Indicator Icons: one image per unit type and weapon type.
 * Created at "init" because the v1 FormApplication base class only exists inside Foundry. */
export const createTokenIndicatorConfig = (FormApplication = foundry.appv1?.api?.FormApplication ?? globalThis.FormApplication) => class TokenIndicatorConfig extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {id: "feue-token-indicator-config", title: "Token Indicator Icons",
            template: `systems/${SYSTEM}/templates/apps/token-indicators.html`, classes: ["feue-indicator-config"], width: 560, height: 640, resizable: true, closeOnSubmit: true});
    }
    getData() {
        const saved = setting("tokenIndicatorIcons", {}), icons = indicatorIcons(saved);
        const row = (group, key, label) => ({group, key, label, value: icons[group][key] ?? "", fallback: DEFAULT_ICONS[group][key], custom: saved?.[group]?.[key] !== undefined});
        return {unitTypes: UNIT_TYPES.map(type => row("unitTypes", type, type)), weapons: Object.entries(WEAPON_TYPES).map(([key, label]) => row("weapons", key, label))};
    }
    activateListeners(html) {
        super.activateListeners(html);
        const root = html[0] ?? html;
        root.querySelectorAll("input[data-icon]").forEach(input => input.addEventListener("change", () => {
            const preview = input.closest(".feue-indicator-row")?.querySelector("img");
            if (preview) { preview.src = input.value || ""; preview.classList.toggle("empty", !input.value); }
        }));
        root.querySelectorAll("[data-reset]").forEach(button => button.addEventListener("click", () => {
            const input = root.querySelector(`input[name="${button.dataset.reset}"]`);
            input.value = input.dataset.fallback;
            input.dispatchEvent(new Event("change"));
        }));
        root.querySelectorAll("[data-browse]").forEach(button => button.addEventListener("click", () => {
            const input = root.querySelector(`input[name="${button.dataset.browse}"]`);
            const Picker = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
            new Picker({type: "image", current: input.value, callback: path => { input.value = path; input.dispatchEvent(new Event("change")); }}).render(true);
        }));
    }
    async _updateObject(event, formData) {
        const value = {unitTypes: {}, weapons: {}};
        for (const [name, path] of Object.entries(foundry.utils.expandObject(formData))) {
            for (const [key, src] of Object.entries(path ?? {})) {
                const fallback = DEFAULT_ICONS[name]?.[key];
                if (fallback !== undefined && String(src ?? "").trim() !== fallback) value[name][key] = String(src ?? "").trim();
            }
        }
        await game.settings.set(SYSTEM, "tokenIndicatorIcons", value);
    }
};

export function registerTokenIndicators() {
    const indicators = new TokenIndicators();
    Hooks.once("init", () => {
        game.settings.register(SYSTEM, "tokenIndicators", {name: "Token Indicators", scope: "client", config: true, type: Boolean, default: true,
            hint: "Show the unit type and equipped weapon as small icons on character tokens. The GM chooses the icons in Token Indicator Icons.",
            onChange: () => indicators.refreshAll()});
        game.settings.register(SYSTEM, "tokenIndicatorIcons", {scope: "world", config: false, type: Object, default: {}, onChange: () => indicators.refreshAll()});
        game.settings.register(SYSTEM, "feHpBars", {name: "Fires of War HP Bars", scope: "client", config: true, type: Boolean, default: true,
            hint: "Draw character HP bars as framed, segmented Fires of War gauges coloured by allegiance (blue Player, green Neutral, red Enemy, gold Other).",
            onChange: () => { for (const token of canvas?.tokens?.placeables ?? []) token.renderFlags.set({refreshBars: true}); }});
        installFiresOfWarBars();
        game.settings.registerMenu(SYSTEM, "tokenIndicatorMenu", {name: "Token Indicator Icons", label: "Choose Icons", icon: "fas fa-icons",
            hint: "Choose the icon shown on tokens for each unit type and weapon type. Clear an entry to hide that badge.", type: createTokenIndicatorConfig(), restricted: true});
    });
    Hooks.once("ready", () => { game.firesOfWar = Object.assign(game.firesOfWar ?? {}, {tokenIndicators: indicators}); });
    Hooks.on("drawToken", token => { token._feueIndicators = null; indicators.refresh(token); });
    Hooks.on("refreshToken", token => indicators.refresh(token));
    Hooks.on("destroyToken", token => indicators.remove(token));
    for (const hook of ["createItem", "updateItem", "deleteItem"]) Hooks.on(hook, item => { if (item.parent?.documentName === "Actor") indicators.refreshActor(item.parent); });
    Hooks.on("updateActor", actor => indicators.refreshActor(actor));
    // Bar colours follow allegiance, which an encounter can assign per combatant.
    for (const hook of ["createCombatant", "updateCombatant", "deleteCombatant", "updateCombat", "deleteCombat"]) Hooks.on(hook, () => {
        for (const token of globalThis.canvas?.tokens?.placeables ?? []) token.renderFlags?.set({refreshBars: true});
    });
    return indicators;
}
