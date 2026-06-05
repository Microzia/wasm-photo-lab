import type {
  ColorProfile,
  DocumentState,
  EngineRequest,
  EngineResponse,
  Operation,
} from "@app/shared-types";

type EngineRequestPayload = {
  [K in EngineRequest["type"]]: Omit<
    Extract<EngineRequest, { type: K }>,
    "requestId"
  >;
}[EngineRequest["type"]];

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

export class EngineProxy {
  private worker: Worker;
  private pending = new Map<string, PendingRequest>();

  constructor() {
    // Web Worker держит WASM-движок вне основного потока интерфейса, чтобы кисти и импорт не подвешивали экран.
    this.worker = new Worker(new URL("./engine.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<EngineResponse<unknown>>) => {
      const response = event.data;
      const pending = this.pending.get(response.requestId);
      if (!pending) {
        return;
      }
      this.pending.delete(response.requestId);
      if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(new Error(response.error));
      }
    };
  }

  private request<T>(
    payload: EngineRequestPayload,
    transfer: Transferable[] = [],
  ): Promise<T> {
    // requestId связывает асинхронный ответ worker-а с конкретной командой интерфейса.
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      const message = { ...payload, requestId } as EngineRequest;
      this.worker.postMessage(message, transfer);
    });
  }

  init() {
    return this.request<{ ready: boolean }>({ type: "init" });
  }

  createDocument(width: number, height: number, colorProfile: ColorProfile) {
    return this.request<{ docId: number }>({
      type: "createDocument",
      width,
      height,
      colorProfile,
    });
  }

  loadImage(docId: number, bytes: Uint8Array, format: "png" | "jpeg" | "webp", name?: string) {
    return this.request<{ layerId: number }>(
      { type: "loadImage", docId, bytes, format, name },
      [bytes.buffer],
    );
  }

  applyOperation(docId: number, operation: Operation) {
    return this.request<{ changedTiles: Array<{ x: number; y: number; width: number; height: number }> }>({
      type: "applyOperation",
      docId,
      operation,
    });
  }

  renderRegion(
    docId: number,
    x: number,
    y: number,
    width: number,
    height: number,
    scale: number,
  ) {
    return this.request<{ pixels: Uint8Array }>({
      type: "renderRegion",
      docId,
      x,
      y,
      width,
      height,
      scale,
    });
  }

  exportDocument(docId: number, format: "png" | "jpeg" | "webp", quality: number) {
    return this.request<{ bytes: Uint8Array }>({
      type: "exportDocument",
      docId,
      format,
      quality,
    });
  }

  undo(docId: number) {
    return this.request<{ applied: boolean }>({ type: "undo", docId });
  }

  redo(docId: number) {
    return this.request<{ applied: boolean }>({ type: "redo", docId });
  }

  getDocumentState(docId: number) {
    return this.request<{ state: DocumentState }>({ type: "getDocumentState", docId });
  }
}

export const engineProxy = new EngineProxy();
