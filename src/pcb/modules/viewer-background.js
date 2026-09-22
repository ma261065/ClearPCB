/** Shared backdrop used by the 2D and 3D board viewers. */
export const VIEWER_BACKGROUND = Object.freeze({
    center: '#111c3f',
    mid: '#071027',
    edge: '#01040c',
});

/** Paint the viewer backdrop into a Canvas2D drawing buffer. */
export function paintViewerBackground(context, width, height) {
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.hypot(centerX, centerY);
    const gradient = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
    gradient.addColorStop(0, VIEWER_BACKGROUND.center);
    gradient.addColorStop(0.52, VIEWER_BACKGROUND.mid);
    gradient.addColorStop(1, VIEWER_BACKGROUND.edge);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
}

/** Build a texture suitable for a Three.js scene background. */
export function createViewerBackgroundTexture(THREE, documentRef = document) {
    const canvas = documentRef.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    paintViewerBackground(context, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}
