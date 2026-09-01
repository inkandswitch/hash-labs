import { view } from "@automerge/automerge";
import { decodeHeads, type UrlHeads } from "@automerge/automerge-repo";
import type {
	Color,
	DifferentialEquation,
	Parameter,
	Place,
	SDCPN,
	Transition,
} from "@hashintel/petrinaut";
import type { Metric, Scenario } from "@hashintel/petrinaut-core";
import type { Doc } from "./datatype";
import { arcsById, isEqual } from "./diff";

/** A field-level diff of the whole document against a baseline, for the
 * change-list panel of the diff tool. Where `diffNet` answers "which canvas
 * elements should glow", this answers "what exactly changed, property by
 * property" — across the graph and everything around it: token types,
 * parameters, differential equations, scenarios, metrics and the title.
 */
export type DocDiff = {
	sections: DiffSection[];
};

export type DiffSection = {
	title: string;
	changes: EntityChange[];
};

export type ChangeKind = "added" | "removed" | "edited" | "moved";

export type EntityChange = {
	/** Unique within the section. */
	id: string;
	/** The `data-id` React Flow renders this entity under, when it is a live
	 * canvas element the panel can glow on hover; `null` for removed elements
	 * and for entities that live in Petrinaut's side panels. */
	canvasId: string | null;
	name: string;
	kind: ChangeKind;
	/** An edited node that was also dragged (pure drags get kind "moved"). */
	moved?: boolean;
	fields: FieldChange[];
};

export type FieldChange = {
	label: string;
	before: string;
	after: string;
	/** Render as a line diff rather than `before → after`. */
	code?: boolean;
};

/** Diff the document against the version at `heads`, the draft's fork point.
 *
 * Returns `null` when the heads aren't part of this document's history, same
 * as `diffNet`.
 */
export function detailedDocDiff(doc: Doc, heads: UrlHeads): DocDiff | null {
	let baseline: Doc;
	try {
		baseline = plainDoc(view(doc, decodeHeads(heads)));
	} catch (error) {
		console.warn("[petrinaut/diff] no document at the baseline heads", error);
		return null;
	}
	const current = plainDoc(doc);
	const before = baseline.petriNetDefinition ?? EMPTY_NET;
	const after = current.petriNetDefinition ?? EMPTY_NET;

	// Referenced entities are named against the live net first, so a rename
	// shows up once (on the renamed entity) rather than everywhere it is used.
	const colorName = referenceNamer(after.types, before.types);
	const equationName = referenceNamer(
		after.differentialEquations,
		before.differentialEquations,
	);
	const parameterName = referenceNamer(after.parameters, before.parameters);
	const placeName = referenceNamer(after.places, before.places);
	const nodeName = referenceNamer(
		[...after.places, ...after.transitions],
		[...before.places, ...before.transitions],
	);

	const sections: DiffSection[] = [
		{ title: "Net", changes: diffTitle(baseline, current) },
		{
			title: "Places",
			changes: diffEntities(before.places, after.places, {
				canvas: true,
				fields: (prev, next) =>
					placeFields(prev, next, colorName, equationName),
			}),
		},
		{
			title: "Transitions",
			changes: diffEntities(
				before.transitions.map(withoutArcs),
				after.transitions.map(withoutArcs),
				{ canvas: true, fields: transitionFields },
			),
		},
		{ title: "Arcs", changes: diffArcs(before, after, nodeName) },
		{
			title: "Token types",
			changes: diffEntities(before.types, after.types, {
				fields: colorFields,
			}),
		},
		{
			title: "Parameters",
			changes: diffEntities(before.parameters, after.parameters, {
				fields: parameterFields,
			}),
		},
		{
			title: "Differential equations",
			changes: diffEntities(
				before.differentialEquations,
				after.differentialEquations,
				{ fields: (prev, next) => equationFields(prev, next, colorName) },
			),
		},
		{
			title: "Scenarios",
			changes: diffEntities(before.scenarios ?? [], after.scenarios ?? [], {
				fields: (prev, next) =>
					scenarioFields(prev, next, parameterName, placeName),
			}),
		},
		{
			title: "Metrics",
			changes: diffEntities(before.metrics ?? [], after.metrics ?? [], {
				fields: metricFields,
			}),
		},
	];

	return { sections: sections.filter((section) => section.changes.length > 0) };
}

export const hasDetailedDiff = (diff: DocDiff | null): diff is DocDiff =>
	!!diff && diff.sections.length > 0;

function diffTitle(baseline: Doc, current: Doc): EntityChange[] {
	if (baseline.title === current.title) return [];
	return [
		{
			id: "title",
			canvasId: null,
			name: "Title",
			kind: "edited",
			fields: [
				{ label: "title", before: show(baseline.title), after: show(current.title) },
			],
		},
	];
}

/** Diff one entity collection by id into added / removed / edited / moved. */
function diffEntities<T extends { id: string; name: string }>(
	before: T[],
	after: T[],
	options: {
		/** Nodes drawn on the canvas: hover-glowable by id, x/y is a "move". */
		canvas?: boolean;
		fields: (previous: T, next: T) => FieldChange[];
	},
): EntityChange[] {
	const changes: EntityChange[] = [];
	const previousById = new Map(before.map((item) => [item.id, item]));
	const liveIds = new Set(after.map((item) => item.id));

	for (const item of after) {
		const canvasId = options.canvas ? item.id : null;
		const previous = previousById.get(item.id);
		if (!previous) {
			changes.push({
				id: item.id,
				canvasId,
				name: item.name,
				kind: "added",
				fields: [],
			});
			continue;
		}
		const fields = options.fields(previous, item);
		const moved = options.canvas && hasMoved(previous, item);
		if (fields.length > 0) {
			changes.push({
				id: item.id,
				canvasId,
				name: item.name,
				kind: "edited",
				moved,
				fields,
			});
		} else if (moved) {
			changes.push({
				id: item.id,
				canvasId,
				name: item.name,
				kind: "moved",
				fields: [],
			});
		}
	}

	for (const item of before) {
		if (!liveIds.has(item.id)) {
			changes.push({
				id: item.id,
				canvasId: null,
				name: item.name,
				kind: "removed",
				fields: [],
			});
		}
	}

	return changes;
}

const hasMoved = (previous: unknown, next: unknown): boolean => {
	const a = previous as { x?: number; y?: number };
	const b = next as { x?: number; y?: number };
	return a.x !== b.x || a.y !== b.y;
};

function placeFields(
	previous: Place,
	next: Place,
	colorName: Namer,
	equationName: Namer,
): FieldChange[] {
	return compact([
		field("name", previous.name, next.name),
		field("token type", colorName(previous.colorId), colorName(next.colorId)),
		field("dynamics", flag(previous.dynamicsEnabled), flag(next.dynamicsEnabled)),
		field(
			"differential equation",
			equationName(previous.differentialEquationId),
			equationName(next.differentialEquationId),
		),
		field(
			"show as initial state",
			flag(previous.showAsInitialState ?? false),
			flag(next.showAsInitialState ?? false),
		),
		codeField("visualizer code", previous.visualizerCode, next.visualizerCode),
	]);
}

function transitionFields(
	previous: Omit<Transition, "inputArcs" | "outputArcs">,
	next: Omit<Transition, "inputArcs" | "outputArcs">,
): FieldChange[] {
	return compact([
		field("name", previous.name, next.name),
		field("lambda type", previous.lambdaType, next.lambdaType),
		codeField("lambda code", previous.lambdaCode, next.lambdaCode),
		codeField(
			"transition kernel",
			previous.transitionKernelCode,
			next.transitionKernelCode,
		),
	]);
}

/** A transition minus its arcs — same reason as in `diff.ts`: arcs are diffed
 * as edges of their own, not folded into the transition that stores them. */
function withoutArcs(transition: Transition) {
	const { inputArcs, outputArcs, ...rest } = transition;
	return rest;
}

/** Arcs, keyed and named the way the canvas draws them. */
function diffArcs(before: SDCPN, after: SDCPN, nodeName: Namer): EntityChange[] {
	const changes: EntityChange[] = [];
	const previousArcs = arcsById(before);
	const liveArcs = arcsById(after);

	for (const [id, arc] of liveArcs) {
		const name = `${nodeName(arc.from)} → ${nodeName(arc.to)}`;
		const previous = previousArcs.get(id);
		if (!previous) {
			changes.push({ id, canvasId: id, name, kind: "added", fields: [] });
			continue;
		}
		const fields = compact([
			field("weight", String(previous.weight), String(arc.weight)),
			field("type", previous.type, arc.type),
		]);
		if (fields.length > 0) {
			changes.push({ id, canvasId: id, name, kind: "edited", fields });
		}
	}

	for (const [id, arc] of previousArcs) {
		if (!liveArcs.has(id)) {
			changes.push({
				id,
				canvasId: null,
				name: `${nodeName(arc.from)} → ${nodeName(arc.to)}`,
				kind: "removed",
				fields: [],
			});
		}
	}

	return changes;
}

function colorFields(previous: Color, next: Color): FieldChange[] {
	const changes = compact([
		field("name", previous.name, next.name),
		field("icon", previous.iconSlug, next.iconSlug),
		field("color", previous.displayColor, next.displayColor),
	]);

	const previousById = new Map(
		previous.elements.map((element) => [element.elementId, element]),
	);
	const liveIds = new Set(next.elements.map((element) => element.elementId));
	for (const element of next.elements) {
		const prev = previousById.get(element.elementId);
		if (!prev) {
			changes.push({
				label: `field "${element.name}"`,
				before: "none",
				after: element.type,
			});
			continue;
		}
		const renamed = field(
			`field "${prev.name}" name`,
			prev.name,
			element.name,
		);
		if (renamed) changes.push(renamed);
		const retyped = field(
			`field "${element.name}" type`,
			prev.type,
			element.type,
		);
		if (retyped) changes.push(retyped);
	}
	for (const element of previous.elements) {
		if (!liveIds.has(element.elementId)) {
			changes.push({
				label: `field "${element.name}"`,
				before: element.type,
				after: "none",
			});
		}
	}

	return changes;
}

function parameterFields(previous: Parameter, next: Parameter): FieldChange[] {
	return compact([
		field("name", previous.name, next.name),
		field("variable", previous.variableName, next.variableName),
		field("type", previous.type, next.type),
		field("default", show(previous.defaultValue), show(next.defaultValue)),
	]);
}

function equationFields(
	previous: DifferentialEquation,
	next: DifferentialEquation,
	colorName: Namer,
): FieldChange[] {
	return compact([
		field("name", previous.name, next.name),
		field("token type", colorName(previous.colorId), colorName(next.colorId)),
		codeField("code", previous.code, next.code),
	]);
}

function scenarioFields(
	previous: Scenario,
	next: Scenario,
	parameterName: Namer,
	placeName: Namer,
): FieldChange[] {
	const changes = compact([
		field("name", previous.name, next.name),
		field("description", show(previous.description), show(next.description)),
	]);

	// Scenario-local parameters, keyed by identifier.
	const previousParams = new Map(
		previous.scenarioParameters.map((param) => [param.identifier, param]),
	);
	const liveParams = new Set(
		next.scenarioParameters.map((param) => param.identifier),
	);
	for (const param of next.scenarioParameters) {
		const prev = previousParams.get(param.identifier);
		const summary = `${param.type}, default ${param.default}`;
		if (!prev) {
			changes.push({
				label: `parameter "${param.identifier}"`,
				before: "none",
				after: summary,
			});
		} else if (prev.type !== param.type || prev.default !== param.default) {
			changes.push({
				label: `parameter "${param.identifier}"`,
				before: `${prev.type}, default ${prev.default}`,
				after: summary,
			});
		}
	}
	for (const param of previous.scenarioParameters) {
		if (!liveParams.has(param.identifier)) {
			changes.push({
				label: `parameter "${param.identifier}"`,
				before: `${param.type}, default ${param.default}`,
				after: "none",
			});
		}
	}

	// Overrides of net-level parameters, keyed by parameter id.
	const overrideIds = new Set([
		...Object.keys(previous.parameterOverrides),
		...Object.keys(next.parameterOverrides),
	]);
	for (const id of overrideIds) {
		const change = field(
			`override "${parameterName(id)}"`,
			show(previous.parameterOverrides[id]),
			show(next.parameterOverrides[id]),
		);
		if (change) changes.push(change);
	}

	changes.push(...initialStateFields(previous, next, placeName));
	return changes;
}

function initialStateFields(
	previous: Scenario,
	next: Scenario,
	placeName: Namer,
): FieldChange[] {
	const before = previous.initialState;
	const after = next.initialState;

	if (before.type !== after.type) {
		return [
			{
				label: "initial state",
				before: stateMode(before.type),
				after: stateMode(after.type),
			},
		];
	}
	if (before.type === "code" && after.type === "code") {
		return compact([
			codeField("initial state code", before.content, after.content),
		]);
	}
	if (before.type === "per_place" && after.type === "per_place") {
		const changes: FieldChange[] = [];
		const placeIds = new Set([
			...Object.keys(before.content),
			...Object.keys(after.content),
		]);
		for (const id of placeIds) {
			if (isEqual(before.content[id], after.content[id])) continue;
			changes.push({
				label: `initial state · ${placeName(id)}`,
				before: showState(before.content[id]),
				after: showState(after.content[id]),
			});
		}
		return changes;
	}
	return [];
}

const stateMode = (type: "per_place" | "code") =>
	type === "per_place" ? "per place" : "code";

const showState = (value: string | number[][] | undefined): string =>
	value === undefined
		? "none"
		: typeof value === "string"
			? show(value)
			: JSON.stringify(value);

function metricFields(previous: Metric, next: Metric): FieldChange[] {
	return compact([
		field("name", previous.name, next.name),
		field("description", show(previous.description), show(next.description)),
		codeField("code", previous.code, next.code),
	]);
}

function field(
	label: string,
	before: string,
	after: string,
): FieldChange | null {
	return before === after ? null : { label, before, after };
}

function codeField(
	label: string,
	before: string | undefined,
	after: string | undefined,
): FieldChange | null {
	if ((before ?? "") === (after ?? "")) return null;
	return { label, before: before ?? "", after: after ?? "", code: true };
}

const compact = (fields: (FieldChange | null)[]): FieldChange[] =>
	fields.filter((change): change is FieldChange => change !== null);

const flag = (value: boolean) => (value ? "on" : "off");

const show = (value: string | undefined | null): string =>
	value === undefined || value === null || value === "" ? "none" : value;

type Namer = (id: string | null) => string;

/** Resolve an entity reference to a display name, preferring the live net. */
function referenceNamer(
	...lists: { id: string; name: string }[][]
): Namer {
	const names = new Map<string, string>();
	for (const list of lists.reverse()) {
		for (const { id, name } of list) {
			names.set(id, name);
		}
	}
	return (id) => (id === null ? "none" : (names.get(id) ?? id));
}

/** Deep-copy the whole doc to plain JS, shedding Automerge proxies. */
function plainDoc(doc: Doc): Doc {
	return JSON.parse(JSON.stringify(doc)) as Doc;
}

const EMPTY_NET: SDCPN = {
	places: [],
	transitions: [],
	types: [],
	differentialEquations: [],
	parameters: [],
};

// --- Line diff for code fields -------------------------------------------

export type DiffLine = {
	type: "context" | "added" | "removed";
	text: string;
};

/** A minimal LCS line diff for the collapsible code sections. Falls back to
 * "everything removed, everything added" for pathologically large bodies. */
export function diffLines(before: string, after: string): DiffLine[] {
	const a = splitLines(before);
	const b = splitLines(after);

	if (a.length * b.length > 250_000) {
		return [
			...a.map((text) => ({ type: "removed" as const, text })),
			...b.map((text) => ({ type: "added" as const, text })),
		];
	}

	// lcs[i][j] = length of the LCS of a[i..] and b[j..]
	const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
		new Array<number>(b.length + 1).fill(0),
	);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i][j] =
				a[i] === b[j]
					? lcs[i + 1][j + 1] + 1
					: Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	const lines: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			lines.push({ type: "context", text: a[i] });
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			lines.push({ type: "removed", text: a[i] });
			i++;
		} else {
			lines.push({ type: "added", text: b[j] });
			j++;
		}
	}
	for (; i < a.length; i++) lines.push({ type: "removed", text: a[i] });
	for (; j < b.length; j++) lines.push({ type: "added", text: b[j] });
	return lines;
}

const splitLines = (text: string): string[] =>
	text === "" ? [] : text.split("\n");
