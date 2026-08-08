"use client";

import { ModelViewer as InteractionModelViewer } from "./model-viewer-interaction";
import {
  installQuickLookTapBehaviorPatch,
  setQuickLookAudioSource
} from "./quicklook-behavior";

// model-viewer-interaction installs the plaque export patch during module
// evaluation. Install the native behavior patch afterwards so it post-processes
// the final USDZ that already contains the plaque geometry.
installQuickLookTapBehaviorPatch();

type Props = {
  modelName: string;
  description: string;
  assetUrl: string;
  audioUrl?: string;
};

export function ModelViewer(props: Props) {
  // Register before the child viewer mounts. Its iPhone export starts from a
  // child effect, so the behavior post-processor can embed this audio in USDZ.
  setQuickLookAudioSource(props.audioUrl);
  return <InteractionModelViewer {...props} />;
}
