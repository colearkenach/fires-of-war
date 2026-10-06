/** Class editing and selection: icon chips for unit types and weapons, a Base / Growth / Cap stat table,
 * and the tabbed class picker used when adding a class to a character. */
import {indicatorIcons, UNIT_TYPES, WEAPON_TYPES} from "../map/token-indicators.mjs";
import {isEnemyUnit} from "../units/allegiance-ui.mjs";
import {chooseFromCatalog} from "./catalog-picker.mjs";

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));
export const STAT_COLUMNS = Object.freeze([["hp", "HP"], ["strength", "Str"], ["magic", "Mag"], ["skill", "Skl"], ["speed", "Spd"],
    ["defense", "Def"], ["resistance", "Res"], ["luck", "Lck"], ["charm", "Cha"], ["build", "Bld"]]);
export const CLASS_PICKER_TABS = Object.freeze(["Recruit", "Standard", "Advanced", "Enemy Only", "Monster"]);
export const ENEMY_CLASS_TYPES = Object.freeze(["Enemy Only", "Monster"]);
export const baseStatLabel = classType => ["Promoted", "Advanced"].includes(classType) ? "Promotion bonus" : "Base";

/** `named` inputs submit with the sheet form; otherwise they carry data-key="ut.X" / "wp.X" for a dialog to read. */
export function classChipsHtml(data, {named = true} = {}) {
    const icons = indicatorIcons();
    const chip = (field, prefix, key, label, on, icon) => `<label class="feue-chip" title="${esc(label)}">
        <input type="checkbox" ${named ? `name="system.${field}.${key}"` : `data-key="${prefix}.${key}"`} ${on ? "checked" : ""}>
        ${icon ? `<img src="${esc(icon)}" alt="">` : ""}<span>${esc(label)}</span></label>`;
    return `<section class="feue-class-block"><h4>Unit Types</h4><div class="feue-chips">${UNIT_TYPES.map(type =>
        chip("unitTypes", "ut", type, type, !!data?.unitTypes?.[type], icons.unitTypes[type])).join("")}</div></section>
        <section class="feue-class-block"><h4>Weapon Proficiencies</h4><div class="feue-chips">${Object.entries(WEAPON_TYPES).map(([key, label]) =>
        chip("weaponProficiencies", "wp", key, label, !!data?.weaponProficiencies?.[key], icons.weapons[key])).join("")}</div></section>`;
}

export function classStatTableHtml(data, {named = true, classType = data?.classType} = {}) {
    const rows = [["baseStats", "bs", baseStatLabel(classType)], ["growthRates", "gr", "Growth"], ["statCaps", "sc", "Cap"]];
    return `<table class="feue-class-stats"><thead><tr><th scope="col"><span class="feue-sr-only">Stat row</span></th>${STAT_COLUMNS.map(([, label]) => `<th scope="col">${label}</th>`).join("")}</tr></thead>
        <tbody>${rows.map(([field, prefix, label]) => `<tr><th scope="row"${prefix === "bs" ? ' class="feue-base-label"' : ""}>${esc(label)}</th>${STAT_COLUMNS.map(([key, short]) =>
        `<td><input type="number" ${named ? `name="system.${field}.${key}" data-dtype="Number"` : `data-key="${prefix}.${key}"`} value="${Number(data?.[field]?.[key] ?? 0)}" min="0" step="1" aria-label="${esc(label)} ${short}"></td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

const weaponSummary = proficiencies => Object.entries(WEAPON_TYPES).filter(([key]) => proficiencies?.[key]).map(([, label]) => label).join(", ");

/** Every class item in the world and in Item compendiums, grouped by class type. */
export async function classCatalog() {
    const entries = [], seen = new Set();
    const add = (uuid, data, source) => {
        const key = `${data.name}|${data.system?.classType}`;
        if (seen.has(key)) return;
        seen.add(key);
        entries.push({uuid, name: data.name, img: data.img || "icons/svg/mystery-man.svg", classType: data.system?.classType || "Standard",
            movement: Number(data.system?.movement) || 0, weapons: weaponSummary(data.system?.weaponProficiencies), source});
    };
    for (const item of game.items ?? []) if (item.type === "class") add(item.uuid, item, "World");
    for (const pack of game.packs.filter(p => p.metadata.type === "Item")) {
        let index;
        try { index = await pack.getIndex({fields: ["system.classType", "system.movement", "system.weaponProficiencies"]}); } catch { continue; }
        for (const entry of index) if (entry.type === "class") add(entry.uuid ?? `Compendium.${pack.collection}.Item.${entry._id}`, entry, pack.metadata.label);
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Tabbed class picker. Enemy Only and Monster classes can only be chosen for Enemy units. Resolves with the created class or null. */
export async function openClassPicker(actor, {onBlank} = {}) {
    const entries = await classCatalog();
    const tabs = [...CLASS_PICKER_TABS, ...new Set(entries.map(e => e.classType).filter(type => !CLASS_PICKER_TABS.includes(type)))];
    const locked = isEnemyUnit(actor) ? {} : Object.fromEntries(ENEMY_CLASS_TYPES.map(tab =>
        [tab, "Only Enemy units can use these classes. Set this unit's Allegiance to Enemy on its sheet to choose one."]));
    const choice = await chooseFromCatalog({title: "Choose Class", noun: "class", plural: "classes", tabs, initial: "Standard", locked,
        entries: entries.map(e => ({...e, tab: e.classType, summary: `Move ${e.movement}${e.weapons ? ` · ${esc(e.weapons)}` : ""}`}))});
    if (choice === "blank") return onBlank?.();
    if (!choice) return null;
    const source = await fromUuid(choice);
    if (!source) return ui.notifications.error("Could not load that class.");
    if (ENEMY_CLASS_TYPES.includes(source.system?.classType) && !isEnemyUnit(actor)) return ui.notifications.warn(`${source.name} is only available to Enemy units.`);
    const data = source.toObject();
    delete data._id; delete data.folder;
    const [created] = await actor.createEmbeddedDocuments("Item", [data]);
    if (created) ui.notifications.info(`Added ${created.name}.`);
    return created;
}

/** The class sheet, promotion editor and picker share one stylesheet; it is linked directly so a running
 * server that cached system.json still loads it. */
export function registerClassUI() {
    if (!globalThis.document || document.getElementById("feue-class-ui-styles")) return;
    const link = document.createElement("link");
    link.id = "feue-class-ui-styles";
    link.rel = "stylesheet";
    link.href = new URL("../../styles/class-ui.css", import.meta.url).href;
    document.head.append(link);
}
