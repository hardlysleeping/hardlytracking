import { MAX_IMAGE_LENGTH, validBackgroundImage } from "./theme-model";
/** Decode locally and re-encode a bounded raster; never store a file path or remote URL. */
export async function backgroundFromFile(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type)) throw new Error("Choose a PNG, JPEG, WebP, GIF or AVIF image.");
  if (file.size > 20_000_000) throw new Error("Choose an image smaller than 20 MB.");
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 1920 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This device could not prepare the image.");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL("image/jpeg", .8);
    if (result.length > MAX_IMAGE_LENGTH || !validBackgroundImage(result)) throw new Error("This image is too detailed to save. Choose a smaller image.");
    return result;
  } catch (error) {
    throw new Error(error instanceof Error && error.message.includes("Choose") ? error.message : "Could not prepare this image. Try a smaller PNG or JPEG.");
  } finally { URL.revokeObjectURL(url); }
}
