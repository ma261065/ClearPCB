/**
 * Rect - Re-exports for backward compatibility.
 * Rectangles are Polyline instances with closed=true, isRect=true.
 */
import { Polyline, createRect } from './polyline.js';
export { createRect };
export { Polyline as Rect };