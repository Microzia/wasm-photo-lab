import type {
  AdjustmentKind,
  BlendMode,
  DocumentState,
  Layer,
  LayerGroup,
} from "@app/shared-types";

interface RustLayer {
  id: number;
  name: string;
  kind: "raster" | "adjustment";
  visible: boolean;
  locked: boolean;
  lock_pixels?: boolean;
  lock_position?: boolean;
  lock_transparent_pixels?: boolean;
  opacity: number;
  fill_opacity?: number;
  blend_mode: BlendMode;
  width: number;
  height: number;
  clipped_to_layer_id: number | null;
  has_mask: boolean;
  alpha_bounds?: { x: number; y: number; width: number; height: number } | null;
  adjustment_kind?: AdjustmentKind;
  adjustment_value?: number;
}

interface RustGroup {
  id: number;
  name: string;
  visible: boolean;
  layer_ids: number[];
}

interface RustDocumentState {
  id: number;
  width: number;
  height: number;
  color_profile: "sRGB";
  layer_order: number[];
  layers: RustLayer[];
  groups: RustGroup[];
  active_layer_id: number | null;
}

export function mapRustStateToDocumentState(rawState: string): DocumentState {
  const parsed = JSON.parse(rawState) as RustDocumentState;

  const layers: Layer[] = parsed.layers.map((layer) => ({
    id: layer.id,
    name: layer.name,
    kind: layer.kind,
    visible: layer.visible,
    locked: layer.locked,
    lockPixels: layer.lock_pixels ?? false,
    lockPosition: layer.lock_position ?? false,
    lockTransparentPixels: layer.lock_transparent_pixels ?? false,
    opacity: layer.opacity,
    fillOpacity: layer.fill_opacity ?? 1,
    blendMode: layer.blend_mode,
    width: layer.width,
    height: layer.height,
    clippedToLayerId: layer.clipped_to_layer_id,
    hasMask: layer.has_mask,
    alphaBounds: layer.alpha_bounds ?? null,
    adjustmentKind: layer.adjustment_kind,
    adjustmentValue: layer.adjustment_value,
  }));

  const groups: LayerGroup[] = parsed.groups.map((group) => ({
    id: group.id,
    name: group.name,
    visible: group.visible,
    layerIds: group.layer_ids,
  }));

  return {
    id: parsed.id,
    width: parsed.width,
    height: parsed.height,
    colorProfile: parsed.color_profile,
    layerOrder: parsed.layer_order,
    layers,
    groups,
    activeLayerId: parsed.active_layer_id,
  };
}
