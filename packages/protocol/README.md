# @mubot/protocol

El contrato entre el bot y el panel: los tipos de lo que el bot manda (`PanelState`: estado, vitales, entidades del radar, decisiones) y la lista cerrada
de órdenes que acepta (`PanelCommand`: `pause`, `resume`, `town`) con su validador `isPanelCommand`. Lo importan `@mubot/bot` y `@mubot/panel`; no tiene
dependencias. Para sumar una orden: agregarla al tipo, a `PANEL_COMMANDS` y a `COMMAND_KEYS`, y manejarla en `bot/src/core/panel.ts`.
