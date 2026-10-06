/** "Player Phase" / "Enemy Phase" banner, shown on every client when an allegiance's phase begins, with an optional sound. */
import {allegianceOf} from "./encounter-rules.mjs";

const SYSTEM = "fires-of-war";
export const PHASE_SOUNDS = Object.freeze({player: "Player", npc: "Neutral", enemy: "Enemy", other: "Other"});
const soundKey = id => `phaseSound${{player: "Player", npc: "Neutral", enemy: "Enemy"}[id] ?? "Other"}`;
export const PHASE_BANNER_DURATION = 2200;
const setting = (key, fallback) => { try { return game.settings.get(SYSTEM, key) ?? fallback; } catch { return fallback; } };

/** Banner colours by default allegiance; custom allegiances use Other. */
export const phaseStyle = id => ["player", "npc", "enemy"].includes(id) ? id : "other";

/** The phase the combat is now in, or null before it starts. */
export function currentPhase(combat) {
    if (!combat?.started || !combat.combatant) return null;
    const group = allegianceOf(combat.combatant, combat);
    return {id: group.id, name: group.name, stamp: `${combat.id}:${combat.round}:${group.id}`};
}

export function showPhaseBanner({id, name}) {
    document.getElementById("feue-phase-banner")?.remove();
    const banner = document.createElement("div");
    banner.id = "feue-phase-banner";
    banner.className = `feue-phase-${phaseStyle(id)}`;
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");
    banner.style.setProperty("--feue-phase-duration", `${PHASE_BANNER_DURATION}ms`);
    const label = document.createElement("span");
    label.textContent = /\bphase$/i.test(String(name).trim()) ? name : `${name} Phase`;
    banner.append(label);
    document.body.append(banner);
    setTimeout(() => banner.remove(), PHASE_BANNER_DURATION);
    return banner;
}

export function playPhaseSound(id) {
    const src = setting(soundKey(phaseStyle(id)), "");
    if (!src) return null;
    const volume = Math.max(0, Math.min(1, Number(setting("phaseSoundVolume", 0.8))));
    const Audio = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
    // Each client reacts to the same combat update, so the sound is played locally rather than broadcast.
    return Audio?.play({src, volume, autoplay: true, loop: false}, false);
}

export function registerPhaseBanner() {
    let announced = null;
    Hooks.once("init", () => {
        game.settings.register(SYSTEM, "phaseBanner", {name: "Phase Announcements", scope: "client", config: true, type: Boolean, default: true,
            hint: "Show a \"Player Phase\" / \"Enemy Phase\" banner when an allegiance's phase begins in the encounter you are viewing."});
        game.settings.register(SYSTEM, "phaseSoundVolume", {name: "Phase Sound Volume", scope: "client", config: true, type: Number, default: 0.8,
            range: {min: 0, max: 1, step: 0.05}, hint: "Volume of the phase announcement sounds on this client."});
        for (const [id, label] of Object.entries(PHASE_SOUNDS)) {
            game.settings.register(SYSTEM, soundKey(id), {name: `${label} Phase Sound`, scope: "world", config: true, type: String, default: "",
                filePicker: "audio", hint: `Sound played on every client when ${id === "other" ? "the Other phase or a custom allegiance's phase" : `the ${label} phase`} begins. Leave blank for silence.`});
        }
    });
    const announce = combat => {
        const phase = currentPhase(combat);
        if (!phase || phase.stamp === announced) return;
        announced = phase.stamp;
        if (combat !== game.combat) return;
        if (setting("phaseBanner", true)) showPhaseBanner(phase);
        playPhaseSound(phase.id);
    };
    Hooks.on("updateCombat", (combat, changes) => {
        if (!("turn" in changes || "round" in changes)) return;
        announce(combat);
    });
    // Remember the current phase on load so a reload does not replay it; a deleted encounter resets.
    Hooks.once("ready", () => { announced = currentPhase(game.combat)?.stamp ?? null; });
    Hooks.on("deleteCombat", () => { announced = null; });
}
