/// <reference lib="webworker" />

import type {
  ChangedTile,
  DocumentState,
  EngineFailure,
  EngineRequest,
  EngineSuccess,
} from "@app/shared-types";
import { mapRustStateToDocumentState } from "./stateMapper";

type WasmModule = typeof import("../wasm/pkg/wasm_engine.js");

let wasmModule: WasmModule | null = null;
let ready = false;

async function initWasm(): Promise<void> {
  if (ready) {
    return;
  }
  // WASM грузится лениво: первый запрос инициализирует Rust-модуль, остальные переиспользуют его.
  wasmModule = await import("../wasm/pkg/wasm_engine.js");
  await wasmModule.default();
  ready = true;
}

function ok<T>(requestId: string, result: T): EngineSuccess<T> {
  return { requestId, ok: true, result };
}

function fail(requestId: string, error: unknown): EngineFailure {
  return {
    requestId,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

function parseChangedTiles(payload: unknown): ChangedTile[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload.map((tile) => ({
    x: (tile as { x?: number }).x ?? 0,
    y: (tile as { y?: number }).y ?? 0,
    width: (tile as { width?: number }).width ?? 0,
    height: (tile as { height?: number }).height ?? 0,
  }));
}

self.onmessage = async (event: MessageEvent<EngineRequest>) => {
  const request = event.data;
  try {
    await initWasm();
    if (!wasmModule) {
      throw new Error("WASM-модуль не смог инициализироваться");
    }

    // Этот switch является границей протокола: интерфейс -> worker -> Rust/WASM.
    switch (request.type) {
      case "init": {
        self.postMessage(ok(request.requestId, { ready: true }));
        return;
      }
      case "createDocument": {
        const id = wasmModule.create_document(
          request.width,
          request.height,
          request.colorProfile,
        );
        self.postMessage(ok(request.requestId, { docId: id }));
        return;
      }
      case "loadImage": {
        wasmModule.set_active_document(request.docId);
        const layerId = wasmModule.load_image(
          request.bytes,
          request.format,
          request.name ?? "",
        );
        self.postMessage(ok(request.requestId, { layerId }));
        return;
      }
      case "applyOperation": {
        const changedTiles = parseChangedTiles(
          wasmModule.apply_operation(
            request.docId,
            JSON.stringify(request.operation),
          ),
        );
        self.postMessage(ok(request.requestId, { changedTiles }));
        return;
      }
      case "renderRegion": {
        const pixels = wasmModule.render_region(
          request.docId,
          request.x,
          request.y,
          request.width,
          request.height,
          request.scale,
        );
        self.postMessage(ok(request.requestId, { pixels }), [pixels.buffer]);
        return;
      }
      case "exportDocument": {
        const bytes = wasmModule.export_document(
          request.docId,
          request.format,
          Math.round(request.quality * 100),
        );
        self.postMessage(ok(request.requestId, { bytes }), [bytes.buffer]);
        return;
      }
      case "undo": {
        const applied = wasmModule.undo(request.docId);
        self.postMessage(ok(request.requestId, { applied }));
        return;
      }
      case "redo": {
        const applied = wasmModule.redo(request.docId);
        self.postMessage(ok(request.requestId, { applied }));
        return;
      }
      case "getDocumentState": {
        const state: DocumentState = mapRustStateToDocumentState(
          wasmModule.get_document_state(request.docId),
        );
        self.postMessage(ok(request.requestId, { state }));
        return;
      }
      default: {
        const exhaustive: never = request;
        throw new Error(`Unsupported request type ${(exhaustive as { type: string }).type}`);
      }
    }
  } catch (error) {
    self.postMessage(fail(request.requestId, error));
  }
};
