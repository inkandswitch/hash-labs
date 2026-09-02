import "@hashintel/petrinaut/dist/main.css";
import type {
	DocHandle,
	DocHandleChangePayload,
} from "@automerge/automerge-repo";
import { Button } from "@hashintel/ds-components";
import { Petrinaut } from "@hashintel/petrinaut";
import type {
	DocHandleState,
	PetrinautDocHandle,
	ReadableStore,
} from "@hashintel/petrinaut";
import {
	calculateGraphLayout,
	layoutNodeDimensions,
	parseSDCPNFile,
} from "@hashintel/petrinaut-core";
import { createLanguageServerWorker } from "@hashintel/petrinaut-core/workers/lsp";
import { createMonteCarloWorker } from "@hashintel/petrinaut-core/workers/monte-carlo";
import { createSimulationWorker } from "@hashintel/petrinaut-core/workers/simulation";
import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import {
	createElement,
	Fragment,
	useMemo,
	useState,
	type CSSProperties,
} from "react";
import { createRoot } from "react-dom/client";
import type { Doc } from "./datatype";
import { NetDiffOverlay, useNetDiff } from "./diff-overlay";
import { ProvenanceOverlay } from "./provenance-overlay";

export const renderPetrinautEditor: ToolImplementation<Doc> = (
	handle,
	element,
) => {
	const root = createRoot(element);

	root.render(createElement(PetrinautEditor, { handle, element }));

	return () => {
		root.unmount();
	};
};

export const PetrinautEditor = ({
	handle,
	element,
}: {
	handle: DocHandle<Doc>;
	element: HTMLElement;
}) => {
	const netHandle = useMemo(() => toPetrinautHandle(handle), [handle]);
	const diff = useNetDiff(handle, element);

	// The overlay decorates Petrinaut's canvas from the outside, so it has to
	// be thrown away with it when a new document swaps the whole editor out.
	return (
		<Fragment key={handle.url}>
			<Petrinaut
				handle={netHandle}
				hideNetManagementControls="all"
				slots={{ topBarEnd: <ImportButton handle={handle} /> }}
				simulationWorkerFactory={createSimulationWorker}
				monteCarloWorkerFactory={createMonteCarloWorker}
				lspWorkerFactory={createLanguageServerWorker}
			/>
			<NetDiffOverlay diff={diff} element={element} />
			<ProvenanceOverlay handle={handle} element={element} />
		</Fragment>
	);
};

/**
 * "Import JSON" in Petrinaut's top bar: replaces the whole net (and the title,
 * when the file carries one) with the contents of a picked SDCPN JSON file.
 * `parseSDCPNFile` handles the versioned, legacy and pre-2025 formats, and
 * files without node positions get an auto layout — the same treatment
 * Petrinaut's own hidden "Import" menu item would give them.
 */
function ImportButton({ handle }: { handle: DocHandle<Doc> }) {
	const [error, setError] = useState<string | null>(null);

	const importFile = async () => {
		setError(null);
		const file = await pickFile();
		if (!file) return;
		try {
			const result = parseSDCPNFile(JSON.parse(await file.text()));
			if (!result.ok) {
				setError(result.error);
				return;
			}
			const { title, ...net } = result.sdcpn;
			if (result.hadMissingPositions) {
				const positions = await calculateGraphLayout(
					net,
					layoutNodeDimensions,
				);
				for (const node of [...net.places, ...net.transitions]) {
					const position = positions[node.id];
					if (position) {
						node.x = position.x;
						node.y = position.y;
					}
				}
			}
			// Round-trip to plain JSON so no `undefined` value can reach
			// Automerge, which rejects them.
			const plain = JSON.parse(JSON.stringify(net));
			handle.change((doc) => {
				doc.petriNetDefinition = plain;
				if (title) doc.title = title;
			});
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	return (
		<span style={importControlsStyle}>
			{error && (
				<span style={importErrorStyle} title={error}>
					{error}
				</span>
			)}
			<Button variant="subtle" onClick={importFile}>
				Import JSON
			</Button>
		</span>
	);
}

function pickFile(): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json,application/json";
		input.onchange = () => resolve(input.files?.[0] ?? null);
		input.oncancel = () => resolve(null);
		input.click();
	});
}

const importControlsStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "8px",
};

const importErrorStyle: CSSProperties = {
	color: "#b91c1c",
	fontSize: "12px",
	maxWidth: "260px",
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
};

/**
 * Petrinaut drives the net through its own handle interface over a bare SDCPN.
 * Patchwork hands us an Automerge handle for the whole document, so project the
 * net out of it and write edits back in place, leaving the title and
 * `@patchwork` metadata wrapped around it untouched.
 */
function toPetrinautHandle(handle: DocHandle<Doc>): PetrinautDocHandle {
	return {
		id: handle.url,
		state: READY,
		whenReady: () => Promise.resolve(),
		doc: () => handle.doc()?.petriNetDefinition,
		change: (fn) => {
			handle.change((doc) => fn(doc.petriNetDefinition));
		},
		subscribe: (listener) => {
			const onChange = ({ doc, patchInfo }: DocHandleChangePayload<Doc>) => {
				listener({
					next: doc.petriNetDefinition,
					source: LOCAL_PATCH_SOURCES.has(patchInfo.source)
						? "local"
						: "remote",
				});
			};
			handle.on("change", onChange);
			return () => handle.off("change", onChange);
		},
	};
}

/** Everything else Automerge reports — merges, sync messages — came from a peer. */
const LOCAL_PATCH_SOURCES = new Set(["change", "changeAt", "emptyChange"]);

/** Patchwork only renders a tool once the document is loaded, so this never moves. */
const READY: ReadableStore<DocHandleState> = {
	get: () => "ready",
	subscribe: () => () => {},
};
