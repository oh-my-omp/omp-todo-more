import {
	type AskWait,
	commitRecordText,
	commitScopeText,
	dueAt,
	explanationText,
	goalLines,
	isOpen,
	type TodoItem,
	type TodoNgState,
	type TodoPhase,
	unexplainedItems,
} from "./state.ts";

const isClosed = (item: TodoItem): boolean => !isOpen(item.progress.status);

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

export function formatDateTime(ms: number): string {
	const date = new Date(ms);
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatClock(ms: number, now: number): string {
	const date = new Date(ms);
	const ref = new Date(now);
	const sameDay = date.getFullYear() === ref.getFullYear() && date.getMonth() === ref.getMonth() && date.getDate() === ref.getDate();
	return sameDay ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}` : formatDateTime(ms);
}

export function currentTimeLine(now: number): string {
	return `Current time: ${formatDateTime(now)}`;
}

export function itemTimeSummary(
	item: TodoItem,
	now: number,
	waits: readonly AskWait[] = [],
	detail: "inline" | "full" = "inline",
): string | undefined {
	const { progress, estimate } = item;
	const started = progress.startedAt === null ? undefined : `started ${formatClock(progress.startedAt, now)}`;
	const unestimated = "no time estimate yet: add one with estimate";
	const parts: string[] = [];
	switch (progress.status) {
		case "in_progress": {
			if (started !== undefined) parts.push(started);
			const due = dueAt(item, now, waits);
			if (estimate.kind === "missing") parts.push(unestimated);
			else if (due !== undefined) parts.push(`due by ${formatClock(due, now)}${now > due ? " (overdue)" : ""}`);
			break;
		}
		case "pending":
			if (started !== undefined) {
				if (detail === "full") parts.push(started);
				const resumes = detail === "full" ? " (deadline resumes on start)" : "";
				parts.push(progress.pausedAt === null ? "paused" : `paused ${formatClock(progress.pausedAt, now)}${resumes}`);
			} else if (detail === "full" && estimate.kind === "estimated") {
				parts.push("not started (deadline set on start)");
			}
			if (estimate.kind === "missing") parts.push(unestimated);
			break;
		case "completed":
		case "abandoned":
			if (detail === "full" && started !== undefined) parts.push(started);
			if (progress.closedAt !== null) parts.push(`${progress.status} ${formatClock(progress.closedAt, now)}`);
			break;
		default: {
			const unreachable: never = progress;
			throw new Error(`Unexpected progress: ${String(unreachable)}`);
		}
	}
	return parts.length > 0 ? parts.join(", ") : undefined;
}

function unestimatedItems(state: Extract<TodoNgState, { kind: "list" }>): TodoItem[] {
	return state.phases.flatMap((phase) => phase.items.filter((item) => !isClosed(item) && item.estimate.kind === "missing"));
}

function goalSection(state: Extract<TodoNgState, { kind: "list" }>): string[] {
	if (state.goal.kind === "set") return ["Goal:", ...goalLines(state.goal.goal).map((line) => `  ${line}`)];
	return ["Goal: none yet — pass goal ({ title, summary, acceptance }) on the next todo call."];
}

function overallLine(phases: readonly TodoPhase[]): string {
	const items = phases.flatMap((phase) => phase.items);
	const completed = items.filter((item) => item.progress.status === "completed").length;
	const abandoned = items.filter((item) => item.progress.status === "abandoned").length;
	const closed = completed + abandoned;
	const open = items.length - closed;
	const breakdown = abandoned > 0 ? ` (${completed} completed, ${abandoned} abandoned)` : "";
	return `Overall: ${closed}/${items.length} done${breakdown}, ${open} open.`;
}

function closedPhasesLine(phases: readonly TodoPhase[]): string | undefined {
	const closedPhases = phases.filter((phase) => phase.items.length > 0 && phase.items.every(isClosed));
	if (closedPhases.length === 0) return undefined;
	return `Closed phases: ${closedPhases.map((phase) => `${JSON.stringify(phase.name)} (${phase.items.length}/${phase.items.length})`).join(", ")}`;
}

function defectLines(state: Extract<TodoNgState, { kind: "list" }>): string[] {
	const lines: string[] = [];
	const unexplained = unexplainedItems(state);
	if (unexplained.length > 0) {
		lines.push(
			`Items without an explanation (${unexplained.length}); pass explain: ${unexplained.map((item) => JSON.stringify(item.id)).join(", ")}`,
		);
	}
	const unestimated = unestimatedItems(state);
	if (unestimated.length > 0) {
		lines.push(
			`Open items without a time estimate (${unestimated.length}); pass estimate: ${unestimated.map((item) => JSON.stringify(item.id)).join(", ")}`,
		);
	}
	return lines;
}

function indentMultiline(prefix: string, text: string): string {
	const continuation = " ".repeat(prefix.length);
	return `${prefix}${text.replaceAll("\n", `\n${continuation}`)}`;
}

function tailMark(item: TodoItem): string | undefined {
	if (item.tailRule === null) return undefined;
	return `project rule ${JSON.stringify(item.tailRule.ruleId)}${item.tailRule.protected ? ", protected" : ""}`;
}

function renderDetailedItem(item: TodoItem, now: number, waits: readonly AskWait[], indent: string): string[] {
	const marks = [itemTimeSummary(item, now, waits, "full"), tailMark(item)].filter((mark) => mark !== undefined);
	const suffix = marks.length === 0 ? "" : ` (${marks.join("; ")})`;
	const lines = [`${indent}- [${item.id}] [${item.progress.status}] ${JSON.stringify(item.title)}${suffix}`];
	lines.push(indentMultiline(`${indent}  Explanation: `, explanationText(item)));
	if (item.commit !== null) {
		lines.push(`${indent}  Commit: ${commitRecordText(item.commit)} (${commitScopeText(item.commit.scope)})`);
	}
	return lines;
}

export type CompactViewOptions = {
	readonly errors?: readonly string[];
	readonly notes?: readonly string[];
	readonly readOnly?: boolean;
	readonly preamble?: string;
	readonly highlightExplanations?: ReadonlySet<string>;
};

export function formatCompactView(
	state: TodoNgState,
	now: number,
	waits: readonly AskWait[] = [],
	options: CompactViewOptions = {},
): string {
	const lines: string[] = [currentTimeLine(now)];
	if (options.errors !== undefined && options.errors.length > 0) lines.push(`Errors: ${options.errors.join("; ")}`);
	if (options.preamble !== undefined) lines.push(options.preamble);
	if (state.kind === "empty") {
		if (options.errors === undefined || options.errors.length === 0) {
			lines.push(options.readOnly ? "Todo list is empty." : "Todo list cleared.");
		}
		if (options.notes !== undefined && options.notes.length > 0) lines.push(...options.notes);
		return lines.join("\n");
	}
	const { phases } = state;
	lines.push(...goalSection(state));
	lines.push(overallLine(phases));
	const closedSummary = closedPhasesLine(phases);
	if (closedSummary !== undefined) lines.push(closedSummary);

	const activePhaseIndex = phases.findIndex((phase) => !phase.items.every(isClosed));
	const workedAhead = activePhaseIndex >= 0 && phases.some((phase, index) => index > activePhaseIndex && phase.items.some(isClosed));

	let omittedClosed = false;
	let omittedPendingExplanations = false;
	for (const [index, phase] of phases.entries()) {
		const openItems = phase.items.filter((item) => !isClosed(item));
		const closedCount = phase.items.length - openItems.length;
		if (closedCount > 0) omittedClosed = true;
		if (openItems.length === 0) continue;
		const isActivePhase = index === activePhaseIndex;
		const aheadNote =
			isActivePhase && workedAhead
				? " — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion."
				: "";
		lines.push(
			`${isActivePhase ? "Active phase" : "Phase"} ${index + 1}/${phases.length} ${JSON.stringify(phase.name)} (${closedCount}/${phase.items.length} done)${aheadNote}:`,
		);
		for (const item of openItems) {
			const time = itemTimeSummary(item, now, waits, "inline");
			const flags: string[] = [];
			if (time !== undefined) flags.push(time);
			if (item.progress.status === "pending" && item.explanation.kind === "missing") flags.push("missing explanation");
			const tail = tailMark(item);
			if (tail !== undefined) flags.push(tail);
			const suffix = flags.length > 0 ? ` (${flags.join("; ")})` : "";
			lines.push(`  - [${item.id}] [${item.progress.status}] ${JSON.stringify(item.title)}${suffix}`);
			if (item.progress.status === "in_progress" || options.highlightExplanations?.has(item.id)) {
				lines.push(indentMultiline("    Explanation: ", explanationText(item)));
			} else if (item.explanation.kind === "explained") {
				omittedPendingExplanations = true;
			}
		}
	}

	lines.push(...defectLines(state));
	if (options.notes !== undefined && options.notes.length > 0) lines.push(...options.notes);

	const omitted: string[] = [];
	if (omittedClosed) omitted.push("closed items");
	if (omittedPendingExplanations) omitted.push("pending explanations");
	if (omitted.length > 0) {
		lines.push(`Omitted: ${omitted.join(" and ")}. Call todo({}) or todo({ view: "<phase>" }) to inspect.`);
	}
	return lines.join("\n");
}

export function formatOpenView(state: TodoNgState, now: number, waits: readonly AskWait[] = []): string {
	const lines: string[] = [currentTimeLine(now)];
	if (state.kind === "empty") {
		lines.push("Todo list is empty.");
		return lines.join("\n");
	}
	const { phases } = state;
	lines.push(...goalSection(state));
	lines.push(overallLine(phases));
	const closedSummary = closedPhasesLine(phases);
	if (closedSummary !== undefined) lines.push(closedSummary);

	let omittedClosed = false;
	for (const [index, phase] of phases.entries()) {
		const openItems = phase.items.filter((item) => !isClosed(item));
		const closedCount = phase.items.length - openItems.length;
		if (closedCount > 0) omittedClosed = true;
		if (openItems.length === 0) continue;
		lines.push(`Phase ${index + 1}/${phases.length} ${JSON.stringify(phase.name)} (${closedCount}/${phase.items.length} done):`);
		for (const item of openItems) lines.push(...renderDetailedItem(item, now, waits, "  "));
	}

	lines.push(...defectLines(state));
	if (omittedClosed) {
		lines.push('Closed items omitted. Call todo({}) or todo({ view: "<phase>" }) to inspect completed/abandoned items.');
	}
	return lines.join("\n");
}

export function formatFullView(
	state: TodoNgState,
	now: number,
	waits: readonly AskWait[] = [],
	options: { readonly preamble?: string } = {},
): string {
	const lines: string[] = [currentTimeLine(now)];
	if (options.preamble !== undefined) lines.push(options.preamble);
	if (state.kind === "empty") {
		lines.push("Todo list is empty.");
		return lines.join("\n");
	}
	const { phases } = state;
	lines.push(...goalSection(state));
	lines.push(overallLine(phases));
	for (const [index, phase] of phases.entries()) {
		const closedCount = phase.items.filter(isClosed).length;
		lines.push(`Phase ${index + 1}/${phases.length} ${JSON.stringify(phase.name)} (${closedCount}/${phase.items.length} done):`);
		for (const item of phase.items) lines.push(...renderDetailedItem(item, now, waits, "  "));
	}
	lines.push(...defectLines(state));
	return lines.join("\n");
}

export function formatPhaseView(phase: TodoPhase, now: number, waits: readonly AskWait[] = []): string {
	const closedCount = phase.items.filter(isClosed).length;
	const openCount = phase.items.length - closedCount;
	const lines: string[] = [
		currentTimeLine(now),
		`Phase ${JSON.stringify(phase.name)} (${closedCount}/${phase.items.length} done, ${openCount} open):`,
	];
	for (const item of phase.items) lines.push(...renderDetailedItem(item, now, waits, "  "));
	return lines.join("\n");
}
