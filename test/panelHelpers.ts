import type { ModelListing } from "../src/provider";

/** A provider listing that succeeded with `count` models in the picker; the panel only reads `ok` and `count`. */
export const listedModels =
  (count = 0) =>
  async (): Promise<ModelListing> => ({ infos: [], ok: true, serverUrl: "", count, keyWithheld: false });
