import { cursor } from "@automerge/automerge-repo";
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import type { Workspace } from "@patchwork/llm";
import type {
	Color,
	DifferentialEquation,
	Parameter,
	Place,
	SDCPN,
	Transition,
} from "@hashintel/petrinaut";

/** "standard" or "inhibitor" — an inhibitor arc blocks its transition while the place holds tokens. */
type ArcType = Transition["inputArcs"][number]["type"];

// Everything Patchwork-side lives under the `@patchwork` envelope next to
// the datatype tag: provenance entries and per-element metadata. NEVER
// reassign the whole `@patchwork` object — always merge into it, or the
// other sections get clobbered.
type PatchworkSection = {
	type: "petrinaut-petrinet";
	provenance?: ProvenanceEntry[];
	metadata?: Record<string, ElementMetadata>;
};

type PetriNetDoc = {
	"@patchwork": PatchworkSection;
	title: string;
	petriNetDefinition: SDCPN;
};

// Provenance: where the net (or parts of it) came from. Entries live in this
// document and point back at their sources; Patchwork's provenance provider
// indexes them so source documents can show inbound links. Targets and
// sources are ALWAYS automerge urls — ref urls into a doc, or bare doc urls.
type ProvenanceEntry = {
	id: string;
	targets: AutomergeUrl[];
	sources: AutomergeUrl[];
	createdAt?: number;
	note?: string;
};

// Arbitrary per-element annotations, keyed by element id under
// `@patchwork.metadata`. `geo` is the one convention other tools understand:
// the Map tool renders every element that has one as a marker.
type ElementMetadata = {
	geo?: { lat: number; lng: number };
	[key: string]: unknown;
};

// Passed alongside a creation call: "the elements this call creates came from
// these sources". The created elements become the entry's targets.
type ProvenanceArgs = {
	sources: AutomergeUrl[];
	note?: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ARC_ID_PREFIX = "$A_";
const ARC_ID_SEPARATOR = "___";

function generateArcId(inputId: string, outputId: string) {
	return `${ARC_ID_PREFIX}${inputId}${ARC_ID_SEPARATOR}${outputId}`;
}

function findPlace(def: SDCPN, nameOrId: string) {
	return def.places.find((p) => p.name === nameOrId || p.id === nameOrId);
}

function findTransition(def: SDCPN, nameOrId: string) {
	return def.transitions.find(
		(t) => t.name === nameOrId || t.id === nameOrId,
	);
}

// Build a ref url into a document. The host runtime exposes `handle.sub(...)`
// (subduction) or `handle.ref(...)` (upstream automerge-repo) — same call
// shape, different name — so tolerate both.
function makeRefUrl(handle: DocHandle<unknown>, path: unknown[]): AutomergeUrl {
	const h = handle as unknown as {
		sub?: (...segments: unknown[]) => { url: AutomergeUrl };
		ref?: (...segments: unknown[]) => { url: AutomergeUrl };
	};
	const make = h.sub ?? h.ref;
	if (!make) {
		throw new Error(
			"This automerge-repo runtime has neither handle.sub nor handle.ref — cannot build ref urls",
		);
	}
	return make.apply(handle, path).url;
}

// A ref url addressing one element of a net by id (stable across splices).
function elementRefUrl(
	handle: DocHandle<unknown>,
	kind: ElementKind,
	id: string,
): AutomergeUrl {
	return makeRefUrl(handle, [
		"petriNetDefinition",
		ELEMENT_ARRAYS[kind],
		{ id },
	]);
}

// Append one provenance entry with the given targets. The shared tail of
// addProvenance and of every creation method's `provenance` option.
function appendProvenanceEntry(
	handle: DocHandle<PetriNetDoc>,
	targets: AutomergeUrl[],
	provenance: ProvenanceArgs,
): ProvenanceEntry {
	const entry: ProvenanceEntry = {
		id: crypto.randomUUID(),
		targets,
		sources: provenance.sources,
		createdAt: Date.now(),
		...(provenance.note !== undefined ? { note: provenance.note } : {}),
	};
	handle.change((doc) => {
		const patchwork = (doc["@patchwork"] ??= {
			type: "petrinaut-petrinet",
		});
		patchwork.provenance ??= [];
		patchwork.provenance.push(entry);
	});
	return entry;
}

// Merge a metadata patch into `@patchwork.metadata[<id>]`. Runs INSIDE a
// handle.change. Undefined values delete the key.
function writeElementMetadata(
	doc: PetriNetDoc,
	id: string,
	metadata: ElementMetadata,
) {
	const patchwork = (doc["@patchwork"] ??= { type: "petrinaut-petrinet" });
	patchwork.metadata ??= {};
	const slot = (patchwork.metadata[id] ??= {});
	for (const [key, value] of Object.entries(metadata)) {
		if (value === undefined) delete slot[key];
		else slot[key] = value;
	}
}

// The array each element kind lives in under `petriNetDefinition`.
const ELEMENT_ARRAYS = {
	place: "places",
	transition: "transitions",
	type: "types",
	parameter: "parameters",
	differentialEquation: "differentialEquations",
} as const;

type ElementKind = keyof typeof ELEMENT_ARRAYS;

type RemoveItem =
	| { type: "place"; id: string }
	| { type: "transition"; id: string }
	| { type: "arc"; id: string }
	| { type: "type"; id: string }
	| { type: "differentialEquation"; id: string }
	| { type: "parameter"; id: string };

function deleteItemsFromSdcpn(sdcpn: SDCPN, items: RemoveItem[]) {
	if (items.length === 0) return;

	const placeIds = new Set<string>();
	const transitionIds = new Set<string>();
	const arcIds = new Set<string>();
	const typeIds = new Set<string>();
	const equationIds = new Set<string>();
	const parameterIds = new Set<string>();

	for (const item of items) {
		switch (item.type) {
			case "place":
				placeIds.add(item.id);
				break;
			case "transition":
				transitionIds.add(item.id);
				break;
			case "arc":
				arcIds.add(item.id);
				break;
			case "type":
				typeIds.add(item.id);
				break;
			case "differentialEquation":
				equationIds.add(item.id);
				break;
			case "parameter":
				parameterIds.add(item.id);
				break;
		}
	}

	if (placeIds.size > 0 || transitionIds.size > 0 || arcIds.size > 0) {
		for (let i = sdcpn.transitions.length - 1; i >= 0; i--) {
			const transition = sdcpn.transitions[i];
			if (!transition) continue;
			if (transitionIds.has(transition.id)) {
				sdcpn.transitions.splice(i, 1);
				continue;
			}

			for (let j = transition.inputArcs.length - 1; j >= 0; j--) {
				const arc = transition.inputArcs[j];
				if (!arc) continue;
				const arcId = generateArcId(arc.placeId, transition.id);
				if (arcIds.has(arcId) || placeIds.has(arc.placeId)) {
					transition.inputArcs.splice(j, 1);
				}
			}

			for (let j = transition.outputArcs.length - 1; j >= 0; j--) {
				const arc = transition.outputArcs[j];
				if (!arc) continue;
				const arcId = generateArcId(transition.id, arc.placeId);
				if (arcIds.has(arcId) || placeIds.has(arc.placeId)) {
					transition.outputArcs.splice(j, 1);
				}
			}
		}

		for (let i = sdcpn.places.length - 1; i >= 0; i--) {
			const place = sdcpn.places[i];
			if (place && placeIds.has(place.id)) {
				sdcpn.places.splice(i, 1);
			}
		}
	}

	if (typeIds.size > 0) {
		for (let i = sdcpn.types.length - 1; i >= 0; i--) {
			const color = sdcpn.types[i];
			if (color && typeIds.has(color.id)) {
				sdcpn.types.splice(i, 1);
			}
		}
		for (const place of sdcpn.places) {
			if (place.colorId && typeIds.has(place.colorId)) {
				place.colorId = null;
			}
		}
		for (const eq of sdcpn.differentialEquations) {
			if (eq.colorId && typeIds.has(eq.colorId)) {
				eq.colorId = null;
			}
		}
	}

	if (equationIds.size > 0) {
		for (let i = sdcpn.differentialEquations.length - 1; i >= 0; i--) {
			const eq = sdcpn.differentialEquations[i];
			if (eq && equationIds.has(eq.id)) {
				sdcpn.differentialEquations.splice(i, 1);
			}
		}
		for (const place of sdcpn.places) {
			if (
				place.differentialEquationId &&
				equationIds.has(place.differentialEquationId)
			) {
				place.differentialEquationId = null;
			}
		}
	}

	if (parameterIds.size > 0) {
		for (let i = sdcpn.parameters.length - 1; i >= 0; i--) {
			const param = sdcpn.parameters[i];
			if (param && parameterIds.has(param.id)) {
				sdcpn.parameters.splice(i, 1);
			}
		}
	}
}

// ─── Arc direction types ──────────────────────────────────────────────────────

type PlaceToTransitionArc = {
	direction: "place_to_transition";
	source_place: string;
	target_transition: string;
	weight?: number;
	type?: ArcType;
};

type TransitionToPlaceArc = {
	direction: "transition_to_place";
	source_transition: string;
	target_place: string;
	weight?: number;
};

type ArcArgs = PlaceToTransitionArc | TransitionToPlaceArc;

type BatchAdd = {
	places?: Array<{
		name: string;
		colorId?: string;
		x?: number;
		y?: number;
		dynamicsEnabled?: boolean;
		differentialEquationId?: string;
		visualizerCode?: string;
		metadata?: ElementMetadata;
	}>;
	transitions?: Array<{
		name: string;
		x?: number;
		y?: number;
		lambdaType?: "predicate" | "stochastic";
		lambdaCode?: string;
		transitionKernelCode?: string;
		inputArcs: Transition["inputArcs"];
		outputArcs: Transition["outputArcs"];
		metadata?: ElementMetadata;
	}>;
	arcs?: ArcArgs[];
};

// ─── Default export: constructor function ─────────────────────────────────────

export default function (workspace: Workspace) {
	return {
		// Pass `provenance` when the net is being built FROM another document:
		// a whole-net entry pointing at the sources is recorded right away.
		async createPetriNet(title?: string, provenance?: ProvenanceArgs) {
			const handle: DocHandle<PetriNetDoc> = await workspace.create<PetriNetDoc>({
				name: title ?? "Untitled Petri Net",
				type: "petrinaut-petrinet",
			});
			handle.change((doc) => {
				// Merge, never replace: @patchwork also carries provenance
				// and metadata sections.
				const patchwork = (doc["@patchwork"] ??= {
					type: "petrinaut-petrinet",
				});
				patchwork.type = "petrinaut-petrinet";
				doc.title = title ?? "Untitled Petri Net";
				doc.petriNetDefinition = {
					places: [],
					transitions: [],
					types: [],
					parameters: [],
					differentialEquations: [],
				};
			});
			if (provenance) {
				appendProvenanceEntry(handle, [handle.url], provenance);
			}
			return { handle, url: handle.url };
		},

		// A cursor-anchored ref url for a text range in another document
		// (e.g. the paragraph a net was generated from). The anchor survives
		// edits to the text. `path` is where the text lives in that doc —
		// ["content"] for standard text documents.
		async textRangeRef(
			url: AutomergeUrl,
			from: number,
			to: number,
			path: string[] = ["content"],
		): Promise<AutomergeUrl> {
			const handle = await workspace.find(url);
			return makeRefUrl(handle, [...path, cursor(from, to)]);
		},

		async getPetriNet(url: AutomergeUrl) {
			const handle: DocHandle<PetriNetDoc> = await workspace.find<PetriNetDoc>(url);

			return {
				get url() {
					return handle.url;
				},

				// ── Read methods ────────────────────────────────────────────

				getPlaces(): Place[] {
					return handle.doc()?.petriNetDefinition.places ?? [];
				},

				getTransitions(): Transition[] {
					return handle.doc()?.petriNetDefinition.transitions ?? [];
				},

				getArcs() {
					const def = handle.doc()?.petriNetDefinition;
					if (!def) return [];
					const arcs: Array<{
						id: string;
						direction: "place_to_transition" | "transition_to_place";
						placeId: string;
						transitionId: string;
						weight: number;
						type?: ArcType;
					}> = [];
					for (const t of def.transitions) {
						for (const ia of t.inputArcs) {
							arcs.push({
								id: generateArcId(ia.placeId, t.id),
								direction: "place_to_transition",
								placeId: ia.placeId,
								transitionId: t.id,
								weight: ia.weight,
								type: ia.type,
							});
						}
						for (const oa of t.outputArcs) {
							arcs.push({
								id: generateArcId(t.id, oa.placeId),
								direction: "transition_to_place",
								placeId: oa.placeId,
								transitionId: t.id,
								weight: oa.weight,
							});
						}
					}
					return arcs;
				},

				getColors(): Color[] {
					return handle.doc()?.petriNetDefinition.types ?? [];
				},

				getDifferentialEquations(): DifferentialEquation[] {
					return (
						handle.doc()?.petriNetDefinition.differentialEquations ?? []
					);
				},

				getParameters(): Parameter[] {
					return handle.doc()?.petriNetDefinition.parameters ?? [];
				},

				getTitle(): string {
					return handle.doc()?.title ?? "";
				},

				// ── Write methods ───────────────────────────────────────────

				addPlace(args: {
					name: string;
					colorId?: string;
					x?: number;
					y?: number;
					dynamicsEnabled?: boolean;
					differentialEquationId?: string;
					visualizerCode?: string;
					provenance?: ProvenanceArgs;
					metadata?: ElementMetadata;
				}) {
					const newPlace: Place = {
						id: crypto.randomUUID(),
						name: args.name,
						colorId: args.colorId ?? null,
						dynamicsEnabled: args.dynamicsEnabled ?? false,
						differentialEquationId: args.differentialEquationId ?? null,
						x: args.x ?? 100,
						y: args.y ?? 100,
						visualizerCode: args.visualizerCode,
					};
					handle.change((doc) => {
						doc.petriNetDefinition.places.push(newPlace);
						if (args.metadata) {
							writeElementMetadata(doc, newPlace.id, args.metadata);
						}
					});
					if (args.provenance) {
						appendProvenanceEntry(
							handle,
							[elementRefUrl(handle, "place", newPlace.id)],
							args.provenance,
						);
					}
					return newPlace;
				},

				addTransition(args: {
					name: string;
					x?: number;
					y?: number;
					lambdaType?: "predicate" | "stochastic";
					lambdaCode?: string;
					transitionKernelCode?: string;
					inputArcs: Transition["inputArcs"];
					outputArcs: Transition["outputArcs"];
					provenance?: ProvenanceArgs;
					metadata?: ElementMetadata;
				}) {
					const newTransition: Transition = {
						id: crypto.randomUUID(),
						name: args.name,
						inputArcs: args.inputArcs,
						outputArcs: args.outputArcs,
						lambdaType: args.lambdaType ?? "predicate",
						lambdaCode: args.lambdaCode ?? "",
						transitionKernelCode: args.transitionKernelCode ?? "",
						x: args.x ?? 100,
						y: args.y ?? 100,
					};
					handle.change((doc) => {
						doc.petriNetDefinition.transitions.push(newTransition);
						if (args.metadata) {
							writeElementMetadata(
								doc,
								newTransition.id,
								args.metadata,
							);
						}
					});
					if (args.provenance) {
						appendProvenanceEntry(
							handle,
							[elementRefUrl(handle, "transition", newTransition.id)],
							args.provenance,
						);
					}
					return newTransition;
				},

				addArc(args: ArcArgs) {
					handle.change((doc) => {
						const def = doc.petriNetDefinition;
						if (args.direction === "place_to_transition") {
							const place = findPlace(def, args.source_place);
							if (!place)
								throw new Error(
									`Place "${args.source_place}" not found`,
								);
							const transition = findTransition(
								def,
								args.target_transition,
							);
							if (!transition)
								throw new Error(
									`Transition "${args.target_transition}" not found`,
								);
							transition.inputArcs.push({
								placeId: place.id,
								weight: args.weight ?? 1,
								type: args.type ?? "standard",
							});
						} else {
							const transition = findTransition(
								def,
								args.source_transition,
							);
							if (!transition)
								throw new Error(
									`Transition "${args.source_transition}" not found`,
								);
							const place = findPlace(def, args.target_place);
							if (!place)
								throw new Error(
									`Place "${args.target_place}" not found`,
								);
							transition.outputArcs.push({
								placeId: place.id,
								weight: args.weight ?? 1,
							});
						}
					});
				},

				addColor(args: {
					name: string;
					iconSlug?: string;
					displayColor: string;
					elements?: Array<{
						name: string;
						type: "real" | "integer" | "boolean";
					}>;
					provenance?: ProvenanceArgs;
				}) {
					const newColor: Color = {
						id: crypto.randomUUID(),
						name: args.name,
						iconSlug: args.iconSlug ?? "circle",
						displayColor: args.displayColor,
						elements: (args.elements ?? []).map((el) => ({
							elementId: crypto.randomUUID(),
							name: el.name,
							type: el.type,
						})),
					};
					handle.change((doc) => {
						doc.petriNetDefinition.types.push(newColor);
					});
					if (args.provenance) {
						appendProvenanceEntry(
							handle,
							[elementRefUrl(handle, "type", newColor.id)],
							args.provenance,
						);
					}
					return newColor;
				},

				addDifferentialEquation(args: {
					name: string;
					colorId: string;
					code: string;
					provenance?: ProvenanceArgs;
				}) {
					const newEq: DifferentialEquation = {
						id: crypto.randomUUID(),
						name: args.name,
						colorId: args.colorId,
						code: args.code,
					};
					handle.change((doc) => {
						doc.petriNetDefinition.differentialEquations.push(newEq);
					});
					if (args.provenance) {
						appendProvenanceEntry(
							handle,
							[elementRefUrl(handle, "differentialEquation", newEq.id)],
							args.provenance,
						);
					}
					return newEq;
				},

				addParameter(args: {
					name: string;
					variableName: string;
					type: "real" | "integer" | "boolean";
					defaultValue: string;
					provenance?: ProvenanceArgs;
				}) {
					const newParam: Parameter = {
						id: crypto.randomUUID(),
						name: args.name,
						variableName: args.variableName,
						type: args.type,
						defaultValue: args.defaultValue,
					};
					handle.change((doc) => {
						doc.petriNetDefinition.parameters.push(newParam);
					});
					if (args.provenance) {
						appendProvenanceEntry(
							handle,
							[elementRefUrl(handle, "parameter", newParam.id)],
							args.provenance,
						);
					}
					return newParam;
				},

				setTitle(title: string) {
					handle.change((doc) => {
						doc.title = title;
					});
				},

				// ── Provenance ──────────────────────────────────────────────

				// A ref url addressing one element of this net (matched by id,
				// so it stays stable across array splices). Use these as
				// `targets` in addProvenance. Usually you won't need this:
				// prefer passing `provenance` to the creation call itself.
				getElementUrl(item: { type: ElementKind; id: string }): AutomergeUrl {
					return elementRefUrl(handle, item.type, item.id);
				},

				// Record where parts of this net came from, after the fact.
				// Prefer the `provenance` option on the creation methods, which
				// targets the created elements automatically; use this for
				// attributing EXISTING elements or the whole net (`targets:
				// [net.url]`). `sources` are urls into the source document
				// (see textRangeRef, or its bare url).
				addProvenance(args: {
					targets: AutomergeUrl[];
					sources: AutomergeUrl[];
					note?: string;
				}): ProvenanceEntry {
					return appendProvenanceEntry(handle, args.targets, {
						sources: args.sources,
						note: args.note,
					});
				},

				getProvenance(): ProvenanceEntry[] {
					return handle.doc()?.["@patchwork"]?.provenance ?? [];
				},

				// ── Metadata ────────────────────────────────────────────────

				// Merge arbitrary annotations onto one element (place,
				// transition, …) by id, under `@patchwork.metadata`. Prefer
				// the `metadata` option on the creation calls. The `geo`
				// key is a shared convention: `{ geo: { lat, lng } }` puts
				// the element on the Map tool.
				setMetadata(id: string, metadata: ElementMetadata) {
					handle.change((doc) => {
						writeElementMetadata(doc, id, metadata);
					});
				},

				// All metadata (keyed by element id), or one element's.
				getMetadata(id?: string) {
					const all = handle.doc()?.["@patchwork"]?.metadata ?? {};
					return id ? (all[id] ?? {}) : all;
				},

				// ── Delete ──────────────────────────────────────────────────

				removeItems(items: RemoveItem[]) {
					if (!items || items.length === 0) return;
					handle.change((doc) => {
						deleteItemsFromSdcpn(doc.petriNetDefinition, items);
					});
				},

				// ── Batch modify ────────────────────────────────────────────

				// Batch add and/or remove in one transaction. Pass `provenance`
				// when the added elements are derived from another document —
				// one entry targeting everything this call created is recorded.
				// Returns the created places and transitions (with their ids).
				modifyNetElements({
					add,
					remove,
					provenance,
				}: {
					add?: BatchAdd;
					remove?: RemoveItem[];
					provenance?: ProvenanceArgs;
				}): { places: Place[]; transitions: Transition[] } {
					const placeIdMap = new Map<string, string>();
					const transitionIdMap = new Map<string, string>();
					const createdPlaces: Place[] = [];
					const createdTransitions: Transition[] = [];

					handle.change((doc) => {
						const def: SDCPN = doc.petriNetDefinition;

						if (remove?.length) {
							deleteItemsFromSdcpn(def, remove);
						}

						if (!add) return;

						if (add.places) {
							for (const p of add.places) {
								const newPlace: Place = {
									id: crypto.randomUUID(),
									name: p.name,
									colorId: p.colorId ?? null,
									dynamicsEnabled: p.dynamicsEnabled ?? false,
									differentialEquationId:
										p.differentialEquationId ?? null,
									x: p.x ?? 100,
									y: p.y ?? 100,
									visualizerCode: p.visualizerCode,
								};
								placeIdMap.set(p.name, newPlace.id);
								createdPlaces.push(newPlace);
								def.places.push(newPlace);
								if (p.metadata) {
									writeElementMetadata(
										doc,
										newPlace.id,
										p.metadata,
									);
								}
							}
						}

						if (add.transitions) {
							for (const t of add.transitions) {
								const newTransition: Transition = {
									id: crypto.randomUUID(),
									name: t.name,
									inputArcs: t.inputArcs,
									outputArcs: t.outputArcs,
									lambdaType: t.lambdaType ?? "predicate",
									lambdaCode: t.lambdaCode ?? "",
									transitionKernelCode:
										t.transitionKernelCode ?? "",
									x: t.x ?? 100,
									y: t.y ?? 100,
								};
								transitionIdMap.set(t.name, newTransition.id);
								createdTransitions.push(newTransition);
								def.transitions.push(newTransition);
								if (t.metadata) {
									writeElementMetadata(
										doc,
										newTransition.id,
										t.metadata,
									);
								}
							}
						}

						if (add.arcs) {
							for (const arcArgs of add.arcs) {
								if (arcArgs.direction === "place_to_transition") {
									let placeId = placeIdMap.get(
										arcArgs.source_place,
									);
									if (!placeId) {
										const existing = findPlace(
											def,
											arcArgs.source_place,
										);
										if (!existing)
											throw new Error(
												`Place "${arcArgs.source_place}" not found`,
											);
										placeId = existing.id;
									}

									let transitionId = transitionIdMap.get(
										arcArgs.target_transition,
									);
									if (!transitionId) {
										const existing = findTransition(
											def,
											arcArgs.target_transition,
										);
										if (!existing)
											throw new Error(
												`Transition "${arcArgs.target_transition}" not found`,
											);
										transitionId = existing.id;
									}

									const transition = def.transitions.find(
										(t) => t.id === transitionId,
									);
									if (transition) {
										transition.inputArcs.push({
											placeId,
											weight: arcArgs.weight ?? 1,
											type: arcArgs.type ?? "standard",
										});
									}
								} else {
									let transitionId = transitionIdMap.get(
										arcArgs.source_transition,
									);
									if (!transitionId) {
										const existing = findTransition(
											def,
											arcArgs.source_transition,
										);
										if (!existing)
											throw new Error(
												`Transition "${arcArgs.source_transition}" not found`,
											);
										transitionId = existing.id;
									}

									let placeId = placeIdMap.get(
										arcArgs.target_place,
									);
									if (!placeId) {
										const existing = findPlace(
											def,
											arcArgs.target_place,
										);
										if (!existing)
											throw new Error(
												`Place "${arcArgs.target_place}" not found`,
											);
										placeId = existing.id;
									}

									const transition = def.transitions.find(
										(t) => t.id === transitionId,
									);
									if (transition) {
										transition.outputArcs.push({
											placeId,
											weight: arcArgs.weight ?? 1,
										});
									}
								}
							}
						}
					});

					if (provenance) {
						// Target each created element; if the call only removed
						// or rewired things, fall back to the whole net.
						const targets: AutomergeUrl[] = [
							...createdPlaces.map((p) =>
								elementRefUrl(handle, "place", p.id),
							),
							...createdTransitions.map((t) =>
								elementRefUrl(handle, "transition", t.id),
							),
						];
						appendProvenanceEntry(
							handle,
							targets.length > 0 ? targets : [handle.url],
							provenance,
						);
					}

					return {
						places: createdPlaces,
						transitions: createdTransitions,
					};
				},
			};
		},
	};
}
