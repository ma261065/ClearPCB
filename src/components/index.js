/**
 * ClearPCB Components Module
 * 
 * Provides:
 * - Component class for rendering schematic symbols
 * - ComponentLibrary for managing component definitions
 * - LCSCFetcher for fetching components from LCSC/EasyEDA
 * - Built-in component library
 */

import { Component } from './Component.js';
import { ComponentLibrary, getComponentLibrary } from './ComponentLibrary.js';
import { LCSCFetcher } from './LCSCFetcher.js';
import { BuiltInComponents } from './BuiltInComponents.js';
import { VRMLPreview } from './VRMLPreview.js';

export { Component, ComponentLibrary, getComponentLibrary, LCSCFetcher, BuiltInComponents, VRMLPreview };

export default {
    Component,
    ComponentLibrary,
    getComponentLibrary,
    LCSCFetcher,
    BuiltInComponents
};