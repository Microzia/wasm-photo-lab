import { describe, expect, it } from "vitest";
import { mapRustStateToDocumentState } from "./stateMapper";

describe("mapRustStateToDocumentState", () => {
  it("maps snake_case state from Rust to frontend DocumentState", () => {
    const raw = JSON.stringify({
      id: 7,
      width: 1920,
      height: 1080,
      color_profile: "sRGB",
      layer_order: [11],
      layers: [
        {
          id: 11,
          name: "Layer 1",
          kind: "raster",
          visible: true,
          locked: false,
          opacity: 0.8,
          blend_mode: "overlay",
          width: 1920,
          height: 1080,
          clipped_to_layer_id: null,
          has_mask: false,
        },
      ],
      groups: [
        { id: 3, name: "Group 1", visible: true, layer_ids: [11] },
      ],
      active_layer_id: 11,
    });

    const mapped = mapRustStateToDocumentState(raw);

    expect(mapped.id).toBe(7);
    expect(mapped.colorProfile).toBe("sRGB");
    expect(mapped.layerOrder).toEqual([11]);
    expect(mapped.layers[0].blendMode).toBe("overlay");
    expect(mapped.groups[0].layerIds).toEqual([11]);
    expect(mapped.activeLayerId).toBe(11);
  });
});
