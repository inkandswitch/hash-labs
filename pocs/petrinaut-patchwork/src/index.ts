import { DataTypeDescription, type Plugin, ToolDescription } from "@patchwork/sdk";

export const plugins: Plugin<ToolDescription | DataTypeDescription>[] = [
  {
    type: "patchwork:dataType",
    id: "petrinaut",
    name: "Petrinaut",
    icon: "Network",
    async load() {
      const { dataType } = await import("./datatype");
      return dataType;
    },
  },
  {
    type: "patchwork:tool",
    id: "petrinaut",
    name: "Petrinaut",
    icon: "Network",
    supportedDataTypes: ["petrinaut"],
    async load() {
      const { Tool } = await import("./tool");
      return { EditorComponent: Tool };
    },
  },
];
