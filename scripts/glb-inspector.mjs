import { open } from "node:fs/promises";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const MAX_JSON_CHUNK_BYTES = 32 * 1024 * 1024;

async function readExactly(handle, length, position) {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error("GLB ended unexpectedly while reading metadata.");
  return buffer;
}

export async function inspectGlbAnimations(filePath) {
  const handle = await open(filePath, "r");

  try {
    const header = await readExactly(handle, 12, 0);
    if (header.readUInt32LE(0) !== GLB_MAGIC) {
      throw new Error("File is not a valid binary GLB.");
    }

    const version = header.readUInt32LE(4);
    if (version !== 2) throw new Error(`Unsupported GLB version ${version}.`);

    const totalLength = header.readUInt32LE(8);
    let offset = 12;

    while (offset + 8 <= totalLength) {
      const chunkHeader = await readExactly(handle, 8, offset);
      const chunkLength = chunkHeader.readUInt32LE(0);
      const chunkType = chunkHeader.readUInt32LE(4);
      offset += 8;

      if (chunkLength > totalLength - offset) {
        throw new Error("GLB contains an invalid chunk length.");
      }

      if (chunkType === JSON_CHUNK_TYPE) {
        if (chunkLength > MAX_JSON_CHUNK_BYTES) {
          throw new Error("GLB JSON metadata is unexpectedly large.");
        }

        const jsonBuffer = await readExactly(handle, chunkLength, offset);
        const document = JSON.parse(jsonBuffer.toString("utf8").replace(/[\u0000\u0020]+$/g, ""));
        const animations = Array.isArray(document.animations) ? document.animations : [];
        const channels = animations.reduce(
          (count, animation) => count + (Array.isArray(animation?.channels) ? animation.channels.length : 0),
          0
        );
        const externalResourceUris = [
          ...(Array.isArray(document.buffers) ? document.buffers : []),
          ...(Array.isArray(document.images) ? document.images : [])
        ]
          .map((resource) => typeof resource?.uri === "string" ? resource.uri : null)
          .filter((uri) => uri && !uri.startsWith("data:"));

        return {
          hasAnimations: animations.length > 0 && channels > 0,
          animationClips: animations.length,
          animationChannels: channels,
          skins: Array.isArray(document.skins) ? document.skins.length : 0,
          externalResources: externalResourceUris.length,
          externalResourceUris: externalResourceUris.slice(0, 50)
        };
      }

      offset += chunkLength;
    }

    throw new Error("GLB does not contain a JSON metadata chunk.");
  } finally {
    await handle.close();
  }
}
