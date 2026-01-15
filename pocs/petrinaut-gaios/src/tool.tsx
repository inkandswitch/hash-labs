import type { AutomergeUrl } from "@automerge/automerge-repo";
import { useDocHandle, useDocument } from "@automerge/automerge-repo-react-hooks";
import { CacheProvider } from "@emotion/react";
import { createEmotionCache, theme } from "@hashintel/design-system/theme";
import type { ToolElement } from "@inkandswitch/patchwork-plugins";
import { toolify } from "@inkandswitch/patchwork-react";
import { ScopedCssBaseline, ThemeProvider } from "@mui/material";
import { Doc } from "./datatype";
import { Petrinaut } from "./main/vendor/petrinaut";

const emotionCache = createEmotionCache();

export const PetrinautEditor = ({ docUrl }: { docUrl: AutomergeUrl; element: ToolElement }) => {
  const [doc, changeDoc] = useDocument<Doc>(docUrl);
  const docHandle = useDocHandle<Doc>(docUrl);

  if (!doc || !docHandle || !docHandle.doc()) return null;

  return (
    <CacheProvider value={emotionCache}>
      <ThemeProvider theme={theme}>
        <ScopedCssBaseline sx={{ height: "100%" }}>
          <Petrinaut
            key={docUrl}
            docHandle={docHandle}
            hideNetManagementControls
            petriNetId={docUrl}
            petriNetDefinition={doc.petriNetDefinition}
            existingNets={[]}
            mutatePetriNetDefinition={(mutationFn) => {
              changeDoc((d) => {
                mutationFn(d.petriNetDefinition);
              });
            }}
            parentNet={null}
            createNewNet={() => {
              throw new Error("Creation not supported via Patchwork wrapper");
            }}
            loadPetriNet={() => {
              throw new Error("Loading other nets not supported via Patchwork wrapper");
            }}
            setTitle={() => {
              throw new Error("setTitle handled by Patchwork data type");
            }}
            title={""}
          />
        </ScopedCssBaseline>
      </ThemeProvider>
    </CacheProvider>
  );
};

export const renderPetrinautEditor = toolify(PetrinautEditor);
