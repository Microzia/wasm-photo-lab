import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Brush,
  Copy,
  Crop,
  Eraser,
  Eye,
  EyeOff,
  FolderPlus,
  Hand,
  Image as ImageIcon,
  Layers,
  Lock,
  LockOpen,
  Move,
  MousePointer2,
  PaintBucket,
  Pencil,
  Pipette,
  Plus,
  Scissors,
  ScanLine,
  SlidersHorizontal,
  Sparkles,
  SquareDashed,
  Trash2,
  WandSparkles,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import type { BlendMode, DocumentState, Layer, LayerBounds, Operation } from "@app/shared-types";
import { engineProxy } from "./engine/engineProxy";
import {
  deleteProject,
  listProjects,
  loadProject,
  saveProject,
  type StoredProject,
} from "./storage/projectStorage";
import "./App.css";

type Tool =
  | "move"
  | "brush"
  | "pencil"
  | "eraser"
  | "scissors"
  | "marquee"
  | "magic"
  | "crop"
  | "eyedropper"
  | "bucket"
  | "zoom"
  | "fragment";
type LassoMode = "freehand" | "polygonal" | "magnetic";
type MarqueeMode = "rect" | "ellipse" | "row" | "column";
type SelectionAction = "copy" | "cut" | "delete";
type ExportFormat = "png" | "jpeg" | "webp";
type ImportFormat = "png" | "jpeg" | "webp";
type DecodedImage = HTMLImageElement | ImageBitmap;
type SelectionPoint = { x: number; y: number };
type MobilePanel = "tools" | "layers";
type AppView = "intro" | "editor";
type LayerTransformMode = "move" | "scale";
type LayerTransformDrag = {
  layerId: number;
  start: SelectionPoint;
  mode: LayerTransformMode;
  bounds: LayerBounds;
};
type MobileFabDrag = {
  panel: MobilePanel;
  pointerId: number;
  start: SelectionPoint;
  origin: SelectionPoint;
  moved: boolean;
};
type LayerTransformPreview = {
  mode: LayerTransformMode;
  bounds: LayerBounds;
};

const BLEND_MODES: BlendMode[] = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
];

const BLEND_MODE_LABELS: Record<BlendMode, string> = {
  normal: "Обычный",
  multiply: "Умножение",
  screen: "Экран",
  overlay: "Перекрытие",
  darken: "Затемнение",
  lighten: "Осветление",
  "color-dodge": "Осветлитель",
  "color-burn": "Затемнитель",
};

const TOOL_LABELS: Record<Tool, string> = {
  move: "Рука",
  brush: "Кисть",
  pencil: "Карандаш",
  eraser: "Ластик",
  scissors: "Ножницы",
  marquee: "Область",
  magic: "Палочка",
  crop: "Кроп",
  eyedropper: "Пипетка",
  bucket: "Заливка",
  zoom: "Лупа",
  fragment: "Фрагмент",
};

const TOOL_ICONS: Record<Tool, LucideIcon> = {
  move: Hand,
  brush: Brush,
  pencil: Pencil,
  eraser: Eraser,
  scissors: Scissors,
  marquee: SquareDashed,
  magic: WandSparkles,
  crop: Crop,
  eyedropper: Pipette,
  bucket: PaintBucket,
  zoom: ZoomIn,
  fragment: Move,
};

const TOOL_HINTS: Record<Tool, string> = {
  move: "Перемещение холста",
  brush: "Рисование мягкой кистью",
  pencil: "Точный пиксельный штрих",
  eraser: "Стирание пикселей активного слоя",
  scissors: "Лассо и вырезание по контуру",
  marquee: "Прямоугольные и овальные выделения",
  magic: "Выделение похожих областей",
  crop: "Кадрирование документа",
  eyedropper: "Выбор цвета с холста",
  bucket: "Заливка похожей области",
  zoom: "Приближение и отдаление",
  fragment: "Перетаскивание вырезанных фрагментов",
};

const LASSO_MODE_LABELS: Record<LassoMode, string> = {
  freehand: "Обычное",
  polygonal: "Прямое",
  magnetic: "Магнитное",
};

const MARQUEE_MODE_LABELS: Record<MarqueeMode, string> = {
  rect: "Прямоуг.",
  ellipse: "Овал",
  row: "Строка",
  column: "Колонка",
};

const LAYER_KIND_LABELS: Record<Layer["kind"], string> = {
  raster: "Растровый",
  adjustment: "Корректирующий",
  group: "Группа",
};

const ADJUSTMENT_LABELS: Record<NonNullable<Layer["adjustmentKind"]>, string> = {
  brightness: "Яркость",
  contrast: "Контраст",
  blur: "Размытие",
  sharpen: "Резкость",
};

function downloadBytes(bytes: Uint8Array, fileName: string, type: string) {
  const safeBytes = Uint8Array.from(bytes);
  const blob = new Blob([safeBytes], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function getSupportedImportFormat(file: File): ImportFormat | null {
  const mime = file.type.toLowerCase();
  if (mime.includes("png")) {
    return "png";
  }
  if (mime.includes("jpeg") || mime.includes("jpg")) {
    return "jpeg";
  }
  if (mime.includes("webp")) {
    return "webp";
  }

  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "png") {
    return "png";
  }
  if (extension === "jpg" || extension === "jpeg") {
    return "jpeg";
  }
  if (extension === "webp") {
    return "webp";
  }
  return null;
}

async function loadImageElement(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } catch (error) {
    throw new Error(
      "Не удалось прочитать изображение. Выберите PNG, JPEG, WebP или другой формат, который поддерживает браузер.",
      { cause: error },
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decodeImageFile(file: File): Promise<DecodedImage> {
  try {
    return await createImageBitmap(file);
  } catch {
    return loadImageElement(file);
  }
}

async function rasterizeToPngBytes(image: DecodedImage): Promise<Uint8Array> {
  const { width, height } = image;
  if (width < 1 || height < 1) {
    throw new Error("Изображение имеет некорректный размер.");
  }

  if ("OffscreenCanvas" in window) {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Не удалось подготовить изображение к импорту.");
    }
    context.drawImage(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Не удалось подготовить изображение к импорту.");
  }
  context.drawImage(image, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) {
        resolve(result);
      } else {
        reject(new Error("Не удалось подготовить изображение к импорту."));
      }
    }, "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

async function rasterizeFileToPngBytes(file: File): Promise<Uint8Array> {
  const image = await decodeImageFile(file);
  try {
    return await rasterizeToPngBytes(image);
  } finally {
    if ("close" in image) {
      image.close();
    }
  }
}

async function prepareImageImport(file: File): Promise<{
  bytes: Uint8Array;
  format: ImportFormat;
  width: number;
  height: number;
}> {
  const image = await decodeImageFile(file);
  try {
    const { width, height } = image;
    if (width < 1 || height < 1) {
      throw new Error("Изображение имеет некорректный размер.");
    }

    const supportedFormat = getSupportedImportFormat(file);
    if (supportedFormat) {
      return {
        bytes: new Uint8Array(await file.arrayBuffer()),
        format: supportedFormat,
        width,
        height,
      };
    }

    return {
      bytes: await rasterizeToPngBytes(image),
      format: "png",
      width,
      height,
    };
  } finally {
    if ("close" in image) {
      image.close();
    }
  }
}

function getLayerNameFromFile(file: File) {
  const withoutExtension = file.name.replace(/\.[^.]+$/, "").trim();
  return withoutExtension || "Импортированное изображение";
}

function distanceBetweenPoints(a: SelectionPoint, b: SelectionPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function simplifySelectionPath(points: SelectionPoint[]) {
  if (points.length < 3) {
    return points;
  }
  const simplified: SelectionPoint[] = [points[0]];
  for (const point of points.slice(1)) {
    const previous = simplified[simplified.length - 1];
    if (distanceBetweenPoints(previous, point) >= 1.5) {
      simplified.push(point);
    }
  }
  return simplified;
}

function shiftSelectionPath(points: SelectionPoint[], dx: number, dy: number) {
  return points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
}

function pointInsideBounds(point: SelectionPoint, bounds: LayerBounds) {
  return point.x >= bounds.x &&
    point.y >= bounds.y &&
    point.x <= bounds.x + bounds.width &&
    point.y <= bounds.y + bounds.height;
}

function layerBoundsToPoints(bounds: LayerBounds) {
  const x2 = bounds.x + bounds.width;
  const y2 = bounds.y + bounds.height;
  return [
    `${bounds.x},${bounds.y}`,
    `${x2},${bounds.y}`,
    `${x2},${y2}`,
    `${bounds.x},${y2}`,
  ].join(" ");
}

function scaleBoundsFromCorner(bounds: LayerBounds, point: SelectionPoint) {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const startX = Math.max(1, bounds.width / 2);
  const startY = Math.max(1, bounds.height / 2);
  const scale = Math.max(
    0.05,
    Math.min(8, Math.max((point.x - cx) / startX, (point.y - cy) / startY)),
  );
  const width = Math.max(1, bounds.width * scale);
  const height = Math.max(1, bounds.height * scale);
  return {
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
  };
}

function pointsFromRect(start: SelectionPoint, end: SelectionPoint) {
  const x1 = Math.min(start.x, end.x);
  const y1 = Math.min(start.y, end.y);
  const x2 = Math.max(start.x, end.x);
  const y2 = Math.max(start.y, end.y);
  return [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
  ];
}

function pointsFromEllipse(start: SelectionPoint, end: SelectionPoint) {
  const x1 = Math.min(start.x, end.x);
  const y1 = Math.min(start.y, end.y);
  const x2 = Math.max(start.x, end.x);
  const y2 = Math.max(start.y, end.y);
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const rx = Math.max(0.5, (x2 - x1) / 2);
  const ry = Math.max(0.5, (y2 - y1) / 2);
  return Array.from({ length: 40 }, (_, index) => {
    const angle = (Math.PI * 2 * index) / 40;
    return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
  });
}

function getHexFromRgba(data: Uint8ClampedArray | number[]) {
  return `#${[data[0], data[1], data[2]]
    .map((value) => Math.round(value).toString(16).padStart(2, "0"))
    .join("")}`;
}

function rgbaDistance(a: number[], b: number[]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);
}

function magicWandBounds(canvas: HTMLCanvasElement | null, point: SelectionPoint, tolerance: number) {
  const context = canvas?.getContext("2d", { willReadFrequently: true });
  if (!canvas || !context) {
    return null;
  }
  const x = Math.min(Math.max(Math.round(point.x), 0), canvas.width - 1);
  const y = Math.min(Math.max(Math.round(point.y), 0), canvas.height - 1);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const startIndex = (y * canvas.width + x) * 4;
  const target = Array.from(image.data.slice(startIndex, startIndex + 4));
  const visited = new Uint8Array(canvas.width * canvas.height);
  const stack: Array<[number, number]> = [[x, y]];
  visited[y * canvas.width + x] = 1;
  let minX = x;
  let maxX = x;
  let minY = y;
  let maxY = y;
  let count = 0;

  while (stack.length > 0) {
    const [cx, cy] = stack.pop()!;
    const idx = (cy * canvas.width + cx) * 4;
    if (rgbaDistance(Array.from(image.data.slice(idx, idx + 4)), target) > tolerance) {
      continue;
    }
    count += 1;
    minX = Math.min(minX, cx);
    maxX = Math.max(maxX, cx);
    minY = Math.min(minY, cy);
    maxY = Math.max(maxY, cy);
    for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
      if (nx < 0 || ny < 0 || nx >= canvas.width || ny >= canvas.height) {
        continue;
      }
      const visitIndex = ny * canvas.width + nx;
      if (!visited[visitIndex]) {
        visited[visitIndex] = 1;
        stack.push([nx, ny]);
      }
    }
  }

  return count > 0 ? { minX, minY, maxX: maxX + 1, maxY: maxY + 1 } : null;
}

function getPointLuminance(data: Uint8ClampedArray, width: number, x: number, y: number) {
  const index = (y * width + x) * 4;
  return data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
}

function findMagneticEdgePoint(canvas: HTMLCanvasElement | null, point: SelectionPoint, width: number) {
  const context = canvas?.getContext("2d", { willReadFrequently: true });
  if (!canvas || !context || width <= 1) {
    return point;
  }

  const radius = Math.max(2, Math.round(width));
  const centerX = Math.round(point.x);
  const centerY = Math.round(point.y);
  const startX = Math.max(1, centerX - radius);
  const endX = Math.min(canvas.width - 2, centerX + radius);
  const startY = Math.max(1, centerY - radius);
  const endY = Math.min(canvas.height - 2, centerY + radius);
  if (startX >= endX || startY >= endY) {
    return point;
  }

  const image = context.getImageData(startX - 1, startY - 1, endX - startX + 3, endY - startY + 3);
  let bestPoint = point;
  let bestScore = 0;

  for (let y = 1; y < image.height - 1; y += 1) {
    for (let x = 1; x < image.width - 1; x += 1) {
      const left = getPointLuminance(image.data, image.width, x - 1, y);
      const right = getPointLuminance(image.data, image.width, x + 1, y);
      const top = getPointLuminance(image.data, image.width, x, y - 1);
      const bottom = getPointLuminance(image.data, image.width, x, y + 1);
      const score = Math.abs(left - right) + Math.abs(top - bottom);
      if (score > bestScore) {
        bestScore = score;
        bestPoint = { x: startX + x - 1, y: startY + y - 1 };
      }
    }
  }

  return bestScore >= 22 ? bestPoint : point;
}

function App() {
  /*
   * App отвечает за две части одностраничного приложения:
   * 1. вступление: приветственная страница проекта;
   * 2. редактор: рабочее место, связанное с Rust/WASM через engineProxy.
   * Ниже состояние сгруппировано по смыслу: документ, инструменты, выделения,
   * слои, мобильные панели и локальные проекты.
   */
  const [view, setView] = useState<AppView>(() => window.location.hash === "#editor" ? "editor" : "intro");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docId, setDocId] = useState<number | null>(null);
  const [state, setState] = useState<DocumentState | null>(null);
  const [activeLayerId, setActiveLayerId] = useState<number | null>(null);
  const [tool, setTool] = useState<Tool>("move");
  const [toolPopoverOpen, setToolPopoverOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [brushColor, setBrushColor] = useState("#0b5fff");
  const [brushRadius, setBrushRadius] = useState(18);
  const [brushStrength, setBrushStrength] = useState(0.85);
  const [filterValue, setFilterValue] = useState(0.2);
  const [resizeWidth, setResizeWidth] = useState(1280);
  const [resizeHeight, setResizeHeight] = useState(720);
  const [projects, setProjects] = useState<StoredProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("png");
  const [selectionPath, setSelectionPath] = useState<SelectionPoint[]>([]);
  const [selectionClosed, setSelectionClosed] = useState(false);
  const [selectionPreviewPoint, setSelectionPreviewPoint] = useState<SelectionPoint | null>(null);
  const [toolCursorPoint, setToolCursorPoint] = useState<SelectionPoint | null>(null);
  const [lassoMode, setLassoMode] = useState<LassoMode>("freehand");
  const [lassoSearchWidth, setLassoSearchWidth] = useState(10);
  const [lassoFrequency, setLassoFrequency] = useState(12);
  const [marqueeMode, setMarqueeMode] = useState<MarqueeMode>("rect");
  const [magicTolerance, setMagicTolerance] = useState(36);
  const [bucketTolerance, setBucketTolerance] = useState(28);
  const [cropStart, setCropStart] = useState<SelectionPoint | null>(null);
  const [cropEnd, setCropEnd] = useState<SelectionPoint | null>(null);
  const [fragmentDragStart, setFragmentDragStart] = useState<SelectionPoint | null>(null);
  const [fragmentDragOffset, setFragmentDragOffset] = useState<SelectionPoint | null>(null);
  const [fragmentTransformPreview, setFragmentTransformPreview] = useState<LayerTransformPreview | null>(null);
  const [dragLayerId, setDragLayerId] = useState<number | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [selectedLayerIds, setSelectedLayerIds] = useState<number[]>([]);
  const [editingLayerId, setEditingLayerId] = useState<number | null>(null);
  const [editingLayerName, setEditingLayerName] = useState("");
  const [mobilePanelOpen, setMobilePanelOpen] = useState<MobilePanel | null>(null);
  const [mobileFabPositions, setMobileFabPositions] = useState<Record<MobilePanel, SelectionPoint>>({
    tools: { x: 10, y: 148 },
    layers: { x: 10, y: 204 },
  });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const drawingRef = useRef(false);
  const draggingRef = useRef(false);
  const selectionPathRef = useRef<SelectionPoint[]>([]);
  const selectionClosedRef = useRef(false);
  const lassoModeRef = useRef<LassoMode>("freehand");
  const lassoSearchWidthRef = useRef(10);
  const lassoFrequencyRef = useRef(12);
  const marqueeModeRef = useRef<MarqueeMode>("rect");
  const marqueeDragRef = useRef<SelectionPoint | null>(null);
  const cropDragRef = useRef<SelectionPoint | null>(null);
  const magicToleranceRef = useRef(36);
  const bucketToleranceRef = useRef(28);
  const fragmentDragRef = useRef<LayerTransformDrag | null>(null);
  const draggedLayerIdRef = useRef<number | null>(null);
  const lastPanRef = useRef({ x: 0, y: 0 });
  const stopMousePanRef = useRef<(() => void) | null>(null);
  const toolRef = useRef<Tool>("move");
  const stateRef = useRef<DocumentState | null>(null);
  const docIdRef = useRef<number | null>(null);
  const activeLayerIdRef = useRef<number | null>(null);
  const selectedLayerIdsRef = useRef<number[]>([]);
  const mobileFabDragRef = useRef<MobileFabDrag | null>(null);

  // Мини-роутинг по хешу адреса нужен, чтобы вступление и редактор жили в одном SPA без React Router.
  useEffect(() => {
    const syncRouteFromHash = () => {
      setView(window.location.hash === "#editor" ? "editor" : "intro");
    };
    window.addEventListener("hashchange", syncRouteFromHash);
    return () => window.removeEventListener("hashchange", syncRouteFromHash);
  }, []);

  useEffect(() => {
    stateRef.current = state;
    docIdRef.current = docId;
    activeLayerIdRef.current = activeLayerId;
    selectedLayerIdsRef.current = selectedLayerIds;
  }, [state, docId, activeLayerId, selectedLayerIds]);

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  useEffect(() => {
    lassoModeRef.current = lassoMode;
    lassoSearchWidthRef.current = lassoSearchWidth;
    lassoFrequencyRef.current = lassoFrequency;
    marqueeModeRef.current = marqueeMode;
    magicToleranceRef.current = magicTolerance;
    bucketToleranceRef.current = bucketTolerance;
  }, [bucketTolerance, lassoFrequency, lassoMode, lassoSearchWidth, magicTolerance, marqueeMode]);

  const clampMobileFabPosition = useCallback((position: SelectionPoint) => {
    if (typeof window === "undefined") {
      return position;
    }
    const size = 48;
    const padding = 8;
    return {
      x: Math.min(Math.max(position.x, padding), Math.max(padding, window.innerWidth - size - padding)),
      y: Math.min(Math.max(position.y, padding), Math.max(padding, window.innerHeight - size - padding)),
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      setMobileFabPositions((current) => ({
        tools: clampMobileFabPosition(current.tools),
        layers: clampMobileFabPosition(current.layers),
      }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampMobileFabPosition]);

  // Плавающие мобильные кнопки можно перетаскивать, а короткое нажатие открывает нужную панель.
  const onMobileFabPointerDown = (panel: MobilePanel, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    mobileFabDragRef.current = {
      panel,
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: mobileFabPositions[panel],
      moved: false,
    };
  };

  const onMobileFabPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = mobileFabDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - drag.start.x;
    const deltaY = event.clientY - drag.start.y;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 5) {
      drag.moved = true;
    }
    const nextPosition = clampMobileFabPosition({
      x: drag.origin.x + deltaX,
      y: drag.origin.y + deltaY,
    });
    setMobileFabPositions((current) => ({
      ...current,
      [drag.panel]: nextPosition,
    }));
  };

  const finishMobileFabPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = mobileFabDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    mobileFabDragRef.current = null;
    if (!drag.moved) {
      setMobilePanelOpen((current) => current === drag.panel ? null : drag.panel);
    }
  };

  const selectTool = (nextTool: Tool) => {
    toolRef.current = nextTool;
    setTool(nextTool);
    setToolPopoverOpen(true);
    if (window.matchMedia("(max-width: 760px)").matches) {
      setMobilePanelOpen(null);
    }
    if (nextTool !== "scissors") {
      selectionPathRef.current = [];
      selectionClosedRef.current = false;
      setSelectionPath([]);
      setSelectionClosed(false);
      setSelectionPreviewPoint(null);
    }
    if (nextTool !== "fragment") {
      fragmentDragRef.current = null;
      setFragmentDragStart(null);
      setFragmentDragOffset(null);
      setFragmentTransformPreview(null);
    }
    if (nextTool !== "crop") {
      cropDragRef.current = null;
      setCropStart(null);
      setCropEnd(null);
    }
  };

  const openIntro = () => {
    window.location.hash = "";
    setView("intro");
  };

  const openEditor = () => {
    window.location.hash = "editor";
    setView("editor");
  };

  const selectLayer = (layerId: number) => {
    activeLayerIdRef.current = layerId;
    setActiveLayerId(layerId);
    selectedLayerIdsRef.current = [layerId];
    setSelectedLayerIds([layerId]);
  };

  const toggleLayerSelection = (layerId: number) => {
    const next = selectedLayerIdsRef.current.includes(layerId)
      ? selectedLayerIdsRef.current.filter((id) => id !== layerId)
      : [...selectedLayerIdsRef.current, layerId];
    const safeNext = next.length > 0 ? next : [layerId];
    activeLayerIdRef.current = layerId;
    selectedLayerIdsRef.current = safeNext;
    setActiveLayerId(layerId);
    setSelectedLayerIds(safeNext);
  };

  useEffect(() => () => {
    stopMousePanRef.current?.();
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }

    const onNativePointerDown = (event: PointerEvent) => {
      if (toolRef.current !== "move") {
        return;
      }
      if (!(event.target instanceof Node) || !stage.contains(event.target)) {
        return;
      }
      event.preventDefault();
      stage.setPointerCapture(event.pointerId);
      draggingRef.current = true;
      setIsPanning(true);
      lastPanRef.current = { x: event.clientX, y: event.clientY };
    };

    const onNativePointerMove = (event: PointerEvent) => {
      if (!draggingRef.current || toolRef.current !== "move") {
        return;
      }
      event.preventDefault();
      const dx = event.clientX - lastPanRef.current.x;
      const dy = event.clientY - lastPanRef.current.y;
      setPan((previous) => ({
        x: previous.x + dx,
        y: previous.y + dy,
      }));
      lastPanRef.current = { x: event.clientX, y: event.clientY };
    };

    const onNativePointerUp = (event: PointerEvent) => {
      if (stage.hasPointerCapture(event.pointerId)) {
        stage.releasePointerCapture(event.pointerId);
      }
      if (!draggingRef.current) {
        return;
      }
      draggingRef.current = false;
      setIsPanning(false);
    };

    const onNativeMouseDown = (event: MouseEvent) => {
      if ("PointerEvent" in window) {
        return;
      }
      if (toolRef.current !== "move") {
        return;
      }
      if (!(event.target instanceof Node) || !stage.contains(event.target)) {
        return;
      }
      event.preventDefault();
      draggingRef.current = true;
      setIsPanning(true);
      lastPanRef.current = { x: event.clientX, y: event.clientY };
    };

    const onNativeMouseMove = (event: MouseEvent) => {
      if (!draggingRef.current || toolRef.current !== "move") {
        return;
      }
      event.preventDefault();
      setPan((previous) => ({
        x: previous.x + event.clientX - lastPanRef.current.x,
        y: previous.y + event.clientY - lastPanRef.current.y,
      }));
      lastPanRef.current = { x: event.clientX, y: event.clientY };
    };

    const onNativeMouseUp = () => {
      if (!draggingRef.current) {
        return;
      }
      draggingRef.current = false;
      setIsPanning(false);
    };

    stage.addEventListener("pointerdown", onNativePointerDown);
    stage.addEventListener("mousedown", onNativeMouseDown);
    window.addEventListener("pointermove", onNativePointerMove);
    window.addEventListener("pointerup", onNativePointerUp);
    window.addEventListener("pointercancel", onNativePointerUp);
    window.addEventListener("mousemove", onNativeMouseMove);
    window.addEventListener("mouseup", onNativeMouseUp);
    return () => {
      stage.removeEventListener("pointerdown", onNativePointerDown);
      stage.removeEventListener("mousedown", onNativeMouseDown);
      window.removeEventListener("pointermove", onNativePointerMove);
      window.removeEventListener("pointerup", onNativePointerUp);
      window.removeEventListener("pointercancel", onNativePointerUp);
      window.removeEventListener("mousemove", onNativeMouseMove);
      window.removeEventListener("mouseup", onNativeMouseUp);
    };
  }, []);

  const activeLayer = useMemo<Layer | null>(() => {
    if (!state || activeLayerId == null) {
      return null;
    }
    return state.layers.find((layer) => layer.id === activeLayerId) ?? null;
  }, [state, activeLayerId]);

  const selectionPolyline = useMemo(
    () => selectionPath.map((point) => `${point.x},${point.y}`).join(" "),
    [selectionPath],
  );

  const selectionPreviewPolyline = useMemo(() => {
    const points = selectionPreviewPoint && !selectionClosed
      ? [...selectionPath, selectionPreviewPoint]
      : selectionPath;
    return points.map((point) => `${point.x},${point.y}`).join(" ");
  }, [selectionClosed, selectionPath, selectionPreviewPoint]);

  const cropPolyline = useMemo(() => {
    if (!cropStart || !cropEnd) {
      return "";
    }
    return pointsFromRect(cropStart, cropEnd).map((point) => `${point.x},${point.y}`).join(" ");
  }, [cropEnd, cropStart]);

  const toolCursorRadius = useMemo(() => {
    if (tool === "brush" || tool === "eraser") {
      return brushRadius;
    }
    if (tool === "pencil") {
      return 1;
    }
    if (tool === "scissors" && lassoMode === "magnetic") {
      return lassoSearchWidth;
    }
    return null;
  }, [brushRadius, lassoMode, lassoSearchWidth, tool]);

  const toolCursorLabel = useMemo(() => {
    if (toolCursorRadius == null) {
      return "";
    }
    if (tool === "scissors" && lassoMode === "magnetic") {
      return `${toolCursorRadius}px поиск`;
    }
    return `${toolCursorRadius}px`;
  }, [lassoMode, tool, toolCursorRadius]);

  const canEditRaster = activeLayer?.kind === "raster";
  const canModifyActiveLayer = Boolean(activeLayer && !activeLayer.locked);
  const canEditActivePixels = Boolean(activeLayer && !activeLayer.locked && !activeLayer.lockPixels);
  const canMoveActiveLayer = Boolean(activeLayer && !activeLayer.locked && !activeLayer.lockPosition);
  const activeLayerBounds = activeLayer?.kind === "raster" ? activeLayer.alphaBounds ?? null : null;
  const transformOverlayBounds = tool === "fragment" && canMoveActiveLayer
    ? fragmentTransformPreview?.bounds ?? activeLayerBounds
    : null;
  const transformOverlayPoints = transformOverlayBounds ? layerBoundsToPoints(transformOverlayBounds) : "";
  const transformHandleRadius = transformOverlayBounds
    ? Math.max(4, Math.min(10, Math.min(transformOverlayBounds.width, transformOverlayBounds.height) * 0.08))
    : 0;
  const hasSelection = selectionClosed && selectionPath.length >= 3;

  const refreshProjects = useCallback(async () => {
    const all = await listProjects();
    all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    setProjects(all);
    if (!selectedProjectId && all.length > 0) {
      setSelectedProjectId(all[0].id);
    }
  }, [selectedProjectId]);

  // Рендер берёт уже сведённые пиксели из WASM и кладёт их в canvas.
  const renderCanvas = useCallback(async (nextDocId: number, nextState: DocumentState) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const { pixels } = await engineProxy.renderRegion(
      nextDocId,
      0,
      0,
      nextState.width,
      nextState.height,
      1,
    );
    canvas.width = nextState.width;
    canvas.height = nextState.height;
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const imageData = new ImageData(
      Uint8ClampedArray.from(pixels),
      nextState.width,
      nextState.height,
    );
    context.putImageData(imageData, 0, 0);
  }, []);

  // После любой операции синхронизируем метаданные документа, активный слой и картинку на холсте.
  const refreshState = useCallback(
    async (targetDocId: number) => {
      const { state: nextState } = await engineProxy.getDocumentState(targetDocId);
      stateRef.current = nextState;
      const nextActiveLayerId = nextState.activeLayerId ?? nextState.layerOrder.at(-1) ?? null;
      activeLayerIdRef.current = nextActiveLayerId;
      selectedLayerIdsRef.current = nextActiveLayerId ? [nextActiveLayerId] : [];
      setState(nextState);
      setActiveLayerId(nextActiveLayerId);
      setSelectedLayerIds(nextActiveLayerId ? [nextActiveLayerId] : []);
      await renderCanvas(targetDocId, nextState);
      return nextState;
    },
    [renderCanvas],
  );

  // Создание документа сбрасывает сдвиг холста/размеры интерфейса и делает новый документ активным.
  const createDocument = useCallback(
    async (width = 1280, height = 720) => {
      const { docId: id } = await engineProxy.createDocument(width, height, "sRGB");
      docIdRef.current = id;
      setDocId(id);
      setPan({ x: 0, y: 0 });
      setResizeWidth(width);
      setResizeHeight(height);
      await refreshState(id);
      return id;
    },
    [refreshState],
  );

  // Единая точка для команд движку: инструменты, слои, маски, фильтры и трансформации.
  const applyOperation = useCallback(
    async (operation: Operation, refreshMeta = true) => {
      if (!docIdRef.current) {
        return;
      }
      try {
        setError(null);
        await engineProxy.applyOperation(docIdRef.current, operation);
        if (refreshMeta) {
          await refreshState(docIdRef.current);
        } else if (stateRef.current) {
          await renderCanvas(docIdRef.current, stateRef.current);
        }
      } catch (operationError) {
        setError(operationError instanceof Error ? operationError.message : String(operationError));
      }
    },
    [renderCanvas, refreshState],
  );

  useEffect(() => {
    // WASM и IndexedDB-проекты поднимаются один раз при загрузке приложения.
    (async () => {
      try {
        await engineProxy.init();
        await refreshProjects();
        await createDocument();
        setReady(true);
      } catch (initError) {
        setError(initError instanceof Error ? initError.message : String(initError));
      }
    })();
  }, [createDocument, refreshProjects]);

  const onImportImage = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const files = Array.from(input.files ?? []);
      try {
        setError(null);
        if (files.length === 0) {
          return;
        }
        setIsImporting(true);

        const prepared: Array<{
          file: File;
          bytes: Uint8Array;
          format: ImportFormat;
          width: number;
          height: number;
          name: string;
        }> = [];
        const failedFiles: string[] = [];

        // Сначала декодируем все файлы, чтобы одним импортом корректно расширить холст под самый большой.
        for (const file of files) {
          try {
            prepared.push({
              file,
              ...(await prepareImageImport(file)),
              name: getLayerNameFromFile(file),
            });
          } catch {
            failedFiles.push(file.name);
          }
        }

        if (prepared.length === 0) {
          throw new Error("Не удалось импортировать выбранные изображения.");
        }

        const currentDocId = docIdRef.current;
        const shouldCreateDocument =
          !currentDocId ||
          !stateRef.current ||
          stateRef.current.layerOrder.length === 0;
        const documentWidth = Math.max(...prepared.map((item) => item.width));
        const documentHeight = Math.max(...prepared.map((item) => item.height));
        const id = shouldCreateDocument
          ? await createDocument(documentWidth, documentHeight)
          : currentDocId;

        // Если Rust-движок не понял исходный формат, браузер растрирует его в PNG и пробует ещё раз.
        for (const imported of prepared) {
          try {
            await engineProxy.loadImage(id, imported.bytes, imported.format, imported.name);
          } catch (loadError) {
            const fallbackBytes = await rasterizeFileToPngBytes(imported.file);
            try {
              await engineProxy.loadImage(id, fallbackBytes, "png", imported.name);
            } catch (fallbackError) {
              failedFiles.push(imported.file.name);
              console.error(loadError, fallbackError);
            }
          }
        }
        await refreshState(id);
        if (failedFiles.length > 0) {
          setError(`Не удалось импортировать: ${failedFiles.join(", ")}`);
        }
      } catch (importError) {
        setError(importError instanceof Error ? importError.message : String(importError));
      } finally {
        setIsImporting(false);
        input.value = "";
      }
    },
    [createDocument, refreshState],
  );

  const onExport = useCallback(async () => {
    if (!docId || !state) {
      return;
    }
    const { bytes } = await engineProxy.exportDocument(docId, exportFormat, 0.92);
    const mime =
      exportFormat === "png"
        ? "image/png"
        : exportFormat === "jpeg"
          ? "image/jpeg"
          : "image/webp";
    downloadBytes(bytes, `изображение-${Date.now()}.${exportFormat}`, mime);
  }, [docId, exportFormat, state]);

  const onUndo = useCallback(async () => {
    if (!docId) {
      return;
    }
    await engineProxy.undo(docId);
    await refreshState(docId);
  }, [docId, refreshState]);

  const onRedo = useCallback(async () => {
    if (!docId) {
      return;
    }
    await engineProxy.redo(docId);
    await refreshState(docId);
  }, [docId, refreshState]);

  const closeSelection = useCallback(() => {
    const points = simplifySelectionPath(selectionPathRef.current);
    if (points.length < 3) {
      return;
    }
    selectionPathRef.current = points;
    selectionClosedRef.current = true;
    setSelectionPath(points);
    setSelectionClosed(true);
    setSelectionPreviewPoint(null);
  }, []);

  const clearSelection = useCallback(() => {
    selectionPathRef.current = [];
    selectionClosedRef.current = false;
    setSelectionPath([]);
    setSelectionClosed(false);
    setSelectionPreviewPoint(null);
  }, []);

  const moveSelection = useCallback((dx: number, dy: number) => {
    if (selectionPathRef.current.length === 0) {
      return;
    }
    const shifted = shiftSelectionPath(selectionPathRef.current, dx, dy);
    selectionPathRef.current = shifted;
    setSelectionPath(shifted);
  }, []);

  const applySelection = useCallback(
    async (action: SelectionAction, refine = false) => {
      const currentActiveLayerId = activeLayerIdRef.current;
      const points = simplifySelectionPath(selectionPathRef.current);
      if (!currentActiveLayerId || points.length < 3 || !selectionClosedRef.current) {
        setError("Сначала замкните выделение лассо.");
        return;
      }

      const base = {
        layer_id: currentActiveLayerId,
        points,
        refine,
      };

      if (action === "copy") {
        await applyOperation({
          type: "copy_selection_to_new_layer",
          ...base,
          name: "Скопированный фрагмент",
        });
        return;
      }

      if (action === "cut") {
        await applyOperation({
          type: "cut_selection_to_new_layer",
          ...base,
          name: "Вырезанный фрагмент",
        });
        return;
      }

      await applyOperation({
        type: "delete_selection",
        ...base,
      });
    },
    [applyOperation],
  );

  const applyMaskFromSelection = useCallback(
    async (invert = false, refine = false) => {
      const currentActiveLayerId = activeLayerIdRef.current;
      const points = simplifySelectionPath(selectionPathRef.current);
      if (!currentActiveLayerId || points.length < 3 || !selectionClosedRef.current) {
        setError("Сначала замкните выделение лассо.");
        return;
      }

      await applyOperation({
        type: "set_layer_mask_from_selection",
        layer_id: currentActiveLayerId,
        points,
        refine,
        invert,
      });
    },
    [applyOperation],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (event.key === "Escape") {
        setToolPopoverOpen(false);
        return;
      }

      if (!event.ctrlKey && !event.altKey && !event.metaKey) {
        const key = event.key.toLowerCase();
        const shortcutTool: Partial<Record<string, Tool>> = {
          h: "move",
          v: "fragment",
          b: "brush",
          e: "eraser",
          l: "scissors",
          m: "marquee",
          w: "magic",
          c: "crop",
          i: "eyedropper",
          g: "bucket",
          z: "zoom",
        };
        const nextTool = shortcutTool[key];
        if (nextTool) {
          event.preventDefault();
          selectTool(nextTool);
          return;
        }
        if (key === "x") {
          event.preventDefault();
          setBrushColor((previous) => (previous === "#000000" ? "#ffffff" : "#000000"));
          return;
        }
      }

      if (event.ctrlKey && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        setZoom((previous) => Math.min(3, previous + 0.1));
        return;
      }
      if (event.ctrlKey && event.key === "-") {
        event.preventDefault();
        setZoom((previous) => Math.max(0.25, previous - 0.1));
        return;
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void applyOperation({ type: "add_empty_layer", name: "Новый слой" });
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        if (selectionClosedRef.current) {
          void applySelection("copy");
        } else if (activeLayerIdRef.current) {
          void applyOperation({ type: "duplicate_layer", layer_id: activeLayerIdRef.current });
        }
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "x") {
        event.preventDefault();
        void applySelection("cut");
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectionClosedRef.current) {
          event.preventDefault();
          void applySelection("delete");
        } else if (activeLayerIdRef.current) {
          event.preventDefault();
          void applyOperation({ type: "delete_layer", layer_id: activeLayerIdRef.current });
        }
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        if (event.shiftKey) {
          const group = stateRef.current?.groups.find((item) =>
            activeLayerIdRef.current ? item.layerIds.includes(activeLayerIdRef.current) : false,
          );
          if (group) {
            void applyOperation({ type: "ungroup", group_id: group.id });
          }
        } else {
          const layerIds = selectedLayerIdsRef.current.length > 0
            ? selectedLayerIdsRef.current
            : activeLayerIdRef.current
              ? [activeLayerIdRef.current]
              : [];
          if (layerIds.length > 0) {
            void applyOperation({ type: "create_group_from_layers", layer_ids: layerIds, name: "Группа слоев" });
          }
        }
        return;
      }
      if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        const layerId = activeLayerIdRef.current;
        const order = stateRef.current?.layerOrder ?? [];
        const index = layerId ? order.indexOf(layerId) : -1;
        const clippedTo = index > 0 ? order[index - 1] : null;
        if (layerId) {
          void applyOperation({ type: "set_clipping_mask", layer_id: layerId, clipped_to_layer_id: clippedTo });
        }
        return;
      }
      if (!selectionClosedRef.current) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveSelection(-1, 0);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        moveSelection(1, 0);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(0, -1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(0, 1);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyOperation, applySelection, moveSelection]);

  const clientToDoc = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return { x: 0, y: 0 };
    }
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) * canvas.width) / rect.width,
      y: ((clientY - rect.top) * canvas.height) / rect.height,
    };
  }, []);

  const updateToolCursor = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const currentTool = toolRef.current;
    const showCursor =
      currentTool === "brush" ||
      currentTool === "pencil" ||
      currentTool === "eraser" ||
      (currentTool === "scissors" && lassoModeRef.current === "magnetic");
    setToolCursorPoint(showCursor ? clientToDoc(event.clientX, event.clientY) : null);
  }, [clientToDoc]);

  const setSelectionFromPoints = useCallback((points: SelectionPoint[]) => {
    const safePoints = simplifySelectionPath(points);
    if (safePoints.length < 3) {
      return;
    }
    selectionPathRef.current = safePoints;
    selectionClosedRef.current = true;
    setSelectionPath(safePoints);
    setSelectionClosed(true);
    setSelectionPreviewPoint(null);
  }, []);

  const sampleColorAt = useCallback((point: SelectionPoint) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) {
      return;
    }
    const x = Math.min(Math.max(Math.round(point.x), 0), canvas.width - 1);
    const y = Math.min(Math.max(Math.round(point.y), 0), canvas.height - 1);
    const data = context.getImageData(x, y, 1, 1).data;
    setBrushColor(getHexFromRgba(data));
  }, []);

  const applyCropRect = useCallback(async () => {
    if (!cropStart || !cropEnd) {
      return;
    }
    const x = Math.floor(Math.min(cropStart.x, cropEnd.x));
    const y = Math.floor(Math.min(cropStart.y, cropEnd.y));
    const width = Math.max(1, Math.round(Math.abs(cropEnd.x - cropStart.x)));
    const height = Math.max(1, Math.round(Math.abs(cropEnd.y - cropStart.y)));
    await applyOperation({ type: "crop", x, y, width, height });
    cropDragRef.current = null;
    setCropStart(null);
    setCropEnd(null);
  }, [applyOperation, cropEnd, cropStart]);

  const onStageMouseDown = (event: ReactMouseEvent<HTMLElement>) => {
    if (toolRef.current !== "move") {
      return;
    }
    event.preventDefault();
    stopMousePanRef.current?.();
    draggingRef.current = true;
    setIsPanning(true);
    lastPanRef.current = { x: event.clientX, y: event.clientY };

    const onMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      const dx = moveEvent.clientX - lastPanRef.current.x;
      const dy = moveEvent.clientY - lastPanRef.current.y;
      setPan((previous) => ({
        x: previous.x + dx,
        y: previous.y + dy,
      }));
      lastPanRef.current = { x: moveEvent.clientX, y: moveEvent.clientY };
    };

    const onUp = () => {
      draggingRef.current = false;
      setIsPanning(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      stopMousePanRef.current = null;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    stopMousePanRef.current = onUp;
  };

  const onPointerDown = async (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!state || !docId) {
      return;
    }
    updateToolCursor(event);
    const currentTool = toolRef.current;
    if (currentTool === "move") {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const currentActiveLayerId = activeLayerIdRef.current;
    const currentState = stateRef.current ?? state;
    const currentActiveLayer =
      currentState?.layers.find((layer) => layer.id === currentActiveLayerId) ?? null;
    if (!currentActiveLayerId) {
      return;
    }
    const point = clientToDoc(event.clientX, event.clientY);
    if (currentTool === "zoom") {
      setZoom((previous) => event.altKey ? Math.max(0.25, previous - 0.2) : Math.min(3, previous + 0.2));
      return;
    }
    if (currentTool === "eyedropper") {
      sampleColorAt(point);
      return;
    }
    if (currentTool === "marquee") {
      marqueeDragRef.current = point;
      selectionClosedRef.current = false;
      setSelectionClosed(false);
      setSelectionPath([]);
      selectionPathRef.current = [];
      return;
    }
    if (currentTool === "magic") {
      const bounds = magicWandBounds(canvasRef.current, point, magicToleranceRef.current);
      if (bounds) {
        setSelectionFromPoints(pointsFromRect(
          { x: bounds.minX, y: bounds.minY },
          { x: bounds.maxX, y: bounds.maxY },
        ));
      }
      return;
    }
    if (currentTool === "crop") {
      cropDragRef.current = point;
      setCropStart(point);
      setCropEnd(point);
      return;
    }
    if (currentTool === "bucket") {
      if (currentActiveLayer?.kind !== "raster") {
        setError("Заливка работает только с растровым слоем.");
        return;
      }
      await applyOperation({
        type: "flood_fill",
        layer_id: currentActiveLayerId,
        x: point.x,
        y: point.y,
        color: hexToRgba(brushColor),
        tolerance: bucketToleranceRef.current,
        contiguous: true,
      });
      return;
    }
    if (currentTool === "scissors") {
      if (currentActiveLayer?.kind !== "raster") {
        setError("Ножницы работают только с растровым слоем.");
        return;
      }
      setError(null);
      const currentLassoMode = lassoModeRef.current;
      if (currentLassoMode === "polygonal") {
        const existing = selectionPathRef.current;
        if (existing.length >= 3 && distanceBetweenPoints(existing[0], point) <= Math.max(6, lassoSearchWidthRef.current)) {
          closeSelection();
          return;
        }
        const nextPath = selectionClosedRef.current ? [point] : [...existing, point];
        selectionPathRef.current = nextPath;
        selectionClosedRef.current = false;
        setSelectionClosed(false);
        setSelectionPath(nextPath);
        setSelectionPreviewPoint(point);
        if (event.detail >= 2) {
          closeSelection();
        }
        return;
      }

      const startPoint = currentLassoMode === "magnetic"
        ? findMagneticEdgePoint(canvasRef.current, point, lassoSearchWidthRef.current)
        : point;
      selectionClosedRef.current = false;
      selectionPathRef.current = [startPoint];
      setSelectionClosed(false);
      setSelectionPath([startPoint]);
      setSelectionPreviewPoint(null);
      return;
    }
    if (currentTool === "fragment") {
      if (currentActiveLayer?.kind !== "raster") {
        setError("Перетаскивать можно только растровый слой или вырезанный фрагмент.");
        return;
      }
      if (currentActiveLayer.lockPosition) {
        setError("Позиция слоя заблокирована.");
        return;
      }
      const bounds = currentActiveLayer.alphaBounds ?? {
        x: 0,
        y: 0,
        width: currentState.width,
        height: currentState.height,
      };
      const handlePoint = { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
      const handleRadius = Math.max(8, Math.min(18, Math.min(bounds.width, bounds.height) * 0.18));
      const mode: LayerTransformMode = distanceBetweenPoints(point, handlePoint) <= handleRadius ? "scale" : "move";
      if (mode === "move" && !pointInsideBounds(point, bounds)) {
        setError("Кликните по фотографии или потяните за угол рамки трансформации.");
        return;
      }
      fragmentDragRef.current = { layerId: currentActiveLayerId, start: point, mode, bounds };
      setFragmentDragStart(point);
      setFragmentDragOffset({ x: 0, y: 0 });
      setFragmentTransformPreview({ mode, bounds });
      return;
    }
    drawingRef.current = true;
    await applyOperation(
      {
        type: "brush",
        layer_id: currentActiveLayerId,
        x: point.x,
        y: point.y,
        radius: brushRadius,
        ...(currentTool === "pencil" ? { radius: 1, strength: 1 } : {}),
        color: hexToRgba(brushColor),
        strength: currentTool === "pencil" ? 1 : brushStrength,
        erase: currentTool === "eraser",
      },
      false,
    );
  };

  const onPointerMove = async (event: ReactPointerEvent<HTMLCanvasElement>) => {
    updateToolCursor(event);
    const currentTool = toolRef.current;
    if (currentTool === "move") {
      return;
    }
    if (marqueeDragRef.current && currentTool === "marquee") {
      const point = clientToDoc(event.clientX, event.clientY);
      const start = marqueeDragRef.current;
      const mode = marqueeModeRef.current;
      const points = mode === "ellipse"
        ? pointsFromEllipse(start, point)
        : mode === "row"
          ? pointsFromRect({ x: 0, y: start.y }, { x: stateRef.current?.width ?? point.x, y: start.y + 1 })
          : mode === "column"
            ? pointsFromRect({ x: start.x, y: 0 }, { x: start.x + 1, y: stateRef.current?.height ?? point.y })
            : pointsFromRect(start, point);
      selectionPathRef.current = points;
      setSelectionPath(points);
      setSelectionClosed(false);
      setSelectionPreviewPoint(null);
      return;
    }
    if (cropDragRef.current && currentTool === "crop") {
      setCropEnd(clientToDoc(event.clientX, event.clientY));
      return;
    }
    if (fragmentDragRef.current && currentTool === "fragment") {
      const point = clientToDoc(event.clientX, event.clientY);
      const drag = fragmentDragRef.current;
      if (drag.mode === "scale") {
        setFragmentTransformPreview({
          mode: "scale",
          bounds: scaleBoundsFromCorner(drag.bounds, point),
        });
        return;
      }
      const offset = {
        x: point.x - drag.start.x,
        y: point.y - drag.start.y,
      };
      setFragmentDragOffset({
        x: offset.x,
        y: offset.y,
      });
      setFragmentTransformPreview({
        mode: "move",
        bounds: {
          ...drag.bounds,
          x: drag.bounds.x + offset.x,
          y: drag.bounds.y + offset.y,
        },
      });
      return;
    }
    if (currentTool === "scissors") {
      const point = clientToDoc(event.clientX, event.clientY);
      if (lassoModeRef.current === "polygonal") {
        if (!selectionClosedRef.current && selectionPathRef.current.length > 0) {
          setSelectionPreviewPoint(point);
        }
        return;
      }
      if (selectionPathRef.current.length === 0 || selectionClosedRef.current) {
        return;
      }
      const nextPoint = lassoModeRef.current === "magnetic"
        ? findMagneticEdgePoint(canvasRef.current, point, lassoSearchWidthRef.current)
        : point;
      const previous = selectionPathRef.current[selectionPathRef.current.length - 1];
      const minDistance = lassoModeRef.current === "magnetic"
        ? Math.max(1.5, 28 / lassoFrequencyRef.current)
        : 1.5;
      if (distanceBetweenPoints(previous, nextPoint) >= minDistance) {
        selectionPathRef.current = [...selectionPathRef.current, nextPoint];
        setSelectionPath(selectionPathRef.current);
      }
      return;
    }
    const currentActiveLayerId = activeLayerIdRef.current;
    if (!drawingRef.current || !currentActiveLayerId) {
      return;
    }
    const point = clientToDoc(event.clientX, event.clientY);
    await applyOperation(
      {
        type: "brush",
        layer_id: currentActiveLayerId,
        x: point.x,
        y: point.y,
        radius: currentTool === "pencil" ? 1 : brushRadius,
        color: hexToRgba(brushColor),
        strength: currentTool === "pencil" ? 1 : brushStrength,
        erase: currentTool === "eraser",
      },
      false,
    );
  };

  const onPointerUp = async (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (marqueeDragRef.current) {
      const point = clientToDoc(event.clientX, event.clientY);
      const start = marqueeDragRef.current;
      const mode = marqueeModeRef.current;
      const points = mode === "ellipse"
        ? pointsFromEllipse(start, point)
        : mode === "row"
          ? pointsFromRect({ x: 0, y: start.y }, { x: stateRef.current?.width ?? point.x, y: start.y + 1 })
          : mode === "column"
            ? pointsFromRect({ x: start.x, y: 0 }, { x: start.x + 1, y: stateRef.current?.height ?? point.y })
            : pointsFromRect(start, point);
      marqueeDragRef.current = null;
      setSelectionFromPoints(points);
      drawingRef.current = false;
      return;
    }
    if (cropDragRef.current) {
      setCropEnd(clientToDoc(event.clientX, event.clientY));
      cropDragRef.current = null;
      drawingRef.current = false;
      return;
    }
    if (fragmentDragRef.current) {
      const drag = fragmentDragRef.current;
      const point = clientToDoc(event.clientX, event.clientY);
      const translateX = Math.round(point.x - drag.start.x);
      const translateY = Math.round(point.y - drag.start.y);
      const preview = fragmentTransformPreview;
      fragmentDragRef.current = null;
      setFragmentDragStart(null);
      setFragmentDragOffset(null);
      setFragmentTransformPreview(null);
      if (drag.mode === "scale") {
        const scale = preview ? preview.bounds.width / Math.max(1, drag.bounds.width) : 1;
        if (Math.abs(scale - 1) >= 0.01) {
          await applyOperation({
            type: "transform_layer",
            layer_id: drag.layerId,
            scale_x: scale,
            scale_y: scale,
          });
        }
      } else if (Math.abs(translateX) >= 1 || Math.abs(translateY) >= 1) {
        await applyOperation({
          type: "transform_layer",
          layer_id: drag.layerId,
          translate_x: translateX,
          translate_y: translateY,
        });
      }
      drawingRef.current = false;
      return;
    }
    const currentActiveLayerId = activeLayerIdRef.current;
    if (selectionPathRef.current.length > 0 && currentActiveLayerId) {
      if (toolRef.current === "scissors" && lassoModeRef.current !== "polygonal") {
        closeSelection();
      }
    }
    drawingRef.current = false;
  };

  const saveCurrentProject = useCallback(async () => {
    if (!docId || !state) {
      return;
    }
    const { bytes } = await engineProxy.exportDocument(docId, "png", 1);
    await saveProject({
      name: `Проект ${new Date().toLocaleString("ru-RU")}`,
      width: state.width,
      height: state.height,
      state,
      flattenedPng: Uint8Array.from(bytes).buffer,
    });
    await refreshProjects();
  }, [docId, refreshProjects, state]);

  const loadSelectedProject = useCallback(async () => {
    if (!selectedProjectId) {
      return;
    }
    const project = await loadProject(selectedProjectId);
    if (!project) {
      return;
    }
    const bytes = new Uint8Array(project.flattenedPng);
    const blob = new Blob([bytes], { type: "image/png" });
    const bitmap = await createImageBitmap(blob);
    const id = await createDocument(bitmap.width, bitmap.height);
    await engineProxy.loadImage(id, bytes, "png", project.name);
    await refreshState(id);
  }, [createDocument, refreshState, selectedProjectId]);

  const onLayerDragStart = (event: ReactDragEvent<HTMLElement>, layerId: number) => {
    draggedLayerIdRef.current = layerId;
    setDragLayerId(layerId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(layerId));
  };

  const onLayerDrop = async (event: ReactDragEvent<HTMLElement>, targetLayerId: number) => {
    event.preventDefault();
    const sourceLayerId = draggedLayerIdRef.current ?? Number(event.dataTransfer.getData("text/plain"));
    draggedLayerIdRef.current = null;
    setDragLayerId(null);
    if (!state || !Number.isFinite(sourceLayerId) || sourceLayerId === targetLayerId) {
      return;
    }
    const sourceIndex = state.layerOrder.indexOf(sourceLayerId);
    const targetIndex = state.layerOrder.indexOf(targetLayerId);
    if (sourceIndex < 0 || targetIndex < 0) {
      return;
    }
    await applyOperation({
      type: "reorder_layer",
      layer_id: sourceLayerId,
      to_index: targetIndex,
    });
  };

  const onLayerDragEnd = () => {
    draggedLayerIdRef.current = null;
    setDragLayerId(null);
  };

  const getDroppedLayerId = (event: ReactDragEvent<HTMLElement>) => {
    const fallback = Number(event.dataTransfer.getData("text/plain"));
    return draggedLayerIdRef.current ?? (Number.isFinite(fallback) ? fallback : null);
  };

  const finishLayerDrop = () => {
    draggedLayerIdRef.current = null;
    setDragLayerId(null);
  };

  const onLayerDockDrop = async (event: ReactDragEvent<HTMLElement>, action: "duplicate" | "delete") => {
    event.preventDefault();
    const layerId = getDroppedLayerId(event);
    finishLayerDrop();
    if (!layerId || !state?.layers.some((layer) => layer.id === layerId)) {
      return;
    }
    const layer = state.layers.find((item) => item.id === layerId);
    if (action === "delete" && layer?.locked) {
      setError("Заблокированный слой нельзя удалить.");
      return;
    }
    await applyOperation(
      action === "duplicate"
        ? { type: "duplicate_layer", layer_id: layerId }
        : { type: "delete_layer", layer_id: layerId },
    );
  };

  const createLayer = useCallback(() => {
    void applyOperation({ type: "add_empty_layer", name: "Новый слой" });
  }, [applyOperation]);

  const deleteActiveLayer = useCallback(() => {
    const layerId = activeLayerIdRef.current;
    if (!layerId) {
      return;
    }
    const layer = stateRef.current?.layers.find((item) => item.id === layerId);
    if (layer?.locked) {
      setError("Заблокированный слой нельзя удалить.");
      return;
    }
    void applyOperation({ type: "delete_layer", layer_id: layerId });
  }, [applyOperation]);

  const duplicateActiveLayer = useCallback(() => {
    const layerId = activeLayerIdRef.current;
    if (!layerId) {
      return;
    }
    void applyOperation({ type: "duplicate_layer", layer_id: layerId });
  }, [applyOperation]);

  const groupSelectedLayers = useCallback(() => {
    const layerIds = selectedLayerIdsRef.current.length > 0
      ? selectedLayerIdsRef.current
      : activeLayerIdRef.current
        ? [activeLayerIdRef.current]
        : [];
    if (layerIds.length === 0) {
      return;
    }
    void applyOperation({
      type: "create_group_from_layers",
      layer_ids: layerIds,
      name: layerIds.length > 1 ? "Группа слоев" : "Группа",
    });
  }, [applyOperation]);

  const commitLayerRename = useCallback(() => {
    if (!editingLayerId) {
      return;
    }
    const name = editingLayerName.trim();
    if (name) {
      void applyOperation({ type: "rename_layer", layer_id: editingLayerId, name });
    }
    setEditingLayerId(null);
    setEditingLayerName("");
  }, [applyOperation, editingLayerId, editingLayerName]);

  const selectedLayerIndex = useMemo(() => {
    if (!state || activeLayerId == null) {
      return -1;
    }
    return state.layerOrder.indexOf(activeLayerId);
  }, [activeLayerId, state]);
  const ActiveToolIcon = TOOL_ICONS[tool];

  if (view === "intro") {
    return (
      <div className="intro-page">
        <header className="intro-nav">
          <div className="brand">Фотолаборатория WASM</div>
          <button className="intro-nav-action" onClick={openEditor}>
            Открыть редактор
            <ArrowRight size={16} strokeWidth={1.8} />
          </button>
        </header>

        <main className="intro-main">
          <section className="intro-hero">
            <div className="intro-copy">
              <span className="intro-kicker">
                <Sparkles size={16} strokeWidth={1.8} />
                WebAssembly-редактор изображений
              </span>
              <h1>Редактор изображений с инструментами, слоями и масками прямо в браузере.</h1>
              <p>
                Проект объединяет React-интерфейс, Rust/WASM-движок обработки пикселей,
                Photoshop-подобные слои, ножницы, маски, импорт нескольких изображений и
                экспорт результата.
              </p>
              <div className="intro-actions">
                <button className="primary" onClick={openEditor}>
                  Начать работу
                  <ArrowRight size={18} strokeWidth={1.8} />
                </button>
                <a href="#docs" className="secondary">Что внутри</a>
              </div>
            </div>

            <div className="intro-product-preview" aria-label="Превью интерфейса редактора">
              <div className="preview-toolbar">
                <span />
                <span />
                <span />
                <strong>WASM Photo Lab</strong>
              </div>
              <div className="preview-layout">
                <div className="preview-tools">
                  {[Move, Scissors, Brush, Eraser, PaintBucket, Layers].map((Icon, index) => (
                    <span key={index}>
                      <Icon size={17} strokeWidth={1.8} />
                    </span>
                  ))}
                </div>
                <div className="preview-canvas">
                  <div className="preview-art">
                    <span className="preview-cut" />
                  </div>
                </div>
                <div className="preview-layers">
                  <b>Слои</b>
                  <span>Объект с маской</span>
                  <span>Фото 02</span>
                  <span>Фон</span>
                </div>
              </div>
            </div>
          </section>

          <section id="docs" className="intro-feature-grid">
            <article>
              <h2>Слои</h2>
              <p>Порядок, видимость, блокировки, opacity/fill, blend modes, маски и clipping.</p>
            </article>
            <article>
              <h2>Инструменты</h2>
              <p>Кисть, ластик, выделения, ножницы, заливка, пипетка, crop и трансформация фрагментов.</p>
            </article>
            <article>
              <h2>WASM-движок</h2>
              <p>Пиксельные операции выполняются в Rust и не блокируют интерфейс благодаря Web Worker.</p>
            </article>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand brand-button" onClick={openIntro}>Фотолаборатория WASM</button>
        <div className="controls">
          <button onClick={() => createDocument(1280, 720)} disabled={!ready}>Новый 1280x720</button>
          <label className={ready && !isImporting ? "file-input-button" : "file-input-button disabled"}>
            {isImporting ? "Импорт..." : "Импорт"}
            <input type="file" accept="image/*" multiple onChange={onImportImage} disabled={!ready || isImporting} />
          </label>
          <button onClick={onUndo} disabled={!docId}>Отменить</button>
          <button onClick={onRedo} disabled={!docId}>Повторить</button>
          <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value as ExportFormat)}>
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option>
          </select>
          <button onClick={onExport} disabled={!docId}>Экспорт</button>
          <button onClick={saveCurrentProject} disabled={!docId}>Сохранить локально</button>
        </div>
      </header>

      {error && <div className="error-strip">{error}</div>}
      {mobilePanelOpen && (
        <button
          className="mobile-panel-backdrop"
          type="button"
          aria-label="Закрыть мобильную панель"
          onClick={() => setMobilePanelOpen(null)}
        />
      )}
      <div className="mobile-panel-fabs" aria-label="Мобильные панели">
        <button
          className={mobilePanelOpen === "tools" ? "mobile-panel-fab active" : "mobile-panel-fab"}
          type="button"
          style={{ left: mobileFabPositions.tools.x, top: mobileFabPositions.tools.y }}
          onPointerDown={(event) => onMobileFabPointerDown("tools", event)}
          onPointerMove={onMobileFabPointerMove}
          onPointerUp={finishMobileFabPointer}
          onPointerCancel={finishMobileFabPointer}
          aria-label="Инструменты"
          title="Инструменты"
        >
          <ActiveToolIcon size={22} strokeWidth={1.9} />
        </button>
        <button
          className={mobilePanelOpen === "layers" ? "mobile-panel-fab active" : "mobile-panel-fab"}
          type="button"
          style={{ left: mobileFabPositions.layers.x, top: mobileFabPositions.layers.y }}
          onPointerDown={(event) => onMobileFabPointerDown("layers", event)}
          onPointerMove={onMobileFabPointerMove}
          onPointerUp={finishMobileFabPointer}
          onPointerCancel={finishMobileFabPointer}
          aria-label="Слои"
          title="Слои"
        >
          <Layers size={22} strokeWidth={1.9} />
        </button>
      </div>

      <main className="workspace">
        <aside className={mobilePanelOpen === "tools" ? "sidebar left mobile-panel is-mobile-open" : "sidebar left mobile-panel"}>
          <h3>Инструменты</h3>
          <div className="toolbox-wrap">
            <div className="tool-grid" aria-label="Панель инструментов">
              {(["move", "fragment", "marquee", "scissors", "magic", "crop", "eyedropper", "zoom", "brush", "pencil", "eraser", "bucket"] as Tool[]).map((item) => {
                const ToolIcon = TOOL_ICONS[item];
                return (
                  <button
                    key={item}
                    className={item === tool ? "active" : ""}
                    onClick={() => selectTool(item)}
                    aria-label={TOOL_LABELS[item]}
                    title={TOOL_LABELS[item]}
                  >
                    <span className="tool-icon" aria-hidden="true">
                      <ToolIcon size={19} strokeWidth={1.8} />
                    </span>
                    <span className="sr-only">{TOOL_LABELS[item]}</span>
                  </button>
                );
              })}
            </div>
            <div className={toolPopoverOpen ? "tool-popover is-open" : "tool-popover"} aria-hidden={!toolPopoverOpen}>
              <div className="tool-popover-title">
                <span className="tool-popover-icon">
                  <ActiveToolIcon size={20} strokeWidth={1.8} />
                </span>
                <span>
                  <strong>{TOOL_LABELS[tool]}</strong>
                  <small>{TOOL_HINTS[tool]}</small>
                </span>
                <button
                  className="tool-popover-close"
                  onClick={() => setToolPopoverOpen(false)}
                  aria-label="Закрыть настройки инструмента"
                  title="Готово"
                >
                  Готово
                </button>
              </div>
              {tool === "marquee" && (
                <div className="tool-options">
                  <div className="segmented-control">
                    {(["rect", "ellipse", "row", "column"] as MarqueeMode[]).map((mode) => (
                      <button
                        key={mode}
                        className={mode === marqueeMode ? "active" : ""}
                        onClick={() => {
                          marqueeModeRef.current = mode;
                          setMarqueeMode(mode);
                        }}
                      >
                        {MARQUEE_MODE_LABELS[mode]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {tool === "scissors" && (
                <div className="lasso-panel">
                  <div className="segmented-control">
                    {(["freehand", "polygonal", "magnetic"] as LassoMode[]).map((mode) => (
                      <button
                        key={mode}
                        className={mode === lassoMode ? "active" : ""}
                        onClick={() => {
                          lassoModeRef.current = mode;
                          setLassoMode(mode);
                          clearSelection();
                        }}
                      >
                        {LASSO_MODE_LABELS[mode]}
                      </button>
                    ))}
                  </div>
                  {lassoMode === "magnetic" && (
                    <>
                      <label>Ширина поиска {lassoSearchWidth}px</label>
                      <input
                        type="range"
                        min={2}
                        max={32}
                        step={1}
                        value={lassoSearchWidth}
                        onChange={(event) => setLassoSearchWidth(Number(event.target.value))}
                      />
                      <label>Частота точек {lassoFrequency}</label>
                      <input
                        type="range"
                        min={4}
                        max={28}
                        step={1}
                        value={lassoFrequency}
                        onChange={(event) => setLassoFrequency(Number(event.target.value))}
                      />
                    </>
                  )}
                  <div className="selection-actions">
                    <button disabled={selectionPath.length < 3 || selectionClosed} onClick={closeSelection}>Замкнуть</button>
                    <button disabled={!hasSelection} onClick={() => applySelection("copy")}>Скопировать в слой</button>
                    <button disabled={!hasSelection} onClick={() => applySelection("cut")}>Вырезать в слой</button>
                    <button disabled={!hasSelection} onClick={() => applySelection("delete")}>Удалить</button>
                    <button disabled={!hasSelection} onClick={() => applySelection("copy", true)}>Копировать объект</button>
                    <button disabled={!hasSelection} onClick={() => applySelection("cut", true)}>Вырезать объект</button>
                    <button disabled={selectionPath.length === 0} onClick={clearSelection}>Сбросить</button>
                  </div>
                </div>
              )}
              {tool === "magic" && (
                <div className="tool-options">
                  <label>Допуск {magicTolerance}</label>
                  <input type="range" min={0} max={160} step={1} value={magicTolerance} onChange={(event) => setMagicTolerance(Number(event.target.value))} />
                </div>
              )}
              {tool === "bucket" && (
                <div className="tool-options">
                  <label>Допуск {bucketTolerance}</label>
                  <input type="range" min={0} max={160} step={1} value={bucketTolerance} onChange={(event) => setBucketTolerance(Number(event.target.value))} />
                </div>
              )}
              {tool === "crop" && (
                <div className="selection-actions">
                  <button disabled={!cropStart || !cropEnd} onClick={applyCropRect}>Применить кроп</button>
                  <button disabled={!cropStart && !cropEnd} onClick={() => {
                    cropDragRef.current = null;
                    setCropStart(null);
                    setCropEnd(null);
                  }}>Сбросить кроп</button>
                </div>
              )}
              <div className="tool-common-options">
                <label>Масштаб {zoom.toFixed(2)}x</label>
                <input type="range" min={0.25} max={3} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
                <label>Цвет кисти</label>
                <input type="color" value={brushColor} onChange={(e) => setBrushColor(e.target.value)} />
                <label>Радиус {brushRadius}px</label>
                <input type="range" min={1} max={80} step={1} value={brushRadius} onChange={(e) => setBrushRadius(Number(e.target.value))} />
                <label>Сила {Math.round(brushStrength * 100)}%</label>
                <input type="range" min={0.1} max={1} step={0.05} value={brushStrength} onChange={(e) => setBrushStrength(Number(e.target.value))} />
              </div>
            </div>
          </div>
        </aside>

        <section
          ref={stageRef}
          className={
            tool === "move"
              ? "canvas-stage is-panning-tool"
              : tool === "fragment"
                ? "canvas-stage is-fragment-tool"
                : ["eyedropper", "bucket", "magic", "marquee", "crop", "zoom", "brush", "pencil", "eraser"].includes(tool)
                  ? `canvas-stage is-${tool}-tool`
                  : tool === "scissors" && lassoMode === "magnetic"
                    ? "canvas-stage is-magnetic-tool"
                : "canvas-stage"
          }
          onMouseDown={onStageMouseDown}
        >
          <div className={isPanning ? "canvas-pan dragging" : "canvas-pan"} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
            <div className="canvas-frame">
              <canvas
                ref={canvasRef}
                className="editor-canvas"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerEnter={updateToolCursor}
                onPointerUp={onPointerUp}
                onPointerLeave={(event) => {
                  setToolCursorPoint(null);
                  void onPointerUp(event);
                }}
              />
              {state && toolCursorPoint && toolCursorRadius != null && (
                <svg
                  className="tool-cursor"
                  viewBox={`0 0 ${state.width} ${state.height}`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <circle
                    cx={toolCursorPoint.x}
                    cy={toolCursorPoint.y}
                    r={Math.max(toolCursorRadius, 1)}
                  />
                  <text
                    x={toolCursorPoint.x + Math.max(toolCursorRadius, 6) + 4}
                    y={toolCursorPoint.y - Math.max(toolCursorRadius, 6) - 4}
                  >
                    {toolCursorLabel}
                  </text>
                </svg>
              )}
              {state && selectionPath.length > 0 && (
                <svg
                  className="selection-lasso"
                  viewBox={`0 0 ${state.width} ${state.height}`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <polyline points={selectionPreviewPolyline || selectionPolyline} />
                  {selectionClosed && selectionPath.length > 2 && (
                    <line
                      x1={selectionPath[selectionPath.length - 1].x}
                      y1={selectionPath[selectionPath.length - 1].y}
                      x2={selectionPath[0].x}
                      y2={selectionPath[0].y}
                    />
                  )}
                </svg>
              )}
              {state && cropPolyline && (
                <svg
                  className="crop-overlay"
                  viewBox={`0 0 ${state.width} ${state.height}`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <polygon points={cropPolyline} />
                </svg>
              )}
              {state && transformOverlayBounds && (
                <svg
                  className="layer-transform-overlay"
                  viewBox={`0 0 ${state.width} ${state.height}`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <polygon points={transformOverlayPoints} />
                  <circle
                    cx={transformOverlayBounds.x + transformOverlayBounds.width}
                    cy={transformOverlayBounds.y + transformOverlayBounds.height}
                    r={transformHandleRadius}
                  />
                </svg>
              )}
              {state && fragmentDragStart && fragmentDragOffset && (
                <svg
                  className="fragment-drag-preview"
                  viewBox={`0 0 ${state.width} ${state.height}`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <line
                    x1={fragmentDragStart.x}
                    y1={fragmentDragStart.y}
                    x2={fragmentDragStart.x + fragmentDragOffset.x}
                    y2={fragmentDragStart.y + fragmentDragOffset.y}
                  />
                  <circle
                    cx={fragmentDragStart.x + fragmentDragOffset.x}
                    cy={fragmentDragStart.y + fragmentDragOffset.y}
                    r={Math.max(3, Math.min(state.width, state.height) * 0.012)}
                  />
                </svg>
              )}
            </div>
          </div>
        </section>

        <aside className={mobilePanelOpen === "layers" ? "sidebar right mobile-panel is-mobile-open" : "sidebar right mobile-panel"}>
          <h3>Слои</h3>
          {activeLayer && (
            <div className="layer-panel-head">
              <div className="layer-head-row">
                <label>
                  Режим
                  <select value={activeLayer.blendMode} onChange={(e) => applyOperation({ type: "set_blend_mode", layer_id: activeLayer.id, blend_mode: e.target.value as BlendMode })}>
                    {BLEND_MODES.map((mode) => <option key={mode} value={mode}>{BLEND_MODE_LABELS[mode]}</option>)}
                  </select>
                </label>
              </div>
              <div className="layer-head-grid">
                <label>
                  Opacity {Math.round(activeLayer.opacity * 100)}%
                  <input type="range" min={0} max={1} step={0.01} value={activeLayer.opacity} onChange={(e) => applyOperation({ type: "set_layer_opacity", layer_id: activeLayer.id, opacity: Number(e.target.value) })} />
                </label>
                <label>
                  Заливка {Math.round(activeLayer.fillOpacity * 100)}%
                  <input type="range" min={0} max={1} step={0.01} value={activeLayer.fillOpacity} onChange={(e) => applyOperation({ type: "set_layer_fill_opacity", layer_id: activeLayer.id, fill_opacity: Number(e.target.value) })} />
                </label>
              </div>
              <div className="lock-strip" aria-label="Блокировки слоя">
                <span>Блок</span>
                <button className={activeLayer.lockTransparentPixels ? "active" : ""} onClick={() => applyOperation({ type: "set_layer_lock_options", layer_id: activeLayer.id, lock_transparent_pixels: !activeLayer.lockTransparentPixels })} title="Блокировать прозрачные пиксели" aria-label="Блокировать прозрачные пиксели">
                  <ScanLine size={15} strokeWidth={1.8} />
                </button>
                <button className={activeLayer.lockPixels ? "active" : ""} onClick={() => applyOperation({ type: "set_layer_lock_options", layer_id: activeLayer.id, lock_pixels: !activeLayer.lockPixels })} title="Блокировать пиксели" aria-label="Блокировать пиксели">
                  <Brush size={15} strokeWidth={1.8} />
                </button>
                <button className={activeLayer.lockPosition ? "active" : ""} onClick={() => applyOperation({ type: "set_layer_lock_options", layer_id: activeLayer.id, lock_position: !activeLayer.lockPosition })} title="Блокировать позицию" aria-label="Блокировать позицию">
                  <MousePointer2 size={15} strokeWidth={1.8} />
                </button>
                <button className={activeLayer.locked ? "active" : ""} onClick={() => applyOperation({ type: "set_layer_lock_options", layer_id: activeLayer.id, locked: !activeLayer.locked })} title="Полная блокировка" aria-label="Полная блокировка">
                  {activeLayer.locked ? <Lock size={15} strokeWidth={1.8} /> : <LockOpen size={15} strokeWidth={1.8} />}
                </button>
              </div>
            </div>
          )}
          <div className="layer-actions">
            <button onClick={createLayer}>+</button>
            <button disabled={!activeLayerId} onClick={duplicateActiveLayer}>Дубль</button>
            <button disabled={!activeLayerId || activeLayer?.locked} onClick={deleteActiveLayer}>Удалить</button>
            <button disabled={!activeLayerId} onClick={groupSelectedLayers}>Группа</button>
            <button disabled={selectedLayerIndex < 0 || !activeLayerId} onClick={() => activeLayerId && applyOperation({ type: "reorder_layer", layer_id: activeLayerId, to_index: Math.max(selectedLayerIndex - 1, 0) })}>Выше</button>
            <button disabled={selectedLayerIndex < 0 || !activeLayerId || !state} onClick={() => activeLayerId && state && applyOperation({ type: "reorder_layer", layer_id: activeLayerId, to_index: Math.min(selectedLayerIndex + 1, state.layerOrder.length - 1) })}>Ниже</button>
          </div>
          {state && state.groups.length > 0 && (
            <div className="group-list">
              {state.groups.map((group) => (
                <div className="group-row" key={group.id}>
                  <button
                    className="icon-button"
                    onClick={() => applyOperation({ type: "toggle_group_visibility", group_id: group.id, visible: !group.visible })}
                    title={group.visible ? "Скрыть группу" : "Показать группу"}
                  >
                    {group.visible ? "●" : "○"}
                  </button>
                  <span className="group-name">Папка: {group.name}</span>
                  <span className="group-count">{group.layerIds.length}</span>
                  <button className="icon-button" onClick={() => applyOperation({ type: "ungroup", group_id: group.id })} title="Разгруппировать">×</button>
                </div>
              ))}
            </div>
          )}
          <div className="layer-list">
            {state?.layers.slice().reverse().map((layer) => (
              <div
                key={layer.id}
                className={[
                  "layer",
                  layer.id === activeLayerId ? "active" : "",
                  selectedLayerIds.includes(layer.id) ? "selected" : "",
                  layer.id === dragLayerId ? "dragging" : "",
                  layer.locked ? "locked" : "",
                ].filter(Boolean).join(" ")}
                draggable
                onClick={(event) => {
                  if (event.ctrlKey || event.metaKey) {
                    toggleLayerSelection(layer.id);
                  } else {
                    selectLayer(layer.id);
                  }
                }}
                onDragStart={(event) => onLayerDragStart(event, layer.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => onLayerDrop(event, layer.id)}
                onDragEnd={onLayerDragEnd}
                role="button"
                tabIndex={0}
              >
                <span className={`layer-thumb ${layer.kind}`}>
                  {layer.kind === "raster" ? <ImageIcon size={18} strokeWidth={1.7} /> : <SlidersHorizontal size={18} strokeWidth={1.7} />}
                  {layer.hasMask && <span className="mask-dot" title="Есть маска" />}
                </span>
                <span className="layer-body">
                  <span className="layer-title-row">
                    {editingLayerId === layer.id ? (
                      <input
                        className="layer-name-input"
                        value={editingLayerName}
                        autoFocus
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => setEditingLayerName(event.target.value)}
                        onBlur={commitLayerRename}
                        onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                          if (event.key === "Enter") {
                            commitLayerRename();
                          }
                          if (event.key === "Escape") {
                            setEditingLayerId(null);
                            setEditingLayerName("");
                          }
                        }}
                      />
                    ) : (
                      <span
                        className="layer-name"
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          setEditingLayerId(layer.id);
                          setEditingLayerName(layer.name);
                        }}
                      >
                        {layer.name}
                      </span>
                    )}
                    {layer.id === activeLayerId && <span className="layer-active-pill">Активен</span>}
                  </span>
                  <span className="layer-meta">
                    <span>{LAYER_KIND_LABELS[layer.kind]}</span>
                    {layer.kind === "raster" && <span>{layer.width}x{layer.height}</span>}
                    {layer.adjustmentKind && <span>{ADJUSTMENT_LABELS[layer.adjustmentKind]}</span>}
                    <span>{Math.round(layer.opacity * 100)}%</span>
                    {layer.fillOpacity < 1 && <span>Заливка {Math.round(layer.fillOpacity * 100)}%</span>}
                    <span>{BLEND_MODE_LABELS[layer.blendMode]}</span>
                    {layer.hasMask && <span>Маска</span>}
                    {layer.clippedToLayerId && <span>Клип</span>}
                    {(layer.locked || layer.lockPixels || layer.lockPosition || layer.lockTransparentPixels) && <span>Блок</span>}
                  </span>
                </span>
                <span className="layer-row-actions">
                  <button
                    className="icon-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      applyOperation({ type: "set_layer_visibility", layer_id: layer.id, visible: !layer.visible });
                    }}
                    title={layer.visible ? "Скрыть слой" : "Показать слой"}
                  >
                    {layer.visible ? <Eye size={15} strokeWidth={1.8} /> : <EyeOff size={15} strokeWidth={1.8} />}
                  </button>
                  <button
                    className="icon-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      applyOperation({ type: "set_layer_lock_options", layer_id: layer.id, locked: !layer.locked });
                    }}
                    title={layer.locked ? "Разблокировать" : "Заблокировать"}
                  >
                    {layer.locked ? <Lock size={15} strokeWidth={1.8} /> : <LockOpen size={15} strokeWidth={1.8} />}
                  </button>
                </span>
              </div>
            ))}
          </div>
          <div className="layer-dock" aria-label="Быстрые действия со слоями">
            <button onClick={createLayer} title="Новый слой" aria-label="Новый слой">
              <Plus size={18} strokeWidth={1.8} />
            </button>
            <button
              className={!activeLayerId ? "is-disabled" : ""}
              onClick={duplicateActiveLayer}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => void onLayerDockDrop(event, "duplicate")}
              title="Дублировать слой. Можно перетащить слой сюда."
              aria-label="Дублировать слой"
            >
              <Copy size={17} strokeWidth={1.8} />
            </button>
            <button disabled={!activeLayerId} onClick={groupSelectedLayers} title="Сгруппировать" aria-label="Сгруппировать">
              <FolderPlus size={17} strokeWidth={1.8} />
            </button>
            <button disabled={selectedLayerIndex < 0 || !activeLayerId} onClick={() => activeLayerId && applyOperation({ type: "reorder_layer", layer_id: activeLayerId, to_index: Math.max(selectedLayerIndex - 1, 0) })} title="Слой выше" aria-label="Слой выше">
              <ArrowUp size={17} strokeWidth={1.8} />
            </button>
            <button disabled={selectedLayerIndex < 0 || !activeLayerId || !state} onClick={() => activeLayerId && state && applyOperation({ type: "reorder_layer", layer_id: activeLayerId, to_index: Math.min(selectedLayerIndex + 1, state.layerOrder.length - 1) })} title="Слой ниже" aria-label="Слой ниже">
              <ArrowDown size={17} strokeWidth={1.8} />
            </button>
            <button
              className={!activeLayerId || activeLayer?.locked ? "is-disabled" : ""}
              onClick={deleteActiveLayer}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => void onLayerDockDrop(event, "delete")}
              title="Удалить слой. Можно перетащить слой сюда."
              aria-label="Удалить слой"
            >
              <Trash2 size={17} strokeWidth={1.8} />
            </button>
          </div>

          {activeLayer && (
            <div className="layer-controls">
              <div className="layer-control-row">
                <button onClick={() => applyOperation({ type: "set_layer_visibility", layer_id: activeLayer.id, visible: !activeLayer.visible })}>
                  {activeLayer.visible ? "Скрыть" : "Показать"}
                </button>
                <button onClick={() => applyOperation({ type: "set_layer_lock_options", layer_id: activeLayer.id, locked: !activeLayer.locked })}>
                  {activeLayer.locked ? "Разблокировать" : "Заблокировать"}
                </button>
              </div>
              <label>Непрозрачность {Math.round(activeLayer.opacity * 100)}%</label>
              <input type="range" min={0} max={1} step={0.01} value={activeLayer.opacity} onChange={(e) => applyOperation({ type: "set_layer_opacity", layer_id: activeLayer.id, opacity: Number(e.target.value) })} />
              <label>Режим наложения</label>
              <select value={activeLayer.blendMode} onChange={(e) => applyOperation({ type: "set_blend_mode", layer_id: activeLayer.id, blend_mode: e.target.value as BlendMode })}>
                {BLEND_MODES.map((mode) => <option key={mode} value={mode}>{BLEND_MODE_LABELS[mode]}</option>)}
              </select>
              <div className="layer-control-row">
                <button disabled={!canEditRaster || !canModifyActiveLayer} onClick={() => applyOperation({ type: activeLayer.hasMask ? "remove_layer_mask" : "add_layer_mask", layer_id: activeLayer.id })}>
                  {activeLayer.hasMask ? "Убрать маску" : "Добавить маску"}
                </button>
                <button disabled={!canEditRaster || !canModifyActiveLayer || !hasSelection} onClick={() => applyMaskFromSelection(false)}>
                  Маска из выделения
                </button>
                <button disabled={!canEditRaster || !canModifyActiveLayer || !hasSelection} onClick={() => applyMaskFromSelection(false, true)}>
                  Маска по объекту
                </button>
                <button disabled={!canEditRaster || !canModifyActiveLayer || !activeLayer.hasMask} onClick={() => applyOperation({ type: "invert_layer_mask", layer_id: activeLayer.id })}>
                  Инвертировать
                </button>
                <button disabled={!activeLayerId || selectedLayerIndex <= 0} onClick={() => {
                  const clippedTo = state?.layerOrder[selectedLayerIndex - 1] ?? null;
                  applyOperation({ type: "set_clipping_mask", layer_id: activeLayer.id, clipped_to_layer_id: activeLayer.clippedToLayerId ? null : clippedTo });
                }}>
                  {activeLayer.clippedToLayerId ? "Убрать клип" : "Обтравка"}
                </button>
              </div>
            </div>
          )}

          <h3>Коррекция</h3>
          <label>Значение</label>
          <input type="range" min={-1} max={1} step={0.05} value={filterValue} onChange={(e) => setFilterValue(Number(e.target.value))} />
          <div className="stack">
            <button disabled={!activeLayerId || !canEditRaster || !canEditActivePixels} onClick={() => activeLayerId && applyOperation({ type: "brightness", layer_id: activeLayerId, value: filterValue })}>Яркость</button>
            <button disabled={!activeLayerId || !canEditRaster || !canEditActivePixels} onClick={() => activeLayerId && applyOperation({ type: "contrast", layer_id: activeLayerId, value: filterValue })}>Контраст</button>
            <button disabled={!activeLayerId || !canEditRaster || !canEditActivePixels} onClick={() => activeLayerId && applyOperation({ type: "blur", layer_id: activeLayerId, radius: Math.abs(filterValue) * 6 + 1 })}>Размытие</button>
            <button disabled={!activeLayerId || !canEditRaster || !canEditActivePixels} onClick={() => activeLayerId && applyOperation({ type: "sharpen", layer_id: activeLayerId, amount: Math.abs(filterValue) })}>Резкость</button>
            <button disabled={!activeLayerId} onClick={() => activeLayerId && applyOperation({ type: "create_adjustment_layer", adjustment_kind: "brightness", value: filterValue, clipped_to_layer_id: activeLayerId })}>Новый корректирующий слой</button>
          </div>

          <h3>Трансформация</h3>
          <button onClick={() => applyOperation({ type: "rotate90", clockwise: true })}>Повернуть вправо</button>
          <button onClick={() => applyOperation({ type: "rotate90", clockwise: false })}>Повернуть влево</button>
          <label>Ширина</label>
          <input type="number" value={resizeWidth} onChange={(e) => setResizeWidth(Number(e.target.value))} />
          <label>Высота</label>
          <input type="number" value={resizeHeight} onChange={(e) => setResizeHeight(Number(e.target.value))} />
          <button onClick={() => applyOperation({ type: "resize", width: resizeWidth, height: resizeHeight })}>Применить размер</button>
          <button onClick={() => state && applyOperation({ type: "crop", x: Math.floor(state.width * 0.1), y: Math.floor(state.height * 0.1), width: Math.floor(state.width * 0.8), height: Math.floor(state.height * 0.8) })}>Обрезать центр 80%</button>

          <h3>Локальные проекты</h3>
          <select value={selectedProjectId} onChange={(e) => setSelectedProjectId(e.target.value)}>
            <option value="">Выбрать проект</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <button onClick={loadSelectedProject} disabled={!selectedProjectId}>Загрузить снимок</button>
          <button
            onClick={async () => {
              if (!selectedProjectId) return;
              await deleteProject(selectedProjectId);
              setSelectedProjectId("");
              await refreshProjects();
            }}
            disabled={!selectedProjectId}
          >
            Удалить снимок
          </button>
        </aside>
      </main>
    </div>
  );
}

function hexToRgba(hex: string): [number, number, number, number] {
  const normalized = hex.replace("#", "");
  const full = normalized.length === 3
    ? normalized.split("").map((char) => `${char}${char}`).join("")
    : normalized;
  const value = Number.parseInt(full, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 255];
}

export default App;
