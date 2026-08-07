(() => {
    'use strict';

    const app = document.querySelector('.mars-app');
    if (!app || window.__marsUi) return;

    const cameraHelp = document.querySelector('#camera-help');
    const interfaceToggle = document.querySelector('#ui-panels-toggle');
    const interfaceToggleIcon = document.querySelector('#ui-panels-icon');
    const commandHandlers = new Map();
    let layerHandler = null;
    let engineState = 'loading';
    let pendingCommand = null;

    const commandById = Object.freeze({
        'focus-rover': 'focus-rover',
        'reset-view': 'global-view',
        'camera-global': 'global-view',
        'camera-rover': 'focus-rover',
        'camera-landing': 'focus-landing',
        'camera-surface': 'enter-surface',
        'camera-zoom-out': 'zoom-out',
        'camera-zoom-in': 'zoom-in',
        'camera-spin': 'toggle-spin',
        'surface-light': 'toggle-surface-light',
        'surface-grid': 'toggle-surface-grid',
        'landmark-card-close': 'close-landmark-card',
        'landmark-card-focus': 'focus-landmark-card',
    });

    function setHelp(message, active = true) {
        if (!cameraHelp) return;
        cameraHelp.textContent = message;
        cameraHelp.dataset.active = String(active);
    }

    function setCollapsed(container, button, collapsed, label) {
        if (!container || !button) return;
        container.classList.toggle('collapsed', collapsed);
        button.setAttribute('aria-expanded', String(!collapsed));
        button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Minimize'} ${label}`);
        button.title = `${collapsed ? 'Expand' : 'Minimize'} ${label}`;
        button.textContent = collapsed ? '+' : '−';
    }

    function setInterfaceClean(enabled) {
        const clean = Boolean(enabled);
        app.classList.toggle('interface-clean', clean);
        interfaceToggle?.setAttribute('aria-pressed', String(clean));
        interfaceToggle?.setAttribute('aria-label', clean ? 'Show all interface panels' : 'Hide all interface panels');
        if (interfaceToggle) interfaceToggle.title = `${clean ? 'Show' : 'Hide'} all interface panels (P)`;
        if (interfaceToggleIcon) interfaceToggleIcon.textContent = clean ? 'SHOW' : 'HIDE';
    }

    function commandFor(button) {
        if (!button) return null;
        if (button.matches('[data-surface-move]')) return 'surface-move';
        if (button.matches('[data-sky-focus]')) return 'sky-focus';
        return commandById[button.id] || null;
    }

    function commandPayload(button) {
        return {
            element: button,
            dataset: { ...button.dataset },
        };
    }

    function invokeCommand(button) {
        const name = commandFor(button);
        if (!name) return false;
        const handler = commandHandlers.get(name);
        if (handler && engineState === 'ready') {
            handler(commandPayload(button));
            return true;
        }
        if (engineState === 'failed') {
            setHelp('3D controls unavailable · mission panels remain usable');
            return true;
        }
        pendingCommand = { name, payload: commandPayload(button) };
        app.dataset.pendingCommand = name;
        setHelp('Finishing Mars terrain · command queued');
        return true;
    }

    function handleClick(event) {
        const button = event.target.closest('button');
        if (!button || !app.contains(button)) return;

        if (button.matches('.panel .panel-toggle')) {
            const panel = button.closest('.panel');
            const label = panel?.querySelector('h2')?.textContent?.trim() || 'panel';
            setCollapsed(panel, button, !panel.classList.contains('collapsed'), label);
            return;
        }
        if (button.id === 'weather-collapse') {
            const dock = button.closest('.data-dock');
            setCollapsed(dock, button, !dock?.classList.contains('collapsed'), 'MEDA surface observations');
            return;
        }
        if (button.id === 'surface-collapse') {
            const explorer = button.closest('.surface-explorer');
            setCollapsed(explorer, button, !explorer?.classList.contains('collapsed'), 'surface controls');
            return;
        }
        if (button.id === 'ui-panels-toggle') {
            setInterfaceClean(!app.classList.contains('interface-clean'));
            return;
        }
        invokeCommand(button);
    }

    function handleLayerChange(event) {
        const input = event.target.closest('[data-layer]');
        if (!input || !app.contains(input)) return;
        if (layerHandler && engineState === 'ready') {
            layerHandler(input.dataset.layer, input.checked);
            return;
        }
        app.dataset.pendingLayers = 'true';
        setHelp(engineState === 'failed'
            ? '3D layers unavailable · mission panels remain usable'
            : 'Layer choice saved · applying when Mars is ready');
    }

    function setEngineState(nextState, message = '') {
        engineState = nextState;
        app.dataset.engineState = nextState;
        app.setAttribute('aria-busy', String(nextState === 'loading'));

        if (nextState === 'ready') {
            document.querySelectorAll('[data-layer]').forEach(input => {
                layerHandler?.(input.dataset.layer, input.checked);
            });
            delete app.dataset.pendingLayers;
            const queued = pendingCommand;
            pendingCommand = null;
            delete app.dataset.pendingCommand;
            if (queued) commandHandlers.get(queued.name)?.(queued.payload);
            return;
        }

        if (nextState === 'failed') {
            pendingCommand = null;
            delete app.dataset.pendingCommand;
            document.querySelectorAll('[data-layer]').forEach(input => { input.disabled = true; });
            setHelp(message || '3D controls unavailable · mission panels remain usable');
        }
    }

    document.addEventListener('click', handleClick);
    document.addEventListener('change', handleLayerChange);
    document.addEventListener('keydown', event => {
        const target = event.target;
        const typing = target instanceof HTMLElement
            && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
        if (typing || event.metaKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== 'p') return;
        setInterfaceClean(!app.classList.contains('interface-clean'));
        event.preventDefault();
    });

    app.dataset.uiReady = 'true';
    app.dataset.engineState = engineState;
    app.setAttribute('aria-busy', 'true');

    window.__marsUi = Object.freeze({
        registerCommands(handlers) {
            Object.entries(handlers).forEach(([name, handler]) => commandHandlers.set(name, handler));
        },
        registerLayerHandler(handler) {
            layerHandler = handler;
        },
        setEngineState,
        setCollapsed,
        setInterfaceClean,
        state: () => ({
            engineState,
            pendingCommand: pendingCommand?.name || null,
            layerHandlerReady: Boolean(layerHandler),
        }),
    });
})();
