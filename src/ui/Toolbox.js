/**
 * Toolbox - Floating tool palette for schematic editor
 */

export class Toolbox {
    constructor(options = {}) {
        this.onToolSelected = options.onToolSelected || null;
        this.onOptionsChanged = options.onOptionsChanged || null;
        this.currentTool = 'select';
        
        this.tools = [
            { id: 'select', icon: '⊹', name: 'Select', shortcut: 'V' },
            { id: 'line', icon: '╱', name: 'Line', shortcut: 'L' },
            { id: 'wire', icon: '⏤', name: 'Wire', shortcut: 'W' },
            { id: 'rect', icon: '▢', name: 'Rectangle', shortcut: 'R' },
            { id: 'circle', icon: '○', name: 'Circle', shortcut: 'C' },
            { id: 'arc', icon: '◠', name: 'Arc', shortcut: 'A' },
            { id: 'polygon', icon: '⬠', name: 'Polygon', shortcut: 'P' },
            { id: 'text', icon: 'T', name: 'Text', shortcut: 'T' },
            { id: 'component', icon: '⊞', name: 'Component', shortcut: 'I' },
        ];
        
        this.element = this._createElement();
        this._bindEvents();
        this._updateSelection();
    }
    
    _createElement() {
        const toolbox = document.createElement('div');
        toolbox.className = 'toolbox';
        toolbox.innerHTML = `
            <div class="toolbox-header">
                <span class="grip">⋮⋮</span>
                <span>Tools</span>
            </div>
            <div class="toolbox-tools">
                ${this.tools.map(tool => `
                    <button class="tool-btn" data-tool="${tool.id}" title="${tool.name} (${tool.shortcut})">
                        <span class="tool-icon">${tool.icon}</span>
                    </button>
                `).join('')}
            </div>
            <div class="toolbox-divider"></div>
            <div class="toolbox-options" id="toolOptions">
            </div>
        `;
        
        return toolbox;
    }
    
    _bindEvents() {
        // Tool button clicks
        this.element.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.selectTool(btn.dataset.tool);
            });
        });
        
        // Keyboard shortcuts
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            
            const key = e.key.toUpperCase();
            const tool = this.tools.find(t => t.shortcut === key);
            if (tool) {
                this.selectTool(tool.id);
            }
        });
        
        // Make draggable by header
        this._makeDraggable();
    }
    
    _makeDraggable() {
        const header = this.element.querySelector('.toolbox-header');
        let isDragging = false;
        let offsetX = 0;
        let offsetY = 0;
        
        header.style.cursor = 'grab';
        
        header.addEventListener('mousedown', (e) => {
            isDragging = true;
            const rect = this.element.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            header.style.cursor = 'grabbing';
            e.preventDefault();
        });
        
        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
            const x = e.clientX - offsetX;
            const y = e.clientY - offsetY;
            
            // Keep within viewport bounds
            const maxX = window.innerWidth - this.element.offsetWidth;
            const maxY = window.innerHeight - this.element.offsetHeight;
            
            this.element.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
            this.element.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
            this.element.style.right = 'auto';
        });
        
        window.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                header.style.cursor = 'grab';
            }
        });
    }
    
    /**
     * Select a tool and update UI.
     * options: { silent: boolean, force: boolean }
     * - silent: do not call onToolSelected callback
     * - force: update UI even if toolId equals currentTool
     */
    selectTool(toolId, options = {}) {
        const { silent = false, force = false } = options;
        if (!force && this.currentTool === toolId) return;

        this.currentTool = toolId;
        this._updateSelection();
        this._updateOptions();

        if (!silent && this.onToolSelected) {
            this.onToolSelected(toolId);
        }
    }
    
    _updateSelection() {
        this.element.querySelectorAll('.tool-btn').forEach(btn => {
            const shouldBeActive = btn.dataset.tool === this.currentTool;
            btn.classList.toggle('active', shouldBeActive);
            // Blur the button if it's being deactivated to clear any focus styling
            if (!shouldBeActive && document.activeElement === btn) {
                btn.blur();
            }
        });
    }
    
    _updateOptions() {
        const optionsEl = this.element.querySelector('#toolOptions');
        
        // Show tool-specific options
        switch (this.currentTool) {
            case 'line':
            case 'wire':
                optionsEl.innerHTML = `
                    <label>Width
                        <input type="number" id="optLineWidth" value="0.2" min="0.1" max="5" step="0.1">
                    </label>
                `;
                break;
            case 'rect':
            case 'circle':
            case 'polygon':
                optionsEl.innerHTML = `
                    <label>
                        <input type="checkbox" id="optFill"> Fill
                    </label>
                `;
                break;
            default:
                optionsEl.innerHTML = '';
        }
        
        // Bind option change events
        optionsEl.querySelectorAll('input').forEach(input => {
            input.addEventListener('change', () => {
                if (this.onOptionsChanged) {
                    this.onOptionsChanged(this.getOptions());
                }
            });
        });
    }
    
    getOptions() {
        const options = {
            lineWidth: 0.2,
            fill: false,
            color: '#00b894'
        };
        
        const lineWidthInput = this.element.querySelector('#optLineWidth');
        if (lineWidthInput) {
            options.lineWidth = parseFloat(lineWidthInput.value) || 0.2;
        }
        
        const fillInput = this.element.querySelector('#optFill');
        if (fillInput) {
            options.fill = fillInput.checked;
        }
        
        return options;
    }
    
    appendTo(parent) {
        parent.appendChild(this.element);
    }
}