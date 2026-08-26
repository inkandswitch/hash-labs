import "maplibre-gl/dist/maplibre-gl.css";
import type { DocHandle } from "@automerge/automerge-repo";
import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import * as maplibregl from "maplibre-gl";
import type { Doc } from "./datatype";
import {
	buildElementRefIndex,
	type ElementRefIndex,
	type FocusDoc,
	focusedElementIds,
	type NetDoc,
	sourcesForElements,
	watchFocusDoc,
	writeHighlight,
} from "./provenance-lib";

/**
 * Renders a Petri net as a map: every place/transition carrying a
 * `@patchwork.metadata[<id>].geo = { lat, lng }` annotation becomes a
 * labelled marker on a MapLibre map.
 *
 * Selection rides the same shared focus doc as the canvas overlay:
 *
 * - hovering a marker transiently highlights the element (glows on the
 *   Petrinaut canvas) plus the provenance sources it derives from (the text
 *   editor emphasises the passages);
 * - clicking a marker makes that highlight sticky until another marker or
 *   the map background is clicked;
 * - and inbound, markers light up when the focus points at their element —
 *   from text with provenance, or a selection on the canvas.
 */
export const renderPetrinautMap: ToolImplementation<Doc> = (
	handle,
	element,
) => {
	const container = document.createElement("div");
	container.className = "petrinaut-map-root";
	const styles = document.createElement("style");
	styles.textContent = MAP_CSS;
	const empty = document.createElement("div");
	empty.className = "petrinaut-map-empty";
	empty.textContent =
		"No mapped elements yet — give places or transitions geo metadata " +
		"(@patchwork.metadata[id].geo = { lat, lng }) and they appear here.";
	element.append(styles, container);

	const map = new maplibregl.Map({
		container,
		style: "https://tiles.openfreemap.org/styles/liberty",
		center: [0, 20],
		zoom: 1,
		attributionControl: { compact: true },
	});

	// The tool host may be laid out after mount; keep the map sized to it.
	const resizeObserver = new ResizeObserver(() => map.resize());
	resizeObserver.observe(container);

	const markers = new Map<string, ElementMarker>();
	let refIndex: ElementRefIndex = buildElementRefIndex(handle);
	let markersSignature = "";

	let focusDoc: FocusDoc | undefined;
	let focusHandle: DocHandle<FocusDoc> | undefined;

	let hoverId: string | undefined;
	let stickyId: string | undefined;
	let contributed = new Set<string>();

	// ── Outbound: marker hover/click → focus highlight ──────────────────

	function updateContribution() {
		if (!focusHandle) return;
		const activeIds = new Set<string>();
		if (hoverId) activeIds.add(hoverId);
		if (stickyId) activeIds.add(stickyId);
		const next = new Set<string>();
		for (const id of activeIds) {
			const refUrl = refIndex.refUrlById.get(id);
			if (refUrl) next.add(refUrl);
		}
		for (const source of sourcesForElements(handle, activeIds, refIndex)) {
			next.add(source);
		}
		writeHighlight(focusHandle, contributed, next);
		contributed = next;
	}

	map.on("click", () => {
		if (stickyId === undefined) return;
		stickyId = undefined;
		applyFocusStyles();
		updateContribution();
	});

	// ── Inbound: focus → marker emphasis ─────────────────────────────────

	function applyFocusStyles() {
		const focused = focusedElementIds(focusDoc, refIndex);
		if (stickyId) focused.add(stickyId);
		for (const [id, entry] of markers) {
			entry.el.classList.toggle("is-focused", focused.has(id));
		}
	}

	const stopFocusWatch = watchFocusDoc(element, (doc, docHandle) => {
		focusDoc = doc;
		focusHandle = docHandle;
		applyFocusStyles();
	});

	// ── Markers from the doc ─────────────────────────────────────────────

	function refreshMarkers() {
		const elements = geoElements(handle);
		const signature = JSON.stringify(
			elements.map((e) => [e.id, e.name, e.kind, e.lat, e.lng]),
		);
		if (signature === markersSignature) return;
		markersSignature = signature;

		for (const entry of markers.values()) entry.marker.remove();
		markers.clear();

		for (const item of elements) {
			const el = document.createElement("div");
			el.className = `petrinaut-map-marker is-${item.kind}`;
			el.textContent = item.name;
			el.title = `${item.kind}: ${item.name}`;
			el.addEventListener("mouseenter", () => {
				hoverId = item.id;
				updateContribution();
			});
			el.addEventListener("mouseleave", () => {
				if (hoverId !== item.id) return;
				hoverId = undefined;
				updateContribution();
			});
			el.addEventListener("click", (event) => {
				event.stopPropagation();
				stickyId = stickyId === item.id ? undefined : item.id;
				applyFocusStyles();
				updateContribution();
			});
			const marker = new maplibregl.Marker({ element: el })
				.setLngLat([item.lng, item.lat])
				.addTo(map);
			markers.set(item.id, { marker, el });
		}

		empty.remove();
		if (elements.length === 0) {
			container.append(empty);
		} else {
			fitToMarkers(map, elements);
		}
		applyFocusStyles();
	}

	// Coalesced doc-change handler: elements, geo metadata and provenance
	// may all have moved.
	let refreshScheduled = false;
	const onDocChange = () => {
		if (refreshScheduled) return;
		refreshScheduled = true;
		queueMicrotask(() => {
			refreshScheduled = false;
			refIndex = buildElementRefIndex(handle);
			refreshMarkers();
			applyFocusStyles();
			updateContribution();
		});
	};
	handle.on("change", onDocChange);
	refreshMarkers();

	return () => {
		handle.off("change", onDocChange);
		stopFocusWatch();
		resizeObserver.disconnect();
		if (focusHandle) {
			writeHighlight(focusHandle, contributed, new Set());
		}
		for (const entry of markers.values()) entry.marker.remove();
		markers.clear();
		map.remove();
		styles.remove();
		container.remove();
		empty.remove();
	};
};

type ElementMarker = { marker: maplibregl.Marker; el: HTMLElement };

type GeoElement = {
	id: string;
	name: string;
	kind: "place" | "transition";
	lat: number;
	lng: number;
};

/** Every place/transition with a valid geo annotation. */
function geoElements(handle: DocHandle<Doc>): GeoElement[] {
	const doc = handle.doc() as NetDoc | undefined;
	const metadata = doc?.["@patchwork"]?.metadata ?? {};
	const out: GeoElement[] = [];
	const collect = (
		kind: GeoElement["kind"],
		items: Array<{ id: string; name: string }>,
	) => {
		for (const item of items) {
			const geo = metadata[item.id]?.geo;
			if (
				geo &&
				typeof geo.lat === "number" &&
				typeof geo.lng === "number" &&
				Number.isFinite(geo.lat) &&
				Number.isFinite(geo.lng)
			) {
				out.push({
					id: item.id,
					name: item.name,
					kind,
					lat: geo.lat,
					lng: geo.lng,
				});
			}
		}
	};
	collect("place", doc?.petriNetDefinition?.places ?? []);
	collect("transition", doc?.petriNetDefinition?.transitions ?? []);
	return out;
}

function fitToMarkers(map: maplibregl.Map, elements: GeoElement[]) {
	if (elements.length === 1) {
		map.jumpTo({ center: [elements[0].lng, elements[0].lat], zoom: 8 });
		return;
	}
	const bounds = new maplibregl.LngLatBounds();
	for (const item of elements) bounds.extend([item.lng, item.lat]);
	map.fitBounds(bounds, { padding: 64, maxZoom: 11, animate: false });
}

const MAP_CSS = `
.petrinaut-map-root {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 320px;
}
.petrinaut-map-empty {
  position: absolute;
  inset: auto 12px 12px 12px;
  z-index: 5;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.92);
  color: #444;
  font: 12.5px/1.5 system-ui, sans-serif;
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.18);
}
.petrinaut-map-marker {
  padding: 2px 9px;
  border-radius: 999px;
  border: 2px solid #2563eb;
  background: #fff;
  color: #111;
  font: 12px/1.5 system-ui, sans-serif;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
}
.petrinaut-map-marker.is-transition {
  border-radius: 5px;
  border-color: #d97706;
}
.petrinaut-map-marker.is-focused {
  background: var(--studio-link, #3b82f6);
  border-color: var(--studio-link, #3b82f6);
  color: #fff;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--studio-link, #3b82f6) 35%, transparent),
    0 1px 6px rgba(0, 0, 0, 0.35);
}
`;
