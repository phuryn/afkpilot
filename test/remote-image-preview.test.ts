import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A source-shape guard, not a behavioural test: exercising the real path needs a
// file picker and a canvas, which live in the browser e2e checks. What it does
// guard is the one ordering that fails SILENTLY — a preview registered after the
// frame is sent still passes every other check, and the chip just renders blank,
// which is exactly the bug this page shipped with.
const html = readFileSync(new URL("../web/chat.html", import.meta.url), "utf8");

const sendEphemeralImage = html.slice(
  html.indexOf("function sendEphemeralImage"),
  html.indexOf("function pickRemoteImage"),
);

describe("remote image upload preview bridge", () => {
  it("builds a small preview separately from the full-size upload", () => {
    // 320px at quality 0.7 — the upload itself stays at REMOTE_IMAGE_MAX_EDGE.
    // Caching the full-size copy instead would put ~800 KB per image into a
    // 24-entry map on a phone.
    expect(html).toContain("drawCanvas(320)");
    expect(html).toContain("canvasJpegBlob(previewCanvas, 0.7)");
  });

  it("registers the preview BEFORE sending pasteImage", () => {
    expect(sendEphemeralImage).not.toBe("");
    const registerAt = sendEphemeralImage.indexOf("registerPreview(image.preview)");
    const sendAt = sendEphemeralImage.indexOf('type: "pasteImage"');
    expect(registerAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(-1);
    expect(registerAt).toBeLessThan(sendAt);
  });

  it("passes previewId through to the host so the chip can find the preview", () => {
    // Without this the host never echoes an id back on the chip, and the phone
    // has no key to look its own copy up by.
    expect(sendEphemeralImage).toContain("previewId");
    expect(html).toContain("window.grokRegisterRemoteImagePreview");
  });
});
