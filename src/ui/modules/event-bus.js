export function setupEventBusListeners(app) {
    app.eventBus.on('component:selected', (def) => {
        app._onComponentDefinitionSelected(def);
    });

    app.eventBus.on('component:pickerClosed', () => {
        app._onComponentPickerClosed();
    });
}
