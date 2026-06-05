export type ColorProfile = "sRGB";

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn";

export type LayerKind = "raster" | "adjustment" | "group";

export type AdjustmentKind = "brightness" | "contrast" | "blur" | "sharpen";

// Общие объекты передачи данных являются контрактом между React-интерфейсом, Web Worker и Rust/WASM-движком.
// Эти имена должны оставаться стабильными: worker сериализует операцию в JSON для Rust.
export interface Mask {
  enabled: boolean;
  inverted: boolean;
}

export interface LayerBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Layer {
  id: number;
  name: string;
  kind: LayerKind;
  visible: boolean;
  locked: boolean;
  // Photoshop-подобные блокировки: полная, пиксели, позиция и прозрачные пиксели.
  lockPixels: boolean;
  lockPosition: boolean;
  lockTransparentPixels: boolean;
  opacity: number;
  fillOpacity: number;
  blendMode: BlendMode;
  width: number;
  height: number;
  clippedToLayerId: number | null;
  hasMask: boolean;
  alphaBounds?: LayerBounds | null;
  adjustmentKind?: AdjustmentKind;
  adjustmentValue?: number;
}

export interface LayerGroup {
  id: number;
  name: string;
  visible: boolean;
  layerIds: number[];
}

export interface DocumentState {
  id: number;
  width: number;
  height: number;
  colorProfile: ColorProfile;
  layerOrder: number[];
  layers: Layer[];
  groups: LayerGroup[];
  activeLayerId: number | null;
}

export type Operation =
  | { type: "add_empty_layer"; name?: string }
  | { type: "rename_layer"; layer_id: number; name: string }
  | { type: "duplicate_layer"; layer_id: number; name?: string }
  | { type: "delete_layer"; layer_id: number }
  | { type: "set_layer_visibility"; layer_id: number; visible: boolean }
  | { type: "set_layer_locked"; layer_id: number; locked: boolean }
  | {
      type: "set_layer_lock_options";
      layer_id: number;
      locked?: boolean;
      lock_pixels?: boolean;
      lock_position?: boolean;
      lock_transparent_pixels?: boolean;
    }
  | { type: "set_layer_opacity"; layer_id: number; opacity: number }
  | { type: "set_layer_fill_opacity"; layer_id: number; fill_opacity: number }
  | { type: "set_blend_mode"; layer_id: number; blend_mode: BlendMode }
  | { type: "reorder_layer"; layer_id: number; to_index: number }
  | {
      type: "brush";
      layer_id: number;
      x: number;
      y: number;
      radius: number;
      color: [number, number, number, number];
      strength: number;
      erase: boolean;
    }
  | {
      type: "flood_fill";
      layer_id: number;
      x: number;
      y: number;
      color: [number, number, number, number];
      tolerance: number;
      contiguous?: boolean;
    }
  | { type: "brightness"; layer_id: number; value: number }
  | { type: "contrast"; layer_id: number; value: number }
  | { type: "blur"; layer_id: number; radius: number }
  | { type: "sharpen"; layer_id: number; amount: number }
  | {
      type: "cut_selection_to_new_layer";
      layer_id: number;
      points: Array<{ x: number; y: number }>;
      refine?: boolean;
      name?: string;
    }
  | {
      type: "copy_selection_to_new_layer";
      layer_id: number;
      points: Array<{ x: number; y: number }>;
      refine?: boolean;
      name?: string;
    }
  | {
      type: "delete_selection";
      layer_id: number;
      points: Array<{ x: number; y: number }>;
      refine?: boolean;
    }
  | { type: "crop"; x: number; y: number; width: number; height: number }
  | { type: "resize"; width: number; height: number }
  | { type: "rotate90"; clockwise: boolean }
  | {
      type: "create_adjustment_layer";
      name?: string;
      adjustment_kind: AdjustmentKind;
      value: number;
      clipped_to_layer_id?: number | null;
    }
  | {
      type: "set_clipping_mask";
      layer_id: number;
      clipped_to_layer_id?: number | null;
    }
  | {
      type: "set_raster_mask_rect";
      layer_id: number;
      x: number;
      y: number;
      width: number;
      height: number;
      invert?: boolean;
    }
  | { type: "create_group"; name?: string }
  | { type: "create_group_from_layers"; layer_ids: number[]; name?: string }
  | { type: "move_layer_to_group"; layer_id: number; group_id: number }
  | { type: "ungroup"; group_id: number }
  | { type: "toggle_group_visibility"; group_id: number; visible: boolean }
  | { type: "add_layer_mask"; layer_id: number }
  | { type: "remove_layer_mask"; layer_id: number }
  | {
      type: "set_layer_mask_from_selection";
      layer_id: number;
      points: Array<{ x: number; y: number }>;
      refine?: boolean;
      invert?: boolean;
    }
  | { type: "invert_layer_mask"; layer_id: number }
  | {
      type: "transform_layer";
      layer_id: number;
      translate_x?: number;
      translate_y?: number;
      scale_x?: number;
      scale_y?: number;
    };

export interface ChangedTile {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type EngineRequest =
  | { requestId: string; type: "init" }
  | {
      requestId: string;
      type: "createDocument";
      width: number;
      height: number;
      colorProfile: ColorProfile;
    }
  | {
      requestId: string;
      type: "loadImage";
      docId: number;
      bytes: Uint8Array;
      format: "png" | "jpeg" | "webp";
      name?: string;
    }
  | {
      requestId: string;
      type: "applyOperation";
      docId: number;
      operation: Operation;
    }
  | {
      requestId: string;
      type: "renderRegion";
      docId: number;
      x: number;
      y: number;
      width: number;
      height: number;
      scale: number;
    }
  | {
      requestId: string;
      type: "exportDocument";
      docId: number;
      format: "png" | "jpeg" | "webp";
      quality: number;
    }
  | { requestId: string; type: "undo"; docId: number }
  | { requestId: string; type: "redo"; docId: number }
  | { requestId: string; type: "getDocumentState"; docId: number };

export type EngineSuccess<T> = {
  requestId: string;
  ok: true;
  result: T;
};

export type EngineFailure = {
  requestId: string;
  ok: false;
  error: string;
};

export type EngineResponse<T> = EngineSuccess<T> | EngineFailure;

export interface ProjectSnapshot {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  width: number;
  height: number;
  state: DocumentState;
  flattenedPng: Uint8Array;
}
