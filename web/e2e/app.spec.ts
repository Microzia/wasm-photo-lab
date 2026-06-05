import { expect, test, type Page } from "@playwright/test";

const RED_4_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAATSURBVBhXY/jPwPAfGZMswPAfADxAH+HkFd+zAAAAAElFTkSuQmCC";

async function waitForEditorReady(page: Page) {
  await page.goto("/#editor");
  await expect(page.locator("canvas.editor-canvas")).toBeVisible();
  await page.waitForFunction(() => !document.querySelector<HTMLInputElement>("input[type=file]")?.disabled);
}

async function uploadSvg(page: Page, name: string, svg: string) {
  await page.locator("input[type=file]").setInputFiles({
    name,
    mimeType: "image/svg+xml",
    buffer: Buffer.from(svg),
  });
}

async function uploadPng(page: Page, name: string, base64: string) {
  await page.locator("input[type=file]").setInputFiles({
    name,
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  });
}

test("renders editor shell and canvas", async ({ page }) => {
  await page.goto("/#editor");
  await expect(page.locator(".brand")).toContainText("WASM");
  await expect(page.getByRole("button", { name: /1280x720/ })).toBeVisible();
  await expect(page.locator("canvas.editor-canvas")).toBeVisible();
});

test("shows intro page and opens editor as an SPA route", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".intro-page")).toBeVisible();
  await expect(page.locator("h1")).toContainText("Редактор изображений");
  await page.getByRole("button", { name: /Начать работу/ }).click();
  await expect(page.locator("canvas.editor-canvas")).toBeVisible();
  await expect(page).toHaveURL(/#editor$/);
});

test("keeps mobile side panels behind draggable floating buttons", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile-only shell behavior.");
  await waitForEditorReady(page);

  const toolFab = page.locator(".mobile-panel-fab").first();
  const layerFab = page.locator(".mobile-panel-fab").nth(1);
  await expect(toolFab).toBeVisible();
  await expect(layerFab).toBeVisible();

  await toolFab.click();
  await expect
    .poll(() => page.locator(".sidebar.left").evaluate((node) => getComputedStyle(node).opacity))
    .toBe("1");

  const viewport = page.viewportSize();
  await page.mouse.click((viewport?.width ?? 390) - 4, Math.round((viewport?.height ?? 720) / 2));
  await expect
    .poll(() => page.locator(".sidebar.left").evaluate((node) => getComputedStyle(node).opacity))
    .toBe("0");

  const before = await layerFab.boundingBox();
  expect(before).not.toBeNull();
  if (!before) return;
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 80, before.y + before.height / 2 + 24);
  await page.mouse.up();

  const after = await layerFab.boundingBox();
  expect(after).not.toBeNull();
  expect(after?.x ?? 0).toBeGreaterThan(before.x + 50);
});

test("imports a user image into an empty document", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await waitForEditorReady(page);
  const canvas = page.locator("canvas.editor-canvas");
  await uploadPng(page, "red.png", RED_4_PNG);

  await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width)).toBe(4);
  await expect(canvas).toHaveJSProperty("height", 4);
  await expect
    .poll(async () =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(0, 0, 1, 1).data) : [];
      }),
    )
    .toEqual([255, 0, 0, 255]);
  expect(pageErrors).toEqual([]);
});

test("imports multiple images as separate layers", async ({ page }) => {
  await waitForEditorReady(page);
  const canvas = page.locator("canvas.editor-canvas");

  await page.locator("input[type=file]").setInputFiles([
    {
      name: "red-small.png",
      mimeType: "image/png",
      buffer: Buffer.from(RED_4_PNG, "base64"),
    },
    {
      name: "blue-large.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>'),
    },
  ]);

  await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width)).toBe(16);
  await expect.poll(() => page.locator(".layer-list .layer").count()).toBe(2);
  await expect(page.locator(".layer-list .layer").first()).toContainText("blue-large");
  await expect(page.locator(".layer-list .layer").nth(1)).toContainText("red-small");

  await page.locator(".layer-list .layer").first().evaluate((node) => (node as HTMLButtonElement).click());
  await page.locator(".layer-controls button").first().evaluate((node) => (node as HTMLButtonElement).click());

  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(7, 7, 1, 1).data) : [];
      }),
    )
    .toEqual([255, 0, 0, 255]);
});

test("keeps existing imported layers centered when a larger image expands the canvas", async ({ page }) => {
  await waitForEditorReady(page);
  const canvas = page.locator("canvas.editor-canvas");

  await uploadPng(page, "first-red.png", RED_4_PNG);
  await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width)).toBe(4);
  await uploadSvg(page, "second-blue.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>');

  await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width)).toBe(16);
  await expect.poll(() => page.locator(".layer-list .layer").count()).toBe(2);
  await page.locator(".layer-list .layer").first().evaluate((node) => (node as HTMLButtonElement).click());
  await page.locator(".layer-controls button").first().evaluate((node) => (node as HTMLButtonElement).click());

  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(7, 7, 1, 1).data) : [];
      }),
    )
    .toEqual([255, 0, 0, 255]);
  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(0, 0, 1, 1).data) : [];
      }),
    )
    .toEqual([0, 0, 0, 0]);
});

test("manages layer visibility lock duplicate rename and groups", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Layer panel double-click editing is covered on desktop.");
  await waitForEditorReady(page);
  const canvas = page.locator("canvas.editor-canvas");
  await uploadPng(page, "base-red.png", RED_4_PNG);
  await expect.poll(() => page.locator(".layer-list .layer").count()).toBe(1);

  await page.keyboard.press("Control+J");
  await expect.poll(() => page.locator(".layer-list .layer").count()).toBe(2);

  const topLayer = page.locator(".layer-list .layer").first();
  await topLayer.locator(".layer-name").dblclick();
  await topLayer.locator(".layer-name-input").fill("copy-renamed");
  await topLayer.locator(".layer-name-input").press("Enter");
  await expect(topLayer).toContainText("copy-renamed");

  await topLayer.locator(".icon-button").nth(1).click();
  await page.keyboard.press("Delete");
  await expect.poll(() => page.locator(".layer-list .layer").count()).toBe(2);

  await page.keyboard.press("Control+G");
  await expect.poll(() => page.locator(".group-list .group-row").count()).toBe(1);
  await page.locator(".group-list .group-row .icon-button").first().click();
  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(0, 0, 1, 1).data) : [];
      }),
    )
    .toEqual([255, 0, 0, 255]);

  await topLayer.locator(".icon-button").nth(1).click();
  await page.keyboard.press("Delete");
  await expect.poll(() => page.locator(".layer-list .layer").count()).toBe(1);
});

test("duplicates and deletes layers by dragging to the bottom dock icons", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Desktop drag and drop is covered on desktop.");
  await waitForEditorReady(page);
  await uploadPng(page, "drag-layer.png", RED_4_PNG);
  await expect.poll(() => page.locator(".layer-list .layer").count()).toBe(1);

  await page.locator(".layer-list .layer").first().dragTo(page.getByRole("button", { name: "Дублировать слой" }));
  await expect.poll(() => page.locator(".layer-list .layer").count()).toBe(2);

  await page.locator(".layer-list .layer").first().dragTo(page.getByRole("button", { name: "Удалить слой" }));
  await expect.poll(() => page.locator(".layer-list .layer").count()).toBe(1);
});

test("uses photoshop-style layer fill and position lock controls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Layer panel precision controls are covered on desktop.");
  await waitForEditorReady(page);
  const canvas = page.locator("canvas.editor-canvas");
  await uploadPng(page, "layer-fill.png", RED_4_PNG);

  await page.locator(".layer-panel-head input[type=range]").nth(1).evaluate((node) => {
    const input = node as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, "0");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(0, 0, 1, 1).data) : [];
      }),
    )
    .toEqual([0, 0, 0, 0]);

  await page.getByRole("button", { name: "Блокировать позицию" }).click();
  await page.locator(".tool-grid button").nth(1).click();
  await expect(page.locator(".layer-transform-overlay")).not.toBeVisible();
});

test("uses marquee eyedropper paint bucket and crop tools", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Pointer-driven tool smoke test is covered on desktop.");
  await waitForEditorReady(page);
  const canvas = page.locator("canvas.editor-canvas");
  await uploadSvg(
    page,
    "tool-target.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="white"/><rect x="4" y="4" width="12" height="12" fill="red"/></svg>',
  );

  await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width)).toBe(32);
  await canvas.scrollIntoViewIfNeeded();
  let box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  let point = (x: number, y: number) => ({
    x: box!.x + (box!.width * x) / 32,
    y: box!.y + (box!.height * y) / 32,
  });

  await page.getByRole("button", { name: "Пипетка" }).click();
  await canvas.scrollIntoViewIfNeeded();
  box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  point = (x: number, y: number) => ({
    x: box!.x + (box!.width * x) / 32,
    y: box!.y + (box!.height * y) / 32,
  });
  await page.mouse.click(point(8, 8).x, point(8, 8).y);
  await expect(page.locator('input[type="color"]')).toHaveValue("#ff0000");

  await page.locator('input[type="color"]').fill("#0000ff");
  await page.getByRole("button", { name: "Заливка" }).click();
  await canvas.scrollIntoViewIfNeeded();
  box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  point = (x: number, y: number) => ({
    x: box!.x + (box!.width * x) / 32,
    y: box!.y + (box!.height * y) / 32,
  });
  await page.mouse.click(point(8, 8).x, point(8, 8).y);
  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(8, 8, 1, 1).data) : [];
      }),
    )
    .toEqual([0, 0, 255, 255]);

  await page.getByRole("button", { name: "Область" }).click();
  await canvas.scrollIntoViewIfNeeded();
  box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  point = (x: number, y: number) => ({
    x: box!.x + (box!.width * x) / 32,
    y: box!.y + (box!.height * y) / 32,
  });
  await page.mouse.move(point(2, 2).x, point(2, 2).y);
  await page.mouse.down();
  await page.mouse.move(point(18, 18).x, point(18, 18).y, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".selection-lasso")).toBeVisible();

  await page.getByRole("button", { name: "Кроп" }).click();
  await canvas.scrollIntoViewIfNeeded();
  box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  point = (x: number, y: number) => ({
    x: box!.x + (box!.width * x) / 32,
    y: box!.y + (box!.height * y) / 32,
  });
  await page.mouse.move(point(2, 2).x, point(2, 2).y);
  await page.mouse.down();
  await page.mouse.move(point(18, 18).x, point(18, 18).y, { steps: 4 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Применить кроп" }).click();
  await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width)).toBe(16);
});

test("shows brush radius preview on the canvas", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Mouse hover preview is covered by the desktop pointer test.");
  await waitForEditorReady(page);
  const canvas = page.locator("canvas.editor-canvas");
  await uploadSvg(page, "brush-preview.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="white"/></svg>');

  await page.locator(".tool-grid button").nth(8).click();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

  await expect(page.locator(".tool-cursor")).toBeVisible();
  await expect(page.locator(".tool-cursor circle")).toHaveAttribute("r", "18");
  await expect(page.locator(".tool-cursor text")).toContainText("18px");
});

test("toggles the tool settings popover from the active tool icon", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Tool popover mouse flow is covered on desktop.");
  await waitForEditorReady(page);
  const brushButton = page.locator(".tool-grid button").nth(8);

  await expect(page.locator(".tool-popover")).not.toBeVisible();
  await brushButton.click();
  await expect(page.locator(".tool-popover")).toBeVisible();
  await page.getByRole("button", { name: "Закрыть настройки инструмента" }).click();
  await expect(page.locator(".tool-popover")).not.toBeVisible();
  await brushButton.click();
  await expect(page.locator(".tool-popover")).toBeVisible();
});

test("cuts a canvas selection into a new layer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Mouse-driven lasso is covered by the desktop pointer test.");
  await waitForEditorReady(page);
  const canvas = page.locator("canvas.editor-canvas");
  await uploadSvg(page, "red.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>');

  await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width)).toBe(64);
  await page.locator(".tool-grid button").nth(3).click();
  await expect(page.locator(".tool-grid button").nth(3)).toHaveClass(/active/);
  await canvas.scrollIntoViewIfNeeded();
  let box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const point = (x: number, y: number) => ({
    x: box!.x + (box!.width * x) / 64,
    y: box!.y + (box!.height * y) / 64,
  });
  await page.mouse.move(point(8, 8).x, point(8, 8).y);
  await page.mouse.down();
  await page.mouse.move(point(42, 8).x, point(42, 8).y, { steps: 8 });
  await page.mouse.move(point(42, 42).x, point(42, 42).y, { steps: 8 });
  await page.mouse.move(point(8, 42).x, point(8, 42).y, { steps: 8 });
  await page.mouse.move(point(8, 8).x, point(8, 8).y, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Вырезать в слой" }).click();

  await expect.poll(() => page.locator(".layer-list .layer").count()).toBe(2);
  await page.locator(".layer-list .layer").first().evaluate((node) => (node as HTMLButtonElement).click());
  await page.locator(".layer-controls button").first().evaluate((node) => (node as HTMLButtonElement).click());
  await page.waitForTimeout(500);
  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(20, 20, 1, 1).data) : [];
      }),
    )
    .toEqual([0, 0, 0, 0]);
  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(54, 54, 1, 1).data) : [];
      }),
    )
    .toEqual([255, 0, 0, 255]);
});

test("refines a loose scissors selection around the object", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Mouse-driven lasso is covered by the desktop pointer test.");
  await waitForEditorReady(page);
  const canvas = page.locator("canvas.editor-canvas");
  await uploadSvg(
    page,
    "object-on-white.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="white"/><circle cx="32" cy="32" r="12" fill="red"/></svg>',
  );

  await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width)).toBe(64);
  await page.locator(".tool-grid button").nth(3).click();
  await canvas.scrollIntoViewIfNeeded();
  let box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const point = (x: number, y: number) => ({
    x: box!.x + (box!.width * x) / 64,
    y: box!.y + (box!.height * y) / 64,
  });

  await page.mouse.move(point(8, 8).x, point(8, 8).y);
  await page.mouse.down();
  await page.mouse.move(point(56, 8).x, point(56, 8).y, { steps: 8 });
  await page.mouse.move(point(56, 56).x, point(56, 56).y, { steps: 8 });
  await page.mouse.move(point(8, 56).x, point(8, 56).y, { steps: 8 });
  await page.mouse.move(point(8, 8).x, point(8, 8).y, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Вырезать объект" }).click();

  await expect.poll(() => page.locator(".layer-list .layer").count()).toBe(2);
  await page.locator(".layer-list .layer").first().evaluate((node) => (node as HTMLButtonElement).click());
  await page.locator(".layer-controls button").first().evaluate((node) => (node as HTMLButtonElement).click());
  await page.waitForTimeout(500);

  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(12, 12, 1, 1).data) : [];
      }),
    )
    .toEqual([255, 255, 255, 255]);
  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(32, 32, 1, 1).data) : [];
      }),
    )
    .toEqual([0, 0, 0, 0]);
});

test("regular scissors cut keeps the full outlined area", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Mouse-driven lasso is covered by the desktop pointer test.");
  await waitForEditorReady(page);
  const canvas = page.locator("canvas.editor-canvas");
  await uploadSvg(
    page,
    "area-on-white.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="white"/><circle cx="32" cy="32" r="12" fill="red"/></svg>',
  );

  await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width)).toBe(64);
  await page.locator(".tool-grid button").nth(3).click();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const point = (x: number, y: number) => ({
    x: box!.x + (box!.width * x) / 64,
    y: box!.y + (box!.height * y) / 64,
  });

  await page.mouse.move(point(8, 8).x, point(8, 8).y);
  await page.mouse.down();
  await page.mouse.move(point(56, 8).x, point(56, 8).y, { steps: 8 });
  await page.mouse.move(point(56, 56).x, point(56, 56).y, { steps: 8 });
  await page.mouse.move(point(8, 56).x, point(8, 56).y, { steps: 8 });
  await page.mouse.move(point(8, 8).x, point(8, 8).y, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Вырезать в слой" }).click();

  await expect.poll(() => page.locator(".layer-list .layer").count()).toBe(2);
  await page.locator(".layer-list .layer").first().evaluate((node) => (node as HTMLButtonElement).click());
  await page.locator(".layer-controls button").first().evaluate((node) => (node as HTMLButtonElement).click());
  await page.waitForTimeout(500);

  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(12, 12, 1, 1).data) : [];
      }),
    )
    .toEqual([0, 0, 0, 0]);
  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(32, 32, 1, 1).data) : [];
      }),
    )
    .toEqual([0, 0, 0, 0]);
});

test("creates a layer mask from the outlined scissors selection", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Mouse-driven lasso is covered by the desktop pointer test.");
  await waitForEditorReady(page);
  const canvas = page.locator("canvas.editor-canvas");
  await uploadSvg(page, "masked-red.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>');

  await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width)).toBe(64);
  await page.locator(".tool-grid button").nth(3).click();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const point = (x: number, y: number) => ({
    x: box!.x + (box!.width * x) / 64,
    y: box!.y + (box!.height * y) / 64,
  });

  await page.mouse.move(point(8, 8).x, point(8, 8).y);
  await page.mouse.down();
  await page.mouse.move(point(42, 8).x, point(42, 8).y, { steps: 8 });
  await page.mouse.move(point(42, 42).x, point(42, 42).y, { steps: 8 });
  await page.mouse.move(point(8, 42).x, point(8, 42).y, { steps: 8 });
  await page.mouse.move(point(8, 8).x, point(8, 8).y, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Маска из выделения" }).click();

  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(20, 20, 1, 1).data) : [];
      }),
    )
    .toEqual([255, 0, 0, 255]);
  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(54, 54, 1, 1).data) : [];
      }),
    )
    .toEqual([0, 0, 0, 0]);
});

test("moves a cut fragment with the fragment tool", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Mouse-driven lasso is covered by the desktop pointer test.");
  await waitForEditorReady(page);
  const canvas = page.locator("canvas.editor-canvas");
  await uploadSvg(
    page,
    "transparent-object.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect x="16" y="16" width="20" height="20" fill="red"/></svg>',
  );

  await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width)).toBe(64);
  await page.locator(".tool-grid button").nth(3).click();
  await canvas.scrollIntoViewIfNeeded();
  let box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const point = (x: number, y: number) => ({
    x: box!.x + (box!.width * x) / 64,
    y: box!.y + (box!.height * y) / 64,
  });

  await page.mouse.move(point(12, 12).x, point(12, 12).y);
  await page.mouse.down();
  await page.mouse.move(point(40, 12).x, point(40, 12).y, { steps: 8 });
  await page.mouse.move(point(40, 40).x, point(40, 40).y, { steps: 8 });
  await page.mouse.move(point(12, 40).x, point(12, 40).y, { steps: 8 });
  await page.mouse.move(point(12, 12).x, point(12, 12).y, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Вырезать в слой" }).click();

  await expect.poll(() => page.locator(".layer-list .layer").count()).toBe(2);
  await page.locator(".layer-list .layer").first().evaluate((node) => (node as HTMLButtonElement).click());
  await canvas.scrollIntoViewIfNeeded();
  box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.locator(".tool-grid button").nth(1).click();
  await expect(page.locator(".tool-grid button").nth(1)).toHaveClass(/active/);
  await canvas.scrollIntoViewIfNeeded();
  box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(point(24, 24).x, point(24, 24).y);
  await page.mouse.down();
  await page.mouse.move(point(42, 34).x, point(42, 34).y, { steps: 6 });
  await page.mouse.up();

  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(24, 24, 1, 1).data) : [];
      }),
    )
    .toEqual([0, 0, 0, 0]);
  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(42, 34, 1, 1).data) : [];
      }),
    )
    .toEqual([255, 0, 0, 255]);
});

test("moves and scales an imported photo layer with the fragment transform handles", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Desktop drag handles are covered on desktop.");
  await waitForEditorReady(page);
  const canvas = page.locator("canvas.editor-canvas");
  await uploadSvg(
    page,
    "transform-photo.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect x="16" y="16" width="16" height="16" fill="red"/></svg>',
  );

  await page.locator(".tool-grid button").nth(1).click();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const point = (x: number, y: number) => ({
    x: box!.x + (box!.width * x) / 64,
    y: box!.y + (box!.height * y) / 64,
  });

  await expect(page.locator(".layer-transform-overlay")).toBeVisible();
  await page.mouse.move(point(24, 24).x, point(24, 24).y);
  await page.mouse.down();
  await page.mouse.move(point(34, 34).x, point(34, 34).y, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(38, 38, 1, 1).data) : [];
      }),
    )
    .toEqual([255, 0, 0, 255]);

  await page.mouse.move(point(42, 42).x, point(42, 42).y);
  await page.mouse.down();
  await page.mouse.move(point(52, 52).x, point(52, 52).y, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(() =>
      canvas.evaluate((node) => {
        const context = (node as HTMLCanvasElement).getContext("2d");
        return context ? Array.from(context.getImageData(48, 48, 1, 1).data) : [];
      }),
    )
    .toEqual([255, 0, 0, 255]);
});
