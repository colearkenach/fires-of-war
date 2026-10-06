/** A character's allegiance (Player, Neutral, Enemy, Other) is stored on its prototype token as the token disposition,
 * plus an explicit flag for Other. It can be chosen when the character is created and changed on its sheet. */
const SYSTEM = "fires-of-war";
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));

export const ALLEGIANCE_CHOICES = Object.freeze([
    Object.freeze({id: "player", label: "Player", disposition: 1, hint: "Friendly: acts in the Player Phase."}),
    Object.freeze({id: "npc", label: "Neutral", disposition: 0, hint: "Acts in the Neutral Phase."}),
    Object.freeze({id: "enemy", label: "Enemy", disposition: -1, hint: "Hostile: acts in the Enemy Phase."}),
    Object.freeze({id: "other", label: "Other", disposition: 0, hint: "A third party: acts in the Other Phase."})
]);
const BY_DISPOSITION = {1: "player", 0: "npc", [-1]: "enemy", [-2]: "other"};

/** The allegiance a token (or prototype token) data object represents. */
export function tokenDataAllegiance(token) {
    const flag = token?.flags?.[SYSTEM]?.allegiance;
    if (ALLEGIANCE_CHOICES.some(choice => choice.id === flag)) return flag;
    return BY_DISPOSITION[Number(token?.disposition ?? -1)] ?? "enemy";
}
export const actorAllegiance = actor => tokenDataAllegiance(actor?.isToken ? actor.token : actor?.prototypeToken);
export const isEnemyUnit = actor => actorAllegiance(actor) === "enemy";

/** Token changes for an allegiance; only Other needs the flag, which otherwise yields to the disposition. */
export function allegianceChanges(id) {
    const choice = ALLEGIANCE_CHOICES.find(c => c.id === id) ?? ALLEGIANCE_CHOICES[2];
    return {disposition: choice.disposition, [`flags.${SYSTEM}.allegiance`]: choice.id === "other" ? "other" : null};
}

/** Update the prototype token and every placed token of a linked character (or the token of an unlinked one). */
export async function setActorAllegiance(actor, id) {
    const changes = allegianceChanges(id);
    if (actor.isToken) return actor.token.update(changes);
    await actor.update(Object.fromEntries(Object.entries(changes).map(([key, value]) => [`prototypeToken.${key}`, value])));
    for (const token of actor.getDependentTokens?.({linked: true}) ?? []) {
        try { await token.update(changes); }
        catch (error) { console.warn(`FEUE | Could not update ${token.name}'s allegiance`, error); }
    }
}

export function allegianceOptions(selected) {
    return ALLEGIANCE_CHOICES.map(choice => `<option value="${choice.id}" ${choice.id === selected ? "selected" : ""} title="${esc(choice.hint)}">${esc(choice.label)}</option>`).join("");
}

/** Adds an Allegiance field to Foundry's "Create Actor" dialog for characters; the last choice is remembered per client. */
function addCreationField(app, element) {
    const root = element instanceof HTMLElement ? element : element?.[0];
    const type = root?.querySelector('form select[name="type"]');
    const values = Array.from(type?.options ?? [], option => option.value);
    if (!type || !values.includes("character") || !values.includes("party") || root.querySelector(".feue-create-allegiance")) return;
    let remembered = "player";
    try { remembered = game.settings.get(SYSTEM, "lastCreateAllegiance") || "player"; } catch { /* not registered yet */ }
    const group = document.createElement("div");
    group.className = "form-group feue-create-allegiance";
    group.innerHTML = `<label>Allegiance</label><div class="form-fields"><select class="feue-allegiance-choice">${allegianceOptions(remembered)}</select>
        <input type="hidden" name="prototypeToken.disposition" data-dtype="Number"><input type="hidden" name="prototypeToken.flags.${SYSTEM}.allegiance"></div>
        <p class="hint">Sets the phase this character acts in. Change it later on the character sheet.</p>`;
    (type.closest(".form-group") ?? type).after(group);
    const choice = group.querySelector("select"), [disposition, flag] = group.querySelectorAll("input");
    const sync = () => {
        const isCharacter = type.value === "character";
        group.hidden = !isCharacter;
        for (const input of [choice, disposition, flag]) input.disabled = !isCharacter;
        const changes = allegianceChanges(choice.value);
        disposition.value = String(changes.disposition);
        flag.value = changes[`flags.${SYSTEM}.allegiance`] ?? "";
    };
    choice.addEventListener("change", () => { sync(); void game.settings.set(SYSTEM, "lastCreateAllegiance", choice.value).catch(() => {}); });
    type.addEventListener("change", sync);
    sync();
    app.setPosition?.({height: "auto"});
}

export function registerAllegianceUI() {
    Hooks.once("init", () => game.settings.register(SYSTEM, "lastCreateAllegiance", {scope: "client", config: false, type: String, default: "player"}));
    Hooks.on("renderDialogV2", addCreationField);
    // v12 still uses the v1 Dialog for document creation.
    Hooks.on("renderDialog", addCreationField);
}
