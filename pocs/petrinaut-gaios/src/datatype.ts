import { type DatatypeImplementation } from "@inkandswitch/patchwork-plugins";
import { defaultTokenTypes, type PetriNetDefinitionObject } from "./main/vendor/petrinaut";

export type Doc = {
  title: string;
  petriNetDefinition: PetriNetDefinitionObject;
};

export const PetrinautDatatype: DatatypeImplementation<Doc> = {
  init: (doc: Doc) => {
    doc.title = "Untitled Petri Net";
    doc.petriNetDefinition = {
      nodes: [],
      arcs: [],
      tokenTypes: structuredClone(defaultTokenTypes),
    };
  },
  getTitle: (doc: Doc) => {
    return doc.title || "Petrinaut";
  },
};

