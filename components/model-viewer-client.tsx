"use client";

import { ModelViewer } from "./model-viewer-interaction";
import { installQuickLookTapBehaviorPatch } from "./quicklook-behavior";

// model-viewer-interaction installs the plaque export patch during module
// evaluation. Install the native behavior patch afterwards so it post-processes
// the final USDZ that already contains the plaque geometry.
installQuickLookTapBehaviorPatch();

export { ModelViewer };
