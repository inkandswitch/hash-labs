import { type Plugin } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:datatype",
    id: "petrinaut",
    name: "Petrinaut",
    icon: "Network",
    async load() {
      const { PetrinautDatatype } = await import("./datatype");
      return PetrinautDatatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "petrinaut",
    name: "Petrinaut",
    icon: "Network",
    supportedDatatypes: ["petrinaut"],
    async load() {
      const { renderPetrinautEditor } = await import("./tool");
      return renderPetrinautEditor;
    },
  },
];
