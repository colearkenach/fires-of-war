/** The character sheet's Add Weapon / Item / Skill / Spell / Combat Art / Battalion pickers: every item of that type in the world
 * and in Item compendiums, in tabs (and, for ranked types, collapsed rank sections). A blank item stays available as a fallback. */
import {chooseFromCatalog} from "./catalog-picker.mjs";
import {INVENTORY_LIMIT, inventoryUsage} from "../units/convoy.mjs";
import {isEnemyUnit} from "../units/allegiance-ui.mjs";
import {isMonsterWeapon} from "../rules/monster-classes.mjs";
import {WEAPON_TYPES} from "../map/token-indicators.mjs";
import {hasInfiniteUses, normalizeWeaponRank} from "../rules/feue.mjs";
import {battalionUseReason} from "../combat/battalions.mjs";

const SYSTEM = "fires-of-war";
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));
const text = value => String(value ?? "").trim();
/** Text fields the compendium fills with "N/A" or a dash when there is nothing to say. */
const note = value => /^(n\/a|none|—|-)$/i.test(text(value)) ? "" : text(value);
const join = parts => parts.filter(Boolean).join(" · ");
const signed = (value, label) => Number(value) ? `${Number(value) > 0 ? "+" : ""}${Number(value)} ${label}` : "";
const usesText = uses => hasInfiniteUses(uses) ? "∞ uses" : Number(uses?.max) > 0 ? `${Number(uses.max)} use${Number(uses.max) === 1 ? "" : "s"}` : "";
const badge = (label, tooltip, kind = "warn") => `<span class="feue-catalog-${kind}"${tooltip ? ` title="${esc(tooltip)}"` : ""}>${esc(label)}</span>`;
const enemyNote = what => `Only Enemy units can take ${what}. Set this unit's Allegiance to Enemy on its sheet to choose one.`;

/** Ranked types list their entries in collapsed sections, lowest rank first; Prf (personal) entries lead. */
const RANK_GROUPS = Object.freeze([...["Prf", "E", "D", "C", "B", "A", "S"].map(key => ({key, label: key === "Prf" ? "Prf" : `Rank ${key}`})), {key: "", label: "Unranked"}]);
const rankGroup = data => normalizeWeaponRank(data.system?.rank, {allowPrf: true});
const ITEM_CATEGORIES = Object.freeze({consumable: "Consumable", equippable: "Equippable", miscellaneous: "Treasure"});
const SKILL_TABS = Object.freeze({"Passive": "Passive", "Passive (Activated)": "Activated", "Active": "Active"});
const ENEMY_ONLY_FOLDER = /enemy[- ]only/i;
const SPELL_SCHOOLS = Object.freeze(["Black Magic", "White Magic", "Dark Magic"]);
const weaponTabs = () => [...Object.values(WEAPON_TYPES).filter(tab => tab !== "Monster"), "Monster"];
/** The first tab named for a weapon type this unit is proficient with. */
const proficientTab = (actor, entries) => Object.entries(WEAPON_TYPES).find(([key, tab]) => actor.hasWeaponProficiency?.(key) && entries.some(e => e.tab === tab))?.[1];
const known = (actor, type, data) => actor.items.some(item => item.type === type && item.name === data.name) ? badge("Known", "This unit already has it.", "tag") : "";

/** Skills learned at a class level group under that level, Innate first. */
function levelGroups(entries) {
    const keys = [...new Set(entries.map(e => e.group))];
    const order = key => key === "Innate" ? -1 : key === "" ? Infinity : Number.isFinite(Number(key)) ? Number(key) : 1e6;
    return keys.sort((a, b) => order(a) - order(b) || a.localeCompare(b))
        .map(key => ({key, label: key === "" ? "No level" : key === "Innate" ? "Innate" : Number.isFinite(Number(key)) ? `Level ${key}` : key}));
}

const PICKERS = {
    weapon: {
        noun: "weapon", width: 540, inventory: true, groups: RANK_GROUPS, group: rankGroup,
        fields: ["system.weaponType", "system.rank", "system.might", "system.hit", "system.crit", "system.range", "system.uses",
            "system.properties", "system.prfProficient", `flags.${SYSTEM}.monsterWeapon`],
        tabs: weaponTabs,
        tab: data => isMonsterWeapon(data) ? "Monster" : WEAPON_TYPES[text(data.system?.weaponType).toLowerCase()] ?? "Other",
        initial: proficientTab,
        locked: actor => isEnemyUnit(actor) ? {} : {Monster: enemyNote("Monster Weapons")},
        refuse: (actor, source) => isMonsterWeapon(source) && !isEnemyUnit(actor) ? `${source.name} is a Monster Weapon; only Enemy units can carry it.` : "",
        summary(data) {
            const s = data.system ?? {};
            return join([...(text(s.weaponType).toLowerCase() === "staff"
                ? [`${s.might ?? 0} Heal`, s.hit ? `${s.hit}% Hit` : "", `${s.range ?? "—"} Rng`]
                : [`${s.might ?? 0} Mt`, `${s.hit ?? 0}% Hit`, `${s.crit ?? 0}% Crit`, `${s.range ?? "—"} Rng`]).map(esc), usesText(s.uses)]);
        },
        badge(data, actor) {
            let usable = true;
            try { usable = actor.canUseWeapon?.(data) ?? true; } catch { /* partial index data */ }
            return usable ? "" : badge("Can't use", "This unit lacks the weapon rank or proficiency to use it.");
        }
    },
    item: {
        noun: "item", width: 460, inventory: true,
        fields: ["system.itemType", "system.uses", "system.effect"],
        tabs: () => Object.values(ITEM_CATEGORIES),
        tab: data => ITEM_CATEGORIES[data.system?.itemType] ?? "Other",
        summary: data => join([usesText(data.system?.uses), esc(text(data.system?.effect))]),
        title: data => text(data.system?.effect)
    },
    skill: {
        noun: "skill", width: 500, groups: levelGroups, group: data => text(data.system?.level),
        fields: ["system.skillType", "system.level", "system.activation", "system.prerequisites"],
        tabs: () => [...Object.values(SKILL_TABS), "Enemy Only"],
        // The rulebook's Enemy-Only Skills sit in their own compendium folder.
        tab: (data, folder) => ENEMY_ONLY_FOLDER.test(folder) ? "Enemy Only" : SKILL_TABS[text(data.system?.skillType)] ?? "Other",
        locked: actor => isEnemyUnit(actor) ? {} : {"Enemy Only": enemyNote("Enemy-Only Skills")},
        refuse: (actor, source) => ENEMY_ONLY_FOLDER.test(source.folder?.name ?? "") && !isEnemyUnit(actor) ? `${source.name} is an Enemy-Only Skill.` : "",
        summary: data => join([text(data.system?.prerequisites) ? `Requires ${esc(text(data.system.prerequisites))}` : "", esc(text(data.system?.activation))]),
        title: data => join([text(data.system?.prerequisites) ? `Requires ${text(data.system.prerequisites)}` : "", text(data.system?.activation)]),
        badge: (data, actor) => known(actor, "skill", data)
    },
    spell: {
        noun: "spell", width: 500, groups: RANK_GROUPS, group: rankGroup,
        fields: ["system.school", "system.rank", "system.hpCost", "system.might", "system.hit", "system.crit", "system.range", "system.special"],
        tabs: () => SPELL_SCHOOLS,
        tab: data => SPELL_SCHOOLS.includes(text(data.system?.school)) ? text(data.system.school) : "Other",
        summary: data => {
            const s = data.system ?? {};
            return join([`${s.hpCost ?? 0} HP`, `${s.might ?? 0} Mt`, `${s.hit ?? 0}% Hit`, `${s.crit ?? 0}% Crit`, `${s.range || "—"} Rng`, text(s.special)].map(esc));
        },
        title: data => text(data.system?.special),
        badge: (data, actor) => known(actor, "spell", data)
    },
    combatArt: {
        noun: "combat art", width: 540,
        fields: ["system.weaponRestriction", "system.prerequisites", "system.durabilityCost", "system.might", "system.hit", "system.crit",
            "system.avoid", "system.dodge", "system.effect"],
        tabs: entries => ["General", ...Object.values(WEAPON_TYPES).filter(tab => entries.some(e => e.tab === tab))],
        tab: data => WEAPON_TYPES[text(data.system?.weaponRestriction).toLowerCase()] ?? "General",
        initial: proficientTab,
        summary: data => {
            const s = data.system ?? {};
            return join([text(s.prerequisites) ? `Requires ${esc(text(s.prerequisites))}` : "", `${Number(s.durabilityCost) || 0} Dur`,
                signed(s.might, "Mt"), signed(s.hit, "Hit"), signed(s.crit, "Crit"), signed(s.avoid, "Avo"), signed(s.dodge, "Ddg"), esc(text(s.effect))]);
        },
        title: data => join([text(data.system?.prerequisites) ? `Requires ${text(data.system.prerequisites)}` : "", text(data.system?.effect)]),
        badge: (data, actor) => known(actor, "combatArt", data)
    },
    battalion: {
        noun: "battalion", width: 500, groups: RANK_GROUPS, group: rankGroup,
        fields: ["system.rank", "system.endurance", "system.might", "system.hit", "system.crit", "system.range", "system.properties"],
        tabs: () => ["Battalions"],
        tab: () => "Battalions",
        summary: data => {
            const s = data.system ?? {}, attacks = Number(s.might) > 0 || Number(s.hit) > 0;
            return join([attacks ? `${s.might ?? 0} Mt · ${s.hit ?? 0}% Hit · ${s.crit ?? 0}% Crit` : "Support", s.range ? `${esc(s.range)} area` : "Self",
                Number(s.endurance?.max) > 0 ? `${Number(s.endurance.max)} End` : "", esc(note(s.properties))]);
        },
        title: data => note(data.system?.properties),
        badge(data, actor) {
            const reason = battalionUseReason(actor, data);
            return reason ? badge("Can't use", reason) : "";
        }
    }
};

export const hasItemPicker = type => Object.hasOwn(PICKERS, type);

/** Every item of `type` the user can see. A world item hides a compendium item of the same name and tab, so an edited world copy
 * replaces the original; compendium items never hide each other. */
async function itemCatalog(type, actor) {
    const config = PICKERS[type], entries = [], world = new Set();
    const add = (uuid, data, folder, fromWorld = false) => {
        const tab = config.tab(data, folder ?? ""), key = `${data.name}|${tab}`;
        if (fromWorld) world.add(key);
        else if (world.has(key)) return;
        entries.push({uuid, name: data.name, img: data.img, tab, group: config.group?.(data), summary: config.summary(data),
            badge: config.badge?.(data, actor) ?? "", title: config.title?.(data) ?? ""});
    };
    for (const item of game.items ?? []) if (item.type === type && item.visible) add(item.uuid, item, item.folder?.name, true);
    for (const pack of game.packs.filter(p => p.metadata.type === "Item" && p.visible)) {
        let index;
        try { index = await pack.getIndex({fields: config.fields}); } catch { continue; }
        for (const entry of index) if (entry.type === type) add(entry.uuid ?? `Compendium.${pack.collection}.Item.${entry._id}`, entry, pack.folders?.get(entry.folder)?.name);
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolves with the created item, or null. `onBlank` runs when the person asks for a blank one instead. */
export async function openItemPicker(actor, type, {onBlank} = {}) {
    const config = PICKERS[type];
    const entries = await itemCatalog(type, actor);
    const fixed = config.tabs(entries);
    const tabs = [...fixed, ...new Set(entries.map(e => e.tab).filter(tab => !fixed.includes(tab)))];
    const label = config.noun.replace(/\b\w/g, c => c.toUpperCase());
    const choice = await chooseFromCatalog({title: `Choose ${label}`, noun: config.noun, tabs, entries, width: config.width,
        initial: config.initial?.(actor, entries) ?? fixed[0], locked: config.locked?.(actor) ?? {},
        groups: typeof config.groups === "function" ? config.groups(entries) : config.groups ?? null});
    if (!choice) return null;
    if (config.inventory && inventoryUsage(actor).full) return ui.notifications.error(`Inventory full (${INVENTORY_LIMIT} max).`);
    if (choice === "blank") return onBlank?.();
    const source = await fromUuid(choice);
    if (!source) return ui.notifications.error(`Could not load that ${config.noun}.`);
    const refusal = config.refuse?.(actor, source);
    if (refusal) return ui.notifications.warn(refusal);
    const data = source.toObject();
    delete data._id; delete data.folder;
    if (config.inventory) data.system.equipped = false;
    const [created] = await actor.createEmbeddedDocuments("Item", [data]);
    if (created) ui.notifications.info(`Added ${created.name}.`);
    return created;
}
