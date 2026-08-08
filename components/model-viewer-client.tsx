"use client";

import { ModelViewer as InteractionModelViewer } from "./model-viewer-interaction";
import {
  installQuickLookTapBehaviorPatch,
  setQuickLookAudioSource
} from "./quicklook-behavior";
import { installQuickLookUsdFinalizePatch } from "./quicklook-usdz-finalize";

installQuickLookTapBehaviorPatch();
installQuickLookUsdFinalizePatch();

type Props = {
  modelName: string;
  description: string;
  assetUrl: string;
  audioUrl?: string;
};

export function ModelViewer(props: Props) {
  setQuickLookAudioSource(props.audioUrl);
  return <InteractionModelViewer {...props} />;
}
