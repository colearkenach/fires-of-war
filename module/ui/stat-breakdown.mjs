/** Bonus/penalty ledgers. A displayed total is always the sum of its terms, so its tooltip explains the exact number. */
export const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"}[c]));
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
export const signed = (value, suffix = "") => `${value < 0 ? "−" : "+"}${Math.abs(num(value))}${suffix}`;
const fraction = mult => ({0.5: "½", 0.25: "¼", 0.75: "¾", 1.5: "1½"})[mult] ?? String(mult);

/**
 * kind: "base" (shown unsigned), "add" (default), "mult" (×value, applied by the caller), "set" (= value),
 * "info" (text only). Only base/add terms are summed.
 */
export function term(label, value = 0, kind = "add", extra = {}) {
    return {label: String(label ?? ""), value: kind === "info" ? 0 : num(value), kind, ...extra};
}
export const sumTerms = terms => (terms ?? []).reduce((total, t) => total + (["base", "add"].includes(t.kind ?? "add") ? num(t.value) : 0), 0);
/** Drop zero additive terms, which only add noise to a tooltip. */
export const visibleTerms = terms => (terms ?? []).filter(t => (t.kind ?? "add") !== "add" || num(t.value) !== 0);

function termValue(t, suffix) {
    if (t.kind === "base") return `${num(t.value)}${suffix}`;
    if (t.kind === "mult") return `×${fraction(t.value)}`;
    if (t.kind === "set") return `= ${num(t.value)}${suffix}`;
    if (t.kind === "info") return t.text ?? "";
    return signed(t.value, suffix);
}

/**
 * Render a tooltip table. `situational` lists modifiers that depend on the opponent or circumstances:
 * {label, text, active} — active entries apply now; inactive ones show their condition.
 */
export function breakdownHtml({title, total, suffix = "", terms = [], situational = [], notes = [], footer = ""}) {
    const rows = visibleTerms(terms).map(t => {
        const tone = t.kind === "add" ? num(t.value) < 0 ? " penalty" : " bonus" : t.kind === "mult" || t.kind === "set" ? ` ${num(t.value) < 1 ? "penalty" : "bonus"}` : "";
        return `<tr class="${esc(t.kind)}${tone}"><td>${esc(t.label)}</td><td>${esc(termValue(t, suffix))}</td></tr>`;
    }).join("");
    const extra = situational.length ? `<div class="feue-breakdown-section">Situational</div><ul>${situational.map(s =>
        `<li class="${s.active ? "active" : "inactive"}"><span>${esc(s.label)}</span>${s.text ? ` <small>${esc(s.text)}</small>` : ""}</li>`).join("")}</ul>` : "";
    const noteHtml = notes.filter(Boolean).map(note => `<p>${esc(note)}</p>`).join("");
    return `<div class="feue-breakdown"><header><span>${esc(title)}</span><strong>${esc(total)}${esc(suffix)}</strong></header>${rows ? `<table>${rows}</table>` : ""}${extra}${noteHtml}${footer ? `<footer>${esc(footer)}</footer>` : ""}</div>`;
}

/** Several labelled sub-ledgers (e.g. attacker Hit, then target Avoid) leading to one final value. */
export function sectionsHtml({title, total, suffix = "", sections = [], notes = []}) {
    const body = sections.filter(section => visibleTerms(section.terms).length || section.always).map(section => {
        const rows = visibleTerms(section.terms).map(t => {
            const tone = (t.kind ?? "add") === "add" ? num(t.value) < 0 ? " penalty" : " bonus" : ["mult", "set"].includes(t.kind) ? ` ${num(t.value) < 1 ? "penalty" : "bonus"}` : "";
            return `<tr class="${esc(t.kind ?? "add")}${tone}"><td>${esc(t.label)}</td><td>${esc(termValue(t, section.suffix ?? suffix))}</td></tr>`;
        }).join("");
        const sign = section.sign === "-" ? "−" : "";
        return `<div class="feue-breakdown-section">${esc(section.heading)}${section.total !== undefined ? `<span>${sign}${esc(section.total)}${esc(section.suffix ?? suffix)}</span>` : ""}</div>${rows ? `<table>${rows}</table>` : ""}`;
    }).join("");
    const noteHtml = notes.filter(Boolean).map(note => `<p>${esc(note)}</p>`).join("");
    return `<div class="feue-breakdown"><header><span>${esc(title)}</span><strong>${esc(total)}${esc(suffix)}</strong></header>${body}${noteHtml}</div>`;
}

/** Foundry v12 renders data-tooltip as HTML; v13 cleans HTML from non-localized data-tooltip values. */
export function tooltipAttributes(html, {direction = "UP"} = {}) {
    return `data-tooltip="${esc(html)}" data-tooltip-class="feue-breakdown-tooltip" data-tooltip-direction="${direction}"`;
}

/** Ledger helper used while preparing actor data. */
export class StatLedger {
    constructor() { this.entries = {}; }
    add(path, label, value, kind = "add", extra = {}) {
        if (kind === "add" && !num(value)) return this;
        (this.entries[path] ??= []).push(term(label, value, kind, extra));
        return this;
    }
    /** Replace terms carrying the same key (used by refreshes such as terrain). */
    replace(path, key, label, value, kind = "add") {
        const list = (this.entries[path] ??= []).filter(t => t.key !== key);
        if (kind !== "add" || num(value)) list.push(term(label, value, kind, {key}));
        this.entries[path] = list;
        return this;
    }
    get(path) { return this.entries[path] ?? []; }
    toObject() { return this.entries; }
}

/** Update a prepared breakdown entry in place (actor.system.breakdown is a plain object). */
export function replaceBreakdownTerm(actor, path, key, label, value) {
    const breakdown = actor?.system?.breakdown;
    if (!breakdown) return;
    const list = (breakdown[path] ?? []).filter(t => t.key !== key);
    if (num(value)) list.push(term(label, value, "add", {key}));
    breakdown[path] = list;
}
