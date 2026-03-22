/**
 * Line - Re-exports Polyline as Line for backward compatibility.
 * Lines are Polyline instances with closed=false.
 */
import { Polyline, createLine } from './polyline.js';
export { Polyline as Line, createLine };