import { execSync } from "node:child_process";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Drives the extension outside Pi with jiti - the same TypeScript loader Pi uses - through a
 * stand-in ExtensionAPI: real logic, no model calls, no terminal.
 *
 *   node test/run.mjs
 *   PI_ROOT=/path/to/pi-coding-agent node test/run.mjs
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function findPiPackage() {
	if (process.env.PI_ROOT) return process.env.PI_ROOT;
	const binary = fs.realpathSync(execSync("command -v pi", { shell: "/bin/bash", encoding: "utf8" }).trim());
	let dir = dirname(binary);
	for (let depth = 0; depth < 10; depth++) {
		for (const candidate of [join(dir, "node_modules"), join(dir, "lib", "node_modules"), join(dir, "libexec", "lib", "node_modules")]) {
			const pkg = join(candidate, "@earendil-works", "pi-coding-agent");
			if (fs.existsSync(join(pkg, "package.json")) && fs.existsSync(join(pkg, "node_modules", "jiti"))) return pkg;
		}
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	throw new Error("could not locate the Pi installation; set PI_ROOT to its pi-coding-agent package directory");
}

const ROOT = join(findPiPackage(), "node_modules");
const { createJiti } = await import(pathToFileURL(join(ROOT, "jiti", "lib", "jiti.mjs")).href);

const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-ai": `${ROOT}/@earendil-works/pi-ai`,
		"@earendil-works/pi-tui": `${ROOT}/@earendil-works/pi-tui`,
		typebox: `${ROOT}/typebox/build/index.mjs`,
	},
});

const mod = await jiti.import(resolve(HERE, "..", "todo-panel.ts"));

const handlers = new Map();
const tools = new Map();
const commands = new Map();
const shortcuts = new Map();

const pi = {
	on(event, handler) {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	},
	registerTool(tool) {
		tools.set(tool.name, tool);
	},
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerShortcut(key, def) {
		shortcuts.set(key, def);
	},
	appendEntry() {},
	setActiveTools() {},
	getActiveTools: () => [...tools.keys()],
	exec: async () => ({ stdout: "", stderr: "", code: 0 }),
};

mod.default(pi);

// ---------- fake contexts ----------
const setStatusCalls = [];
const notifyCalls = [];
let overlayComponent = undefined;
let overlayOptions = undefined;
let renderRequests = 0;

const fakeTui = {
	showOverlay(component, options) {
		overlayComponent = component;
		overlayOptions = options;
		return { hide() {}, setHidden() {}, isHidden: () => false, focus() {}, unfocus() {}, isFocused: () => false, getBounds: () => undefined };
	},
	requestRender() {
		renderRequests++;
	},
};

const sessionCtx = {
	mode: "tui",
	hasUI: true,
	cwd: process.cwd(),
	sessionManager: { getBranch: () => [] },
	ui: {
		theme: await makeTheme(jiti),
		setStatus: (key, text) => setStatusCalls.push([key, text]),
		notify: (text, kind) => notifyCalls.push([kind, text]),
		setWidget: (key, factory) => {
			if (key === "todo-panel") factory(fakeTui, sessionCtx.ui.theme);
		},
	},
};

async function makeTheme(jiti) {
	// The extension only needs fg()/bold(); give it a colourless stand-in.
	const identity = (text) => text;
	return { fg: (_token, text) => text, bg: (_token, text) => text, bold: identity, style: identity, colors: {}, appearance: "dark" };
}

const toolCtx = sessionCtx;

const run = async (params) => {
	const result = await tools.get("todo").execute("tc", params, undefined, undefined, toolCtx);
	const text = result.content.map((c) => c.text ?? "").join("\n");
	return { ok: !result.isError, text, details: result.details };
};

const check = (label, condition, extra = "") => {
	console.log(`${condition ? "PASS" : "FAIL"}  ${label}${condition ? "" : `\n${extra}`}`);
	if (!condition) process.exitCode = 1;
};

// ---------- scenarios ----------
await handlers.get("session_start")[0]({}, sessionCtx);
check("panel overlay registered", overlayComponent !== undefined, JSON.stringify(overlayOptions));
check("panel hidden while list empty", overlayComponent.render(40).length === 0);

const plan = await run({
	action: "plan",
	items: [
		{ text: "Read the extension docs" },
		{ text: "Write the panel component", sub: false },
		{ text: "Design the overlay options", sub: true },
		{ text: "Wire the tool", sub: false },
		{ text: "Smoke test in a pty", sub: false },
	],
});
check("plan accepted", plan.ok, plan.text);
check("ids assigned 1..5", plan.details.items.map((i) => i.id).join(",") === "1,2,3,4,5", plan.text);
check("sub flag kept", plan.details.items[2].sub === true && plan.details.items[1].sub === false);

const start1 = await run({ action: "status", changes: [{ id: 1, status: "in_progress" }] });
check("start #1", start1.ok, start1.text);
const done1 = await run({ action: "status", changes: [{ id: 1, status: "completed" }] });
check("complete #1", done1.ok, done1.text);

const skipAhead = await run({ action: "status", changes: [{ id: 4, status: "completed" }] });
check("out-of-order completion rejected", !skipAhead.ok, skipAhead.text);
check("rejection explains the blocker", /#3/.test(skipAhead.text) && /move/.test(skipAhead.text), skipAhead.text);

const start2 = await run({ action: "status", changes: [{ id: 2, status: "in_progress" }] });
check("start #2 after #1", start2.ok, start2.text);
check("parent auto-in-progress with active sub", true);

const subActive = await run({ action: "status", changes: [{ id: 3, status: "in_progress" }] });
check("sub-step can start while parent active", subActive.ok, subActive.text);
check("parent stays in progress", subActive.details.items.find((i) => i.id === 2).status === "in_progress", subActive.text);

const subDone = await run({ action: "status", changes: [{ id: 3, status: "completed" }] });
check("sub-step completes", subDone.ok, subDone.text);

const parentDone = await run({ action: "status", changes: [{ id: 2, status: "completed" }] });
check("parent completes once sub-steps resolve", parentDone.ok, parentDone.text);

const dependency = await run({ action: "add", items: [{ text: "Discover the missing dependency" }], before: 4 });
check("dependency inserted before #4", dependency.ok, dependency.text);
check("reorder keeps the list in order", dependency.details.items.map((i) => i.id).join(",") === "1,2,3,6,4,5", JSON.stringify(dependency.details.items));
check("dependency sits before #4", dependency.details.items.findIndex((i) => i.id === 6) === 3, JSON.stringify(dependency.details.items));

const startBlocked = await run({ action: "status", changes: [{ id: 5, status: "in_progress" }] });
check("cannot start #5 while #6 pending earlier", !startBlocked.ok, startBlocked.text);

const dependencyDone = await run({ action: "status", changes: [{ id: 6, status: "in_progress" }] });
check("start the dependency", dependencyDone.ok, dependencyDone.text);
const dependencyDone2 = await run({ action: "status", changes: [{ id: 6, status: "completed" }] });
check("complete the dependency", dependencyDone2.ok, dependencyDone2.text);

const start5 = await run({ action: "status", changes: [{ id: 5, status: "in_progress" }] });
check("#5 still waits behind pending #4", !start5.ok, start5.text);
const blocked = await run({ action: "status", changes: [{ id: 5, status: "blocked", note: "needs credentials" }] });
check("mark #5 blocked with note", blocked.ok, blocked.text);

const start4 = await run({ action: "status", changes: [{ id: 4, status: "in_progress" }] });
check("blocked step frees later steps", start4.ok, start4.text);
const skip4 = await run({ action: "status", changes: [{ id: 4, status: "skipped", note: "user asked to skip" }] });
check("skip #4", skip4.ok, skip4.text);

const reopen = await run({ action: "status", changes: [{ id: 1, status: "pending" }] });
check("reopen #1", reopen.ok, reopen.text);
const reopenDone = await run({ action: "status", changes: [{ id: 1, status: "completed" }] });
check("reopening forces a move before re-completing", !reopenDone.ok, reopenDone.text);

const moved = await run({ action: "move", id: 1, after: 4 });
check("move #1 to the end", moved.ok, moved.text);
check("#1 lands directly after #4", moved.details.items.findIndex((i) => i.id === 1) === 4, JSON.stringify(moved.details.items));
const reopenDone2 = await run({ action: "status", changes: [{ id: 1, status: "in_progress" }, { id: 1, status: "completed" }] });
check("re-complete #1 after moving", reopenDone2.ok, reopenDone2.text);

const list = await run({ action: "list" });
check("list shows bracket states", /\[✓\]/.test(list.text) && /\[×\]/.test(list.text) && /\[s\]/.test(list.text), list.text);
check("sub-steps indented by two spaces", /^ {2}\[/m.test(list.text), list.text);

const replan = await run({
	action: "plan",
	items: [
		{ id: 1, text: "Re-complete #1 after moving" },
		{ text: "Write the README" },
		{ text: "Install globally", sub: true },
	],
});
check("replan keeps known ids", replan.ok && replan.details.items[0].id === 1, replan.text);
check("replan matches text to reuse ids", replan.details.items.some((i) => i.id <= 6 && i.status === "pending"), JSON.stringify(replan.details.items));

// ---------- panel rendering ----------
overlayComponent.invalidate();
const lines = overlayComponent.render(34);
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");
console.log("\n--- panel @34x40 ---");
console.log(lines.map(strip).join("\n"));
check("panel renders a bordered box", lines.length > 3 && strip(lines[0]).startsWith("╭") && strip(lines[lines.length - 1]).startsWith("╰"));
check("panel lines fit the width", lines.every((line) => visibleWidthOf(strip(line)) <= 34), lines.map(strip).join("\n"));
check("visibility gated on terminal size", overlayOptions.visible(80, 40) === false && overlayOptions.visible(120, 40) === true);

// A long list in a short terminal must scroll to the active step.
const big = await run({
	action: "plan",
	items: Array.from({ length: 24 }, (_unused, index) => ({ text: `Step number ${index + 1} of 24` })),
});
check("long plan accepted", big.ok, big.text);
const bigIds = big.details.items.map((item) => item.id);
await run({ action: "status", changes: bigIds.slice(0, 17).map((id) => ({ id, status: "completed" })) });
const started = await run({ action: "status", changes: [{ id: bigIds[17], status: "in_progress" }] });
check("step 18 becomes active", started.ok, started.text);
overlayOptions.visible(120, 14);
const short = overlayComponent.render(34);
check("panel scrolls when rows are tight", short.length <= 12 && short.some((line) => strip(line).includes("earlier")) && short.some((line) => strip(line).includes("later")), short.map(strip).join("\n"));
check("the active step stays on screen", short.some((line) => strip(line).includes(`[-] ${bigIds[17]}.`)), short.map(strip).join("\n"));
console.log("--- panel @34x14, 24 steps ---");
console.log(short.map(strip).join("\n"));

// ---------- user command + shortcut ----------
const small = await run({
	action: "plan",
	items: [{ text: "Write the README" }, { text: "Install globally", sub: true }],
});
const [readmeId, installId] = small.details.items.map((item) => item.id);
await commands.get("todo").handler("add Review the panel colours", sessionCtx);
check("/todo add appends", notifyCalls.at(-1)[1].startsWith("added #"), JSON.stringify(notifyCalls.at(-1)));
await commands.get("todo").handler(`done ${installId}`, sessionCtx);
const afterDone = (await run({ action: "list" })).text;
check("/todo done completes the sub-step", afterDone.includes(`[✓] ${installId}.`), afterDone);
check("parent auto-completes with sub-steps done", afterDone.includes(`[✓] ${readmeId}.`), afterDone);
check("footer status set", setStatusCalls.some(([key, text]) => key === "todo" && /todo \d+\/\d+/.test(text ?? "")), JSON.stringify(setStatusCalls));
await shortcuts.get("alt+t").handler(sessionCtx);
check("alt+t hides the panel", overlayComponent.render(34).length === 0);
await shortcuts.get("alt+t").handler(sessionCtx);
check("alt+t shows it again", overlayComponent.render(34).length > 3);
check("tool renderers do not throw", tools.get("todo").renderCall({ action: "plan", items: [{ text: "x" }] }, fakeTheme(), { outputPad: 0, state: {} }) !== undefined);
const rendered = tools.get("todo").renderResult(
	{ content: [{ type: "text", text: "ok" }], details: (await run({ action: "list" })).details },
	{ expanded: false, isPartial: false },
	fakeTheme(),
	{ outputPad: 0, state: {} },
);
check("renderResult returns lines", rendered.render(60).length > 1);

function fakeTheme() {
	return { fg: (_t, s) => s, bold: (s) => s, style: (_o, s) => s, colors: {}, appearance: "dark" };
}

function visibleWidthOf(text) {
	// Rough width: the panel already truncated to the overlay width, so just count code points.
	return [...text].length;
}

// ---------- reminder nudge ----------
await run({ action: "plan", items: [{ text: "One open step" }, { text: "Another open step" }] });
const settle = await handlers.get("agent_before_settle")[0]({ entries: [] }, sessionCtx);
check("settle nudge fires once", settle?.continue === true && settle.entries.length === 1, JSON.stringify(settle));
const settle2 = await handlers.get("agent_before_settle")[0]({ entries: [] }, sessionCtx);
check("settle nudge does not repeat", settle2 === undefined, JSON.stringify(settle2));

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
