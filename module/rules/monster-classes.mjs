/** Monster classes and Monster Weapons (Game Master Reference, p. 152–155).
 * The active GM adds them to the system's Classes and Weapons compendiums once, in "Monster" folders. */
const SYSTEM = "fires-of-war";
/** The system's item icon for a monster class or weapon, named after it. */
const itemIcon = (folder, name) => `systems/${SYSTEM}/icons/items/${folder}/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.svg`;
const STATS = ["hp", "strength", "magic", "skill", "speed", "defense", "resistance", "luck", "charm", "build"];
const UNIT_TYPES = ["Infantry", "Mounted", "Flying", "Dragon", "Armored", "Magician", "Beast", "Mechanical", "Monster"];
const WEAPONS = ["sword", "lance", "axe", "bow", "firearm", "unarmed", "knife", "anima", "light", "dark", "staff", "monster", "stone"];

const GROUPS = {
    undead: {label: "Undead", types: ["Monster"]},
    beasts: {label: "Beasts", types: ["Monster", "Beast"]},
    fliers: {label: "Fliers", types: ["Monster", "Flying"]},
    horrors: {label: "Horrors", types: ["Monster"]},
    dragons: {label: "Dragons", types: ["Monster", "Dragon", "Flying"]},
    lord: {label: "Lord of Monsters", types: ["Monster"]}
};

// [name, group, MOV, HP, STR, MAG, DEF, RES, SKL, SPD, BLD, proficiencies, rulebook weapons, innate skills, note]
const TABLE = [
    ["Revenant", "undead", 4, 25, 0, 0, 0, 0, 0, 0, 6, ["monster"], "Rotten Claw", []],
    ["Entombed", "undead", 5, 40, 6, 0, 4, 0, 0, 0, 10, ["monster"], "Fetid Claw", []],
    ["Bonewalker", "undead", 5, 20, 4, 0, 3, 0, 2, 3, 6, ["sword", "lance", "bow"], "Sword, Lance, Bow", [], "Proficient in only one of Sword, Lance or Bow, and receives the corresponding weapon: uncheck the other two."],
    ["Wight", "undead", 5, 30, 8, 0, 6, 2, 5, 5, 8, ["sword", "lance", "bow"], "Sword, Lance, Bow", [], "Proficient in only one of Sword, Lance or Bow, and receives the corresponding weapon: uncheck the other two."],
    ["Mauthedoog", "beasts", 6, 24, 5, 0, 2, 0, 4, 7, 6, ["monster"], "Fiery Fang", ["Canto"]],
    ["Gwyllgi", "beasts", 7, 35, 10, 0, 5, 2, 7, 10, 8, ["monster"], "Hellfang", ["Canto"]],
    ["Bael", "beasts", 5, 40, 10, 0, 8, 0, 2, 3, 14, ["monster"], "Poison Claw", ["Mountain Stride"]],
    ["Elder Bael", "beasts", 5, 60, 16, 0, 12, 2, 4, 4, 18, ["monster"], "Lethal Talon", ["Mountain Stride", "Great Shield"]],
    ["Tarvos", "beasts", 7, 35, 9, 0, 6, 0, 5, 6, 10, ["axe"], "Axe", ["Canto"]],
    ["Maelduin", "beasts", 8, 45, 14, 0, 8, 2, 8, 9, 12, ["axe", "bow"], "Axe, Bow", ["Canto", "Axefaire"]],
    ["Gargoyle", "fliers", 6, 26, 8, 0, 6, 0, 3, 6, 8, ["lance"], "Lance", ["Canto"]],
    ["Deathgoyle", "fliers", 7, 38, 14, 0, 10, 4, 6, 8, 10, ["lance"], "Lance", ["Canto"]],
    ["Mogall", "fliers", 6, 18, 0, 6, 0, 4, 4, 5, 4, ["monster", "dark"], "Eye", [], "Its monster weapon is Dark, so it is also proficient in Dark."],
    ["Arch Mogall", "fliers", 6, 28, 0, 12, 2, 8, 8, 7, 6, ["monster", "dark"], "Eye", ["Shadowgift"], "Its monster weapon is Dark, so it is also proficient in Dark."],
    ["Gorgon", "horrors", 5, 32, 0, 10, 4, 8, 6, 3, 8, ["monster", "dark"], "Demon Surge, Stone", [], "Its monster weapons are Dark, so it is also proficient in Dark."],
    ["Cyclops", "horrors", 5, 50, 14, 0, 10, 0, 2, 2, 16, ["axe", "monster"], "Axe, Rock", ["Mountain Stride"]],
    ["Draco Zombie", "dragons", 5, 53, 1, 14, 12, 12, 0, 1, 25, ["monster"], "Wretched Air", ["Fierce Mien", "Pavise", "Seal Movement", "Silence Ward"]],
    ["Fire Dragon", "dragons", 4, 60, 16, 10, 14, 8, 4, 2, 20, ["stone"], "Dragonstone", ["Pavise"]],
    ["Ice Dragon", "dragons", 5, 50, 8, 16, 10, 14, 6, 4, 18, ["stone"], "Dragonstone", ["Aegis", "Canto"]],
    ["Formortiis", "lord", 3, 80, 18, 18, 18, 18, 10, 4, 30, ["monster", "anima", "light", "dark", "staff"], "Ravager, Demon Light, Nightmare", ["Mantle", "Quintessence", "Renewal"],
        "Has Ravager, Demon Light (Dark) and Nightmare (Staff) by default, and is proficient in all magic types."]
];

export const MONSTER_CLASSES = Object.freeze(TABLE.map(([name, group, movement, hp, strength, magic, defense, resistance, skill, speed, build, proficiencies, weapons, skills, note]) => {
    const base = {hp, strength, magic, skill, speed, defense, resistance, luck: 0, charm: 0, build};
    return Object.freeze({name, group: GROUPS[group].label, unitTypes: GROUPS[group].types, movement, baseStats: base, proficiencies, weapons, skills, note: note ?? ""});
}));

// [name, type, Mt, Hit, Crit, Wt, Rng, stat bonuses, properties, notes]
export const MONSTER_WEAPONS = Object.freeze([
    ["Rotten Claw", "monster", 7, 80, 0, 8, "1"],
    ["Sharp Claw", "monster", 14, 65, 0, 14, "1"],
    ["Fetid Claw", "monster", 12, 75, 0, 10, "1"],
    ["Poison Claw", "monster", 6, 65, 0, 10, "1", {}, {poison: true}],
    ["Lethal Talon", "monster", 10, 60, 0, 12, "1", {}, {poison: true}],
    ["Fiery Fang", "monster", 5, 90, 0, 5, "1"],
    ["Hellfang", "monster", 13, 80, 0, 8, "1"],
    ["Wretched Air", "monster", 10, 100, 0, 0, "1-2", {strength: 10, magic: 10, skill: 10, defense: 20, resistance: 10}, {magical: true, piercing: true}],
    ["Demon Light", "dark", 15, 65, 0, 0, "1-3", {magic: 10, skill: 10, luck: 10, defense: 10, resistance: 15}, {magical: true}],
    ["Ravager", "monster", 15, 85, 10, 0, "1", {strength: 15, skill: 15, defense: 15, resistance: 10}],
    ["Nightmare", "staff", 0, 70, 0, 0, "1-3", {}, {}, "Inflicts Sleep on all foes within range for 5 turns."],
    ["Fire Breath", "monster", 12, 80, 0, 5, "1-3", {}, {magical: true, piercing: true}],
    ["Slam", "monster", 8, 80, 0, 10, "1"],
    ["Rock", "monster", 14, 80, 0, 20, "1-5", {}, {unwieldy: true, slow: true}]
].map(([name, weaponType, might, hit, crit, weight, range, bonuses = {}, properties = {}, notes = ""]) => Object.freeze({name, weaponType, might, hit, crit, weight, range, bonuses, properties, notes})));

const zeros = keys => Object.fromEntries(keys.map(key => [key, 0]));
const flags = keys => Object.fromEntries(keys.map(key => [key, false]));

/** Class item data for one monster; `skills` maps skill names to compendium skill documents. */
export function monsterClassData(monster, skills = new Map()) {
    const unitTypes = flags(UNIT_TYPES), weaponProficiencies = flags(WEAPONS);
    for (const type of monster.unitTypes) unitTypes[type] = true;
    for (const weapon of monster.proficiencies) weaponProficiencies[weapon] = true;
    const classSkills = monster.skills.map(name => skills.get(name)).filter(Boolean).map(skill => ({id: foundry.utils.randomID(), level: "Innate",
        skillData: {name: skill.name, img: skill.img, system: foundry.utils.deepClone(skill.system)}}));
    const description = `<p>${monster.group} monster. Weapons: ${monster.weapons}.${monster.skills.length ? ` Innate skills: ${monster.skills.join(", ")}.` : ""}</p>`
        + (monster.note ? `<p>${monster.note}</p>` : "")
        + "<p>Monster stat caps: 80 HP and 30 in every other stat; S Rank in proficient weapon groups; Level 30. The rulebook gives monsters no growth rates: level them with the Static Growth Bonus table, or set growths here.</p>";
    return {name: monster.name, type: "class", img: itemIcon("classes", monster.name), flags: {[SYSTEM]: {monsterClass: true}},
        system: {description, classType: "Monster", maxLevel: 30, movement: monster.movement, unitTypes, weaponProficiencies,
            baseStats: {...monster.baseStats}, growthRates: zeros(STATS), statCaps: {...Object.fromEntries(STATS.map(key => [key, 30])), hp: 80},
            classSkills, roleplayTraits: [{base: "", alternative: ""}, {base: "", alternative: ""}, {base: "", alternative: ""}], promotions: []}};
}

/** Monster Weapons: no rank, never lose durability (0/0 uses) and cannot be traded. */
export function monsterWeaponData(weapon) {
    const props = {illegal: false, legendary: false, slayer: {enabled: false, all: false, types: {}}, cursed: false, shade: false, deadly: false, magical: false,
        unwieldy: false, slow: false, mechanical: false, abuse: false, absorb: false, puncture: false, piercing: false, brave: false, poison: false,
        reverse: false, superior: false, smash: false, crippling: false, vehicle: false, petrify: false, ...weapon.properties};
    const notes = [...Object.entries(weapon.properties).filter(([, on]) => on).map(([key]) => key[0].toUpperCase() + key.slice(1)), weapon.notes].filter(Boolean).join(", ");
    return {name: weapon.name, type: "weapon", img: itemIcon("weapons", weapon.name),
        flags: {[SYSTEM]: {monsterWeapon: true}},
        system: {description: `<p>Monster Weapon: cannot be traded or looted, never loses durability and has no Weapon Rank.${weapon.notes ? ` ${weapon.notes}` : ""}</p>`,
            weaponType: weapon.weaponType, might: weapon.might, hit: weapon.hit, crit: weapon.crit, weight: weapon.weight, range: weapon.range,
            rank: "", uses: {value: 0, max: 0}, price: 0, properties: props, propertiesNotes: notes,
            bonuses: {attributes: {...zeros(STATS), move: 0, ...weapon.bonuses}}}};
}

/** A weapon that belongs to its monster: flagged Monster Weapons and the monster weapon type. */
export const isMonsterWeapon = item => item?.type === "weapon" && (!!item.flags?.[SYSTEM]?.monsterWeapon ||
    String(item.system?.weaponType ?? "").trim().toLowerCase() === "monster");

async function ensureFolder(pack, name) {
    const existing = pack.folders.find(folder => folder.name === name);
    if (existing) return {folder: existing, created: false};
    const folder = await Folder.implementation.create({name, type: "Item", sorting: "a"}, {pack: pack.collection});
    return {folder, created: true};
}

/** Adds any missing monster classes and weapons once; a deleted "Monster" folder is treated as "add them again". */
export async function seedMonsterContent() {
    if (game.users.activeGM?.id !== game.user.id) return;
    const classes = game.packs.get(`${SYSTEM}.classes`), weapons = game.packs.get(`${SYSTEM}.weapons`), skillPack = game.packs.get(`${SYSTEM}.skills`);
    if (!classes || !weapons) return;
    if (classes.folders.some(folder => folder.name === "Monster") && weapons.folders.some(folder => folder.name === "Monster")) return;
    const unlock = async pack => { const locked = pack.locked; if (locked) await pack.configure({locked: false}); return locked; };
    const classLocked = await unlock(classes), weaponLocked = await unlock(weapons);
    try {
        const skillNames = new Set(MONSTER_CLASSES.flatMap(monster => monster.skills));
        const skills = new Map();
        if (skillPack) for (const entry of skillPack.index.filter(e => skillNames.has(e.name))) skills.set(entry.name, await skillPack.getDocument(entry._id));
        const classFolder = await ensureFolder(classes, "Monster");
        if (classFolder.created) {
            const present = new Set(classes.index.map(e => e.name));
            const data = MONSTER_CLASSES.filter(m => !present.has(m.name)).map(m => ({...monsterClassData(m, skills), folder: classFolder.folder.id}));
            if (data.length) await Item.implementation.createDocuments(data, {pack: classes.collection});
        }
        const weaponFolder = await ensureFolder(weapons, "Monster");
        if (weaponFolder.created) {
            const present = new Set(weapons.index.map(e => e.name));
            const data = MONSTER_WEAPONS.filter(w => !present.has(w.name)).map(w => ({...monsterWeaponData(w), folder: weaponFolder.folder.id}));
            if (data.length) await Item.implementation.createDocuments(data, {pack: weapons.collection});
        }
        ui.notifications.info("Fires of War: added the rulebook's Monster classes and Monster Weapons to the system compendiums.");
    } catch (error) {
        console.error("FEUE | Adding monster content failed", error);
    } finally {
        if (classLocked) await classes.configure({locked: true});
        if (weaponLocked) await weapons.configure({locked: true});
    }
}
