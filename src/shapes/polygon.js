/**
 * Polygon - Re-exports Polyline as Polygon for backward compatibility.
 * Polygons are Polyline instances with closed=true.
 */
import { Polyline, createPolygon } from './polyline.js';
export { Polyline as Polygon, createPolygon };