/** Skill name matching shared by rules, terrain and movement. */
import {revivalSkillOpen} from "../rules/alt-rules.mjs";
const ALIASES = Object.freeze({
    acrobatic: "acrobat",
    "sword and pistol": "sword & pistol",
    "lockpick use": "lockpick usage",
    "lockpicks usage": "lockpick usage",
    "mighty king": "mighty king of legend"
});
const STATS = {str: "strength", mag: "magic", skl: "skill", spd: "speed", def: "defense", res: "resistance", lck: "luck", luk: "luck", cha: "charm", move: "movement", mov: "movement"};

/** Normalize case, spacing and bracket styles: "Critical (Axe) +15" and "Critical [Axe] +15" are the same skill. */
export function canonicalSkillName(value) {
    const name = String(value ?? "").trim().toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ");
    const critical = name.match(/^critical\s*[[(]?\s*([a-z]+)\s*[\])]?\s*\+\s*(\d+)$/);
    if (critical) return `critical [${critical[1]}] +${critical[2]}`;
    const tagged = name.match(/^(rally|seal)\s*[[(]?\s*([a-z]+)\s*[\])]?$/);
    if (tagged) return `${tagged[1]} ${STATS[tagged[2]] ?? tagged[2]}`;
    const range = name.match(/^(bow|firearm)\s+range\s*\+\s*(\d+)$/);
    if (range) return `${range[1]} range +${range[2]}`;
    return ALIASES[name] ?? name;
}

export const skillName = item => canonicalSkillName(item?.name);
/** Automation "Off" and Revival Stone locks (Empowering Revival) both remove a skill from play. */
export const skillEnabled = item => item?.type === "skill" && item.system?.automation?.mode !== "off" && revivalSkillOpen(item);

/** Whether an actor owns an enabled skill with this (case/alias-insensitive) name. */
export function hasSkill(actor, name) {
    const wanted = canonicalSkillName(name);
    return Array.from(actor?.items ?? []).some(item => skillEnabled(item) && skillName(item) === wanted);
}

export function findSkill(actor, name) {
    const wanted = canonicalSkillName(name);
    return Array.from(actor?.items ?? []).find(item => skillEnabled(item) && skillName(item) === wanted) ?? null;
}
