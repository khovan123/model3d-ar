"use client";

import { ModelViewer as InteractionModelViewer } from "./model-viewer-interaction";
import { ModelSpaceDebugPanel } from "./modelspace-debug-panel";
import {
  installQuickLookTapBehaviorPatch,
  setQuickLookAudioSource
} from "./quicklook-behavior";
import { installQuickLookUsdFinalizePatch } from "./quicklook-usdz-finalize";
import { installModelSpaceDebugging } from "@/lib/modelspace-debug";

installQuickLookTapBehaviorPatch();
installQuickLookUsdFinalizePatch();
installModelSpaceDebugging();

type Props = {
  modelName: string;
  description: string;
  assetUrl: string;
  audioUrl?: string;
  usdzUrl?: string;
};

export function ModelViewer(props: Props) {
  setQuickLookAudioSource(props.audioUrl);
  return (
    <>
      <InteractionModelViewer {...props} />
      <ModelSpaceDebugPanel />
    </>
  );
}
