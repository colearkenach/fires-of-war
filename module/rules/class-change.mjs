import {hasInfiniteUses} from "./feue.mjs";

const SYSTEM = "fires-of-war";
const setting = key => globalThis.game?.settings?.get(SYSTEM, key);
const normalize = value => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Class change items: crests that promote listed classes, Master Seals that promote any class,
 * and Second Seals that change to an alternate class (Reclassing). */
export const CLASS_CHANGE_MODES = {
    promote: "Promotes the listed classes",
    master: "Promotes any class (Master Seal)",
    reclass: "Changes to an alternate class (Second Seal)"
};
/** Proper Promotion turns class change items on. */
export const classChangeItemsEnabled = () => (setting("properPromotion") || "off") !== "off";
/** With both alt rules on, every reclass spends a Second Seal. */
export const secondSealRequired = () => classChangeItemsEnabled() && !!setting("useReclassing");

export function classChangeConfig(item) {
    if (item?.type !== "item") return {mode: "", classes: []};
    const data = item.system?.classChange ?? {};
    // Items marked with the earlier "Promotion Item" checkbox promote any class.
    const mode = data.mode || (item.flags?.[SYSTEM]?.isPromotionItem ? "master" : "");
    return {mode: CLASS_CHANGE_MODES[mode] ? mode : "", classes: (Array.isArray(data.classes) ? data.classes : []).map(name => String(name).trim()).filter(Boolean)};
}

/** The class change this item performs under the current settings, or "". */
export function activeClassChange(item) {
    const {mode} = classChangeConfig(item);
    if (!mode || !classChangeItemsEnabled() || mode === "reclass" && !setting("useReclassing")) return "";
    return mode;
}

export function hasUsesLeft(item) {
    const uses = item?.system?.uses;
    if (hasInfiniteUses(uses)) return true;
    return !(Number(uses?.max) > 0 && Number(uses.value) <= 0) && Number(item?.system?.quantity ?? 1) > 0;
}

export function promotesClass(item, className) {
    const {mode, classes} = classChangeConfig(item);
    return mode === "master" || mode === "promote" && classes.some(name => normalize(name) === normalize(className));
}

/** Promotion items the unit can use on a class, listed crests before Master Seals. */
export function promotionItemsFor(actor, node) {
    return Array.from(actor?.items ?? []).filter(item => ["promote", "master"].includes(activeClassChange(item)) && hasUsesLeft(item) && promotesClass(item, node?.name))
        .sort((a, b) => Number(activeClassChange(a) === "master") - Number(activeClassChange(b) === "master"));
}

export const secondSealsOf = actor => Array.from(actor?.items ?? []).filter(item => activeClassChange(item) === "reclass" && hasUsesLeft(item));

/** Spend one use. A spent single item is removed; a stack loses one and refills its uses. */
export async function consumeClassChangeItem(item) {
    if (!item || hasInfiniteUses(item.system.uses)) return;
    const uses = item.system.uses, max = Number(uses?.max) || 0, quantity = Number(item.system.quantity ?? 1);
    if (max > 0 && Number(uses.value) > 1) return item.update({"system.uses.value": Number(uses.value) - 1});
    if (quantity > 1) return item.update({"system.quantity": quantity - 1, ...(max > 0 ? {"system.uses.value": max} : {})});
    return item.delete();
}

/** Class names offered when listing the classes a crest can promote. */
export function knownClassNames() {
    const names = new Set();
    const walk = node => { if (node?.name) names.add(node.name); for (const child of node?.promotions ?? []) walk(child); };
    for (const item of globalThis.game?.items ?? []) if (item.type === "class") walk({name: item.name, promotions: item.system.promotions});
    for (const pack of globalThis.game?.packs ?? []) if (pack.documentName === "Item") for (const entry of pack.index ?? []) if (entry.type === "class") names.add(entry.name);
    return [...names].sort((a, b) => a.localeCompare(b));
}
