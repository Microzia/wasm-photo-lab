use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPEncoder;
use image::{ColorType, DynamicImage, ImageEncoder, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

thread_local! {
    static ENGINE: RefCell<Engine> = RefCell::new(Engine::default());
}

#[wasm_bindgen]
pub fn create_document(width: u32, height: u32, color_profile: String) -> u32 {
    ENGINE.with(|engine| {
        let mut engine = engine.borrow_mut();
        engine.create_document(width.max(1), height.max(1), color_profile)
    })
}

#[wasm_bindgen]
pub fn set_active_document(doc_id: u32) -> bool {
    ENGINE.with(|engine| engine.borrow_mut().set_active(doc_id))
}

#[wasm_bindgen]
pub fn load_image(bytes: Vec<u8>, format: String, name: String) -> Result<u32, JsValue> {
    ENGINE.with(|engine| {
        let mut engine = engine.borrow_mut();
        let doc_id = engine
            .active_doc_id
            .ok_or_else(|| JsValue::from_str("No active document. Create one first."))?;

        let image_format = match format.to_ascii_lowercase().as_str() {
            "png" => ImageFormat::Png,
            "jpeg" | "jpg" => ImageFormat::Jpeg,
            "webp" => ImageFormat::WebP,
            _ => image::guess_format(&bytes)
                .map_err(|err| JsValue::from_str(&format!("Unsupported format: {err}")))?,
        };

        let decoded = image::load_from_memory_with_format(&bytes, image_format)
            .map_err(|err| JsValue::from_str(&format!("Failed to decode image: {err}")))?
            .to_rgba8();

        let doc = engine
            .documents
            .get_mut(&doc_id)
            .ok_or_else(|| JsValue::from_str("Document not found"))?;

        doc.checkpoint();
        if decoded.width() > doc.width || decoded.height() > doc.height {
            doc.expand_canvas(
                decoded.width().max(doc.width),
                decoded.height().max(doc.height),
            );
        }
        let layer_id = doc.next_layer_id;
        doc.next_layer_id += 1;

        let mut layer_pixels = vec![0; (doc.width * doc.height * 4) as usize];
        let width = decoded.width().min(doc.width);
        let height = decoded.height().min(doc.height);
        let offset_x = (doc.width - width) / 2;
        let offset_y = (doc.height - height) / 2;
        for y in 0..height {
            for x in 0..width {
                let src_index = ((y * decoded.width() + x) * 4) as usize;
                let dst_index = (((y + offset_y) * doc.width + x + offset_x) * 4) as usize;
                layer_pixels[dst_index..dst_index + 4]
                    .copy_from_slice(&decoded.as_raw()[src_index..src_index + 4]);
            }
        }

        let layer_name = if name.trim().is_empty() {
            format!("Image {layer_id}")
        } else {
            name
        };
        let layer = Layer::new_raster(layer_id, layer_name, doc.width, doc.height);
        if let LayerContent::Raster { pixels, .. } =
            &mut doc.layers.entry(layer_id).or_insert(layer).content
        {
            *pixels = layer_pixels;
        }
        doc.layer_order.push(layer_id);
        doc.active_layer_id = Some(layer_id);
        Ok(layer_id)
    })
}

#[wasm_bindgen]
pub fn apply_operation(doc_id: u32, operation_json: String) -> Result<JsValue, JsValue> {
    ENGINE.with(|engine| {
        let mut engine = engine.borrow_mut();
        let doc = engine
            .documents
            .get_mut(&doc_id)
            .ok_or_else(|| JsValue::from_str("Document not found"))?;

        let operation: Operation = serde_json::from_str(&operation_json)
            .map_err(|err| JsValue::from_str(&format!("Invalid operation payload: {err}")))?;
        doc.execute(operation)
            .map_err(|err| JsValue::from_str(&format!("Operation failed: {err}")))?;

        let changed_tiles = vec![ChangedTile {
            x: 0,
            y: 0,
            width: doc.width,
            height: doc.height,
        }];
        serde_wasm_bindgen::to_value(&changed_tiles)
            .map_err(|err| JsValue::from_str(&format!("Failed to serialize tiles: {err}")))
    })
}

#[wasm_bindgen]
pub fn render_region(
    doc_id: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    _scale: f32,
) -> Result<Vec<u8>, JsValue> {
    ENGINE.with(|engine| {
        let engine = engine.borrow();
        let doc = engine
            .documents
            .get(&doc_id)
            .ok_or_else(|| JsValue::from_str("Document not found"))?;
        let composite = doc.render_flattened();
        let rw = width.min(doc.width.saturating_sub(x));
        let rh = height.min(doc.height.saturating_sub(y));
        let mut region = vec![0; (rw * rh * 4) as usize];
        for row in 0..rh {
            let src_start = (((y + row) * doc.width + x) * 4) as usize;
            let src_end = src_start + (rw * 4) as usize;
            let dst_start = (row * rw * 4) as usize;
            region[dst_start..dst_start + (rw * 4) as usize]
                .copy_from_slice(&composite[src_start..src_end]);
        }
        Ok(region)
    })
}

#[wasm_bindgen]
pub fn undo(doc_id: u32) -> bool {
    ENGINE.with(|engine| {
        if let Some(doc) = engine.borrow_mut().documents.get_mut(&doc_id) {
            return doc.undo();
        }
        false
    })
}

#[wasm_bindgen]
pub fn redo(doc_id: u32) -> bool {
    ENGINE.with(|engine| {
        if let Some(doc) = engine.borrow_mut().documents.get_mut(&doc_id) {
            return doc.redo();
        }
        false
    })
}

#[wasm_bindgen]
pub fn export_document(doc_id: u32, format: String, quality: u8) -> Result<Vec<u8>, JsValue> {
    ENGINE.with(|engine| {
        let engine = engine.borrow();
        let doc = engine
            .documents
            .get(&doc_id)
            .ok_or_else(|| JsValue::from_str("Document not found"))?;
        let flattened = doc.render_flattened();
        let image = RgbaImage::from_raw(doc.width, doc.height, flattened)
            .ok_or_else(|| JsValue::from_str("Failed to create image buffer"))?;

        match format.to_ascii_lowercase().as_str() {
            "png" => {
                let mut bytes = Vec::new();
                let encoder = PngEncoder::new(&mut bytes);
                encoder
                    .write_image(
                        image.as_raw(),
                        doc.width,
                        doc.height,
                        ColorType::Rgba8.into(),
                    )
                    .map_err(|err| JsValue::from_str(&format!("PNG export failed: {err}")))?;
                Ok(bytes)
            }
            "jpeg" | "jpg" => {
                let mut bytes = Vec::new();
                let mut encoder = JpegEncoder::new_with_quality(&mut bytes, quality.clamp(1, 100));
                encoder
                    .encode_image(&DynamicImage::ImageRgba8(image))
                    .map_err(|err| JsValue::from_str(&format!("JPEG export failed: {err}")))?;
                Ok(bytes)
            }
            "webp" => {
                let mut bytes = Vec::new();
                let encoder = WebPEncoder::new_lossless(&mut bytes);
                encoder
                    .write_image(
                        image.as_raw(),
                        doc.width,
                        doc.height,
                        ColorType::Rgba8.into(),
                    )
                    .map_err(|err| JsValue::from_str(&format!("WebP export failed: {err}")))?;
                Ok(bytes)
            }
            _ => {
                let mut cursor = Cursor::new(Vec::new());
                DynamicImage::ImageRgba8(image)
                    .write_to(&mut cursor, ImageFormat::Png)
                    .map_err(|err| JsValue::from_str(&format!("Fallback export failed: {err}")))?;
                Ok(cursor.into_inner())
            }
        }
    })
}

#[wasm_bindgen]
pub fn get_document_state(doc_id: u32) -> Result<String, JsValue> {
    ENGINE.with(|engine| {
        let engine = engine.borrow();
        let doc = engine
            .documents
            .get(&doc_id)
            .ok_or_else(|| JsValue::from_str("Document not found"))?;
        serde_json::to_string(&doc.to_public_state())
            .map_err(|err| JsValue::from_str(&format!("Failed to serialize state: {err}")))
    })
}

#[derive(Default)]
struct Engine {
    documents: HashMap<u32, Document>,
    next_doc_id: u32,
    active_doc_id: Option<u32>,
}

impl Engine {
    fn create_document(&mut self, width: u32, height: u32, color_profile: String) -> u32 {
        self.next_doc_id += 1;
        let doc_id = self.next_doc_id;
        self.documents
            .insert(doc_id, Document::new(doc_id, width, height, color_profile));
        self.active_doc_id = Some(doc_id);
        doc_id
    }

    fn set_active(&mut self, doc_id: u32) -> bool {
        if self.documents.contains_key(&doc_id) {
            self.active_doc_id = Some(doc_id);
            return true;
        }
        false
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Document {
    id: u32,
    width: u32,
    height: u32,
    color_profile: String,
    layer_order: Vec<u32>,
    layers: HashMap<u32, Layer>,
    groups: HashMap<u32, LayerGroup>,
    active_layer_id: Option<u32>,
    next_layer_id: u32,
    next_group_id: u32,
    past: Vec<DocumentSnapshot>,
    future: Vec<DocumentSnapshot>,
}

#[derive(Clone, Serialize, Deserialize)]
struct DocumentSnapshot {
    width: u32,
    height: u32,
    layer_order: Vec<u32>,
    layers: HashMap<u32, Layer>,
    groups: HashMap<u32, LayerGroup>,
    active_layer_id: Option<u32>,
    next_layer_id: u32,
    next_group_id: u32,
}

impl Document {
    fn new(id: u32, width: u32, height: u32, color_profile: String) -> Self {
        Self {
            id,
            width,
            height,
            color_profile,
            layer_order: Vec::new(),
            layers: HashMap::new(),
            groups: HashMap::new(),
            active_layer_id: None,
            next_layer_id: 1,
            next_group_id: 1,
            past: Vec::new(),
            future: Vec::new(),
        }
    }

    fn snapshot(&self) -> DocumentSnapshot {
        DocumentSnapshot {
            width: self.width,
            height: self.height,
            layer_order: self.layer_order.clone(),
            layers: self.layers.clone(),
            groups: self.groups.clone(),
            active_layer_id: self.active_layer_id,
            next_layer_id: self.next_layer_id,
            next_group_id: self.next_group_id,
        }
    }

    fn restore(&mut self, snapshot: DocumentSnapshot) {
        self.width = snapshot.width;
        self.height = snapshot.height;
        self.layer_order = snapshot.layer_order;
        self.layers = snapshot.layers;
        self.groups = snapshot.groups;
        self.active_layer_id = snapshot.active_layer_id;
        self.next_layer_id = snapshot.next_layer_id;
        self.next_group_id = snapshot.next_group_id;
    }

    fn checkpoint(&mut self) {
        self.past.push(self.snapshot());
        if self.past.len() > 100 {
            let drop_count = self.past.len() - 100;
            self.past.drain(0..drop_count);
        }
        self.future.clear();
    }

    fn undo(&mut self) -> bool {
        if let Some(snapshot) = self.past.pop() {
            self.future.push(self.snapshot());
            self.restore(snapshot);
            return true;
        }
        false
    }

    fn redo(&mut self) -> bool {
        if let Some(snapshot) = self.future.pop() {
            self.past.push(self.snapshot());
            self.restore(snapshot);
            return true;
        }
        false
    }

    fn to_public_state(&self) -> PublicDocumentState {
        let layers = self
            .layer_order
            .iter()
            .filter_map(|id| self.layers.get(id))
            .map(Layer::to_public_layer)
            .collect::<Vec<_>>();

        let groups = self
            .groups
            .values()
            .map(|group| PublicLayerGroup {
                id: group.id,
                name: group.name.clone(),
                visible: group.visible,
                layer_ids: group.layer_ids.clone(),
            })
            .collect::<Vec<_>>();

        PublicDocumentState {
            id: self.id,
            width: self.width,
            height: self.height,
            color_profile: self.color_profile.clone(),
            layer_order: self.layer_order.clone(),
            layers,
            groups,
            active_layer_id: self.active_layer_id,
        }
    }

    fn execute(&mut self, operation: Operation) -> Result<(), String> {
        // Операция - граница команд от TypeScript к Rust.
        // Каждая ветка либо изменяет документ/слои, либо обновляет метаданные рендера.
        match operation {
            Operation::AddEmptyLayer { name } => {
                self.checkpoint();
                let id = self.next_layer_id;
                self.next_layer_id += 1;
                self.layers.insert(
                    id,
                    Layer::new_raster(
                        id,
                        name.unwrap_or_else(|| format!("Layer {id}")),
                        self.width,
                        self.height,
                    ),
                );
                self.layer_order.push(id);
                self.active_layer_id = Some(id);
            }
            Operation::RenameLayer { layer_id, name } => {
                self.checkpoint();
                let trimmed = name.trim();
                if trimmed.is_empty() {
                    return Err("Layer name cannot be empty".to_string());
                }
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .name = trimmed.to_string();
            }
            Operation::DuplicateLayer { layer_id, name } => {
                let source = self
                    .layers
                    .get(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .clone();
                self.checkpoint();
                let id = self.next_layer_id;
                self.next_layer_id += 1;
                let mut duplicate = source.clone();
                duplicate.id = id;
                duplicate.name = name.unwrap_or_else(|| format!("{} copy", source.name));
                duplicate.locked = false;
                self.layers.insert(id, duplicate);
                let insert_at = self
                    .layer_order
                    .iter()
                    .position(|current| *current == layer_id)
                    .map(|index| index + 1)
                    .unwrap_or(self.layer_order.len());
                self.layer_order.insert(insert_at, id);
                self.active_layer_id = Some(id);
            }
            Operation::DeleteLayer { layer_id } => {
                if !self.layers.contains_key(&layer_id) {
                    return Err("Layer not found".to_string());
                }
                self.ensure_layer_unlocked(layer_id)?;
                self.checkpoint();
                self.layers.remove(&layer_id);
                self.layer_order.retain(|id| *id != layer_id);
                for group in self.groups.values_mut() {
                    group.layer_ids.retain(|id| *id != layer_id);
                }
                if self.active_layer_id == Some(layer_id) {
                    self.active_layer_id = self.layer_order.last().copied();
                }
            }
            Operation::SetLayerVisibility { layer_id, visible } => {
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .visible = visible;
            }
            Operation::SetLayerLocked { layer_id, locked } => {
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .locked = locked;
            }
            Operation::SetLayerLockOptions {
                layer_id,
                locked,
                lock_pixels,
                lock_position,
                lock_transparent_pixels,
            } => {
                self.checkpoint();
                let layer = self
                    .layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?;
                if let Some(value) = locked {
                    layer.locked = value;
                }
                if let Some(value) = lock_pixels {
                    layer.lock_pixels = value;
                }
                if let Some(value) = lock_position {
                    layer.lock_position = value;
                }
                if let Some(value) = lock_transparent_pixels {
                    layer.lock_transparent_pixels = value;
                }
            }
            Operation::SetLayerOpacity { layer_id, opacity } => {
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .opacity = opacity.clamp(0.0, 1.0);
            }
            Operation::SetLayerFillOpacity {
                layer_id,
                fill_opacity,
            } => {
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .fill_opacity = fill_opacity.clamp(0.0, 1.0);
            }
            Operation::SetBlendMode {
                layer_id,
                blend_mode,
            } => {
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .blend_mode = blend_mode;
            }
            Operation::ReorderLayer { layer_id, to_index } => {
                self.checkpoint();
                let current = self
                    .layer_order
                    .iter()
                    .position(|id| *id == layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?;
                let target = to_index.min(self.layer_order.len().saturating_sub(1));
                let value = self.layer_order.remove(current);
                self.layer_order.insert(target, value);
            }
            Operation::Brush {
                layer_id,
                x,
                y,
                radius,
                color,
                strength,
                erase,
            } => {
                self.ensure_layer_pixels_unlocked(layer_id)?;
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .apply_brush(x, y, radius, color, strength, erase)?;
            }
            Operation::FloodFill {
                layer_id,
                x,
                y,
                color,
                tolerance,
                contiguous,
            } => {
                self.ensure_layer_pixels_unlocked(layer_id)?;
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .flood_fill(x, y, color, tolerance, contiguous.unwrap_or(true))?;
            }
            Operation::Brightness { layer_id, value } => {
                self.ensure_layer_pixels_unlocked(layer_id)?;
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .apply_brightness(value)?;
            }
            Operation::Contrast { layer_id, value } => {
                self.ensure_layer_pixels_unlocked(layer_id)?;
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .apply_contrast(value)?;
            }
            Operation::Blur { layer_id, radius } => {
                self.ensure_layer_pixels_unlocked(layer_id)?;
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .apply_blur(radius)?;
            }
            Operation::Sharpen { layer_id, amount } => {
                self.ensure_layer_pixels_unlocked(layer_id)?;
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .apply_sharpen(amount)?;
            }
            Operation::CutSelectionToNewLayer {
                layer_id,
                points,
                refine,
                name,
            } => {
                if points.len() < 3 {
                    return Err("Selection is empty".to_string());
                }
                self.ensure_layer_pixels_unlocked(layer_id)?;
                self.checkpoint();
                let id = self.next_layer_id;
                self.next_layer_id += 1;
                let layer_pixels = self
                    .layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .cut_polygon_to_layer_pixels(
                        self.width,
                        self.height,
                        &points,
                        refine.unwrap_or(false),
                        true,
                    )?;
                let mut layer = Layer::new_raster(
                    id,
                    name.unwrap_or_else(|| format!("Cut {id}")),
                    self.width,
                    self.height,
                );
                if let LayerContent::Raster { pixels, .. } = &mut layer.content {
                    *pixels = layer_pixels;
                }
                self.layers.insert(id, layer);
                let insert_at = self
                    .layer_order
                    .iter()
                    .position(|current| *current == layer_id)
                    .map(|index| index + 1)
                    .unwrap_or(self.layer_order.len());
                self.layer_order.insert(insert_at, id);
                self.active_layer_id = Some(id);
            }
            Operation::CopySelectionToNewLayer {
                layer_id,
                points,
                refine,
                name,
            } => {
                if points.len() < 3 {
                    return Err("Selection is empty".to_string());
                }
                self.ensure_layer_pixels_unlocked(layer_id)?;
                self.checkpoint();
                let id = self.next_layer_id;
                self.next_layer_id += 1;
                let layer_pixels = self
                    .layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .cut_polygon_to_layer_pixels(
                        self.width,
                        self.height,
                        &points,
                        refine.unwrap_or(false),
                        false,
                    )?;
                let mut layer = Layer::new_raster(
                    id,
                    name.unwrap_or_else(|| format!("Selection {id}")),
                    self.width,
                    self.height,
                );
                if let LayerContent::Raster { pixels, .. } = &mut layer.content {
                    *pixels = layer_pixels;
                }
                self.layers.insert(id, layer);
                let insert_at = self
                    .layer_order
                    .iter()
                    .position(|current| *current == layer_id)
                    .map(|index| index + 1)
                    .unwrap_or(self.layer_order.len());
                self.layer_order.insert(insert_at, id);
                self.active_layer_id = Some(id);
            }
            Operation::DeleteSelection {
                layer_id,
                points,
                refine,
            } => {
                if points.len() < 3 {
                    return Err("Selection is empty".to_string());
                }
                self.ensure_layer_pixels_unlocked(layer_id)?;
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .cut_polygon_to_layer_pixels(
                        self.width,
                        self.height,
                        &points,
                        refine.unwrap_or(false),
                        true,
                    )?;
            }
            Operation::Crop {
                x,
                y,
                width,
                height,
            } => {
                self.checkpoint();
                self.crop(x, y, width, height);
            }
            Operation::Resize { width, height } => {
                self.checkpoint();
                self.resize(width.max(1), height.max(1));
            }
            Operation::Rotate90 { clockwise } => {
                self.checkpoint();
                self.rotate90(clockwise);
            }
            Operation::CreateAdjustmentLayer {
                name,
                adjustment_kind,
                value,
                clipped_to_layer_id,
            } => {
                self.checkpoint();
                let id = self.next_layer_id;
                self.next_layer_id += 1;
                self.layers.insert(
                    id,
                    Layer::new_adjustment(
                        id,
                        name.unwrap_or_else(|| format!("Adjustment {id}")),
                        adjustment_kind,
                        value,
                        clipped_to_layer_id,
                    ),
                );
                self.layer_order.push(id);
                self.active_layer_id = Some(id);
            }
            Operation::SetClippingMask {
                layer_id,
                clipped_to_layer_id,
            } => {
                self.ensure_layer_unlocked(layer_id)?;
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .clipped_to_layer_id = clipped_to_layer_id;
            }
            Operation::SetRasterMaskRect {
                layer_id,
                x,
                y,
                width,
                height,
                invert,
            } => {
                self.ensure_layer_pixels_unlocked(layer_id)?;
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .set_raster_mask_rect(x, y, width, height, invert.unwrap_or(false))?;
            }
            Operation::CreateGroup { name } => {
                self.checkpoint();
                let id = self.next_group_id;
                self.next_group_id += 1;
                self.groups.insert(
                    id,
                    LayerGroup {
                        id,
                        name: name.unwrap_or_else(|| format!("Group {id}")),
                        visible: true,
                        layer_ids: Vec::new(),
                    },
                );
            }
            Operation::CreateGroupFromLayers { layer_ids, name } => {
                if layer_ids.is_empty() {
                    return Err("Group needs at least one layer".to_string());
                }
                for layer_id in &layer_ids {
                    if !self.layers.contains_key(layer_id) {
                        return Err("Layer not found".to_string());
                    }
                }
                self.checkpoint();
                let id = self.next_group_id;
                self.next_group_id += 1;
                for group in self.groups.values_mut() {
                    group
                        .layer_ids
                        .retain(|layer_id| !layer_ids.contains(layer_id));
                }
                self.groups.insert(
                    id,
                    LayerGroup {
                        id,
                        name: name.unwrap_or_else(|| format!("Group {id}")),
                        visible: true,
                        layer_ids,
                    },
                );
            }
            Operation::MoveLayerToGroup { layer_id, group_id } => {
                self.checkpoint();
                if !self.layers.contains_key(&layer_id) {
                    return Err("Layer not found".to_string());
                }
                for group in self.groups.values_mut() {
                    group.layer_ids.retain(|id| *id != layer_id);
                }
                self.groups
                    .get_mut(&group_id)
                    .ok_or_else(|| "Group not found".to_string())?
                    .layer_ids
                    .push(layer_id);
            }
            Operation::ToggleGroupVisibility { group_id, visible } => {
                self.checkpoint();
                self.groups
                    .get_mut(&group_id)
                    .ok_or_else(|| "Group not found".to_string())?
                    .visible = visible;
            }
            Operation::Ungroup { group_id } => {
                self.checkpoint();
                self.groups
                    .remove(&group_id)
                    .ok_or_else(|| "Group not found".to_string())?;
            }
            Operation::AddLayerMask { layer_id } => {
                self.ensure_layer_unlocked(layer_id)?;
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .add_full_mask()?;
            }
            Operation::RemoveLayerMask { layer_id } => {
                self.ensure_layer_unlocked(layer_id)?;
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .remove_mask()?;
            }
            Operation::SetLayerMaskFromSelection {
                layer_id,
                points,
                refine,
                invert,
            } => {
                if points.len() < 3 {
                    return Err("Selection is empty".to_string());
                }
                self.ensure_layer_unlocked(layer_id)?;
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .set_mask_from_polygon(
                        self.width,
                        self.height,
                        &points,
                        refine.unwrap_or(false),
                        invert.unwrap_or(false),
                    )?;
            }
            Operation::InvertLayerMask { layer_id } => {
                self.ensure_layer_unlocked(layer_id)?;
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .invert_mask()?;
            }
            Operation::TransformLayer {
                layer_id,
                translate_x,
                translate_y,
                scale_x,
                scale_y,
            } => {
                self.ensure_layer_position_unlocked(layer_id)?;
                self.checkpoint();
                self.layers
                    .get_mut(&layer_id)
                    .ok_or_else(|| "Layer not found".to_string())?
                    .transform(
                        self.width,
                        self.height,
                        translate_x.unwrap_or(0.0),
                        translate_y.unwrap_or(0.0),
                        scale_x.unwrap_or(1.0).max(0.01),
                        scale_y.unwrap_or(1.0).max(0.01),
                    )?;
            }
        }
        Ok(())
    }

    fn crop(&mut self, x: u32, y: u32, width: u32, height: u32) {
        let max_x = x.min(self.width.saturating_sub(1));
        let max_y = y.min(self.height.saturating_sub(1));
        let new_width = width.max(1).min(self.width.saturating_sub(max_x));
        let new_height = height.max(1).min(self.height.saturating_sub(max_y));

        for layer in self.layers.values_mut() {
            if let LayerContent::Raster {
                width: layer_width,
                height: layer_height,
                pixels,
                mask,
            } = &mut layer.content
            {
                let mut out = vec![0; (new_width * new_height * 4) as usize];
                for row in 0..new_height {
                    for col in 0..new_width {
                        let src_x = (max_x + col).min(*layer_width - 1);
                        let src_y = (max_y + row).min(*layer_height - 1);
                        let src = ((src_y * *layer_width + src_x) * 4) as usize;
                        let dst = ((row * new_width + col) * 4) as usize;
                        out[dst..dst + 4].copy_from_slice(&pixels[src..src + 4]);
                    }
                }
                *pixels = out;

                if let Some(mask) = mask {
                    let mut out_mask = vec![0; (new_width * new_height) as usize];
                    for row in 0..new_height {
                        for col in 0..new_width {
                            let src_x = (max_x + col).min(*layer_width - 1);
                            let src_y = (max_y + row).min(*layer_height - 1);
                            let src = (src_y * *layer_width + src_x) as usize;
                            let dst = (row * new_width + col) as usize;
                            out_mask[dst] = mask.values[src];
                        }
                    }
                    mask.values = out_mask;
                    mask.width = new_width;
                    mask.height = new_height;
                }

                *layer_width = new_width;
                *layer_height = new_height;
            }
        }
        self.width = new_width;
        self.height = new_height;
    }

    fn resize(&mut self, new_width: u32, new_height: u32) {
        for layer in self.layers.values_mut() {
            if let LayerContent::Raster {
                width,
                height,
                pixels,
                mask,
            } = &mut layer.content
            {
                let old_width = *width;
                let old_height = *height;
                let mut out = vec![0; (new_width * new_height * 4) as usize];
                for y in 0..new_height {
                    for x in 0..new_width {
                        let src_x = ((x as f32 / new_width as f32) * old_width as f32)
                            .floor()
                            .clamp(0.0, (old_width - 1) as f32)
                            as u32;
                        let src_y = ((y as f32 / new_height as f32) * old_height as f32)
                            .floor()
                            .clamp(0.0, (old_height - 1) as f32)
                            as u32;
                        let src = ((src_y * old_width + src_x) * 4) as usize;
                        let dst = ((y * new_width + x) * 4) as usize;
                        out[dst..dst + 4].copy_from_slice(&pixels[src..src + 4]);
                    }
                }
                *pixels = out;

                if let Some(mask) = mask {
                    let mut out_mask = vec![0; (new_width * new_height) as usize];
                    for y in 0..new_height {
                        for x in 0..new_width {
                            let src_x = ((x as f32 / new_width as f32) * old_width as f32)
                                .floor()
                                .clamp(0.0, (old_width - 1) as f32)
                                as u32;
                            let src_y = ((y as f32 / new_height as f32) * old_height as f32)
                                .floor()
                                .clamp(0.0, (old_height - 1) as f32)
                                as u32;
                            let src = (src_y * old_width + src_x) as usize;
                            let dst = (y * new_width + x) as usize;
                            out_mask[dst] = mask.values[src];
                        }
                    }
                    mask.values = out_mask;
                    mask.width = new_width;
                    mask.height = new_height;
                }
                *width = new_width;
                *height = new_height;
            }
        }
        self.width = new_width;
        self.height = new_height;
    }

    fn expand_canvas(&mut self, new_width: u32, new_height: u32) {
        let new_width = new_width.max(self.width);
        let new_height = new_height.max(self.height);
        if new_width == self.width && new_height == self.height {
            return;
        }
        let offset_x = (new_width - self.width) / 2;
        let offset_y = (new_height - self.height) / 2;

        for layer in self.layers.values_mut() {
            if let LayerContent::Raster {
                width,
                height,
                pixels,
                mask,
            } = &mut layer.content
            {
                let old_width = *width;
                let old_height = *height;
                let mut out = vec![0; (new_width * new_height * 4) as usize];
                for y in 0..old_height.min(new_height) {
                    for x in 0..old_width.min(new_width) {
                        let src = ((y * old_width + x) * 4) as usize;
                        let dst = (((y + offset_y) * new_width + x + offset_x) * 4) as usize;
                        out[dst..dst + 4].copy_from_slice(&pixels[src..src + 4]);
                    }
                }
                *pixels = out;

                if let Some(mask) = mask {
                    let mut out_mask = vec![0; (new_width * new_height) as usize];
                    for y in 0..mask.height.min(new_height) {
                        for x in 0..mask.width.min(new_width) {
                            let src = (y * mask.width + x) as usize;
                            let dst = ((y + offset_y) * new_width + x + offset_x) as usize;
                            out_mask[dst] = mask.values[src];
                        }
                    }
                    mask.values = out_mask;
                    mask.width = new_width;
                    mask.height = new_height;
                }

                *width = new_width;
                *height = new_height;
            }
        }

        self.width = new_width;
        self.height = new_height;
    }

    fn rotate90(&mut self, clockwise: bool) {
        let old_width = self.width;
        let old_height = self.height;
        let new_width = old_height;
        let new_height = old_width;

        for layer in self.layers.values_mut() {
            if let LayerContent::Raster {
                width,
                height,
                pixels,
                mask,
            } = &mut layer.content
            {
                let mut out = vec![0; (new_width * new_height * 4) as usize];
                for y in 0..new_height {
                    for x in 0..new_width {
                        let (src_x, src_y) = if clockwise {
                            (y, old_height - 1 - x)
                        } else {
                            (old_width - 1 - y, x)
                        };
                        let src = ((src_y * old_width + src_x) * 4) as usize;
                        let dst = ((y * new_width + x) * 4) as usize;
                        out[dst..dst + 4].copy_from_slice(&pixels[src..src + 4]);
                    }
                }
                *pixels = out;

                if let Some(mask) = mask {
                    let mut out_mask = vec![0; (new_width * new_height) as usize];
                    for y in 0..new_height {
                        for x in 0..new_width {
                            let (src_x, src_y) = if clockwise {
                                (y, old_height - 1 - x)
                            } else {
                                (old_width - 1 - y, x)
                            };
                            let src = (src_y * old_width + src_x) as usize;
                            let dst = (y * new_width + x) as usize;
                            out_mask[dst] = mask.values[src];
                        }
                    }
                    mask.values = out_mask;
                    mask.width = new_width;
                    mask.height = new_height;
                }
                *width = new_width;
                *height = new_height;
            }
        }

        self.width = new_width;
        self.height = new_height;
    }

    fn render_flattened(&self) -> Vec<u8> {
        // Финальное изображение рендерится снизу вверх: пиксели слоя -> заливка -> маска -> обтравка -> наложение.
        let mut composite = vec![0; (self.width * self.height * 4) as usize];
        let group_visibility = self.layer_group_visibility_map();
        let mut alpha_cache: HashMap<u32, Vec<u8>> = HashMap::new();

        for layer_id in &self.layer_order {
            let Some(layer) = self.layers.get(layer_id) else {
                continue;
            };
            if !layer.visible {
                continue;
            }
            if let Some(visible) = group_visibility.get(layer_id) {
                if !visible {
                    continue;
                }
            }

            match &layer.content {
                LayerContent::Raster {
                    width,
                    height,
                    pixels,
                    mask,
                } => {
                    if *width != self.width || *height != self.height {
                        continue;
                    }
                    let mut current = pixels.clone();
                    if layer.fill_opacity < 1.0 {
                        apply_fill_opacity(&mut current, layer.fill_opacity);
                    }
                    if let Some(mask) = mask {
                        apply_mask(&mut current, mask);
                    }
                    if let Some(clipped_to) = layer.clipped_to_layer_id {
                        if let Some(alpha) = alpha_cache.get(&clipped_to) {
                            for (index, clip_alpha) in alpha.iter().enumerate() {
                                let alpha_index = index * 4 + 3;
                                current[alpha_index] =
                                    ((current[alpha_index] as u16 * *clip_alpha as u16) / 255)
                                        as u8;
                            }
                        }
                    }

                    blend_layer(
                        &mut composite,
                        &current,
                        layer.opacity,
                        layer.blend_mode,
                        self.width,
                        self.height,
                    );

                    alpha_cache.insert(
                        layer.id,
                        current.chunks_exact(4).map(|px| px[3]).collect::<Vec<u8>>(),
                    );
                }
                LayerContent::Adjustment {
                    adjustment_kind,
                    adjustment_value,
                } => {
                    let clipping_alpha = layer
                        .clipped_to_layer_id
                        .and_then(|id| alpha_cache.get(&id).cloned());
                    apply_adjustment(
                        &mut composite,
                        *adjustment_kind,
                        *adjustment_value,
                        clipping_alpha.as_deref(),
                        self.width,
                        self.height,
                    );
                }
            }
        }

        composite
    }

    fn layer_group_visibility_map(&self) -> HashMap<u32, bool> {
        let mut map = HashMap::new();
        for group in self.groups.values() {
            for layer_id in &group.layer_ids {
                map.insert(*layer_id, group.visible);
            }
        }
        map
    }

    fn ensure_layer_unlocked(&self, layer_id: u32) -> Result<(), String> {
        let layer = self
            .layers
            .get(&layer_id)
            .ok_or_else(|| "Layer not found".to_string())?;
        if layer.locked {
            return Err("Layer is locked".to_string());
        }
        Ok(())
    }

    fn ensure_layer_pixels_unlocked(&self, layer_id: u32) -> Result<(), String> {
        self.ensure_layer_unlocked(layer_id)?;
        let layer = self
            .layers
            .get(&layer_id)
            .ok_or_else(|| "Layer not found".to_string())?;
        if layer.lock_pixels {
            return Err("Layer pixels are locked".to_string());
        }
        Ok(())
    }

    fn ensure_layer_position_unlocked(&self, layer_id: u32) -> Result<(), String> {
        self.ensure_layer_unlocked(layer_id)?;
        let layer = self
            .layers
            .get(&layer_id)
            .ok_or_else(|| "Layer not found".to_string())?;
        if layer.lock_position {
            return Err("Layer position is locked".to_string());
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Layer {
    id: u32,
    name: String,
    visible: bool,
    locked: bool,
    lock_pixels: bool,
    lock_position: bool,
    lock_transparent_pixels: bool,
    opacity: f32,
    fill_opacity: f32,
    blend_mode: BlendMode,
    clipped_to_layer_id: Option<u32>,
    content: LayerContent,
}

impl Layer {
    fn new_raster(id: u32, name: String, width: u32, height: u32) -> Self {
        Self {
            id,
            name,
            visible: true,
            locked: false,
            lock_pixels: false,
            lock_position: false,
            lock_transparent_pixels: false,
            opacity: 1.0,
            fill_opacity: 1.0,
            blend_mode: BlendMode::Normal,
            clipped_to_layer_id: None,
            content: LayerContent::Raster {
                width,
                height,
                pixels: vec![0; (width * height * 4) as usize],
                mask: None,
            },
        }
    }

    fn new_adjustment(
        id: u32,
        name: String,
        adjustment_kind: AdjustmentKind,
        adjustment_value: f32,
        clipped_to_layer_id: Option<u32>,
    ) -> Self {
        Self {
            id,
            name,
            visible: true,
            locked: false,
            lock_pixels: false,
            lock_position: false,
            lock_transparent_pixels: false,
            opacity: 1.0,
            fill_opacity: 1.0,
            blend_mode: BlendMode::Normal,
            clipped_to_layer_id,
            content: LayerContent::Adjustment {
                adjustment_kind,
                adjustment_value,
            },
        }
    }

    fn to_public_layer(&self) -> PublicLayer {
        let (kind, width, height, has_mask, alpha_bounds, adjustment_kind, adjustment_value) =
            match &self.content {
                LayerContent::Raster {
                    width,
                    height,
                    mask,
                    pixels,
                } => (
                    "raster".to_string(),
                    *width,
                    *height,
                    mask.is_some(),
                    alpha_bounds(*width, *height, pixels, mask.as_ref()),
                    None,
                    None,
                ),
                LayerContent::Adjustment {
                    adjustment_kind,
                    adjustment_value,
                } => (
                    "adjustment".to_string(),
                    0,
                    0,
                    false,
                    None,
                    Some(*adjustment_kind),
                    Some(*adjustment_value),
                ),
            };

        PublicLayer {
            id: self.id,
            name: self.name.clone(),
            kind,
            visible: self.visible,
            locked: self.locked,
            lock_pixels: self.lock_pixels,
            lock_position: self.lock_position,
            lock_transparent_pixels: self.lock_transparent_pixels,
            opacity: self.opacity,
            fill_opacity: self.fill_opacity,
            blend_mode: self.blend_mode,
            width,
            height,
            clipped_to_layer_id: self.clipped_to_layer_id,
            has_mask,
            alpha_bounds,
            adjustment_kind,
            adjustment_value,
        }
    }

    fn raster_mut(
        &mut self,
    ) -> Result<(&mut u32, &mut u32, &mut Vec<u8>, &mut Option<LayerMask>), String> {
        match &mut self.content {
            LayerContent::Raster {
                width,
                height,
                pixels,
                mask,
            } => Ok((width, height, pixels, mask)),
            LayerContent::Adjustment { .. } => Err("Operation requires a raster layer".to_string()),
        }
    }

    fn apply_brush(
        &mut self,
        x: f32,
        y: f32,
        radius: f32,
        color: [u8; 4],
        strength: f32,
        erase: bool,
    ) -> Result<(), String> {
        let lock_transparent_pixels = self.lock_transparent_pixels;
        let (width, height, pixels, _) = self.raster_mut()?;
        let radius = radius.max(1.0);
        let strength = strength.clamp(0.0, 1.0);
        let min_x = (x - radius).floor().max(0.0) as u32;
        let min_y = (y - radius).floor().max(0.0) as u32;
        let max_x = (x + radius).ceil().min(*width as f32 - 1.0) as u32;
        let max_y = (y + radius).ceil().min(*height as f32 - 1.0) as u32;

        for py in min_y..=max_y {
            for px in min_x..=max_x {
                let dx = px as f32 - x;
                let dy = py as f32 - y;
                let dist = (dx * dx + dy * dy).sqrt();
                if dist > radius {
                    continue;
                }
                let alpha = strength * (1.0 - dist / radius);
                let idx = ((py * *width + px) * 4) as usize;
                if lock_transparent_pixels && pixels[idx + 3] == 0 {
                    continue;
                }
                if erase {
                    let current_alpha = pixels[idx + 3] as f32 / 255.0;
                    pixels[idx + 3] = (current_alpha * (1.0 - alpha) * 255.0).round() as u8;
                } else {
                    for channel in 0..3 {
                        let current = pixels[idx + channel] as f32;
                        let target = color[channel] as f32;
                        pixels[idx + channel] =
                            (current + (target - current) * alpha).round() as u8;
                    }
                    let current_alpha = pixels[idx + 3] as f32 / 255.0;
                    let paint_alpha = (color[3] as f32 / 255.0) * alpha;
                    let out_alpha = current_alpha + (1.0 - current_alpha) * paint_alpha;
                    pixels[idx + 3] = (out_alpha * 255.0).round() as u8;
                }
            }
        }
        Ok(())
    }

    fn flood_fill(
        &mut self,
        x: f32,
        y: f32,
        color: [u8; 4],
        tolerance: f32,
        contiguous: bool,
    ) -> Result<(), String> {
        let (width, height, pixels, _) = self.raster_mut()?;
        if *width == 0 || *height == 0 {
            return Ok(());
        }
        let start_x = x.round().clamp(0.0, (*width - 1) as f32) as u32;
        let start_y = y.round().clamp(0.0, (*height - 1) as f32) as u32;
        let start_index = ((start_y * *width + start_x) * 4) as usize;
        let target = [
            pixels[start_index],
            pixels[start_index + 1],
            pixels[start_index + 2],
            pixels[start_index + 3],
        ];
        let tolerance = tolerance.clamp(0.0, 255.0);

        if contiguous {
            let mut visited = vec![false; (*width * *height) as usize];
            let mut stack = vec![(start_x, start_y)];
            visited[(start_y * *width + start_x) as usize] = true;

            while let Some((cx, cy)) = stack.pop() {
                let idx = ((cy * *width + cx) * 4) as usize;
                if !rgba_within_tolerance(&pixels[idx..idx + 4], target, tolerance) {
                    continue;
                }
                pixels[idx..idx + 4].copy_from_slice(&color);

                for (nx, ny) in neighbors4(cx, cy, *width, *height) {
                    let visit_index = (ny * *width + nx) as usize;
                    if !visited[visit_index] {
                        visited[visit_index] = true;
                        stack.push((nx, ny));
                    }
                }
            }
        } else {
            for idx in (0..pixels.len()).step_by(4) {
                if rgba_within_tolerance(&pixels[idx..idx + 4], target, tolerance) {
                    pixels[idx..idx + 4].copy_from_slice(&color);
                }
            }
        }

        Ok(())
    }

    fn apply_brightness(&mut self, value: f32) -> Result<(), String> {
        let (_, _, pixels, _) = self.raster_mut()?;
        let delta = value.clamp(-1.0, 1.0) * 255.0;
        for px in pixels.chunks_exact_mut(4) {
            px[0] = (px[0] as f32 + delta).clamp(0.0, 255.0) as u8;
            px[1] = (px[1] as f32 + delta).clamp(0.0, 255.0) as u8;
            px[2] = (px[2] as f32 + delta).clamp(0.0, 255.0) as u8;
        }
        Ok(())
    }

    fn apply_contrast(&mut self, value: f32) -> Result<(), String> {
        let (_, _, pixels, _) = self.raster_mut()?;
        let contrast = value.clamp(-1.0, 1.0) * 255.0;
        let factor = (259.0 * (contrast + 255.0)) / (255.0 * (259.0 - contrast));
        for px in pixels.chunks_exact_mut(4) {
            px[0] = (factor * (px[0] as f32 - 128.0) + 128.0).clamp(0.0, 255.0) as u8;
            px[1] = (factor * (px[1] as f32 - 128.0) + 128.0).clamp(0.0, 255.0) as u8;
            px[2] = (factor * (px[2] as f32 - 128.0) + 128.0).clamp(0.0, 255.0) as u8;
        }
        Ok(())
    }

    fn apply_blur(&mut self, radius: f32) -> Result<(), String> {
        let (width, height, pixels, _) = self.raster_mut()?;
        let radius = radius.round().clamp(1.0, 12.0) as i32;
        let source = pixels.clone();
        for y in 0..*height as i32 {
            for x in 0..*width as i32 {
                let mut sum = [0u32; 4];
                let mut count = 0u32;
                for ky in -radius..=radius {
                    for kx in -radius..=radius {
                        let sx = (x + kx).clamp(0, *width as i32 - 1) as u32;
                        let sy = (y + ky).clamp(0, *height as i32 - 1) as u32;
                        let idx = ((sy * *width + sx) * 4) as usize;
                        for c in 0..4 {
                            sum[c] += source[idx + c] as u32;
                        }
                        count += 1;
                    }
                }
                let dst = (((y as u32) * *width + x as u32) * 4) as usize;
                for c in 0..4 {
                    pixels[dst + c] = (sum[c] / count) as u8;
                }
            }
        }
        Ok(())
    }

    fn apply_sharpen(&mut self, amount: f32) -> Result<(), String> {
        let (width, height, pixels, _) = self.raster_mut()?;
        let amount = amount.clamp(0.0, 2.0);
        let source = pixels.clone();
        let kernel = [0.0, -1.0, 0.0, -1.0, 5.0, -1.0, 0.0, -1.0, 0.0];
        for y in 0..*height {
            for x in 0..*width {
                let dst = ((y * *width + x) * 4) as usize;
                for c in 0..3 {
                    let mut acc = 0.0;
                    for ky in 0..3 {
                        for kx in 0..3 {
                            let sx = (x as i32 + kx as i32 - 1).clamp(0, *width as i32 - 1) as u32;
                            let sy = (y as i32 + ky as i32 - 1).clamp(0, *height as i32 - 1) as u32;
                            let src = ((sy * *width + sx) * 4 + c as u32) as usize;
                            acc += source[src] as f32 * kernel[(ky * 3 + kx) as usize];
                        }
                    }
                    let base = source[dst + c] as f32;
                    pixels[dst + c] = (base + (acc - base) * amount).clamp(0.0, 255.0) as u8;
                }
                pixels[dst + 3] = source[dst + 3];
            }
        }
        Ok(())
    }

    fn cut_polygon_to_layer_pixels(
        &mut self,
        doc_width: u32,
        doc_height: u32,
        points: &[SelectionPoint],
        refine: bool,
        clear_source: bool,
    ) -> Result<Vec<u8>, String> {
        let (layer_width, layer_height, pixels, _) = self.raster_mut()?;
        let bounds = polygon_bounds(points, *layer_width, *layer_height, doc_width, doc_height)?;
        let (start_x, start_y, end_x, end_y) = bounds;
        if start_x >= end_x || start_y >= end_y {
            return Err("Selection is outside the layer".to_string());
        }

        let mut mask = vec![false; (doc_width * doc_height) as usize];
        for py in start_y..end_y {
            for px in start_x..end_x {
                if point_in_polygon(px as f32 + 0.5, py as f32 + 0.5, points) {
                    mask[(py * doc_width + px) as usize] = true;
                }
            }
        }

        if refine {
            smart_refine_mask(
                &mut mask,
                pixels,
                doc_width,
                doc_height,
                *layer_width,
                bounds,
            );
        }

        let mut out = vec![0; (doc_width * doc_height * 4) as usize];
        for py in start_y..end_y {
            for px in start_x..end_x {
                if !mask[(py * doc_width + px) as usize] {
                    continue;
                }
                let src = ((py * *layer_width + px) * 4) as usize;
                let dst = ((py * doc_width + px) * 4) as usize;
                out[dst..dst + 4].copy_from_slice(&pixels[src..src + 4]);
                if clear_source {
                    pixels[src..src + 4].fill(0);
                }
            }
        }
        Ok(out)
    }

    fn set_raster_mask_rect(
        &mut self,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        invert: bool,
    ) -> Result<(), String> {
        let (layer_width, layer_height, _, mask_slot) = self.raster_mut()?;
        let mut values =
            vec![if invert { 0 } else { 255 }; (*layer_width * *layer_height) as usize];
        let max_x = (x + width).min(*layer_width);
        let max_y = (y + height).min(*layer_height);
        for py in y..max_y {
            for px in x..max_x {
                let idx = (py * *layer_width + px) as usize;
                values[idx] = if invert { 255 } else { 0 };
            }
        }
        *mask_slot = Some(LayerMask {
            width: *layer_width,
            height: *layer_height,
            values,
            inverted: invert,
        });
        Ok(())
    }

    fn set_mask_from_polygon(
        &mut self,
        doc_width: u32,
        doc_height: u32,
        points: &[SelectionPoint],
        refine: bool,
        invert: bool,
    ) -> Result<(), String> {
        let (layer_width, layer_height, pixels, mask_slot) = self.raster_mut()?;
        let bounds = polygon_bounds(points, *layer_width, *layer_height, doc_width, doc_height)?;
        let (start_x, start_y, end_x, end_y) = bounds;
        if start_x >= end_x || start_y >= end_y {
            return Err("Selection is outside the layer".to_string());
        }

        let mut selected = vec![false; (doc_width * doc_height) as usize];
        for py in start_y..end_y {
            for px in start_x..end_x {
                if point_in_polygon(px as f32 + 0.5, py as f32 + 0.5, points) {
                    selected[(py * doc_width + px) as usize] = true;
                }
            }
        }

        if refine {
            smart_refine_mask(
                &mut selected,
                pixels,
                doc_width,
                doc_height,
                *layer_width,
                bounds,
            );
        }

        let mut values = vec![0; (*layer_width * *layer_height) as usize];
        for py in 0..(*layer_height).min(doc_height) {
            for px in 0..(*layer_width).min(doc_width) {
                let doc_index = (py * doc_width + px) as usize;
                let layer_index = (py * *layer_width + px) as usize;
                let visible = selected[doc_index] ^ invert;
                values[layer_index] = if visible { 255 } else { 0 };
            }
        }

        *mask_slot = Some(LayerMask {
            width: *layer_width,
            height: *layer_height,
            values,
            inverted: false,
        });
        Ok(())
    }

    fn add_full_mask(&mut self) -> Result<(), String> {
        let (layer_width, layer_height, _, mask_slot) = self.raster_mut()?;
        *mask_slot = Some(LayerMask {
            width: *layer_width,
            height: *layer_height,
            values: vec![255; (*layer_width * *layer_height) as usize],
            inverted: false,
        });
        Ok(())
    }

    fn remove_mask(&mut self) -> Result<(), String> {
        let (_, _, _, mask_slot) = self.raster_mut()?;
        *mask_slot = None;
        Ok(())
    }

    fn invert_mask(&mut self) -> Result<(), String> {
        let (_, _, _, mask_slot) = self.raster_mut()?;
        let mask = mask_slot
            .as_mut()
            .ok_or_else(|| "Layer has no mask".to_string())?;
        for value in &mut mask.values {
            *value = 255 - *value;
        }
        mask.inverted = !mask.inverted;
        Ok(())
    }

    fn transform(
        &mut self,
        doc_width: u32,
        doc_height: u32,
        translate_x: f32,
        translate_y: f32,
        scale_x: f32,
        scale_y: f32,
    ) -> Result<(), String> {
        let (width, height, pixels, _) = self.raster_mut()?;
        if *width != doc_width || *height != doc_height {
            return Err("Only full-size raster layers can be transformed in this MVP".to_string());
        }
        let source = pixels.clone();
        let source_bounds = alpha_bounds(*width, *height, &source, None);
        let (cx, cy) = source_bounds
            .as_ref()
            .map(|bounds| {
                (
                    bounds.x as f32 + bounds.width as f32 / 2.0,
                    bounds.y as f32 + bounds.height as f32 / 2.0,
                )
            })
            .unwrap_or((doc_width as f32 / 2.0, doc_height as f32 / 2.0));
        for y in 0..doc_height {
            for x in 0..doc_width {
                let tx = x as f32 - cx - translate_x;
                let ty = y as f32 - cy - translate_y;
                let src_x = tx / scale_x + cx;
                let src_y = ty / scale_y + cy;
                let dst = ((y * doc_width + x) * 4) as usize;
                if src_x >= 0.0
                    && src_y >= 0.0
                    && src_x < doc_width as f32
                    && src_y < doc_height as f32
                {
                    let sx = src_x.floor() as u32;
                    let sy = src_y.floor() as u32;
                    let src = ((sy * doc_width + sx) * 4) as usize;
                    pixels[dst..dst + 4].copy_from_slice(&source[src..src + 4]);
                } else {
                    pixels[dst..dst + 4].fill(0);
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum LayerContent {
    Raster {
        width: u32,
        height: u32,
        pixels: Vec<u8>,
        mask: Option<LayerMask>,
    },
    Adjustment {
        adjustment_kind: AdjustmentKind,
        adjustment_value: f32,
    },
}

#[derive(Clone, Serialize, Deserialize)]
struct LayerMask {
    width: u32,
    height: u32,
    values: Vec<u8>,
    inverted: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct LayerGroup {
    id: u32,
    name: String,
    visible: bool,
    layer_ids: Vec<u32>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum BlendMode {
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AdjustmentKind {
    Brightness,
    Contrast,
    Blur,
    Sharpen,
}

#[derive(Serialize)]
struct PublicDocumentState {
    id: u32,
    width: u32,
    height: u32,
    color_profile: String,
    layer_order: Vec<u32>,
    layers: Vec<PublicLayer>,
    groups: Vec<PublicLayerGroup>,
    active_layer_id: Option<u32>,
}

#[derive(Serialize)]
struct PublicLayer {
    id: u32,
    name: String,
    kind: String,
    visible: bool,
    locked: bool,
    lock_pixels: bool,
    lock_position: bool,
    lock_transparent_pixels: bool,
    opacity: f32,
    fill_opacity: f32,
    blend_mode: BlendMode,
    width: u32,
    height: u32,
    clipped_to_layer_id: Option<u32>,
    has_mask: bool,
    alpha_bounds: Option<PublicLayerBounds>,
    adjustment_kind: Option<AdjustmentKind>,
    adjustment_value: Option<f32>,
}

#[derive(Serialize)]
struct PublicLayerBounds {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Serialize)]
struct PublicLayerGroup {
    id: u32,
    name: String,
    visible: bool,
    layer_ids: Vec<u32>,
}

#[derive(Serialize)]
struct ChangedTile {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Operation {
    AddEmptyLayer {
        name: Option<String>,
    },
    RenameLayer {
        layer_id: u32,
        name: String,
    },
    DuplicateLayer {
        layer_id: u32,
        name: Option<String>,
    },
    DeleteLayer {
        layer_id: u32,
    },
    SetLayerVisibility {
        layer_id: u32,
        visible: bool,
    },
    SetLayerLocked {
        layer_id: u32,
        locked: bool,
    },
    SetLayerLockOptions {
        layer_id: u32,
        locked: Option<bool>,
        lock_pixels: Option<bool>,
        lock_position: Option<bool>,
        lock_transparent_pixels: Option<bool>,
    },
    SetLayerOpacity {
        layer_id: u32,
        opacity: f32,
    },
    SetLayerFillOpacity {
        layer_id: u32,
        fill_opacity: f32,
    },
    SetBlendMode {
        layer_id: u32,
        blend_mode: BlendMode,
    },
    ReorderLayer {
        layer_id: u32,
        to_index: usize,
    },
    Brush {
        layer_id: u32,
        x: f32,
        y: f32,
        radius: f32,
        color: [u8; 4],
        strength: f32,
        erase: bool,
    },
    FloodFill {
        layer_id: u32,
        x: f32,
        y: f32,
        color: [u8; 4],
        tolerance: f32,
        contiguous: Option<bool>,
    },
    Brightness {
        layer_id: u32,
        value: f32,
    },
    Contrast {
        layer_id: u32,
        value: f32,
    },
    Blur {
        layer_id: u32,
        radius: f32,
    },
    Sharpen {
        layer_id: u32,
        amount: f32,
    },
    CutSelectionToNewLayer {
        layer_id: u32,
        points: Vec<SelectionPoint>,
        refine: Option<bool>,
        name: Option<String>,
    },
    CopySelectionToNewLayer {
        layer_id: u32,
        points: Vec<SelectionPoint>,
        refine: Option<bool>,
        name: Option<String>,
    },
    DeleteSelection {
        layer_id: u32,
        points: Vec<SelectionPoint>,
        refine: Option<bool>,
    },
    Crop {
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    },
    Resize {
        width: u32,
        height: u32,
    },
    Rotate90 {
        clockwise: bool,
    },
    CreateAdjustmentLayer {
        name: Option<String>,
        adjustment_kind: AdjustmentKind,
        value: f32,
        clipped_to_layer_id: Option<u32>,
    },
    SetClippingMask {
        layer_id: u32,
        clipped_to_layer_id: Option<u32>,
    },
    SetRasterMaskRect {
        layer_id: u32,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        invert: Option<bool>,
    },
    CreateGroup {
        name: Option<String>,
    },
    CreateGroupFromLayers {
        layer_ids: Vec<u32>,
        name: Option<String>,
    },
    MoveLayerToGroup {
        layer_id: u32,
        group_id: u32,
    },
    Ungroup {
        group_id: u32,
    },
    ToggleGroupVisibility {
        group_id: u32,
        visible: bool,
    },
    AddLayerMask {
        layer_id: u32,
    },
    RemoveLayerMask {
        layer_id: u32,
    },
    SetLayerMaskFromSelection {
        layer_id: u32,
        points: Vec<SelectionPoint>,
        refine: Option<bool>,
        invert: Option<bool>,
    },
    InvertLayerMask {
        layer_id: u32,
    },
    TransformLayer {
        layer_id: u32,
        translate_x: Option<f32>,
        translate_y: Option<f32>,
        scale_x: Option<f32>,
        scale_y: Option<f32>,
    },
}

#[derive(Clone, Copy, Deserialize)]
struct SelectionPoint {
    x: f32,
    y: f32,
}

fn polygon_bounds(
    points: &[SelectionPoint],
    layer_width: u32,
    layer_height: u32,
    doc_width: u32,
    doc_height: u32,
) -> Result<(u32, u32, u32, u32), String> {
    if points.len() < 3 {
        return Err("Selection is empty".to_string());
    }
    let max_x = layer_width.min(doc_width);
    let max_y = layer_height.min(doc_height);
    let min_x = points
        .iter()
        .map(|point| point.x.floor().max(0.0) as u32)
        .min()
        .unwrap_or(0)
        .min(max_x);
    let min_y = points
        .iter()
        .map(|point| point.y.floor().max(0.0) as u32)
        .min()
        .unwrap_or(0)
        .min(max_y);
    let end_x = points
        .iter()
        .map(|point| point.x.ceil().max(0.0) as u32)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
        .min(max_x);
    let end_y = points
        .iter()
        .map(|point| point.y.ceil().max(0.0) as u32)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
        .min(max_y);
    Ok((min_x, min_y, end_x, end_y))
}

fn point_in_polygon(x: f32, y: f32, points: &[SelectionPoint]) -> bool {
    let mut winding = 0i32;
    for index in 0..points.len() {
        let start = points[index];
        let end = points[(index + 1) % points.len()];
        if point_on_segment(x, y, start, end) {
            return true;
        }
        let edge = (end.x - start.x) * (y - start.y) - (x - start.x) * (end.y - start.y);
        if start.y <= y {
            if end.y > y && edge > 0.0 {
                winding += 1;
            }
        } else if end.y <= y && edge < 0.0 {
            winding -= 1;
        }
    }
    winding != 0
}

fn point_on_segment(x: f32, y: f32, start: SelectionPoint, end: SelectionPoint) -> bool {
    let cross = (x - start.x) * (end.y - start.y) - (y - start.y) * (end.x - start.x);
    if cross.abs() > 0.5 {
        return false;
    }
    let min_x = start.x.min(end.x) - 0.5;
    let max_x = start.x.max(end.x) + 0.5;
    let min_y = start.y.min(end.y) - 0.5;
    let max_y = start.y.max(end.y) + 0.5;
    x >= min_x && x <= max_x && y >= min_y && y <= max_y
}

fn alpha_bounds(
    width: u32,
    height: u32,
    pixels: &[u8],
    mask: Option<&LayerMask>,
) -> Option<PublicLayerBounds> {
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0;
    let mut max_y = 0;
    let mut found = false;

    for y in 0..height {
        for x in 0..width {
            let index = (y * width + x) as usize;
            let alpha_index = index * 4 + 3;
            let alpha = pixels.get(alpha_index).copied().unwrap_or(0);
            let mask_alpha = mask
                .and_then(|layer_mask| layer_mask.values.get(index).copied())
                .unwrap_or(255);
            if alpha == 0 || mask_alpha == 0 {
                continue;
            }
            found = true;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
    }

    found.then(|| PublicLayerBounds {
        x: min_x,
        y: min_y,
        width: max_x - min_x + 1,
        height: max_y - min_y + 1,
    })
}

fn smart_refine_mask(
    mask: &mut Vec<bool>,
    pixels: &[u8],
    doc_width: u32,
    doc_height: u32,
    layer_width: u32,
    bounds: (u32, u32, u32, u32),
) {
    let (start_x, start_y, end_x, end_y) = bounds;
    let original = mask.clone();

    for py in start_y..end_y {
        for px in start_x..end_x {
            let doc_index = (py * doc_width + px) as usize;
            if !original[doc_index] {
                continue;
            }
            let mut neighbors = 0;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let nx = px as i32 + dx;
                    let ny = py as i32 + dy;
                    if nx < 0 || ny < 0 || nx >= doc_width as i32 || ny >= doc_height as i32 {
                        continue;
                    }
                    if original[(ny as u32 * doc_width + nx as u32) as usize] {
                        neighbors += 1;
                    }
                }
            }
            if neighbors <= 2 {
                mask[doc_index] = false;
            }
        }
    }

    let alpha_cleaned = mask.clone();
    for py in start_y..end_y {
        for px in start_x..end_x {
            let doc_index = (py * doc_width + px) as usize;
            if !mask[doc_index] {
                continue;
            }
            let alpha_index = ((py * layer_width + px) * 4 + 3) as usize;
            if pixels.get(alpha_index).copied().unwrap_or(0) == 0 {
                mask[doc_index] = false;
            }
        }
    }

    if let Some(color_refined) = refine_mask_by_boundary_color(
        &alpha_cleaned,
        mask,
        pixels,
        doc_width,
        doc_height,
        layer_width,
        bounds,
    ) {
        *mask = color_refined;
    }

    keep_largest_component(mask, doc_width, doc_height, bounds);
}

fn refine_mask_by_boundary_color(
    original: &[bool],
    alpha_mask: &[bool],
    pixels: &[u8],
    doc_width: u32,
    doc_height: u32,
    layer_width: u32,
    bounds: (u32, u32, u32, u32),
) -> Option<Vec<bool>> {
    let background = estimate_boundary_color(
        original,
        alpha_mask,
        pixels,
        doc_width,
        doc_height,
        layer_width,
        bounds,
    )?;
    let masked_count = count_mask_pixels(alpha_mask, doc_width, bounds);
    if masked_count < 24 {
        return None;
    }

    let mut candidate = vec![false; alpha_mask.len()];
    let mut candidate_count = 0usize;
    let threshold = background.threshold.max(34.0);
    let (start_x, start_y, end_x, end_y) = bounds;

    for py in start_y..end_y {
        for px in start_x..end_x {
            let doc_index = (py * doc_width + px) as usize;
            if !alpha_mask[doc_index] {
                continue;
            }
            let pixel_index = ((py * layer_width + px) * 4) as usize;
            let Some(pixel) = pixels.get(pixel_index..pixel_index + 4) else {
                continue;
            };
            if pixel[3] == 0 {
                continue;
            }
            if color_distance(pixel, background.color) > threshold {
                candidate[doc_index] = true;
                candidate_count += 1;
            }
        }
    }

    let ratio = candidate_count as f32 / masked_count as f32;
    if candidate_count < 16 || ratio < 0.035 || ratio > 0.92 {
        return None;
    }

    keep_largest_component(&mut candidate, doc_width, doc_height, bounds);
    let refined_count = count_mask_pixels(&candidate, doc_width, bounds);
    let refined_ratio = refined_count as f32 / masked_count as f32;
    if refined_count < 16 || refined_ratio < 0.035 || refined_ratio > 0.92 {
        return None;
    }

    Some(candidate)
}

struct BoundaryColor {
    color: [f32; 3],
    threshold: f32,
}

fn estimate_boundary_color(
    original: &[bool],
    alpha_mask: &[bool],
    pixels: &[u8],
    doc_width: u32,
    doc_height: u32,
    layer_width: u32,
    bounds: (u32, u32, u32, u32),
) -> Option<BoundaryColor> {
    let (start_x, start_y, end_x, end_y) = bounds;
    let mut samples: Vec<[f32; 3]> = Vec::new();

    for py in start_y..end_y {
        for px in start_x..end_x {
            let doc_index = (py * doc_width + px) as usize;
            if !alpha_mask[doc_index] || !is_mask_boundary(original, px, py, doc_width, doc_height)
            {
                continue;
            }
            let pixel_index = ((py * layer_width + px) * 4) as usize;
            let Some(pixel) = pixels.get(pixel_index..pixel_index + 4) else {
                continue;
            };
            if pixel[3] == 0 {
                continue;
            }
            samples.push([pixel[0] as f32, pixel[1] as f32, pixel[2] as f32]);
        }
    }

    if samples.len() < 8 {
        return None;
    }

    let mut color = [0.0; 3];
    for sample in &samples {
        color[0] += sample[0];
        color[1] += sample[1];
        color[2] += sample[2];
    }
    let sample_count = samples.len() as f32;
    color[0] /= sample_count;
    color[1] /= sample_count;
    color[2] /= sample_count;

    let mut distances = Vec::with_capacity(samples.len());
    for sample in &samples {
        distances.push(color_distance_rgb(*sample, color));
    }
    let mean_distance = distances.iter().sum::<f32>() / distances.len() as f32;
    let variance = distances
        .iter()
        .map(|distance| {
            let delta = distance - mean_distance;
            delta * delta
        })
        .sum::<f32>()
        / distances.len() as f32;

    Some(BoundaryColor {
        color,
        threshold: mean_distance + variance.sqrt() * 2.0 + 18.0,
    })
}

fn is_mask_boundary(mask: &[bool], x: u32, y: u32, width: u32, height: u32) -> bool {
    for (nx, ny) in neighbors8(x, y, width, height) {
        if !mask[(ny * width + nx) as usize] {
            return true;
        }
    }
    false
}

fn color_distance(pixel: &[u8], color: [f32; 3]) -> f32 {
    color_distance_rgb([pixel[0] as f32, pixel[1] as f32, pixel[2] as f32], color)
}

fn color_distance_rgb(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dr = a[0] - b[0];
    let dg = a[1] - b[1];
    let db = a[2] - b[2];
    (dr * dr + dg * dg + db * db).sqrt()
}

fn count_mask_pixels(mask: &[bool], doc_width: u32, bounds: (u32, u32, u32, u32)) -> usize {
    let (start_x, start_y, end_x, end_y) = bounds;
    let mut count = 0usize;
    for py in start_y..end_y {
        for px in start_x..end_x {
            if mask[(py * doc_width + px) as usize] {
                count += 1;
            }
        }
    }
    count
}

fn keep_largest_component(
    mask: &mut Vec<bool>,
    doc_width: u32,
    doc_height: u32,
    bounds: (u32, u32, u32, u32),
) {
    let (start_x, start_y, end_x, end_y) = bounds;
    let mut visited = vec![false; mask.len()];
    let mut largest: Vec<usize> = Vec::new();

    for py in start_y..end_y {
        for px in start_x..end_x {
            let start_index = (py * doc_width + px) as usize;
            if !mask[start_index] || visited[start_index] {
                continue;
            }
            let mut component = Vec::new();
            let mut stack = vec![(px, py)];
            visited[start_index] = true;

            while let Some((cx, cy)) = stack.pop() {
                let current_index = (cy * doc_width + cx) as usize;
                component.push(current_index);
                for (nx, ny) in neighbors8(cx, cy, doc_width, doc_height) {
                    if nx < start_x || nx >= end_x || ny < start_y || ny >= end_y {
                        continue;
                    }
                    let next_index = (ny * doc_width + nx) as usize;
                    if mask[next_index] && !visited[next_index] {
                        visited[next_index] = true;
                        stack.push((nx, ny));
                    }
                }
            }

            if component.len() > largest.len() {
                largest = component;
            }
        }
    }

    if largest.is_empty() {
        return;
    }
    let mut keep = vec![false; mask.len()];
    for index in largest {
        keep[index] = true;
    }
    for (index, value) in mask.iter_mut().enumerate() {
        *value = *value && keep[index];
    }
}

fn neighbors8(x: u32, y: u32, width: u32, height: u32) -> Vec<(u32, u32)> {
    let mut result = Vec::with_capacity(8);
    for dy in -1..=1 {
        for dx in -1..=1 {
            if dx == 0 && dy == 0 {
                continue;
            }
            let nx = x as i32 + dx;
            let ny = y as i32 + dy;
            if nx >= 0 && ny >= 0 && nx < width as i32 && ny < height as i32 {
                result.push((nx as u32, ny as u32));
            }
        }
    }
    result
}

fn neighbors4(x: u32, y: u32, width: u32, height: u32) -> Vec<(u32, u32)> {
    let mut result = Vec::with_capacity(4);
    if x > 0 {
        result.push((x - 1, y));
    }
    if y > 0 {
        result.push((x, y - 1));
    }
    if x + 1 < width {
        result.push((x + 1, y));
    }
    if y + 1 < height {
        result.push((x, y + 1));
    }
    result
}

fn rgba_within_tolerance(pixel: &[u8], target: [u8; 4], tolerance: f32) -> bool {
    let dr = pixel[0] as f32 - target[0] as f32;
    let dg = pixel[1] as f32 - target[1] as f32;
    let db = pixel[2] as f32 - target[2] as f32;
    let da = pixel[3] as f32 - target[3] as f32;
    ((dr * dr + dg * dg + db * db + da * da).sqrt()) <= tolerance
}

fn apply_mask(pixels: &mut [u8], mask: &LayerMask) {
    for (idx, alpha) in mask.values.iter().enumerate() {
        let pixel_alpha = idx * 4 + 3;
        let existing = pixels[pixel_alpha] as u16;
        let mask_alpha = if mask.inverted { 255 - *alpha } else { *alpha } as u16;
        pixels[pixel_alpha] = ((existing * mask_alpha) / 255) as u8;
    }
}

fn apply_fill_opacity(pixels: &mut [u8], fill_opacity: f32) {
    let fill_opacity = fill_opacity.clamp(0.0, 1.0);
    for pixel in pixels.chunks_exact_mut(4) {
        pixel[3] = ((pixel[3] as f32 * fill_opacity).round()).clamp(0.0, 255.0) as u8;
    }
}

fn blend_layer(
    base: &mut [u8],
    top: &[u8],
    opacity: f32,
    mode: BlendMode,
    width: u32,
    height: u32,
) {
    let opacity = opacity.clamp(0.0, 1.0);
    for y in 0..height {
        for x in 0..width {
            let idx = ((y * width + x) * 4) as usize;
            let base_a = base[idx + 3] as f32 / 255.0;
            let top_a = (top[idx + 3] as f32 / 255.0) * opacity;
            if top_a <= 0.0 {
                continue;
            }
            let out_a = top_a + base_a * (1.0 - top_a);
            if out_a <= 0.0 {
                continue;
            }
            for channel in 0..3 {
                let b = base[idx + channel] as f32 / 255.0;
                let t = top[idx + channel] as f32 / 255.0;
                let mixed = blend_channel(mode, b, t);
                let out = ((mixed * top_a) + (b * base_a * (1.0 - top_a))) / out_a;
                base[idx + channel] = (out.clamp(0.0, 1.0) * 255.0).round() as u8;
            }
            base[idx + 3] = (out_a.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }
}

fn blend_channel(mode: BlendMode, base: f32, top: f32) -> f32 {
    match mode {
        BlendMode::Normal => top,
        BlendMode::Multiply => base * top,
        BlendMode::Screen => 1.0 - (1.0 - base) * (1.0 - top),
        BlendMode::Overlay => {
            if base < 0.5 {
                2.0 * base * top
            } else {
                1.0 - 2.0 * (1.0 - base) * (1.0 - top)
            }
        }
        BlendMode::Darken => base.min(top),
        BlendMode::Lighten => base.max(top),
        BlendMode::ColorDodge => {
            if top >= 1.0 {
                1.0
            } else {
                (base / (1.0 - top)).clamp(0.0, 1.0)
            }
        }
        BlendMode::ColorBurn => {
            if top <= 0.0 {
                0.0
            } else {
                (1.0 - (1.0 - base) / top).clamp(0.0, 1.0)
            }
        }
    }
}

fn apply_adjustment(
    pixels: &mut [u8],
    kind: AdjustmentKind,
    value: f32,
    clipping_alpha: Option<&[u8]>,
    width: u32,
    height: u32,
) {
    match kind {
        AdjustmentKind::Brightness => {
            let delta = value.clamp(-1.0, 1.0) * 255.0;
            for (idx, px) in pixels.chunks_exact_mut(4).enumerate() {
                if !allowed_adjustment(idx, clipping_alpha) {
                    continue;
                }
                px[0] = (px[0] as f32 + delta).clamp(0.0, 255.0) as u8;
                px[1] = (px[1] as f32 + delta).clamp(0.0, 255.0) as u8;
                px[2] = (px[2] as f32 + delta).clamp(0.0, 255.0) as u8;
            }
        }
        AdjustmentKind::Contrast => {
            let contrast = value.clamp(-1.0, 1.0) * 255.0;
            let factor = (259.0 * (contrast + 255.0)) / (255.0 * (259.0 - contrast));
            for (idx, px) in pixels.chunks_exact_mut(4).enumerate() {
                if !allowed_adjustment(idx, clipping_alpha) {
                    continue;
                }
                px[0] = (factor * (px[0] as f32 - 128.0) + 128.0).clamp(0.0, 255.0) as u8;
                px[1] = (factor * (px[1] as f32 - 128.0) + 128.0).clamp(0.0, 255.0) as u8;
                px[2] = (factor * (px[2] as f32 - 128.0) + 128.0).clamp(0.0, 255.0) as u8;
            }
        }
        AdjustmentKind::Blur => {
            let source = pixels.to_vec();
            let radius = value.abs().round().clamp(1.0, 8.0) as i32;
            for y in 0..height as i32 {
                for x in 0..width as i32 {
                    let pixel_index = (y * width as i32 + x) as usize;
                    if !allowed_adjustment(pixel_index, clipping_alpha) {
                        continue;
                    }
                    let mut sum = [0u32; 4];
                    let mut count = 0u32;
                    for ky in -radius..=radius {
                        for kx in -radius..=radius {
                            let sx = (x + kx).clamp(0, width as i32 - 1) as u32;
                            let sy = (y + ky).clamp(0, height as i32 - 1) as u32;
                            let src = ((sy * width + sx) * 4) as usize;
                            for c in 0..4 {
                                sum[c] += source[src + c] as u32;
                            }
                            count += 1;
                        }
                    }
                    let dst = ((y as u32 * width + x as u32) * 4) as usize;
                    for c in 0..3 {
                        pixels[dst + c] = (sum[c] / count) as u8;
                    }
                }
            }
        }
        AdjustmentKind::Sharpen => {
            let amount = value.clamp(0.0, 1.0);
            for (idx, px) in pixels.chunks_exact_mut(4).enumerate() {
                if !allowed_adjustment(idx, clipping_alpha) {
                    continue;
                }
                for c in 0..3 {
                    let centered = px[c] as f32 - 128.0;
                    px[c] = (128.0 + centered * (1.0 + amount)).clamp(0.0, 255.0) as u8;
                }
            }
        }
    }
}

fn allowed_adjustment(index: usize, clipping_alpha: Option<&[u8]>) -> bool {
    clipping_alpha
        .map(|alpha| alpha.get(index).copied().unwrap_or(0) > 0)
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn blend_modes_in_range() {
        for mode in [
            BlendMode::Normal,
            BlendMode::Multiply,
            BlendMode::Screen,
            BlendMode::Overlay,
            BlendMode::Darken,
            BlendMode::Lighten,
            BlendMode::ColorDodge,
            BlendMode::ColorBurn,
        ] {
            let out = blend_channel(mode, 0.35, 0.72);
            assert!((0.0..=1.0).contains(&out));
        }
    }

    #[test]
    fn undo_and_redo_work() {
        let mut doc = Document::new(1, 4, 4, "sRGB".to_string());
        doc.execute(Operation::AddEmptyLayer { name: None })
            .unwrap();
        let layer_id = doc.active_layer_id.unwrap();
        let before = serde_json::to_string(&doc.snapshot()).unwrap();
        doc.execute(Operation::Brush {
            layer_id,
            x: 1.0,
            y: 1.0,
            radius: 2.0,
            color: [255, 0, 0, 255],
            strength: 1.0,
            erase: false,
        })
        .unwrap();
        assert!(doc.undo());
        assert_eq!(before, serde_json::to_string(&doc.snapshot()).unwrap());
        assert!(doc.redo());
    }

    proptest! {
        #[test]
        fn contrast_stays_within_byte_bounds(value in -1.0f32..1.0f32) {
            let mut layer = Layer::new_raster(1, "L".to_string(), 1, 1);
            if let LayerContent::Raster { pixels, .. } = &mut layer.content {
                pixels[0] = 120;
                pixels[1] = 140;
                pixels[2] = 220;
                pixels[3] = 255;
            }
            layer.apply_contrast(value).unwrap();
            if let LayerContent::Raster { pixels, .. } = &layer.content {
                prop_assert_eq!(pixels[3], 255);
            }
        }
    }
}
