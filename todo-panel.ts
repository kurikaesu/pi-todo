/**
 * todo-panel — a persistent to-do panel on the right side of Pi's interface.
 *
 * The model (and the user) maintain an ordered list of steps. Pi renders it in a
 * non-capturing overlay anchored to the top-right so the transcript keeps full
 * focus while the list stays visible.
 *
 * Step states, exactly as bracketed in the panel and in tool output:
 *   [ ]  pending      - not started
 *   [-]  in_progress  - the one step being worked on right now
 *   [✓]  completed    - finished successfully
 *   [×]  blocked      - cannot be completed (needs access, a decision, an outside change)
 *   [s]  skipped      - no longer relevant, or the user asked to skip it
 *
 * The list is at most two layers deep: top-level steps, plus sub-steps rendered with
 * two-space indentation. New steps are appended at the end; dependencies discovered
 * late are inserted before the steps that need them (action "add" with before/after,
 * or action "move"). Steps are worked strictly in order: a later step cannot be started
 * or completed while an earlier one is still open, so the list always reads in the order
 * work was actually done.
 *
 * State lives in tool result `details` (plus `todo-state` custom entries for user edits),
 * so /resume, /tree, /fork and /reload all restore the list for the branch you are on.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

// ---------- model ----------

const STATUSES = ["pending", "in_progress", "completed", "blocked", "skipped"] as const;
type Status = (typeof STATUSES)[number];

interface Item {
	id: number;
	text: string;
	status: Status;
	/** true = sub-step of the preceding top-level step (two levels max) */
	sub: boolean;
	note?: string;
}

interface State {
	items: Item[];
	nextId: number;
}

interface Snapshot {
	items: Item[];
	nextId: number;
}

interface TodoDetails extends Snapshot {
	action: "plan" | "add" | "status" | "move" | "remove" | "list";
	notes?: string[];
	error?: string;
}

const MARK: Record<Status, string> = {
	pending: "[ ]",
	in_progress: "[-]",
	completed: "[✓]",
	blocked: "[×]",
	skipped: "[s]",
};

type Fg = Parameters<Theme["fg"]>[0];

const MARK_TOKEN: Record<Status, Fg> = {
	pending: "dim",
	in_progress: "accent",
	completed: "success",
	blocked: "error",
	skipped: "warning",
};

const TEXT_TOKEN: Record<Status, Fg> = {
	pending: "text",
	in_progress: "accent",
	completed: "muted",
	blocked: "muted",
	skipped: "dim",
};

const MAX_TEXT = 200;
const MAX_NOTE = 120;
const MAX_ITEMS = 200;

// ---------- helpers ----------

const clean = (value: string | undefined, max: number): string => {
	const oneLine = (value ?? "").replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
};

const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();

const isResolved = (item: Item): boolean => item.status !== "pending" && item.status !== "in_progress";

function clone(items: Item[]): Item[] {
	return items.map((item) => ({ ...item }));
}

function indexOfId(items: Item[], id: number): number {
	return items.findIndex((item) => item.id === id);
}

/** Index of the parent step when items[idx] is a sub-step, otherwise -1. */
function parentIndex(items: Item[], idx: number): number {
	if (!items[idx]?.sub) return -1;
	for (let i = idx - 1; i >= 0; i--) if (!items[i]!.sub) return i;
	return -1;
}

/** true when items[i] is a top-level step that owns the sub-steps that follow it. */
function isContainer(items: Item[], i: number): boolean {
	return items[i] !== undefined && !items[i]!.sub && items[i + 1]?.sub === true;
}

function substeps(items: Item[], i: number): Item[] {
	const out: Item[] = [];
	for (let j = i + 1; j < items.length && items[j]!.sub; j++) out.push(items[j]!);
	return out;
}

/** First step before idx that is still open and that must therefore come first. */
function blockersBefore(items: Item[], idx: number): Item | undefined {
	const parent = parentIndex(items, idx);
	for (let i = 0; i < idx; i++) {
		if (i === parent || isContainer(items, i)) continue;
		const item = items[i]!;
		if (!isResolved(item)) return item;
	}
	return undefined;
}

/** The step to work on next, or undefined when nothing is outstanding. */
function nextOpen(items: Item[]): Item | undefined {
	for (let i = 0; i < items.length; i++) {
		if (isContainer(items, i)) {
			const open = substeps(items, i).find((sub) => !isResolved(sub));
			if (open) return open;
			continue;
		}
		if (!isResolved(items[i]!)) return items[i];
	}
	return undefined;
}

const counts = (items: Item[]) => {
	const resolved = items.filter((item) => isResolved(item)).length;
	return { resolved, total: items.length };
};

/** Reject structures the panel cannot represent. */
function validateStructure(items: Item[]): string[] {
	const errors: string[] = [];
	const seen = new Set<number>();
	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		if (seen.has(item.id)) errors.push(`duplicate step id #${item.id}`);
		seen.add(item.id);
		if (!item.text) errors.push(`step #${item.id} has an empty description`);
		if (item.sub && i === 0) errors.push("a sub-step cannot be the first step in the list");
		if (item.sub && parentIndex(items, i) < 0) errors.push(`sub-step #${item.id} has no parent step above it`);
	}
	if (items.length > MAX_ITEMS) errors.push(`the list cannot hold more than ${MAX_ITEMS} steps`);
	return errors;
}

/**
 * Claims of progress must be earned in list order. `old` is the committed list, `next` is
 * the proposed list. Only transitions are checked: a step that merely stays where it was is
 * handled by enforceOrder() so restructures and late dependencies can insert themselves.
 */
function validateClaims(old: Item[], next: Item[]): string[] {
	const errors: string[] = [];
	for (let i = 0; i < next.length; i++) {
		const item = next[i]!;
		if (item.status !== "completed" && item.status !== "in_progress") continue;
		const prev = old.find((o) => o.id === item.id);
		if (prev && prev.status === item.status) continue;

		const verb = item.status === "completed" ? "complete" : "start";
		const blocker = blockersBefore(next, i);
		if (blocker) {
			const why = blocker.status === "in_progress" ? "is already in progress" : "is still pending";
			errors.push(
				`cannot ${verb} #${item.id} "${item.text}": #${blocker.id} "${blocker.text}" sits earlier in the list and ${why}. ` +
					`Work the steps in order — do #${blocker.id} first — or, if #${item.id} really belongs earlier, ` +
					`reposition it with action "move" (before: ${blocker.id}) so the list matches the order the work is done in.`,
			);
		}

		if (item.status === "completed" && isContainer(next, i)) {
			const open = substeps(next, i).filter((sub) => !isResolved(sub));
			if (open.length) {
				errors.push(
					`cannot complete #${item.id} "${item.text}": its sub-steps are still open (${open
						.map((sub) => `#${sub.id} "${sub.text}" [${sub.status}]`)
						.join(", ")})`,
				);
			}
		}

		if (item.status === "completed" && prev && prev.status !== "completed") {
			const laterDone = next
				.slice(i + 1)
				.filter((later) => later.status === "completed" && old.find((o) => o.id === later.id)?.status === "completed");
			if (laterDone.length) {
				errors.push(
					`cannot complete #${item.id} "${item.text}": ${laterDone
						.map((later) => `#${later.id}`)
						.join(", ")} were already completed before it. The list must read in the order steps were completed — ` +
						`move #${item.id} below them with action "move" if it is being redone now.`,
				);
			}
		}
	}
	return errors;
}

/** Keep parent steps consistent with their sub-steps. Returns human-readable notes. */
function deriveParents(items: Item[]): string[] {
	const notes: string[] = [];
	for (let i = 0; i < items.length; i++) {
		if (!isContainer(items, i)) continue;
		const parent = items[i]!;
		const subs = substeps(items, i);
		const active = subs.find((sub) => sub.status === "in_progress");
		const open = subs.filter((sub) => !isResolved(sub));

		if (active && parent.status !== "in_progress") {
			parent.status = "in_progress";
			notes.push(`#${parent.id} is in progress because sub-step #${active.id} is in progress`);
		} else if (!active && open.length && parent.status === "completed") {
			parent.status = "in_progress";
			notes.push(`#${parent.id} reopened: sub-step #${open[0]!.id} is still open`);
		} else if (!open.length) {
			if (subs.every((sub) => sub.status === "completed")) {
				if (parent.status !== "completed") {
					parent.status = "completed";
					notes.push(`#${parent.id} completed automatically: every sub-step completed`);
				}
			} else if (parent.status === "in_progress") {
				notes.push(
					`sub-steps of #${parent.id} are all resolved but some were blocked or skipped — ` +
						`mark #${parent.id} completed, blocked, or skipped yourself`,
				);
			}
		}
	}
	return notes;
}

interface OrderResult {
	/** fixes that were applied automatically */
	fixed: string[];
	/** violations that must be resolved by the caller */
	violations: string[];
}

/**
 * Two invariants: one step in progress at a time (a parent may share the flag with its own
 * active sub-step), and nothing pending ahead of the step in progress.
 */
function enforceOrder(items: Item[], autoFix: boolean): OrderResult {
	const fixed: string[] = [];
	const violations: string[] = [];

	const report = (message: string) => {
		if (autoFix) fixed.push(message);
		else violations.push(message);
	};

	let active: { item: Item; index: number } | undefined;
	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		if (item.status !== "in_progress") continue;
		if (!active) {
			active = { item, index: i };
			continue;
		}
		const sameChain = parentIndex(items, i) === active.index || parentIndex(items, active.index) === i;
		if (sameChain) continue;
		if (!autoFix) {
			violations.push(
				`#${item.id} "${item.text}" cannot start while #${active.item.id} "${active.item.text}" is in progress — ` +
					`only one step can be in progress. Complete, block, or skip #${active.item.id} first.`,
			);
			continue;
		}
		item.status = "pending";
		fixed.push(`#${item.id} returned to pending: only one step can be in progress at a time`);
	}

	if (active) {
		const blocker = blockersBefore(items, active.index);
		if (blocker) {
			const message =
				`#${active.item.id} "${active.item.text}" was returned to pending because #${blocker.id} ` +
				`"${blocker.text}" now comes earlier in the list. Work the list in order: start #${blocker.id}, ` +
				`or move the step you meant to work on so the list matches the real order.`;
			if (autoFix) {
				active.item.status = "pending";
				fixed.push(message);
			} else {
				violations.push(message);
			}
		}
	}

	return { fixed, violations };
}

function plainList(items: Item[]): string {
	if (!items.length) return "(no steps)";
	return items
		.map(
			(item) =>
				`${item.sub ? "  " : ""}${MARK[item.status]} ${item.id}. ${item.text}${item.note ? ` — ${item.note}` : ""}`,
		)
		.join("\n");
}

// ---------- panel component ----------

class TodoPanel implements Component {
	private cache?: { key: string; lines: string[] };
	private version = 0;

	constructor(
		private readonly theme: () => Theme,
		private readonly state: () => State,
		private readonly dims: () => { cols: number; rows: number },
		private readonly hidden: () => boolean,
	) {}

	invalidate(): void {
		this.version++;
	}

	bump(): void {
		this.version++;
	}

	render(width: number): string[] {
		const dims = this.dims();
		const key = `${width}x${dims.rows}:${this.version}:${this.hidden() ? "h" : "v"}`;
		if (this.cache?.key === key) return this.cache.lines;

		const th = this.theme();
		const items = this.state().items;
		const lines: string[] = [];
		this.cache = { key, lines };
		if (this.hidden() || items.length === 0 || width < 16) return lines;

		const border = (text: string) => th.fg("borderMuted", text);
		const inner = width - 2;
		const row = (content: string): string => {
			const clipped = truncateToWidth(content, inner);
			return `${border("│")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${border("│")}`;
		};

		const { resolved, total } = counts(items);

		// The top border carries the title and the counter.
		const title = th.fg(resolved === total ? "success" : "accent", " TODO ");
		const counter = th.fg("dim", ` ${resolved}/${total} `);
		const top = `╭${border("─")}${title}${border("─")}${counter}`;
		lines.push(truncateToWidth(`${top}${border("─".repeat(Math.max(0, width - visibleWidth(top) - 1)))}╮`, width));

		const filled = Math.max(0, Math.min(10, Math.round((10 * resolved) / Math.max(1, total))));
		lines.push(
			row(
				`${th.fg("success", "▓".repeat(filled))}${th.fg("borderMuted", "░".repeat(10 - filled))} ${th.fg("muted", filled === 10 ? "all resolved" : `${resolved}/${total} done`)}`,
			),
		);

		// Fit the list into the rows the terminal can spare, keeping the active step on screen.
		const reserve = lines.length + 3; // bottom border plus one row per scroll indicator
		const budget = Math.max(1, Math.max(6, dims.rows - 2) - reserve);
		const active = items.findIndex((item) => item.status === "in_progress");
		const target = Math.max(0, active >= 0 ? active : items.findIndex((item) => !isResolved(item)));
		const start = Math.max(0, Math.min(target - Math.floor(budget / 2), Math.max(0, items.length - budget)));
		const end = Math.min(items.length, start + budget);

		if (start > 0) lines.push(row(th.fg("dim", ` ↑ ${start} earlier`)));
		for (let i = start; i < end; i++) {
			const item = items[i]!;
			const note = item.note ? th.fg("dim", ` (${item.note})`) : "";
			lines.push(
				row(
					`${item.sub ? "  " : ""}${th.fg(MARK_TOKEN[item.status], MARK[item.status])} ${th.fg("dim", `${item.id}.`)} ${th.fg(TEXT_TOKEN[item.status], item.text)}${note}`,
				),
			);
		}
		if (end < items.length) lines.push(row(th.fg("dim", ` ↓ ${items.length - end} later`)));

		lines.push(truncateToWidth(`╰${border("─".repeat(Math.max(0, width - 2)))}╯`, width));
		return lines;
	}
}

// ---------- schemas ----------

const StatusSchema = StringEnum(STATUSES, {
	description: "[ ] pending · [-] in_progress · [✓] completed · [×] blocked (cannot be completed) · [s] skipped",
});

const ItemInput = Type.Object({
	text: Type.String({ description: "One-line, imperative step description" }),
	status: Type.Optional(StatusSchema),
	sub: Type.Optional(Type.Boolean({ description: "true = sub-step of the step above it (two levels maximum)" })),
	note: Type.Optional(Type.String({ description: "Short reason, mostly for blocked/skipped steps" })),
	id: Type.Optional(Type.Integer({ minimum: 1, description: "Optional id of an existing step, to keep its identity across a full replan" })),
});

const StatusChange = Type.Object({
	id: Type.Integer({ minimum: 1 }),
	status: Type.Optional(StatusSchema),
	text: Type.Optional(Type.String({ description: "Reword this step" })),
	note: Type.Optional(Type.String({ description: "Short reason, mostly for blocked/skipped steps" })),
});

const TodoParams = Type.Object({
	action: StringEnum(["plan", "add", "status", "move", "remove", "list"] as const, {
		description:
			"plan = set the whole ordered list · add = insert new steps · status = change step states · move = reposition a step · remove = delete steps · list = show the current list",
	}),
	items: Type.Optional(Type.Array(ItemInput, { description: "plan: the complete ordered list (empty clears it). add: the new steps" })),
	changes: Type.Optional(Type.Array(StatusChange, { description: "status: the state changes to apply" })),
	before: Type.Optional(Type.Integer({ minimum: 1, description: "add: insert the new steps before this step id · move: reposition before this step id" })),
	after: Type.Optional(Type.Integer({ minimum: 1, description: "add: insert the new steps after this step id · move: reposition after this step id" })),
	parent: Type.Optional(Type.Integer({ minimum: 1, description: "add/move: attach as sub-steps of this top-level step id" })),
	id: Type.Optional(Type.Integer({ minimum: 1, description: "move: id of the step to reposition" })),
	ids: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "remove: step ids to delete (their sub-steps go with them)" })),
});

type TodoInput = Static<typeof TodoParams>;

// ---------- extension ----------

export default function todoPanel(pi: ExtensionAPI) {
	let state: State = { items: [], nextId: 1 };

	let tui: TUI | undefined;
	let handle: OverlayHandle | undefined;
	let panel: TodoPanel | undefined;
	let ui: ExtensionContext["ui"] | undefined;
	let userHidden = false;
	let dims = { cols: 120, rows: 32 };
	let usedToolThisRun = false;
	let nudgedThisRun = false;

	const sanitize = (raw: unknown): Item[] => {
		if (!Array.isArray(raw)) return [];
		const out: Item[] = [];
		let id = 0;
		for (const entry of raw.slice(0, MAX_ITEMS) as Partial<Item>[]) {
			const text = clean(entry?.text, MAX_TEXT);
			if (!text) continue;
			const status = STATUSES.includes(entry?.status as Status) ? (entry!.status as Status) : "pending";
			out.push({
				id: typeof entry?.id === "number" && entry.id > 0 ? entry.id : ++id,
				text,
				status,
				sub: entry?.sub === true,
				note: clean(entry?.note, MAX_NOTE) || undefined,
			});
		}
		// Repair structures that cannot be rendered: the first step is never a sub-step,
		// and a sub-step needs a top-level step above it.
		if (out.length && out[0]!.sub) out[0]!.sub = false;
		for (let i = 1; i < out.length; i++) {
			if (out[i]!.sub && parentIndex(out, i) < 0) out[i]!.sub = false;
		}
		return out;
	};

	const reconstruct = (ctx: ExtensionContext) => {
		let items: Item[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") {
				const message = entry.message;
				if (message.role !== "toolResult" || message.toolName !== "todo") continue;
				const details = message.details as Snapshot | undefined;
				if (details?.items) items = sanitize(details.items);
			} else if (entry.type === "custom" && entry.customType === "todo-state") {
				const data = entry.data as Snapshot | undefined;
				if (data?.items) items = sanitize(data.items);
			}
		}
		const maxId = items.reduce((max, item) => Math.max(max, item.id), 0);
		state = { items, nextId: maxId + 1 };
	};

	const refresh = () => {
		panel?.bump();
		tui?.requestRender();
		if (!ui) return;
		const { resolved, total } = counts(state.items);
		ui.setStatus("todo", total ? `todo ${resolved}/${total}` : undefined);
	};

	/** Apply a proposed list: reject dishonest progress, repair invariants, commit. */
	const apply = (candidate: Item[], notes: string[], autoFix: boolean): { text: string; details: TodoDetails } => {
		const structure = validateStructure(candidate);
		if (structure.length) throw new Error(structure.join("; "));

		const claims = validateClaims(state.items, candidate);
		if (claims.length) throw new Error(claims.join("\n"));

		const derived = deriveParents(candidate);
		const order = enforceOrder(candidate, autoFix);
		if (order.violations.length) throw new Error(order.violations.join("\n"));
		const allNotes = [...notes, ...derived, ...order.fixed];

		state = { items: candidate, nextId: candidate.reduce((max, item) => Math.max(max, item.id + 1), 1) };
		refresh();

		const { resolved, total } = counts(state.items);
		const next = nextOpen(state.items);
		const lines = [`Todo list: ${resolved}/${total} steps resolved`, plainList(state.items)];
		if (allNotes.length) lines.push(`Notes:\n${allNotes.map((note) => `  · ${note}`).join("\n")}`);
		lines.push(
			next
				? `Next in order: #${next.id} "${next.text}" (mark it [-] in_progress with action "status" before doing it)`
				: "Every step is resolved (completed, blocked, or skipped).",
		);
		return {
			text: lines.join("\n"),
			details: { action: "list", items: clone(state.items), nextId: state.nextId, notes: allNotes },
		};
	}

	const newItems = (raws: NonNullable<TodoInput["items"]>, sub: boolean | undefined): Item[] =>
		raws.map((raw) => ({
			id: state.nextId++,
			text: clean(raw.text, MAX_TEXT),
			status: (raw.status ?? "pending") as Status,
			sub: sub ?? raw.sub === true,
			note: clean(raw.note, MAX_NOTE) || undefined,
		}));

	pi.on("session_start", async (_event, ctx) => {
		reconstruct(ctx);
		ui = ctx.hasUI ? ctx.ui : undefined;
		userHidden = false;
		usedToolThisRun = false;
		nudgedThisRun = false;
		if (ctx.mode !== "tui") {
			panel = undefined;
			tui = undefined;
			handle = undefined;
			return;
		}
		// An invisible widget is the least intrusive way to get a live handle on the TUI: the
		// component renders nothing (and below the editor Pi adds no spacer for it), while
		// disposing it takes the panel overlay with it.
		ctx.ui.setWidget(
			"todo-panel",
			(liveTui) => {
				tui = liveTui;
				panel = new TodoPanel(
					() => ctx.ui.theme,
					() => state,
					() => dims,
					() => userHidden,
				);
				handle = liveTui.showOverlay(panel, {
					nonCapturing: true,
					anchor: "top-right",
					width: "30%",
					minWidth: 28,
					margin: { top: 1, right: 1 },
					visible: (cols, rows) => {
						dims = { cols, rows };
						return !userHidden && state.items.length > 0 && cols >= 96 && rows >= 14;
					},
				});
				return {
					render: () => [],
					invalidate: () => {},
					dispose: () => {
						handle?.hide();
						handle = undefined;
						panel = undefined;
						tui = undefined;
					},
				};
			},
			{ placement: "belowEditor" },
		);
		refresh();
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstruct(ctx);
		refresh();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		handle?.hide();
		handle = undefined;
		panel = undefined;
		tui = undefined;
		ctx.ui.setStatus("todo", undefined);
	});

	pi.on("before_agent_start", async () => {
		usedToolThisRun = false;
		nudgedThisRun = false;
	});

	// The list is a commitment: do not let the model stop while it still has open steps.
	pi.on("agent_before_settle", async (event, ctx) => {
		const open = state.items.filter((item) => !isResolved(item));
		if (!open.length || !usedToolThisRun || nudgedThisRun) return undefined;
		nudgedThisRun = true;
		const next = nextOpen(state.items);
		const summary = open
			.slice(0, 8)
			.map((item) => `${MARK[item.status]} #${item.id} ${item.text}`)
			.join("\n");
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: "todo-reminder",
					content:
						`The todo list still has ${open.length} unresolved step(s):\n${summary}\n` +
						`Continue with ${next ? `#${next.id} "${next.text}"` : "the next step"} in order and check steps off with the todo tool, ` +
						`or mark each remaining step blocked ([×]) or skipped ([s]) with a note if it should not be done. Do not list these steps in your reply prose.`,
					display: false,
				},
			],
			continue: true,
		};
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: [
			"Maintain the ordered step list shown in the panel on the right.",
			"States: [ ] pending, [-] in_progress, [✓] completed, [×] blocked (cannot be completed), [s] skipped (no longer relevant or the user asked to skip it).",
			"Actions: plan (whole ordered list, replaces it), add (new steps, appended by default, or inserted with before/after/parent), status (change states), move (reposition a step), remove (delete steps), list (show it).",
			"Steps are worked strictly in order: never start or complete a later step while an earlier one is open. Put work that must happen earlier into the right position with add/move instead, so the list reads in the order work was done.",
			"Two levels max: steps, plus sub-steps flagged sub:true under the step they belong to.",
		].join(" "),
		promptSnippet: "Maintain the step list in the right-hand todo panel: plan/add/status/move/remove/list",
		promptGuidelines: [
			"Use the todo tool for any task with two or more distinct steps, and for anything the user hands you as a list, plan, or set of requirements — the panel is the only place steps are tracked, so do NOT write to-do lists or markdown checklists in your replies.",
			"Call todo with action \"plan\" first to lay out the ordered steps (add sub-steps with items[].sub when a step is large), then todo action \"status\" to mark exactly one step [-] in_progress immediately before doing it and [✓] completed as soon as it is genuinely done.",
			"Work the list strictly in order: never start or complete a later step while an earlier step is pending. If you discover work that belongs earlier, insert it as a dependency with todo action \"add\" (before/after ids) or reposition the step with action \"move\", so the list still reads in the order the work was actually done.",
			"Append newly discovered steps at the end with todo action \"add\"; add them as sub-steps with parent:<id> when they belong to an existing step.",
			"Mark a step [×] blocked when it cannot be completed (missing access, an outside change, a user decision needed) and [s] skipped when it is no longer relevant or the user asked to skip it; put the reason in note. Both free the steps after it to proceed.",
			"Keep the list honest: update it as soon as a step's state changes, use action \"remove\" for steps that should never be tracked, and finish only when every step is completed, blocked, or skipped.",
		],
		executionMode: "sequential",
		parameters: TodoParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Cancelled" }], details: { action: "list", items: clone(state.items), nextId: state.nextId } as TodoDetails };
			}
			usedToolThisRun = true;

			const fail = (error: string) => ({
				content: [{ type: "text", text: `todo rejected: ${error}` }],
				details: {
					action: params.action as TodoDetails["action"],
					items: clone(state.items),
					nextId: state.nextId,
					error,
				} as TodoDetails,
				isError: true,
			});

			try {
				switch (params.action) {
					case "list": {
						const { resolved, total } = counts(state.items);
						const next = nextOpen(state.items);
						const text = state.items.length
							? `${resolved}/${total} steps resolved\n${plainList(state.items)}\n${next ? `Next in order: #${next.id} "${next.text}"` : "Every step is resolved."}`
							: "The todo list is empty.";
						return {
							content: [{ type: "text", text }],
							details: { action: "list", items: clone(state.items), nextId: state.nextId } as TodoDetails,
						};
					}

					case "plan": {
						if (!params.items) throw new Error('plan needs "items" (the complete ordered list; [] clears it)');
						const taken = new Set<number>();
						const openOld = state.items.filter((item) => !isResolved(item));
						const candidate: Item[] = [];
						for (const raw of params.items) {
							const text = clean(raw.text, MAX_TEXT);
							if (!text) throw new Error("every step needs a description");
							let id: number;
							if (raw.id !== undefined) {
								if (!state.items.some((item) => item.id === raw.id)) {
									throw new Error(`unknown step id #${raw.id} in plan — omit "id" for new steps`);
								}
								id = raw.id;
							} else {
								const match = openOld.find((item) => !taken.has(item.id) && normalize(item.text) === normalize(text));
								id = match ? match.id : state.nextId++;
							}
							if (taken.has(id)) throw new Error(`step id #${id} appears twice in the plan`);
							taken.add(id);
							candidate.push({
								id,
								text,
								status: (raw.status ?? "pending") as Status,
								sub: raw.sub === true,
								note: clean(raw.note, MAX_NOTE) || undefined,
							});
						}
						const dropped = state.items.filter((item) => !taken.has(item.id) && !isResolved(item));
						const notes = dropped.length
							? [`dropped by the replan: ${dropped.map((item) => `#${item.id} "${item.text}"`).join(", ")}`]
							: [];
						const result = apply(candidate, notes, true);
						result.details.action = "plan";
						return {
							content: [{ type: "text", text: `Planned ${candidate.length} step(s)\n${result.text}` }],
							details: result.details,
						};
					}

					case "add": {
						if (!params.items?.length) throw new Error('add needs "items"');
						const notes: string[] = [];
						let list = clone(state.items);
						let attachSub: number | undefined;
						let position = list.length;

						if (params.parent !== undefined) {
							const idx = indexOfId(list, params.parent);
							if (idx < 0) throw new Error(`unknown step id #${params.parent} for parent`);
							if (list[idx]!.sub) throw new Error(`#${params.parent} is a sub-step; steps can only be two levels deep`);
							if (params.before !== undefined || params.after !== undefined) {
								throw new Error('use either "parent" or "before"/"after" when adding steps');
							}
							attachSub = params.parent;
							position = idx + 1 + substeps(list, idx).length;
						} else if (params.before !== undefined) {
							const idx = indexOfId(list, params.before);
							if (idx < 0) throw new Error(`unknown step id #${params.before} for before`);
							const parent = parentIndex(list, idx);
							position = parent >= 0 ? parent : idx;
							if (parent >= 0) notes.push(`inserted before parent step #${list[parent]!.id}, which holds #${params.before}`);
						} else if (params.after !== undefined) {
							const idx = indexOfId(list, params.after);
							if (idx < 0) throw new Error(`unknown step id #${params.after} for after`);
							position = idx + 1;
							if (!list[idx]!.sub && list[position]?.sub) position += substeps(list, idx).length;
						}

						const created = newItems(params.items, attachSub !== undefined ? true : undefined);
						list.splice(position, 0, ...created);
						const result = apply(list, notes, true);
						result.details.action = "add";
						return {
							content: [
								{
									type: "text",
									text: `Added ${created.length} step(s): ${created.map((item) => `#${item.id}`).join(", ")}\n${result.text}`,
								},
							],
							details: result.details,
						};
					}

					case "status": {
						if (!params.changes?.length) throw new Error('status needs "changes"');
						const list = clone(state.items);
						const notes: string[] = [];
						for (const change of params.changes) {
							const item = list.find((entry) => entry.id === change.id);
							if (!item) {
								throw new Error(
									`unknown step id #${change.id}. Current list:\n${plainList(state.items)}`,
								);
							}
							if (change.text) item.text = clean(change.text, MAX_TEXT);
							if (change.note !== undefined) item.note = clean(change.note, MAX_NOTE) || undefined;
							if (!change.status || change.status === item.status) continue;
							if (change.status === "in_progress") {
								const otherIndex = list.findIndex(
									(entry, index) =>
										entry.status === "in_progress" &&
										index !== list.indexOf(item) &&
										parentIndex(list, index) !== list.indexOf(item) &&
										parentIndex(list, list.indexOf(item)) !== index,
								);
								if (otherIndex >= 0) {
									const other = list[otherIndex]!;
									throw new Error(
										`#${item.id} cannot start while #${other.id} "${other.text}" is in progress — finish, block, or skip #${other.id} first`,
									);
								}
							}
							notes.push(`#${item.id} ${MARK[item.status]} → ${MARK[change.status]} ${item.text}`);
							item.status = change.status;
						}
						const result = apply(list, notes, false);
						result.details.action = "status";
						return { content: [{ type: "text", text: result.text }], details: result.details };
					}

					case "move": {
						if (params.id === undefined) throw new Error('move needs "id"');
						const list = clone(state.items);
						const idx = indexOfId(list, params.id);
						if (idx < 0) throw new Error(`unknown step id #${params.id}`);
						const moving = list[idx]!;
						const block = [list[idx]!, ...(moving.sub ? [] : substeps(list, idx))];
						list.splice(idx, block.length);

						const notes: string[] = [];
						let insertAt = list.length;
						if (params.parent !== undefined) {
							const target = indexOfId(list, params.parent);
							if (target < 0) throw new Error(`unknown step id #${params.parent} for parent`);
							if (list[target]!.sub) throw new Error(`#${params.parent} is a sub-step; steps can only be two levels deep`);
							for (const item of block) item.sub = true;
							insertAt = target + 1 + substeps(list, target).length;
							notes.push(`#${moving.id} is now a sub-step of #${params.parent}`);
						} else if (params.before !== undefined) {
							const target = indexOfId(list, params.before);
							if (target < 0) throw new Error(`unknown step id #${params.before} for before`);
							insertAt = parentIndex(list, target) >= 0 ? parentIndex(list, target) : target;
						} else if (params.after !== undefined) {
							const target = indexOfId(list, params.after);
							if (target < 0) throw new Error(`unknown step id #${params.after} for after`);
							insertAt = target + 1;
							if (!list[insertAt - 1]!.sub && list[insertAt]?.sub) insertAt += substeps(list, target).length;
						}
						if (insertAt === 0 && block[0]!.sub) throw new Error("a sub-step cannot be moved to the start of the list");
						list.splice(insertAt, 0, ...block);
						const result = apply(list, [`moved #${moving.id}${moving.sub ? " (with its sub-steps)" : ""} to a new position`, ...notes], true);
						result.details.action = "move";
						return { content: [{ type: "text", text: result.text }], details: result.details };
					}

					case "remove": {
						const ids = new Set(params.ids ?? []);
						if (!ids.size) throw new Error('remove needs "ids"');
						const list = clone(state.items);
						const keep: Item[] = [];
						for (let i = 0; i < list.length; i++) {
							const item = list[i]!;
							if (ids.has(item.id)) {
								for (let j = i + 1; j < list.length && list[j]!.sub; j++) i = j;
								continue;
							}
							keep.push(item);
						}
						const notes = [`removed ${ids.size} step(s)`];
						const result = apply(keep, notes, true);
						result.details.action = "remove";
						return { content: [{ type: "text", text: result.text }], details: result.details };
					}

					default:
						return fail(`unknown action ${String(params.action)}`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				refresh();
				return fail(message);
			}
		},

		renderCall(args, theme, _context) {
			const label = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action ?? "");
			const extra: string[] = [];
			if (args.items?.length) extra.push(theme.fg("dim", `${args.items.length} item(s)`));
			if (args.changes?.length) extra.push(theme.fg("dim", `${args.changes.length} change(s)`));
			if (args.id !== undefined) extra.push(theme.fg("accent", `#${args.id}`));
			if (args.ids?.length) extra.push(theme.fg("accent", args.ids.map((id: number) => `#${id}`).join(" ")));
			return new Text(`${label}${extra.length ? ` ${extra.join(" ")}` : ""}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.error) return new Text(theme.fg("error", details.error.split("\n")[0]!), 0, 0);

			const { resolved, total } = counts(details.items);
			const head = theme.fg(resolved === total ? "success" : "accent", `${resolved}/${total} steps`);
			const open = details.items.filter((item) => !isResolved(item));
			const shown = expanded ? details.items : details.items.slice(0, 12);
			const rows = shown.map((item) => {
				const indent = item.sub ? "  " : "";
				return `${indent}${theme.fg(MARK_TOKEN[item.status], MARK[item.status])} ${theme.fg("dim", `${item.id}.`)} ${theme.fg(TEXT_TOKEN[item.status], item.text)}`;
			});
			const hiddenCount = details.items.length - shown.length;
			const body = [head, ...rows, ...(hiddenCount ? [theme.fg("dim", `  … ${hiddenCount} more`)] : [])];
			if (!expanded && open.length) {
				const next = nextOpen(details.items);
				if (next) body.push(theme.fg("dim", `next: #${next.id} ${next.text}`));
			}
			return new Text(body.join("\n"), 0, 0);
		},
	});

	// User-side control.
	const runUserCommand = (raw: string, ctx: ExtensionCommandContext) => {
		const args = raw.trim();
		const [command, ...rest] = args.split(/\s+/);
		const tail = rest.join(" ").trim();
		const idOf = (value: string): number => {
			const id = Number(value.replace(/^#/, ""));
			if (!Number.isInteger(id) || id <= 0) throw new Error(`"${value}" is not a step id`);
			return id;
		};		const persist = () => {
			pi.appendEntry("todo-state", { items: clone(state.items), nextId: state.nextId } satisfies Snapshot);
			refresh();
		};

		switch ((command ?? "").toLowerCase()) {
			case "":
			case "list":
			case "show": {
				if (command === "show") userHidden = false;
				refresh();
				ctx.ui.notify(
					state.items.length
						? `${counts(state.items).resolved}/${state.items.length} resolved\n${plainList(state.items)}`
						: "The todo list is empty. Ask for a plan, or use /todo add <step>.",
					"info",
				);
				return;
			}
			case "hide":
				userHidden = true;
				refresh();
				ctx.ui.notify("todo panel hidden (alt+t or /todo show)", "info");
				return;
			case "toggle":
				userHidden = !userHidden;
				refresh();
				ctx.ui.notify(userHidden ? "todo panel hidden" : "todo panel shown", "info");
				return;
			case "add": {
				if (!tail) throw new Error("usage: /todo add <step>");
				const list = clone(state.items);
				const item = { id: state.nextId++, text: clean(tail, MAX_TEXT), status: "pending" as Status, sub: false };
				list.push(item);
				state = { items: list, nextId: state.nextId };
				persist();
				ctx.ui.notify(`added #${item.id} ${item.text}`, "info");
				return;
			}
			case "ins": {
				const [rawId, ...textParts] = rest;
				const text = textParts.join(" ").trim();
				if (!rawId || !text) throw new Error("usage: /todo ins <id> <step>");
				const list = clone(state.items);
				const idx = indexOfId(list, idOf(rawId));
				if (idx < 0) throw new Error(`no step #${rawId}`);
				const item = { id: state.nextId++, text: clean(text, MAX_TEXT), status: "pending" as Status, sub: false };
				list.splice(parentIndex(list, idx) >= 0 ? parentIndex(list, idx) : idx, 0, item);
				state = { items: list, nextId: state.nextId };
				persist();
				ctx.ui.notify(`inserted #${item.id} before #${rawId}`, "info");
				return;
			}
			case "done":
			case "progress":
			case "skip":
			case "block":
			case "open": {
				if (!tail) throw new Error(`usage: /todo ${command} <id>`);
				const map: Record<string, Status> = {
					done: "completed",
					progress: "in_progress",
					skip: "skipped",
					block: "blocked",
					open: "pending",
				};
				const list = clone(state.items);
				for (const token of tail.split(/[\s,]+/).filter(Boolean)) {
					const item = list.find((entry) => entry.id === idOf(token));
					if (!item) throw new Error(`no step #${token}`);
					item.status = map[command!.toLowerCase()]!;
				}
				applyUser(list);
				persist();
				ctx.ui.notify(`${command}: ${tail}`, "info");
				return;
			}
			case "drop": {
				if (!tail) throw new Error("usage: /todo drop <id> [id…]");
				const ids = new Set(tail.split(/[\s,]+/).filter(Boolean).map(idOf));
				const list = clone(state.items);
				const keep: Item[] = [];
				for (let i = 0; i < list.length; i++) {
					if (ids.has(list[i]!.id)) {
						for (let j = i + 1; j < list.length && list[j]!.sub; j++) i = j;
						continue;
					}
					keep.push(list[i]!);
				}
				state = { items: keep, nextId: state.nextId };
				persist();
				ctx.ui.notify(`dropped ${ids.size} step(s)`, "info");
				return;
			}
			case "clear":
				state = { items: [], nextId: 1 };
				persist();
				ctx.ui.notify("todo list cleared", "info");
				return;
			case "help":
				ctx.ui.notify(
					"/todo [list | add <step> | ins <id> <step> | done <id…> | progress <id…> | skip <id…> | block <id…> | open <id…> | drop <id…> | clear | hide | show | toggle]\n" +
						"[ ] pending · [-] in_progress · [✓] completed · [×] blocked · [s] skipped · alt+t toggles the panel",
					"info",
				);
				return;
			default:
				throw new Error(`unknown /todo subcommand "${command}" (try /todo help)`);
		}
	};

	/** User edits bypass the in-order claim rules but the list must stay renderable. */
	const applyUser = (list: Item[]) => {
		const structure = validateStructure(list);
		if (structure.length) throw new Error(structure.join("; "));
		deriveParents(list);
		enforceOrder(list, true);
		state = { items: list, nextId: Math.max(state.nextId, list.reduce((max, item) => Math.max(max, item.id + 1), 1)) };
	};

	pi.registerCommand("todo", {
		description: "Show or edit the step list in the right-hand panel (/todo help)",
		handler: async (args, ctx) => {
			try {
				runUserCommand(args, ctx);
			} catch (error) {
				ctx.ui.notify(`todo: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerShortcut("alt+t", {
		description: "Toggle the todo panel",
		handler: (ctx) => {
			userHidden = !userHidden;
			refresh();
			ctx.ui.notify(userHidden ? "todo panel hidden (/todo show)" : "todo panel shown", "info");
		},
	});
}
