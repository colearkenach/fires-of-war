/** The tabbed, searchable "choose an existing one" dialog behind the character sheet's Add buttons (classes, weapons, items,
 * skills, spells, combat arts, battalions and support partners).
 * Styles live in styles/class-ui.css (linked by registerClassUI). */
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));

/**
 * Resolves with the chosen UUID, "blank" when the person asks for a blank document instead, or null.
 * `entries` are `{uuid, name, img, tab, summary, badge?, title?, group?}`; `summary` and `badge` (shown beside the name) are
 * trusted HTML. Entries in a `locked` tab are shown but cannot be chosen, under that tab's note (trusted HTML). With `groups`
 * (`[{key, label}]`, in display order), each tab lists its entries in collapsed sections by `entry.group`; searching opens the
 * sections that match. `footer` is trusted HTML shown under the list; `onConfirm(root)` reads it when a choice is confirmed.
 */
export function chooseFromCatalog({title, noun, plural = `${noun}s`, tabs, entries, initial, locked = {}, groups = null,
    footer = "", onConfirm, blankLabel = `Create a blank ${noun} instead`, width = 440, height = 600}) {
    const byTab = Object.fromEntries(tabs.map(tab => [tab, entries.filter(e => e.tab === tab)]));
    const start = byTab[initial]?.length ? initial : tabs.find(tab => byTab[tab].length) ?? tabs[0];
    const list = tab => {
        const note = locked[tab];
        const rows = items => items.map(e => `<li><label class="feue-catalog-option${note ? " locked" : ""}" data-name="${esc(e.name.toLowerCase())}"${e.title ? ` title="${esc(e.title)}"` : ""}>
            <img src="${esc(e.img || "icons/svg/item-bag.svg")}" alt=""><span class="feue-catalog-option-text"><b>${esc(e.name)}${e.badge ? ` ${e.badge}` : ""}</b>${e.summary ? `<small>${e.summary}</small>` : ""}</span>
            <input type="radio" name="feue-catalog-choice" value="${esc(e.uuid)}" ${note ? "disabled" : ""} aria-label="${esc(e.name)}"></label></li>`).join("");
        const empty = `<ul class="feue-catalog-list"><li class="feue-catalog-empty">No ${esc(plural)} of this type.</li></ul>`;
        const body = !groups ? `<ul class="feue-catalog-list" role="radiogroup" aria-label="${esc(tab)} ${esc(plural)}">${rows(byTab[tab])}</ul>`
            : groups.map(({key, label}) => {
                const items = byTab[tab].filter(e => e.group === key);
                return items.length ? `<details class="feue-catalog-group" data-group="${esc(key)}"><summary>${esc(label)} <span>${items.length}</span></summary>
                    <ul class="feue-catalog-list" role="radiogroup" aria-label="${esc(tab)} ${esc(label)} ${esc(plural)}">${rows(items)}</ul></details>` : "";
            }).join("");
        return `<div class="feue-catalog-panel" data-tab="${esc(tab)}" role="tabpanel" ${tab === start ? "" : "hidden"}>
            ${note ? `<p class="feue-catalog-locked-note"><i class="fas fa-lock"></i> ${note}</p>` : ""}
            ${byTab[tab].length ? body : empty}</div>`;
    };
    const content = `<div class="feue-catalog-picker-body">
        <input type="search" class="feue-catalog-search" placeholder="Search ${esc(plural)}..." aria-label="Search ${esc(plural)}">
        ${tabs.length > 1 ? `<nav class="feue-catalog-tabs" role="tablist">${tabs.map(tab => `<button type="button" role="tab" data-tab="${esc(tab)}" aria-selected="${tab === start}">${esc(tab)} <span>${byTab[tab].length}</span></button>`).join("")}</nav>` : ""}
        ${tabs.map(list).join("")}
        ${footer}
        <button type="button" class="feue-catalog-blank"><i class="fas fa-plus"></i> ${esc(blankLabel)}</button></div>`;
    return new Promise(resolve => {
        let result = null;
        const dialog = new Dialog({title, content,
            buttons: {confirm: {icon: '<i class="fas fa-check"></i>', label: "Confirm", callback: html => {
                const root = html[0] ?? html;
                result = root.querySelector('input[name="feue-catalog-choice"]:checked')?.value ?? null;
                if (!result) return ui.notifications.warn(`Choose a ${noun} first.`);
                onConfirm?.(root);
            }}, cancel: {label: "Cancel"}},
            default: "confirm",
            render: html => {
                const root = html[0] ?? html;
                let current = start;
                const show = tab => {
                    current = tab;
                    root.querySelectorAll(".feue-catalog-tabs [data-tab]").forEach(button => button.setAttribute("aria-selected", String(button.dataset.tab === tab)));
                    root.querySelectorAll(".feue-catalog-panel").forEach(panel => { panel.hidden = panel.dataset.tab !== tab; });
                };
                root.querySelectorAll(".feue-catalog-tabs [data-tab]").forEach(button => button.addEventListener("click", () => show(button.dataset.tab)));
                root.querySelector(".feue-catalog-search").addEventListener("input", event => {
                    const query = event.target.value.trim().toLowerCase();
                    const counts = {};
                    for (const panel of root.querySelectorAll(".feue-catalog-panel")) {
                        let shown = 0;
                        for (const option of panel.querySelectorAll(".feue-catalog-option")) {
                            const match = !query || option.dataset.name.includes(query);
                            option.parentElement.hidden = !match;
                            shown += match;
                        }
                        // Searching opens every section with a match; clearing the search puts sections back as the person left them.
                        for (const group of panel.querySelectorAll(".feue-catalog-group")) {
                            const matches = group.querySelectorAll("li:not([hidden]) > .feue-catalog-option").length;
                            group.hidden = !matches;
                            group.querySelector("summary span").textContent = String(matches);
                            if (query) {
                                group.dataset.userOpen ??= String(group.open);
                                group.open = true;
                            } else if (group.dataset.userOpen) {
                                group.open = group.dataset.userOpen === "true";
                                delete group.dataset.userOpen;
                            }
                        }
                        counts[panel.dataset.tab] = shown;
                        const count = root.querySelector(`.feue-catalog-tabs [data-tab="${CSS.escape(panel.dataset.tab)}"] span`);
                        if (count) count.textContent = String(shown);
                    }
                    // Follow the search to a tab that has matches, so a name typed on the wrong tab still turns up.
                    if (query && !counts[current]) {
                        const next = tabs.find(tab => counts[tab]);
                        if (next) show(next);
                    }
                });
                root.querySelectorAll(".feue-catalog-option:not(.locked)").forEach(option => option.addEventListener("dblclick", () => {
                    option.querySelector("input").checked = true;
                    root.closest(".app")?.querySelector('[data-button="confirm"]')?.click();
                }));
                root.querySelector(".feue-catalog-blank").addEventListener("click", () => { result = "blank"; dialog.close(); });
            },
            close: () => resolve(result)}, {classes: ["dialog", "feue-catalog-picker"], width, height, resizable: true});
        dialog.render(true);
    });
}
