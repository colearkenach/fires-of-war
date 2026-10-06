/** The character sheet's Add Support: choose a partner from the world's characters (their Affinity fills in), or add one by name. */
import {chooseFromCatalog} from "../ui/catalog-picker.mjs";
import {ALLEGIANCE_CHOICES, actorAllegiance} from "./allegiance-ui.mjs";
import {baseActorId} from "./convoy.mjs";

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));
const nameKey = name => String(name ?? "").trim().toLowerCase();
const options = (values, first = "") => `${first}${values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join("")}`;

const addSupport = (actor, data) => actor.update({[`system.supportRanks.${foundry.utils.randomID()}`]: data});

/** Fields shared by the picker footer and the by-name form; `partnerAffinity` adds a "use the partner's own" choice. */
function supportFields({affinities, ranks}, {name = false, partnerAffinity = false} = {}) {
    return `<div class="feue-catalog-fields">
        ${name ? '<label class="wide">Partner name <input type="text" data-field="name" placeholder="Character name" autocomplete="off"></label>' : ""}
        <label>Starting rank <select data-field="rank">${options(ranks)}</select></label>
        <label>Affinity <select data-field="affinity">${options(affinities, partnerAffinity ? '<option value="">Partner\'s own</option>' : "")}</select></label></div>`;
}
const readFields = root => Object.fromEntries([...root.querySelectorAll("[data-field]")].map(el => [el.dataset.field, el.value.trim()]));

function supportByName(actor, config) {
    return new Promise(resolve => {
        let values = null;
        new Dialog({title: "Add Support Partner", content: `<div class="feue-catalog-picker-body feue-catalog-form">
                <p class="feue-catalog-hint">For a partner who is not a character in this world.</p>${supportFields(config, {name: true})}</div>`,
            buttons: {confirm: {icon: '<i class="fas fa-plus"></i>', label: "Add", callback: html => {
                values = readFields(html[0] ?? html);
                if (!values.name) { values = null; ui.notifications.warn("Enter the partner's name."); }
            }}, cancel: {label: "Cancel"}},
            default: "confirm",
            render: html => (html[0] ?? html).querySelector('[data-field="name"]')?.focus(),
            close: () => resolve(values)}, {classes: ["dialog", "feue-catalog-picker"], width: 380}).render(true);
    }).then(values => values ? addSupport(actor, values) : null);
}

/** `affinities` and `ranks` are the system's Affinity and Support Rank lists. Resolves once the partner is added, or with null. */
export async function openSupportPicker(actor, {affinities, ranks}) {
    const config = {affinities, ranks};
    const self = baseActorId(actor);
    const taken = new Set(Object.values(actor.system.supportRanks ?? {}).map(support => nameKey(support.name)));
    const tabOf = Object.fromEntries(ALLEGIANCE_CHOICES.map(choice => [choice.id, choice.label]));
    const entries = (game.actors ?? []).filter(other => other.type === "character" && other.id !== self && other.visible && !taken.has(nameKey(other.name)))
        .map(other => {
            const affinity = other.system.affinity, className = other.system.activeClassName;
            return {uuid: other.uuid, name: other.name, img: other.img, tab: tabOf[actorAllegiance(other)] ?? "Other",
                summary: [`Lv ${Number(other.system.level) || 1}${className ? ` ${esc(className)}` : ""}`,
                    affinity ? `${esc(affinity)} affinity` : '<span class="feue-catalog-warn">No affinity set</span>'].join(" · ")};
        }).sort((a, b) => a.name.localeCompare(b.name));
    let fields = {};
    const choice = await chooseFromCatalog({title: "Choose Support Partner", noun: "partner", tabs: Object.values(tabOf), entries,
        initial: tabOf[actorAllegiance(actor)], footer: supportFields(config, {partnerAffinity: true}), onConfirm: root => { fields = readFields(root); },
        blankLabel: "Add a partner by name instead"});
    if (choice === "blank") return supportByName(actor, config);
    if (!choice) return null;
    const partner = await fromUuid(choice);
    if (!partner) return ui.notifications.error("Could not load that character.");
    return addSupport(actor, {name: partner.name, affinity: fields.affinity || partner.system.affinity || "", rank: fields.rank || ranks[0]});
}
