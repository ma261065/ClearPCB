# ClearPCB - Project Structure

```
clearpcb/
│
├── index.html                  # Main entry point
├── package.json                # Project config (for future bundling)
│
├── src/
│   ├── core/                   # Shared core functionality
│   │   ├── Viewport.js         # Canvas viewport, pan/zoom/grid
│   │   ├── EventBus.js         # Pub/sub for decoupled communication
│   │   ├── CommandHistory.js   # Undo/redo system
│   │   ├── SelectionManager.js # Multi-select, box select
│   │   ├── SpatialIndex.js     # R-tree for hit testing
│   │   ├── Geometry.js         # Math utilities (intersection, distance, etc.)
│   │   ├── Units.js            # Unit conversion (mm, mil, inch)
│   │   └── Colors.js           # Color palette and layer colors
│   │
│   ├── shapes/                 # Shape primitives
│   │   ├── index.js            # Exports + factory function
│   │   ├── Shape.js            # Base class (bounds, render, hit test)
│   │   ├── Line.js             # Line segment
│   │   ├── Circle.js           # Circle/disc
│   │   ├── Rect.js             # Rectangle
│   │   ├── Arc.js              # Circular arc
│   │   ├── Pad.js              # PCB solder pad
│   │   ├── Via.js              # PCB via
│   │   └── Polygon.js          # Closed polygon
│   │
│   └── ui/
│       └── App.js              # Main app (now uses shapes + selection)
│
└── docs/
    └── PROJECT_STRUCTURE.md
│   ├── schematic/              # Schematic capture module
│   │   ├── SchematicEditor.js  # Main schematic editor class
│   │   ├── SchematicSheet.js   # Single schematic sheet data model
│   │   ├── Wire.js             # Wire/net wire primitive
│   │   ├── Junction.js         # Wire junction point
│   │   ├── NetLabel.js         # Net name labels
│   │   ├── PowerSymbol.js      # VCC, GND, etc.
│   │   ├── Bus.js              # Bus lines
│   │   ├── NetlistExtractor.js # Generate netlist from schematic
│   │   │
│   │   ├── tools/              # Schematic editing tools
│   │   │   ├── SelectTool.js   # Selection and move
│   │   │   ├── WireTool.js     # Draw wires
│   │   │   ├── PlaceTool.js    # Place symbols
│   │   │   ├── LabelTool.js    # Add net labels
│   │   │   └── MeasureTool.js  # Measure distances
│   │   │
│   │   └── symbols/            # Symbol handling
│   │       ├── Symbol.js       # Symbol data model
│   │       ├── SymbolInstance.js # Placed symbol instance
│   │       ├── Pin.js          # Symbol pin definition
│   │       ├── SymbolRenderer.js # Draw symbols
│   │       └── SymbolEditor.js # Create/edit symbols
│   │
│   ├── pcb/                    # PCB layout module
│   │   ├── PCBEditor.js        # Main PCB editor class
│   │   ├── Board.js            # Board outline and stackup
│   │   ├── Track.js            # Copper traces
│   │   ├── Via.js              # Vias (through, blind, buried)
│   │   ├── Zone.js             # Copper pours/fills
│   │   ├── Layer.js            # Layer definitions
│   │   ├── LayerStack.js       # PCB layer stackup
│   │   ├── DRC.js              # Design rule checker
│   │   ├── Ratsnest.js         # Unrouted connections display
│   │   │
│   │   ├── tools/              # PCB editing tools
│   │   │   ├── SelectTool.js   # Selection and move
│   │   │   ├── RouteTool.js    # Interactive routing
│   │   │   ├── DrawTool.js     # Draw board outline, zones
│   │   │   ├── PlaceTool.js    # Place footprints
│   │   │   ├── ViaTool.js      # Place vias manually
│   │   │   └── MeasureTool.js  # Measure distances
│   │   │
│   │   └── footprints/         # Footprint handling
│   │       ├── Footprint.js    # Footprint data model
│   │       ├── FootprintInstance.js # Placed footprint
│   │       ├── Pad.js          # SMD and through-hole pads
│   │       ├── FootprintRenderer.js # Draw footprints
│   │       └── FootprintEditor.js # Create/edit footprints
│   │
│   ├── ui/                     # User interface components
│   │   ├── App.js              # Main application shell
│   │   ├── Toolbar.js          # Tool selection bar
│   │   ├── MenuBar.js          # File/Edit/View menus
│   │   ├── StatusBar.js        # Bottom status display
│   │   │
│   │   ├── components/         # Reusable UI components
│   │   │   ├── Button.js
│   │   │   ├── Dropdown.js
│   │   │   ├── ColorPicker.js
│   │   │   ├── NumberInput.js
│   │   │   └── TreeView.js     # For library browser
│   │   │
│   │   ├── panels/             # Side panels
│   │   │   ├── LayerPanel.js   # Layer visibility/selection
│   │   │   ├── PropertyPanel.js # Selected item properties
│   │   │   ├── LibraryPanel.js # Symbol/footprint browser
│   │   │   ├── DesignRulesPanel.js # DRC settings
│   │   │   └── NetlistPanel.js # Net browser
│   │   │
│   │   └── dialogs/            # Modal dialogs
│   │       ├── NewProjectDialog.js
│   │       ├── BoardSetupDialog.js
│   │       ├── ExportDialog.js
│   │       ├── DRCResultsDialog.js
│   │       └── AboutDialog.js
│   │
│   ├── lib/                    # Library management
│   │   ├── LibraryManager.js   # Load/save libraries
│   │   ├── SymbolLibrary.js    # Symbol library format
│   │   ├── FootprintLibrary.js # Footprint library format
│   │   └── ComponentMapper.js  # Symbol ↔ Footprint mapping
│   │
│   └── io/                     # File import/export
│       ├── ProjectFile.js      # Native project format (.cpcb)
│       ├── KiCadImporter.js    # Import KiCad files
│       ├── KiCadExporter.js    # Export to KiCad
│       ├── GerberExporter.js   # Export Gerber/drill files
│       ├── PDFExporter.js      # Export to PDF
│       ├── SVGExporter.js      # Export to SVG
│       ├── BOMExporter.js      # Bill of materials
│       └── NetlistExporter.js  # Various netlist formats
│
├── assets/
│   ├── icons/                  # Tool and UI icons (SVG)
│   │   ├── tools/
│   │   ├── actions/
│   │   └── layers/
│   │
│   └── styles/
│       ├── main.css            # Global styles
│       ├── toolbar.css
│       ├── panels.css
│       └── dialogs.css
│
├── libraries/                  # Built-in component libraries
│   ├── symbols/
│   │   ├── basic.json          # R, C, L, diode, etc.
│   │   ├── discrete.json       # Transistors, etc.
│   │   ├── logic.json          # Gates, flip-flops
│   │   ├── microcontrollers.json
│   │   └── connectors.json
│   │
│   └── footprints/
│       ├── resistors.json      # 0402, 0603, 0805, etc.
│       ├── capacitors.json
│       ├── sot.json            # SOT-23, SOT-223, etc.
│       ├── soic.json           # SOIC-8, SOIC-16, etc.
│       ├── qfp.json            # TQFP, LQFP, etc.
│       └── connectors.json
│
└── docs/
    ├── PROJECT_STRUCTURE.md    # This file
    ├── DATA_MODEL.md           # Data structure documentation
    ├── ARCHITECTURE.md         # System architecture
    └── API.md                  # Public API documentation
```

## Module Dependencies

```
                    ┌─────────────┐
                    │    App.js   │
                    └──────┬──────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │  Schematic   │ │     PCB      │ │     UI       │
   │    Editor    │ │    Editor    │ │   Panels     │
   └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
          │                │                │
          └────────────────┼────────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │    Core     │
                    │  (Viewport, │
                    │  Commands,  │
                    │  Selection) │
                    └─────────────┘
```

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         Project File                            │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐          │
│  │  Schematic  │───▶│   Netlist   │◀───│     PCB     │         │
│  │   Sheets    │    │             │    │   Layout    │          │
│  └─────────────┘    └─────────────┘    └─────────────┘          │
│         │                 ▲                   │                 │
│         │                 │                   │                 │
│         ▼                 │                   ▼                 │
│  ┌─────────────┐          │           ┌─────────────┐           │
│  │   Symbol    │          │           │  Footprint  │           │
│  │  Instances  │          │           │  Instances  │           │
│  └──────┬──────┘          │           └──────┬──────┘           │
│         │                 │                  │                  │
│         ▼                 │                  ▼                  │
│  ┌─────────────┐          │           ┌─────────────┐           │
│  │   Symbol    │    Component        │  Footprint  │            │
│  │   Library   │◀───Mapping────────▶│   Library   │            │
│  └─────────────┘                      └─────────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Separation of Concerns
- **Core**: No knowledge of schematic or PCB specifics
- **Schematic/PCB**: Independent modules, communicate via netlist
- **UI**: Thin layer, delegates to editors

### 2. Tool Pattern
Each tool handles its own mouse/keyboard input:
```javascript
class Tool {
    onMouseDown(event, worldPos) {}
    onMouseMove(event, worldPos) {}
    onMouseUp(event, worldPos) {}
    onKeyDown(event) {}
    render(ctx, viewport) {}  // Tool-specific overlay
}
```

### 3. Command Pattern for Undo
All edits go through commands:
```javascript
class PlaceComponentCommand {
    constructor(component, position) { ... }
    execute() { /* add to document */ }
    undo() { /* remove from document */ }
}
```

### 4. Event-Driven Updates
Components don't directly modify each other:
```javascript
eventBus.emit('component:added', component);
eventBus.emit('selection:changed', selectedItems);
eventBus.emit('net:highlighted', netName);
```

### 5. Library Format
JSON-based for easy editing and version control:
```json
{
    "name": "Basic Passives",
    "symbols": [
        {
            "id": "resistor",
            "name": "Resistor",
            "pins": [...],
            "graphics": [...]
        }
    ]
}
```