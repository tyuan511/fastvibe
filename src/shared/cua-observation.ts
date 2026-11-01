/**
 * The model-facing projection of Cua's native window snapshot.
 *
 * Keep this module free of Electron and the native SDK so the projection can be tested
 * with ordinary Node tests. Bigints are converted only at the JSON boundary: window ids
 * and element indexes must remain exact while they are inside the driver.
 */
export type CuaWindowElementProjection = {
  elementToken?: string;
  elementIndex?: bigint | number;
  parentIndex?: bigint | number;
  [key: string]: unknown;
};

export type CuaWindowStateProjection = {
  windowId?: bigint | number;
  elements?: CuaWindowElementProjection[];
  treeElements?: CuaWindowElementProjection[];
  images?: Array<{ mimeType?: string; width?: number; height?: number }>;

  [key: string]: unknown;
};

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Preserve every scalar and tree field from WindowStateOutput while keeping image bytes
 * in the tool's image channel. `token` is a compatibility alias used by the original
 * FastVibe tool contract; `elementToken` remains too, so native output is lossless.
 */
export function serializeWindowState(output: CuaWindowStateProjection): string {
  const { images, elements, treeElements, ...snapshot } = output;
  const projectElements = (items: CuaWindowElementProjection[]) => items.map((element) => ({
    ...element,
    ...(element.elementToken ? { token: element.elementToken } : {}),
  }));
  const payload = {
    ...snapshot,
    ...(images ? {
      imageCount: images.length,
      imageMimeTypes: images.map((image) => image.mimeType).filter(Boolean),
      imageDimensions: images
        .filter((image) => image.width !== undefined && image.height !== undefined)
        .map((image) => ({ width: image.width, height: image.height })),
    } : {}),
    ...(elements ? {
      elements: projectElements(elements),
    } : {}),
    ...(treeElements ? {
      treeElements: projectElements(treeElements),
    } : {}),
  };
  return JSON.stringify(payload, jsonReplacer, 2);
}
