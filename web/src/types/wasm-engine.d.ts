declare module "../wasm/pkg/wasm_engine.js" {
  export default function init(): Promise<void>;
  export function create_document(
    width: number,
    height: number,
    color_profile: string,
  ): number;
  export function set_active_document(doc_id: number): boolean;
  export function load_image(bytes: Uint8Array, format: string): number;
  export function apply_operation(doc_id: number, operation_json: string): unknown;
  export function render_region(
    doc_id: number,
    x: number,
    y: number,
    width: number,
    height: number,
    scale: number,
  ): Uint8Array;
  export function undo(doc_id: number): boolean;
  export function redo(doc_id: number): boolean;
  export function export_document(
    doc_id: number,
    format: string,
    quality: number,
  ): Uint8Array;
  export function get_document_state(doc_id: number): string;
}
